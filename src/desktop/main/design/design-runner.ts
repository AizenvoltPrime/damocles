// Design renders for core (PD-14, PD-41, docs/invariants.md "Design mode" D85): main queues and bounds the runs; each is one
// offscreen window of the design renderer process with an origin of its own, as contained as a preview view.
import { randomBytes } from 'node:crypto';
import { BrowserWindow } from 'electron';
import {
  MAX_CONSOLE_ERRORS,
  MAX_OVERFLOWING,
  MAX_PROBE_ELEMENTS,
  MAX_PROBE_LINE_CHARS,
  MAX_PROBE_PX,
  MAX_PROBE_WIDTHS,
  MAX_RENDER_HEIGHT,
  MAX_RENDER_IMAGE_SIDE,
  MAX_RENDER_WIDTH,
  MIN_RENDER_WIDTH,
  RENDER_FRAME_HEIGHT,
  pngSize,
  renderScale,
  SWEEP_FROM,
  SWEEP_STEP,
} from '../../../shared/design-render';
import { DESIGN_NAME } from '../../../shared/design-paths';
import { visibleLines, visibleText } from '../../../shared/visible-text';
import { MAX_IMAGE_BASE64_LENGTH } from '../../../shared/types/content';
import { MAX_JOURNEY_OUTLINE_CHARS, parseJourneySteps } from '../../../shared/design-journey';
import type { DesignCapture, DesignJourneyRun, DesignOverflowingElement, DesignProbeElement, DesignProbeResult, DesignProbeWidth, JourneyStep } from '../../../shared/types/design';
import { DESIGN_SCHEME } from '../protocol';
import { registerLockedContents } from '../security';
import { runJourney, untilAborted, type JourneyCdpMethod } from './design-journey';
import { DESIGN_PARTITION, type DesignViewTarget } from './design-session';

export const MAX_CONCURRENT_RUNS = 2;
// a core, a remote one included, queues at most this many runs behind the running ones; one past it is refused
export const MAX_QUEUED_RUNS_PER_AUTHORITY = 16;
export const RUN_TIMEOUT_MS = 60_000;
export const MAX_PROBE_OUTPUT_CHARS: number = 64 * 1024;
const MAX_ATTRIBUTE_CHARS = 120;
// a world of the runner's own, apart from Electron's (999) and the preview's (1001)
const RUNNER_WORLD_ID = 1002;

/** One run's page: an offscreen window main drives; every read of it is page-influenced. */
export interface RunnerPage {
  load(url: string): Promise<void>;
  /** CSS px; the window's content area. */
  resize(width: number, height: number): Promise<void>;
  insertCss(css: string): Promise<void>;
  /** Runs `code` in the runner's isolated world and returns its completion value. */
  evaluate(code: string): Promise<unknown>;
  /** A PNG of the clip at the top left, `scale` device px per CSS px. */
  screenshot(width: number, height: number, scale: number): Promise<Uint8Array>;
  /** A CDP command on the page's own webContents, through its debugger; the answer is the page's. */
  cdp(method: JourneyCdpMethod, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface RunnerPageEvents {
  readonly consoleError: (text: string) => void;
  // the renderer ended or the window was destroyed under the run
  readonly gone: (reason: string) => void;
}

export interface DesignRunnerDeps {
  // a page in the design renderer process (design-renderer-host.ts), whose session holds the preview's containment
  readonly openPage: (origin: string, width: number, events: RunnerPageEvents) => RunnerPage;
  readonly log: (line: string) => void;
  readonly timeoutMs?: number;
}

export interface CaptureRequest {
  readonly relPath: string;
  readonly width: number;
  readonly state: string | null;
  readonly scale: number;
}

export interface JourneyRequest {
  readonly relPath: string;
  readonly widths: readonly number[];
  readonly state: string | null;
  readonly steps: readonly JourneyStep[];
  // a DOM outline of each page where its run ended, for a model that reads no images
  readonly outline: boolean;
}

export interface ProbeRequest {
  readonly relPath: string;
  readonly widths: readonly number[];
  readonly state: string | null;
  // the sweep's last width, the design's widest breakpoint
  readonly sweepTo?: number;
}

// The page's own, but scrollbars are overlays on the devices a design targets, so none takes layout width here.
function runSheet(state: string | null): string {
  const shown = state ?? 'default';
  if (!DESIGN_NAME.test(shown)) throw new Error('Not a state name');
  return `html { scrollbar-width: none !important; }\nhtml [data-ds-state-only]:not([data-ds-state-only~="${shown}"]) { display: none !important; }`;
}

// The root's scrollHeight is never below the viewport, so the content's own height comes from the root's box and the body's
// scroll height.
const CONTENT_HEIGHT = 'Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, document.body ? document.body.scrollHeight : 0))';
const MEASURE = `[${CONTENT_HEIGHT}, document.documentElement.scrollWidth, document.documentElement.clientWidth]`;
// tags outside this alphabet (<o:p>, <x_y>) are named by this placeholder, so one odd tag never fails the probe
const TAG = /^[a-z][a-z0-9-]{0,31}$/;
const OTHER_TAG = 'element';
// the share of the 64 KiB answer the overflow list may use: 8 items of three 120-character strings, escaped
const OVERFLOW_BUDGET_CHARS = 8 * 1024;

// Runs in the runner's own world, so the page's scripts cannot reach its globals; the result is bounded here and parsed as hostile in main.
const PROBE_SCRIPT = `(() => {
  const root = document.documentElement;
  const cw = root.clientWidth;
  const cut = (value) => (value === null ? null : String(value).slice(0, ${MAX_ATTRIBUTE_CHARS}));
  const tag = (el) => { const name = el.tagName.toLowerCase(); return ${TAG}.test(name) ? name : '${OTHER_TAG}'; };
  const out = { h: ${CONTENT_HEIGHT}, sw: root.scrollWidth, cw, els: [], over: [] };
  // the overflow list's share is held back first, so the whole answer stays within the bound main enforces
  let size = ${OVERFLOW_BUDGET_CHARS};
  for (const el of document.querySelectorAll('[data-ds-component],[data-ds-variant],[data-ds-bind]')) {
    if (out.els.length >= ${MAX_PROBE_ELEMENTS}) break;
    const box = el.getBoundingClientRect();
    const visible = box.width > 0 && box.height > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    const item = [tag(el), cut(el.getAttribute('id')), cut(el.getAttribute('data-ds-component')), cut(el.getAttribute('data-ds-variant')), cut(el.getAttribute('data-ds-bind')), box.x, box.y + window.scrollY, box.width, box.height, visible];
    size += JSON.stringify(item).length;
    if (size > ${MAX_PROBE_OUTPUT_CHARS - 1024}) break;
    out.els.push(item);
  }
  if (root.scrollWidth > cw && document.body) {
    const marked = new Set();
    let scanned = 0;
    let overSize = 0;
    for (const el of document.body.getElementsByTagName('*')) {
      if (++scanned > 20000 || out.over.length >= ${MAX_OVERFLOWING}) break;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.right <= cw + 0.5) continue;
      const nested = el.parentElement !== null && marked.has(el.parentElement);
      marked.add(el);
      if (nested) continue;
      const className = typeof el.className === 'string' ? el.className.trim().split(/\\s+/)[0] : '';
      const item = [tag(el), cut(el.getAttribute('id')), cut(className || null), cut(el.getAttribute('data-ds-component')), box.width];
      overSize += JSON.stringify(item).length;
      if (overSize > ${OVERFLOW_BUDGET_CHARS}) break;
      out.over.push(item);
    }
  }
  return JSON.stringify(out);
})()`;

const MAX_OUTLINE_NODES = 400;
// Runs in the runner's own world; a hidden element is listed but not entered, and the answer is bounded here and in main.
const OUTLINE_SCRIPT = `(() => {
  const lines = [];
  let size = 0;
  const skipped = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK']);
  const quote = (text) => JSON.stringify(text.replace(/\\s+/g, ' ').trim().slice(0, 80));
  const walk = (element, depth) => {
    if (lines.length >= ${MAX_OUTLINE_NODES} || depth > 16 || skipped.has(element.tagName)) return;
    const name = element.tagName.toLowerCase();
    const box = element.getBoundingClientRect();
    const shown = box.width > 0 && box.height > 0 && element.checkVisibility({ visibilityProperty: true });
    const own = Array.from(element.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent).join(' ');
    const parts = ['  '.repeat(depth) + (${TAG}.test(name) ? name : '${OTHER_TAG}')];
    for (const attribute of ['role', 'aria-label', 'placeholder', 'type']) {
      const value = element.getAttribute(attribute);
      if (value !== null) parts.push(attribute + '=' + quote(value));
    }
    if (own.trim() !== '') parts.push(quote(own));
    if ('value' in element && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) parts.push('value=' + quote(String(element.value)));
    if (!shown) parts.push('(hidden)');
    const line = parts.join(' ');
    if (size + line.length + 1 > ${MAX_JOURNEY_OUTLINE_CHARS}) return;
    size += line.length + 1;
    lines.push(line);
    if (shown) for (const child of element.children) walk(child, depth + 1);
  };
  if (document.body) walk(document.body, 0);
  return lines.join('\\n');
})()`;

/** The isolated world's outline, parsed as hostile: a bounded string, shown with its controls escaped. */
export function parseOutline(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > MAX_JOURNEY_OUTLINE_CHARS) throw new Error('The page returned a malformed outline');
  return visibleLines(raw).slice(0, MAX_JOURNEY_OUTLINE_CHARS);
}

const clampNumber = (value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('The page returned a malformed probe');
  return Math.min(max, Math.max(min, Math.round(value)));
};
const optionalText = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('The page returned a malformed probe');
  return visibleText(value).slice(0, MAX_ATTRIBUTE_CHARS);
};

function describe(tag: string, id: string | null, className: string | null, component: string | null): string {
  return `<${tag}${id ? `#${id}` : ''}${className ? `.${className}` : ''}${component ? ` data-ds-component="${component}"` : ''}>`.slice(0, MAX_PROBE_LINE_CHARS);
}

/** The isolated world's answer, parsed as hostile: a bounded string, then each field typed and clamped. */
export function parseProbeOutput(raw: unknown, width: number): DesignProbeWidth {
  if (typeof raw !== 'string' || raw.length > MAX_PROBE_OUTPUT_CHARS) throw new Error('The page returned a malformed probe');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('The page returned a malformed probe');
  }
  if (typeof data !== 'object' || data === null) throw new Error('The page returned a malformed probe');
  const { h, sw, cw, els, over } = data as Record<string, unknown>;
  if (!Array.isArray(els) || els.length > MAX_PROBE_ELEMENTS || !Array.isArray(over) || over.length > MAX_OVERFLOWING) throw new Error('The page returned a malformed probe');
  const tagOf = (value: unknown): string => {
    if (typeof value !== 'string') throw new Error('The page returned a malformed probe');
    return TAG.test(value) ? value : OTHER_TAG;
  };
  const elements: DesignProbeElement[] = els.map((item: unknown) => {
    if (!Array.isArray(item) || item.length !== 10 || typeof item[9] !== 'boolean') throw new Error('The page returned a malformed probe');
    return {
      tag: tagOf(item[0]),
      id: optionalText(item[1]),
      component: optionalText(item[2]),
      variant: optionalText(item[3]),
      bind: optionalText(item[4]),
      rect: { x: clampNumber(item[5], -MAX_PROBE_PX, MAX_PROBE_PX), y: clampNumber(item[6], -MAX_PROBE_PX, MAX_PROBE_PX), w: clampNumber(item[7], 0, MAX_PROBE_PX), h: clampNumber(item[8], 0, MAX_PROBE_PX) },
      visible: item[9],
    };
  });
  const overflowing: DesignOverflowingElement[] = over.map((item: unknown) => {
    if (!Array.isArray(item) || item.length !== 5) throw new Error('The page returned a malformed probe');
    return { element: describe(tagOf(item[0]), optionalText(item[1]), optionalText(item[2]), optionalText(item[3])), width: clampNumber(item[4], 0, MAX_PROBE_PX) };
  });
  const scrollWidth = clampNumber(sw, 0, MAX_PROBE_PX);
  const clientWidth = clampNumber(cw, 0, MAX_PROBE_PX);
  return { width, contentHeight: clampNumber(h, 0, MAX_PROBE_PX), scrollWidth, clientWidth, overflow: scrollWidth > clientWidth, overflowing, elements };
}

function parseMeasure(raw: unknown): { height: number; scrollWidth: number; clientWidth: number } {
  if (!Array.isArray(raw) || raw.length !== 3) throw new Error('The page returned a malformed measure');
  return { height: clampNumber(raw[0], 0, MAX_PROBE_PX), scrollWidth: clampNumber(raw[1], 0, MAX_PROBE_PX), clientWidth: clampNumber(raw[2], 0, MAX_PROBE_PX) };
}

const MAX_SHRINKS = 3;
const base64Length = (bytes: Uint8Array): number => Math.ceil(bytes.byteLength / 3) * 4;

const runHeight = (contentHeight: number): number => Math.min(MAX_RENDER_HEIGHT, Math.max(1, contentHeight));

interface Run {
  readonly controller: AbortController;
  page: RunnerPage | undefined;
}

export class DesignRunner {
  private readonly deps: DesignRunnerDeps;
  private running = 0;
  private readonly waiting: Array<{ readonly start: () => void; readonly authority: string }> = [];
  private readonly tokens = new Map<string, DesignViewTarget>();
  private readonly runs = new Set<Run>();

  constructor(deps: DesignRunnerDeps) {
    this.deps = deps;
  }

  /** The design a running page's token names, for the design scheme's handler. */
  targetOf(token: string): DesignViewTarget | undefined {
    return this.tokens.get(token);
  }

  /** Runs and queued runs, for tests. */
  get size(): number {
    return this.runs.size;
  }

  /** A PNG of the frame W × min(900, content height) at the largest scale up to `scale` within MAX_RENDER_IMAGE_SIDE. */
  async capture(target: DesignViewTarget, request: CaptureRequest, signal: AbortSignal): Promise<DesignCapture> {
    const { width } = request;
    if (!Number.isInteger(width) || width < MIN_RENDER_WIDTH || width > MAX_RENDER_WIDTH) throw new Error('Not a design width');
    const sheet = runSheet(request.state);
    return this.run(target, request.relPath, width, signal, async (page, abort) => {
      await untilAborted(page.insertCss(sheet), abort);
      const contentHeight = await this.fit(page, width, abort);
      // a page of fixed-position content alone measures 0 high, and a frame is at least 1 px
      const cssHeight = Math.max(1, Math.min(RENDER_FRAME_HEIGHT, contentHeight));
      let scale = renderScale(width, cssHeight, request.scale);
      let png = await untilAborted(page.screenshot(width, cssHeight, scale), abort);
      // a busy page can make a PNG too large for one image block, so it is taken again smaller
      for (let retry = 0; retry < MAX_SHRINKS && base64Length(png) > MAX_IMAGE_BASE64_LENGTH; retry++) {
        scale = Math.floor(scale * 700) / 1000;
        png = await untilAborted(page.screenshot(width, cssHeight, scale), abort);
      }
      if (base64Length(png) > MAX_IMAGE_BASE64_LENGTH) throw new Error('The capture is too large for one image');
      const size = pngSize(png);
      if (size.width > MAX_RENDER_IMAGE_SIDE || size.height > MAX_RENDER_IMAGE_SIDE) throw new Error(`The capture is ${size.width} × ${size.height} px, over ${MAX_RENDER_IMAGE_SIDE} px`);
      return { png, cssWidth: width, cssHeight, contentHeight, scale };
    });
  }

  /** The visible data-ds elements, the overflow and the console errors at each width, and with `sweepTo` the overflow sweep. */
  async probe(target: DesignViewTarget, request: ProbeRequest, signal: AbortSignal): Promise<DesignProbeResult> {
    const widths = [...new Set(request.widths)].sort((a, b) => a - b);
    const valid = (width: number): boolean => Number.isInteger(width) && width >= MIN_RENDER_WIDTH && width <= MAX_RENDER_WIDTH;
    if (widths.length === 0 || widths.length > MAX_PROBE_WIDTHS || !widths.every(valid) || (request.sweepTo !== undefined && !valid(request.sweepTo))) throw new Error('Not design widths');
    const sheet = runSheet(request.state);
    const consoleErrors: string[] = [];
    return this.run(target, request.relPath, widths[0]!, signal, async (page, abort) => {
      await untilAborted(page.insertCss(sheet), abort);
      const measured: DesignProbeWidth[] = [];
      for (const width of widths) {
        await this.fit(page, width, abort);
        measured.push(parseProbeOutput(await untilAborted(page.evaluate(PROBE_SCRIPT), abort), width));
      }
      if (request.sweepTo === undefined) return { widths: measured, consoleErrors };
      const overflowAt: { width: number; scrollWidth: number }[] = [];
      // one resize a width: scrollWidth needs no fit to the content's height
      for (let width = SWEEP_FROM; width <= request.sweepTo; width = width === request.sweepTo ? width + 1 : Math.min(width + SWEEP_STEP, request.sweepTo)) {
        abort.throwIfAborted();
        await untilAborted(page.resize(width, RENDER_FRAME_HEIGHT), abort);
        const { scrollWidth, clientWidth } = parseMeasure(await untilAborted(page.evaluate(MEASURE), abort));
        if (scrollWidth > clientWidth) overflowAt.push({ width, scrollWidth });
      }
      return { widths: measured, consoleErrors, sweep: { from: SWEEP_FROM, to: request.sweepTo, step: SWEEP_STEP, overflowAt } };
    }, (text) => {
      if (consoleErrors.length < MAX_CONSOLE_ERRORS) consoleErrors.push(visibleText(text.slice(0, MAX_PROBE_LINE_CHARS)).slice(0, MAX_PROBE_LINE_CHARS));
    });
  }

  /**
   * The journey's steps at each width, ascending and in turn, each in a fresh page W × RENDER_FRAME_HEIGHT CSS px; with `outline`, each
   * page's DOM outline where its run ended. Main validates the steps again: a core is another trust domain.
   */
  async journey(target: DesignViewTarget, request: JourneyRequest, signal: AbortSignal): Promise<DesignJourneyRun> {
    const widths = [...new Set(request.widths)].sort((a, b) => a - b);
    const valid = (width: number): boolean => Number.isInteger(width) && width >= MIN_RENDER_WIDTH && width <= MAX_RENDER_WIDTH;
    if (widths.length === 0 || widths.length > MAX_PROBE_WIDTHS || !widths.every(valid)) throw new Error('Not design widths');
    const parsed = parseJourneySteps(request.steps);
    if (!('steps' in parsed)) throw new Error('Not journey steps');
    const sheet = runSheet(request.state);
    const consoleErrors: string[] = [];
    const results: DesignJourneyRun['widths'][number][] = [];
    for (const width of widths) {
      results.push(await this.run(target, request.relPath, width, signal, async (page, abort) => {
        await untilAborted(page.insertCss(sheet), abort);
        await untilAborted(page.resize(width, RENDER_FRAME_HEIGHT), abort);
        const run = await runJourney({ send: (method, params) => untilAborted(page.cdp(method, params), abort) }, parsed.steps, { width, signal: abort });
        const outline = request.outline ? parseOutline(await untilAborted(page.evaluate(OUTLINE_SCRIPT), abort)) : undefined;
        return { width, passed: run.passed, steps: run.steps, ...(outline !== undefined ? { outline } : {}) };
      }, (text) => {
        if (consoleErrors.length < MAX_CONSOLE_ERRORS) consoleErrors.push(visibleText(text.slice(0, MAX_PROBE_LINE_CHARS)).slice(0, MAX_PROBE_LINE_CHARS));
      }));
    }
    return { widths: results, consoleErrors };
  }

  /** Ends every run and queued run and closes every runner window: the main window closed, or the app quits. */
  closeAll(reason: string): void {
    for (const run of this.runs) {
      run.controller.abort(new Error(reason));
      run.page?.close();
    }
  }

  // The window is W wide and as tall as the content, up to MAX_RENDER_HEIGHT; answers the content height.
  private async fit(page: RunnerPage, width: number, abort: AbortSignal): Promise<number> {
    await untilAborted(page.resize(width, RENDER_FRAME_HEIGHT), abort);
    const first = parseMeasure(await untilAborted(page.evaluate(MEASURE), abort));
    await untilAborted(page.resize(width, runHeight(first.height)), abort);
    return parseMeasure(await untilAborted(page.evaluate(MEASURE), abort)).height;
  }

  private async run<T>(
    target: DesignViewTarget,
    relPath: string,
    width: number,
    signal: AbortSignal,
    body: (page: RunnerPage, abort: AbortSignal) => Promise<T>,
    consoleError: (text: string) => void = () => undefined,
  ): Promise<T> {
    const run: Run = { controller: new AbortController(), page: undefined };
    const abort = run.controller.signal;
    const onAbort = (): void => run.controller.abort(signal.reason);
    if (signal.aborted) throw signal.reason;
    signal.addEventListener('abort', onAbort, { once: true });
    this.runs.add(run);
    let timer: NodeJS.Timeout | undefined;
    let token: string | undefined;
    let started = false;
    try {
      await this.slot(abort, target.authority);
      started = true;
      timer = setTimeout(() => run.controller.abort(new Error(`The design render took longer than ${Math.round((this.deps.timeoutMs ?? RUN_TIMEOUT_MS) / 1000)} s`)), this.deps.timeoutMs ?? RUN_TIMEOUT_MS);
      token = randomBytes(16).toString('hex');
      const origin = `${DESIGN_SCHEME}://${token}`;
      this.tokens.set(token, target);
      run.page = this.deps.openPage(origin, width, {
        consoleError,
        gone: (reason) => run.controller.abort(new Error(`The design's page ended: ${reason}`)),
      });
      await untilAborted(run.page.load(`${origin}/${relPath.split('/').map(encodeURIComponent).join('/')}`), abort);
      return await untilAborted(body(run.page, abort), abort);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      run.page?.close();
      if (token !== undefined) this.tokens.delete(token);
      this.runs.delete(run);
      if (started) this.release();
    }
  }

  // At most MAX_CONCURRENT_RUNS run at once; the rest wait in order, and one aborted while waiting leaves the queue.
  private slot(abort: AbortSignal, authority: string): Promise<void> {
    if (this.running < MAX_CONCURRENT_RUNS) {
      this.running++;
      return Promise.resolve();
    }
    if (this.waiting.filter((entry) => entry.authority === authority).length >= MAX_QUEUED_RUNS_PER_AUTHORITY) {
      return Promise.reject(new Error(`${MAX_QUEUED_RUNS_PER_AUTHORITY} design renders of this host are already waiting; try again once they finish`));
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        authority,
        start: () => {
          abort.removeEventListener('abort', leave);
          this.running++;
          resolve();
        },
      };
      const leave = (): void => {
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        reject(abort.reason);
      };
      abort.addEventListener('abort', leave, { once: true });
      this.waiting.push(entry);
    });
  }

  private release(): void {
    this.running--;
    this.waiting.shift()?.start();
  }
}

/**
 * A page of the design renderer process: a hidden offscreen window on its design-preview partition, built exactly as a preview
 * view (design-previews.ts buildView) is, at device scale 1; a capture is CDP `Page.captureScreenshot` with the clip's scale
 * (docs/invariants.md "Design mode" D85 records why).
 */
export function openOffscreenPage(origin: string, width: number, events: RunnerPageEvents): RunnerPage {
  const window = new BrowserWindow({
    show: false,
    width,
    height: RENDER_FRAME_HEIGHT,
    useContentSize: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      partition: DESIGN_PARTITION,
      offscreen: { deviceScaleFactor: 1 },
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      javascript: true,
      disableDialogs: true,
      devTools: false,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      focusOnNavigation: false,
    },
  });
  const contents = window.webContents;
  // Before the first load, so the navigation lock applies to it.
  registerLockedContents(contents, origin);
  // WebRTC's sockets bypass webRequest and CSP; with UDP only through the session's refusing proxy, ICE reaches no host.
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  contents.on('will-prevent-unload', (event) => event.preventDefault());
  contents.on('console-message', (event) => {
    if (event.level === 'error') events.consoleError(event.message);
  });
  contents.on('render-process-gone', (_event, details) => events.gone(details.reason));
  window.on('closed', () => events.gone('closed'));
  let status: number | undefined;
  contents.on('did-navigate', (_event, _url, httpResponseCode) => {
    status = httpResponseCode;
  });
  return {
    load: async (url) => {
      await contents.loadURL(url);
      if (status !== 200) throw new Error('The design file could not be read');
    },
    resize: async (w, h) => {
      window.setContentSize(w, h);
    },
    insertCss: async (css) => {
      await contents.insertCSS(css, { cssOrigin: 'user' });
    },
    evaluate: (code) => contents.executeJavaScriptInIsolatedWorld(RUNNER_WORLD_ID, [{ code }]),
    screenshot: async (w, h, scale) => {
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
      const shot = await contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale } }) as { data?: unknown };
      if (typeof shot.data !== 'string') throw new Error('The capture returned no image');
      return Buffer.from(shot.data, 'base64');
    },
    cdp: (method, params) => {
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
      return contents.debugger.sendCommand(method, params);
    },
    close: () => {
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
