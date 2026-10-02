import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AssistantImages, ImageApi, ImageModel, Usage } from '@earendil-works/pi-ai';
import type { PiCodingAgentModule } from '../../pi-loader';

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }));
vi.mock('../../../logger', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../logger')>()), log: logSpy }));

import { createGenerateImageTool, imageAvailability, IMAGE_TIMEOUT_MS, type ImageRuntime, type ImageToolDetails } from '../image-tools';
import { isOfferedImageModel } from '../image-tool-specs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString('base64');

function imageModel(id: string, cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): ImageModel<ImageApi> {
  return {
    id, name: id, provider: 'openrouter', api: 'openrouter-images', type: 'image', output: ['image'],
    cost: { cacheRead: 0, cacheWrite: 0, ...cost },
  } as unknown as ImageModel<ImageApi>;
}

/** pi's catalog prices this model's output at the text rate, about a twelfth of what OpenRouter bills an image. */
const MODEL = imageModel('google/gemini-image', { input: 0.3, output: 2.5 });
/** OpenRouter's "variable price" sentinel, as pi's catalog carries it for `openrouter/auto`. */
const AUTO = imageModel('openrouter/auto', { input: -1_000_000, output: -1_000_000 });
/** Priced per image by OpenRouter, so pi's token price is zero and the spend would read as $0. */
const PER_IMAGE = imageModel('black-forest-labs/flux', { input: 0, output: 0 });
/** Prompt tokens priced, the image itself not: the recorded spend would leave the image out. */
const PROMPT_ONLY = imageModel('microsoft/mai-image-2.5', { input: 5, output: 0 });
const CATALOG = [MODEL, AUTO, PER_IMAGE, PROMPT_ONLY];

/** pi's `usage` for one image: tokens priced from MODEL's catalog entry (parseUsage in openrouter-images.js). */
const USAGE: Usage = {
  input: 12, output: 1290, cacheRead: 0, cacheWrite: 0, totalTokens: 1302,
  cost: { input: 0.0000036, output: 0.003225, cacheRead: 0, cacheWrite: 0, total: 0.0032286 },
};
/** What OpenRouter billed for the same image, as `usage.cost` on the response body. */
const BILLED = 0.0387;

function images(overrides: Partial<AssistantImages> = {}): AssistantImages {
  return {
    api: 'openrouter-images', provider: 'openrouter', model: MODEL.id, stopReason: 'stop', timestamp: 0,
    output: [{ type: 'image', mimeType: 'image/png', data: PNG }], usage: USAGE, ...overrides,
  };
}

type GenerateOptions = Parameters<ImageRuntime['generateImages']>[2];

/** A pi model runtime that never reaches OpenRouter: one known model, a configurable credential and reply. */
function fakeRuntime(reply: (options: GenerateOptions) => Promise<AssistantImages>, { auth = true } = {}): ImageRuntime & { generateImages: ReturnType<typeof vi.fn> } {
  return {
    getModelOfType: (_type, provider, id) => (provider === 'openrouter' ? CATALOG.find((model) => model.id === id) : undefined),
    getModelsOfType: () => CATALOG,
    hasConfiguredAuth: (provider) => auth && provider === 'openrouter',
    generateImages: vi.fn((_model: unknown, _context: unknown, options: GenerateOptions) => reply(options)),
  };
}

/**
 * pi's openrouter-images.js: the OpenAI client sends the request through `options.fetch` with the
 * caller's signal, parses the body, and returns `usage` priced from the catalog. An abort rejects the
 * request, which pi reports as `stopReason: 'aborted'` with no usage.
 */
function throughPi(body: unknown, reply: AssistantImages = images()): (options: GenerateOptions) => Promise<AssistantImages> {
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return async (options) => {
    try {
      const response = await options!.fetch!('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', ...(options?.signal ? { signal: options.signal } : {}) });
      await response.json();
      return reply;
    } catch {
      const failed = images({ stopReason: options?.signal?.aborted ? 'aborted' : 'error', output: [] });
      delete failed.usage;
      return failed;
    }
  };
}

const openRouterBody = (usage: Record<string, unknown>) => ({ id: 'gen-1', choices: [{ message: { content: '', images: [] } }], usage });

const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

type Result = { content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>; details?: ImageToolDetails; usage?: Usage; isError?: boolean };

let cwd: string;

beforeEach(async () => {
  cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gen-image-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.promises.rm(cwd, { recursive: true, force: true });
});

async function run(runtime: ImageRuntime, file_path: string, signal?: AbortSignal, prompt = 'a red fox', modelId = MODEL.id): Promise<Result> {
  const tool = createGenerateImageTool({ pi, cwd, getRuntime: () => runtime, getModelId: () => modelId });
  return (await tool.execute('tc-1', { prompt, file_path }, signal, undefined, undefined as never)) as unknown as Result;
}

const text = (result: Result): string => result.content.find((block) => block.type === 'text')?.text ?? '';

describe('GenerateImage — tool body', () => {
  it('asks for the model of its own tool call, so an approved model reaches the request', async () => {
    const runtime = fakeRuntime(async () => images());
    const getModelId = vi.fn((toolCallId: string) => (toolCallId === 'tc-1' ? MODEL.id : 'another/model'));
    const tool = createGenerateImageTool({ pi, cwd, getRuntime: () => runtime, getModelId });
    const result = (await tool.execute('tc-1', { prompt: 'a red fox', file_path: 'fox.png' }, undefined, undefined, undefined as never)) as unknown as Result;
    expect(result.isError).toBeUndefined();
    expect(getModelId).toHaveBeenCalledWith('tc-1');
    expect(runtime.generateImages).toHaveBeenCalledWith(MODEL, expect.anything(), expect.anything());
  });

  it('writes a new file, returns the image block, details and the usage pi persists on the toolResult', async () => {
    const runtime = fakeRuntime(async () => images());
    const result = await run(runtime, 'art/fox.png');

    const target = path.join(cwd, 'art', 'fox.png');
    expect(fs.readFileSync(target).equals(Buffer.from(PNG, 'base64'))).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.usage).toEqual(USAGE);
    expect(result.details).toEqual({ provider: 'openrouter', model: MODEL.id, filePath: target, mimeType: 'image/png', bytes: 12 });
    expect(result.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: PNG });
    expect(runtime.generateImages).toHaveBeenCalledWith(
      MODEL, { input: [{ type: 'text', text: 'a red fox' }] }, { fetch: expect.any(Function), timeoutMs: IMAGE_TIMEOUT_MS });
  });

  it('records the cost OpenRouter billed on the same response, with no second request', async () => {
    const runtime = fakeRuntime(throughPi(openRouterBody({ prompt_tokens: 12, completion_tokens: 1290, cost: BILLED })));
    const result = await run(runtime, 'fox.png');

    expect(result.isError).toBeUndefined();
    expect(result.usage?.cost.total).toBe(BILLED);
    expect(result.usage?.cost.input).toBe(USAGE.cost.input);
    expect(result.usage?.cost.output).toBeCloseTo(BILLED - USAGE.cost.input, 12);
    expect({ ...result.usage, cost: undefined }).toEqual({ ...USAGE, cost: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['absent', {}],
    ['negative', { cost: -1 }],
    ['not a number', { cost: '0.5' }],
  ])('keeps pi\'s estimate when the billed cost is %s, and logs that without the body or the prompt', async (_label, extra) => {
    logSpy.mockClear();
    const runtime = fakeRuntime(throughPi(openRouterBody({ prompt_tokens: 12, completion_tokens: 1290, ...extra })));
    const result = await run(runtime, 'fox.png', undefined, 'a secret prompt');

    expect(result.usage).toEqual(USAGE);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).toContain(MODEL.id);
    expect(logged).not.toContain('a secret prompt');
    expect(logged).not.toContain('gen-1');
  });

  it('accepts image/jpg as image/jpeg', async () => {
    const result = await run(fakeRuntime(async () => images({ output: [{ type: 'image', mimeType: 'image/jpg', data: JPEG }] })), 'fox.jpg');
    expect(result.isError).toBeUndefined();
    expect(result.details?.mimeType).toBe('image/jpeg');
    expect(fs.existsSync(path.join(cwd, 'fox.jpg'))).toBe(true);
  });

  it('names the provider and model in details on a failure too, so /stats attributes its spend', async () => {
    const result = await run(fakeRuntime(async () => images({ stopReason: 'error', errorMessage: 'rate limited', output: [] })), 'fox.png');
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ provider: 'openrouter', model: MODEL.id });
  });

  it('keeps usage and the existing file when another writer creates the path while the image generates', async () => {
    const target = path.join(cwd, 'fox.png');
    const runtime = fakeRuntime(async () => {
      fs.writeFileSync(target, 'someone else');
      return images();
    });
    const result = await run(runtime, 'fox.png');

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('was created while the image was generating');
    expect(result.usage).toEqual(USAGE);
    expect(fs.readFileSync(target, 'utf8')).toBe('someone else');
  });

  it('writes a multi-megabyte image and records its usage (the response check is linear, never a regex)', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 7);
    Buffer.from(PNG, 'base64').copy(big);
    const data = big.toString('base64');
    const result = await run(fakeRuntime(async () => images({ output: [{ type: 'image', mimeType: 'image/png', data }] })), 'big.png');

    expect(result.isError).toBeUndefined();
    expect(result.usage).toEqual(USAGE);
    expect(fs.statSync(path.join(cwd, 'big.png')).size).toBe(big.length);
  });

  it('refuses an existing file before spending anything, and leaves it untouched', async () => {
    fs.writeFileSync(path.join(cwd, 'fox.png'), 'keep me');
    const runtime = fakeRuntime(async () => images());
    const result = await run(runtime, 'fox.png');

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('already exists');
    expect(runtime.generateImages).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(cwd, 'fox.png'), 'utf8')).toBe('keep me');
  });

  it('refuses an extension outside png/jpg/jpeg/webp before spending anything', async () => {
    const runtime = fakeRuntime(async () => images());
    const result = await run(runtime, 'fox.gif');
    expect(result.isError).toBe(true);
    expect(runtime.generateImages).not.toHaveBeenCalled();
  });

  it('checks the extension case-insensitively and treats jpg and jpeg as image/jpeg', async () => {
    const runtime = fakeRuntime(async () => images({ output: [{ type: 'image', mimeType: 'image/jpeg', data: JPEG }] }));
    for (const name of ['a.jpg', 'b.JPEG']) {
      const result = await run(runtime, name);
      expect(result.isError, name).toBeUndefined();
      expect(fs.existsSync(path.join(cwd, name)), name).toBe(true);
    }
  });

  it('refuses a MIME/extension mismatch: writes nothing, keeps usage, names the returned type, keeps the path', async () => {
    const runtime = fakeRuntime(async () => images({ output: [{ type: 'image', mimeType: 'image/jpeg', data: JPEG }] }));
    const result = await run(runtime, 'fox.png');

    expect(result.isError).toBe(true);
    expect(result.usage).toEqual(USAGE);
    expect(text(result)).toContain('image/jpeg');
    expect(text(result)).toContain('.jpg');
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it('keeps usage when the provider stops with an error, and writes nothing', async () => {
    const runtime = fakeRuntime(async () => images({ stopReason: 'error', errorMessage: 'rate limited', output: [] }));
    const result = await run(runtime, 'fox.png');

    expect(result.isError).toBe(true);
    expect(result.usage).toEqual(USAGE);
    expect(text(result)).toContain('rate limited');
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it.each([
    ['no image block', images({ output: [{ type: 'text', text: 'I cannot draw that' }] })],
    ['base64 that does not decode', images({ output: [{ type: 'image', mimeType: 'image/png', data: 'not*base64' }] })],
    ['bytes that are not the declared type', images({ output: [{ type: 'image', mimeType: 'image/png', data: JPEG }] })],
  ])('validates the response: %s fails with usage kept and nothing written', async (_label, reply) => {
    const result = await run(fakeRuntime(async () => reply), 'fox.png');
    expect(result.isError).toBe(true);
    expect(result.usage).toEqual(USAGE);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it('forwards the turn signal to pi, which cancels the request, and writes nothing', async () => {
    const controller = new AbortController();
    const runtime = fakeRuntime(async (options) => {
      controller.abort();
      return throughPi(openRouterBody({ cost: BILLED }))(options);
    });
    const result = await run(runtime, 'fox.png', controller.signal);

    expect(runtime.generateImages.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('aborted');
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it('keeps the billed usage of a response that landed as the turn was aborted, and writes nothing', async () => {
    const controller = new AbortController();
    const body = throughPi(openRouterBody({ cost: BILLED }));
    const runtime = fakeRuntime(async (options) => {
      const reply = await body(options);
      controller.abort();
      return reply;
    });
    const result = await run(runtime, 'fox.png', controller.signal);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('aborted');
    expect(result.usage?.cost.total).toBe(BILLED);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it.each([['a variable-price model', AUTO.id], ['a per-image-priced model', PER_IMAGE.id], ['a model that prices only the prompt', PROMPT_ONLY.id]])('never calls the provider with %s', async (_label, modelId) => {
    const runtime = fakeRuntime(async () => images());
    const result = await run(runtime, 'fox.png', undefined, 'a red fox', modelId);
    expect(result.isError).toBe(true);
    expect(runtime.generateImages).not.toHaveBeenCalled();
  });

  it('fails without calling the provider when no model is configured', async () => {
    const runtime = fakeRuntime(async () => images());
    const tool = createGenerateImageTool({ pi, cwd, getRuntime: () => runtime, getModelId: () => '' });
    const result = (await tool.execute('tc-1', { prompt: 'x', file_path: 'fox.png' }, undefined, undefined, undefined as never)) as unknown as Result;
    expect(result.isError).toBe(true);
    expect(runtime.generateImages).not.toHaveBeenCalled();
  });
});

describe('imageAvailability — eligibility', () => {
  const runtime = (auth: boolean): ImageRuntime => fakeRuntime(async () => images(), { auth });

  it('is unavailable without a model, with a model pi does not know, or without an OpenRouter credential', () => {
    expect(imageAvailability('', runtime(true))).toEqual({ available: false, reason: 'noModel' });
    expect(imageAvailability('nope/unknown', runtime(true))).toEqual({ available: false, reason: 'unknownModel' });
    expect(imageAvailability(MODEL.id, null)).toEqual({ available: false, reason: 'unknownModel' });
    expect(imageAvailability(MODEL.id, runtime(false))).toEqual({ available: false, reason: 'noOpenRouterKey' });
  });

  it('treats a model without a positive output price as not offered: the variable-price sentinel, per-image pricing, prompt-only pricing', () => {
    expect(imageAvailability(AUTO.id, runtime(true))).toEqual({ available: false, reason: 'unknownModel' });
    expect(imageAvailability(PER_IMAGE.id, runtime(true))).toEqual({ available: false, reason: 'unknownModel' });
    expect(imageAvailability(PROMPT_ONLY.id, runtime(true))).toEqual({ available: false, reason: 'unknownModel' });
    expect(CATALOG.filter(isOfferedImageModel)).toEqual([MODEL]);
  });

  it('is available once the model resolves and the credential exists', () => {
    expect(imageAvailability(MODEL.id, runtime(true))).toEqual({ available: true });
  });
});
