// DesignParity's capture of the real app (PD-34, PD-41): the URL at W CSS px in a browser scope made for the call, as one
// frame of W × min(900, content height). A remote chat's runs on the computer that shows the chat, as user.browser.tool
// `PARITY_CAPTURE_TOOL`, which no model is ever given.
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BrowserAgentScope } from '../browser';
import type { PiCodingAgentModule } from '../pi-session/pi-loader';
import { MAX_RENDER_HEIGHT, MAX_RENDER_IMAGE_SIDE, MAX_RENDER_SCALE, MAX_RENDER_WIDTH, MIN_RENDER_WIDTH, RENDER_FRAME_HEIGHT, pngSize, renderScale } from '../../shared/design-render';
import type { BrowserToolAnswer } from '../../shared/remote-user';
import { MAX_IMAGE_BASE64_LENGTH } from '../../shared/types/content';

export const PARITY_CAPTURE_TOOL = 'DesignParityCapture';

const LOAD_TIMEOUT_MS = 15_000;
const CONTROLLER_TIMEOUT_MS = 25_000;
const SETTLE_TIMEOUT_MS = 3_000;
// a PNG past one image block is taken again at this share of the scale, at most this many times
const SHRINK = 0.7;
const MAX_SHRINKS = 3;

const parityCaptureSchema = Type.Object({
  url: Type.String({ maxLength: 8192 }),
  width: Type.Integer({ minimum: MIN_RENDER_WIDTH, maximum: MAX_RENDER_WIDTH }),
}, { additionalProperties: false });

/** One frame of the app, as the capture answers it. */
export interface AppFrame {
  readonly png: string;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly contentHeight: number;
  readonly status: number | null;
}

export function isHttpUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol } = new URL(url);
  return protocol === 'http:' || protocol === 'https:';
}

/** Why a capture failed, so the caller words it in the user's language; `detail` is a Chromium net code, an HTTP status or an unexpected error's message. */
export type AppCaptureFailure = 'scheme' | 'noPage' | 'load' | 'status' | 'loadTimeout' | 'closed' | 'height' | 'tooLarge' | 'error';

const FAILURES: ReadonlySet<string> = new Set<AppCaptureFailure>(['scheme', 'noPage', 'load', 'status', 'loadTimeout', 'closed', 'height', 'tooLarge', 'error']);
const NET_ERROR = /net::ERR_[A-Z_]{1,64}/;

const failed = (failure: AppCaptureFailure, detail?: string): BrowserToolAnswer => ({ content: [{ type: 'text', text: JSON.stringify({ failure, ...(detail !== undefined ? { detail } : {}) }) }], isError: true });

// Runs in Patchright's isolated world; the page's own scripts never see it, and its answer is checked as hostile.
const MEASURE = `(async () => {
  await Promise.race([document.fonts ? document.fonts.ready : null, new Promise((resolve) => setTimeout(resolve, ${SETTLE_TIMEOUT_MS}))]);
  const root = document.documentElement;
  return Math.max(root ? root.getBoundingClientRect().height : 0, document.body ? document.body.scrollHeight : 0);
})()`;

/** The app at `url`, `width` CSS px wide, in `scope`'s own tab: an answer of the frame's sizes as JSON text, then its PNG. */
export async function captureAppFrame(scope: BrowserAgentScope, url: string, width: number, signal?: AbortSignal): Promise<BrowserToolAnswer> {
  if (!isHttpUrl(url)) return failed('scheme');
  if (!scope.getController()) {
    await scope.open('about:blank', signal);
    if (!(await scope.waitForController(CONTROLLER_TIMEOUT_MS, signal))) return failed('noPage');
  }
  // set before the load, so the page lays out and runs its scripts at this width
  await scope.getController()!.setViewport(width, RENDER_FRAME_HEIGHT, 1);
  let status: number | undefined;
  try {
    status = await scope.open(url, signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const net = NET_ERROR.exec(message)?.[0];
    return net ? failed('load', net) : failed('error', message);
  }
  // a wrong address or the app's own error page is no screen to judge
  if (status !== undefined && status >= 400) return failed('status', String(status));
  const controller = scope.getController();
  if (!controller) return failed('closed');
  const page = controller.getPage();
  try {
    await page.waitForLoadState('load', { timeout: LOAD_TIMEOUT_MS });
  } catch {
    return page.isClosed() ? failed('closed') : failed('loadTimeout', String(LOAD_TIMEOUT_MS / 1000));
  }
  const measured: unknown = await page.evaluate(MEASURE);
  if (typeof measured !== 'number' || !Number.isFinite(measured)) return failed('height');
  const contentHeight = Math.min(Math.max(Math.round(measured), 1), MAX_RENDER_HEIGHT);
  const cssHeight = Math.min(RENDER_FRAME_HEIGHT, contentHeight);
  let scale = renderScale(width, cssHeight, MAX_RENDER_SCALE);
  for (let attempt = 0; attempt <= MAX_SHRINKS; attempt++) {
    const png = await controller.captureScreenshot({ format: 'png', clip: { x: 0, y: 0, width, height: cssHeight, scale } });
    const size = pngSize(Buffer.from(png, 'base64'));
    if (Math.max(size.width, size.height) > MAX_RENDER_IMAGE_SIDE) return failed('tooLarge');
    if (png.length <= MAX_IMAGE_BASE64_LENGTH) {
      const frame = { cssWidth: width, cssHeight, contentHeight, status: status ?? null };
      return { content: [{ type: 'text', text: JSON.stringify(frame) }, { type: 'image', data: png, mimeType: 'image/png' }] };
    }
    scale = Math.floor(scale * SHRINK * 1000) / 1000;
  }
  return failed('tooLarge');
}

const positive = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;

/** A failed capture: its kind, or `undefined` for text the capture did not write (a remote relay's or guard's refusal), given as `detail`. */
export interface AppCaptureFailed {
  readonly failure: AppCaptureFailure | undefined;
  readonly detail: string;
}

function failureOf(text: string | undefined): AppCaptureFailed {
  if (text === undefined) return { failure: undefined, detail: 'The capture failed.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { failure: undefined, detail: text.slice(0, 2000) };
  }
  const { failure, detail } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (typeof failure !== 'string' || !FAILURES.has(failure)) return { failure: undefined, detail: text.slice(0, 2000) };
  return { failure: failure as AppCaptureFailure, detail: typeof detail === 'string' ? detail.slice(0, 2000) : '' };
}

/** A capture's answer as a frame, or the failure it reports; anything else in it is refused. */
export function parseAppFrame(answer: BrowserToolAnswer, width: number): AppFrame | AppCaptureFailed {
  const text = answer.content.find((block) => block.type === 'text');
  if (answer.isError === true) return failureOf(text?.type === 'text' ? text.text : undefined);
  const malformed: AppCaptureFailed = { failure: 'error', detail: 'The capture answered something other than a frame.' };
  const image = answer.content.find((block) => block.type === 'image');
  if (answer.content.length !== 2 || text?.type !== 'text' || image?.type !== 'image' || image.mimeType !== 'image/png') return malformed;
  let sizes: Record<string, unknown>;
  try {
    sizes = JSON.parse(text.text) as Record<string, unknown>;
  } catch {
    return malformed;
  }
  const { cssWidth, cssHeight, contentHeight, status } = sizes ?? {};
  if (cssWidth !== width || !positive(cssHeight, RENDER_FRAME_HEIGHT) || !positive(contentHeight, MAX_RENDER_HEIGHT) || !(status === null || positive(status, 999))) return malformed;
  if (image.data.length > MAX_IMAGE_BASE64_LENGTH) return { failure: 'tooLarge', detail: '' };
  let size: { width: number; height: number };
  try {
    size = pngSize(Buffer.from(image.data, 'base64'));
  } catch {
    return malformed;
  }
  if (Math.max(size.width, size.height) > MAX_RENDER_IMAGE_SIDE) return { failure: 'tooLarge', detail: '' };
  return { png: image.data, cssWidth, cssHeight, contentHeight, status };
}

/** The capture as a tool definition, for the computer that runs a remote chat's browser; never in a model's tool set. */
export function createParityCaptureTool(pi: PiCodingAgentModule, scope: BrowserAgentScope): ToolDefinition {
  return pi.defineTool<typeof parityCaptureSchema, undefined>({
    name: PARITY_CAPTURE_TOOL,
    label: PARITY_CAPTURE_TOOL,
    description: "DesignParity's capture of the app at one width.",
    parameters: parityCaptureSchema,
    execute: async (_toolCallId, input, signal) => {
      const answer = await captureAppFrame(scope, input.url, input.width, signal);
      return { content: answer.content.map((block) => ({ ...block })), details: undefined, ...(answer.isError === true ? { isError: true } : {}) };
    },
  }) as ToolDefinition;
}
