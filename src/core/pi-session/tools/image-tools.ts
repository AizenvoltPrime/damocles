import { lstat, mkdir, writeFile } from 'fs/promises';
import { dirname, extname } from 'path';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AssistantImages, ImageApi, ImageContent, ImageModel, ImagesContext, Usage } from '@earendil-works/pi-ai';
import type { ToolGroupUnavailableReason } from '@shared/types/tools';
import type { PiCodingAgentModule } from '../pi-loader';
import { TOOL_GENERATE_IMAGE } from '../../../shared/tool-names';
import { log } from '../../logger';
import { resolveToCwd } from './search-tools';
import { IMAGE_PROVIDER, isOfferedImageModel } from './image-tool-specs';

/** The slice of pi's `ModelRuntime` the image tool and its eligibility read. */
export interface ImageRuntime {
  getModelOfType(type: 'image', provider: string, id: string): ImageModel<ImageApi> | undefined;
  getModelsOfType(type: 'image', provider?: string): readonly ImageModel<ImageApi>[];
  hasConfiguredAuth(provider: string): boolean;
  generateImages(
    model: ImageModel<ImageApi>,
    context: ImagesContext,
    options?: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number },
  ): Promise<AssistantImages>;
}

/** Bounds one generation; without it a hung request holds the turn for the OpenAI SDK's 10-minute default. */
export const IMAGE_TIMEOUT_MS: number = 3 * 60 * 1000;

/** The configured model, when pi's catalog has it and offers it (see `isOfferedImageModel`). */
function offeredImageModel(runtime: ImageRuntime | null, modelId: string): ImageModel<ImageApi> | undefined {
  const model = runtime?.getModelOfType('image', IMAGE_PROVIDER, modelId);
  return model && isOfferedImageModel(model) ? model : undefined;
}

export type ImageAvailability = { available: true } | { available: false; reason: ToolGroupUnavailableReason };

/**
 * Whether GenerateImage can run with this model id: the id resolves in pi's image catalog, Damocles offers
 * it (`isOfferedImageModel`), and pi holds an OpenRouter credential. `hasConfiguredAuth` reads the same credential `generateImages` authenticates
 * with, so the ToolSearch menu lists the tool exactly when a call can authenticate.
 */
export function imageAvailability(modelId: string, runtime: ImageRuntime | null): ImageAvailability {
  if (!modelId) return { available: false, reason: 'noModel' };
  if (!runtime || !offeredImageModel(runtime, modelId)) return { available: false, reason: 'unknownModel' };
  if (!runtime.hasConfiguredAuth(IMAGE_PROVIDER)) return { available: false, reason: 'noOpenRouterKey' };
  return { available: true };
}

/** `provider` and `model` are on every outcome, so `/stats` attributes the spend to the image model. */
export interface ImageToolDetails {
  provider: string;
  model: string;
  /** The absolute path written; this and the rest only when a file was written. */
  filePath?: string;
  mimeType?: string;
  bytes?: number;
}

export interface ImageToolDeps {
  pi: PiCodingAgentModule;
  cwd: string;
  /** pi's model runtime, or null before it initializes. */
  getRuntime: () => ImageRuntime | null;
  /** The model to bill this call to: the one its approval prompt showed, else `damocles.imageGeneration.model`. */
  getModelId: (toolCallId: string) => string;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/** The file signature each allowed type starts with; the data URL's declared type is not proof of the bytes. */
function hasSignature(mimeType: string, bytes: Buffer): boolean {
  switch (mimeType) {
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg': return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case 'image/webp': return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
    default: return false;
  }
}

const imageSchema = Type.Object(
  {
    prompt: Type.String({ description: 'What the image should show.' }),
    file_path: Type.String({ description: 'Where to save the image: a new file ending in .png, .jpg, .jpeg or .webp. Must not exist.' }),
  },
  { additionalProperties: false },
);

type ImageToolResult = AgentToolResult<ImageToolDetails>;

/** A failed call. Returned, never thrown, so pi keeps `usage` on the toolResult and the spend is counted. */
function failure(text: string, details: ImageToolDetails, usage?: Usage): ImageToolResult {
  return { content: [{ type: 'text', text }], details, isError: true, ...(usage ? { usage } : {}) };
}

/**
 * A fetch for pi's OpenRouter request that also reads the `usage.cost` (USD) OpenRouter billed from the
 * same response, which pi's catalog-priced `usage` drops. One per call, so parallel calls never mix costs.
 */
function billedCostFetch(): { fetch: typeof fetch; billed: () => Promise<number | undefined> } {
  let billed: Promise<number | undefined> = Promise.resolve(undefined);
  return {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      // A body that fails to read or parse fails pi's own read too; the caller logs the missing cost.
      billed = response.clone().json().then(
        (body: unknown) => {
          const cost = (body as { usage?: { cost?: unknown } } | null)?.usage?.cost;
          return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
        },
        () => undefined,
      );
      return response;
    },
    billed: () => billed,
  };
}

/** pi's usage with the billed cost as its total; the output cost takes what pi's prompt-side estimate leaves. */
function billedUsage(usage: Usage, billed: number | undefined, modelId: string): Usage {
  if (billed === undefined) {
    log('[GenerateImage] the %s response carried no usable usage.cost; recording pi\'s catalog estimate', modelId);
    return usage;
  }
  const { input, cacheRead, cacheWrite } = usage.cost;
  return { ...usage, cost: { ...usage.cost, output: Math.max(0, billed - input - cacheRead - cacheWrite), total: billed } };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * The deferred `GenerateImage` tool. It runs after the write gate approved `file_path` and the prompt,
 * so it never changes the path: a format the extension does not match fails, writes nothing, and names
 * the returned type. Never log the prompt or the provider's response.
 */
export function createGenerateImageTool(deps: ImageToolDeps): ToolDefinition {
  const { pi, cwd, getRuntime, getModelId } = deps;
  return pi.defineTool<typeof imageSchema, ImageToolDetails>({
    name: TOOL_GENERATE_IMAGE,
    label: 'Generate image',
    description:
      'Generate an image from a text prompt with the configured OpenRouter image model and save it as a NEW file. ' +
      'file_path must end in .png, .jpg, .jpeg or .webp and must not exist; existing files are never overwritten. ' +
      'The model chooses the image format and most image models return PNG, so use .png unless an earlier call in this session returned another type. ' +
      'When the format does not match the extension, nothing is written and the error names the returned type, so call again with that extension. ' +
      'Each call is billed to the user\'s OpenRouter account.',
    parameters: imageSchema,
    execute: async (toolCallId, params, signal, _onUpdate, ctx): Promise<ImageToolResult> => {
      const modelId = getModelId(toolCallId);
      const details: ImageToolDetails = { provider: IMAGE_PROVIDER, model: modelId };
      const filePath = resolveToCwd(params.file_path, ctx?.cwd || cwd);
      const expectedMime = MIME_BY_EXTENSION[extname(filePath).toLowerCase()];
      if (!expectedMime) return failure(`file_path must end in .png, .jpg, .jpeg or .webp: ${params.file_path}`, details);
      if (await pathExists(filePath)) {
        return failure(`${params.file_path} already exists. GenerateImage only creates new files; choose a path that does not exist.`, details);
      }

      const runtime = getRuntime();
      const model = modelId ? offeredImageModel(runtime, modelId) : undefined;
      if (!runtime || !model) return failure('Image generation is not configured: choose an OpenRouter image model in Settings.', details);

      // pi forwards `signal` to the HTTP request, so an abort settles this promptly. An abortableTool wrapper
      // would answer first and drop the usage of a response that landed as the turn was aborted.
      const context: ImagesContext = { input: [{ type: 'text', text: params.prompt }] };
      const cost = billedCostFetch();
      const result = await runtime.generateImages(model, context, { ...(signal ? { signal } : {}), fetch: cost.fetch, timeoutMs: IMAGE_TIMEOUT_MS });
      const usage = result.usage ? billedUsage(result.usage, await cost.billed(), model.id) : undefined;
      if (result.stopReason !== 'stop') {
        return failure(`Image generation ${result.stopReason === 'aborted' ? 'was aborted' : 'failed'}${result.errorMessage ? `: ${result.errorMessage}` : ''}. Nothing was written.`, details, usage);
      }

      const image = result.output.find((block): block is ImageContent => block.type === 'image');
      if (!image) return failure('The image model returned no image. Nothing was written.', details, usage);
      const declared = image.mimeType.toLowerCase();
      const mimeType = declared === 'image/jpg' ? 'image/jpeg' : declared;
      if (mimeType !== expectedMime) {
        const suggested = EXTENSION_BY_MIME[mimeType];
        return failure(
          `The model returned ${mimeType}, which does not match ${params.file_path}. Nothing was written.` +
            (suggested ? ` Call GenerateImage again with a file_path ending in ${suggested}.` : ' That type cannot be saved; try another prompt or model.'),
          details,
          usage,
        );
      }
      // A round trip, not a regex: a regex over a multi-megabyte payload overflows V8's stack and loses `usage`.
      const bytes = Buffer.from(image.data, 'base64');
      if (bytes.length === 0 || bytes.toString('base64') !== image.data || !hasSignature(mimeType, bytes)) {
        return failure(`The image model returned data that is not a valid ${mimeType} image. Nothing was written.`, details, usage);
      }

      // A response that landed as the turn was aborted is still billed: keep its usage and write nothing.
      if (signal?.aborted) return failure('Image generation was aborted. Nothing was written.', details, usage);
      try {
        await mkdir(dirname(filePath), { recursive: true });
        if (signal?.aborted) return failure('Image generation was aborted. Nothing was written.', details, usage);
        await writeFile(filePath, bytes, { flag: 'wx' });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return failure(
          code === 'EEXIST'
            ? `${params.file_path} was created while the image was generating. Nothing was written; choose a path that does not exist.`
            : `Could not write ${params.file_path}: ${err instanceof Error ? err.message : String(err)}`,
          details,
          usage,
        );
      }

      return {
        content: [
          { type: 'text', text: `Saved a ${mimeType} image (${bytes.length} bytes) generated by ${model.id} to ${params.file_path}.` },
          { type: 'image', mimeType, data: image.data },
        ],
        details: { ...details, filePath, mimeType, bytes: bytes.length },
        ...(usage ? { usage } : {}),
      };
    },
  });
}
