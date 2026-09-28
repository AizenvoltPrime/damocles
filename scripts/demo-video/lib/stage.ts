import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type CDPSession, type Locator, type Page } from 'patchright';

/**
 * Installed Chrome, headless. The scale is forced on the whole browser rather than emulated per page,
 * because headless screencast frames ignore an emulated device scale and arrive at CSS-pixel size.
 */
export const launchBrowser = (): Promise<Browser> =>
  chromium.launch({ headless: true, channel: 'chrome', args: [`--force-device-scale-factor=${DEVICE_SCALE}`, `--window-size=${VIEWPORT.width},${VIEWPORT.height}`] });
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../src/shared/types/messages.ts';

/** The page renders at this CSS size and scale, so every captured frame is exactly WINDOW_W x WINDOW_H. */
export const VIEWPORT = { width: 1280, height: 720 };
export const DEVICE_SCALE = 1.25;
export const WINDOW_W = VIEWPORT.width * DEVICE_SCALE;
export const WINDOW_H = VIEWPORT.height * DEVICE_SCALE;

type PostType = WebviewToExtensionMessage['type'];
type PostOf<T extends PostType> = Extract<WebviewToExtensionMessage, { type: T }>;
type Responder = (msg: WebviewToExtensionMessage) => ExtensionToWebviewMessage[] | void;

const MIN_CAPTION_SECONDS = 3.2;

export interface Caption {
  t: number;
  text: string;
}

/** A camera move starting at `t`: onto `rect` (page CSS pixels), or back to the whole window when null. */
export interface CameraKey {
  t: number;
  rect: { x: number; y: number; width: number; height: number } | null;
  maxZoom: number;
}

export interface Recording {
  framesDir: string;
  /** Seconds since recording start at which each frame was painted. */
  frames: { file: string; t: number }[];
  duration: number;
  captions: Caption[];
  camera: CameraKey[];
  /** The window title from each `t` on. */
  titles: Caption[];
  /** Named moments in seconds since recording start, e.g. the bounds of a GIF highlight. */
  marks: Record<string, number>;
}

export interface Stage {
  page: Page;
  send(...messages: ExtensionToWebviewMessage[]): Promise<void>;
  /** Answers every future post of `type` with the returned messages, the way the extension would. */
  respond<T extends PostType>(type: T, fn: (msg: PostOf<T>) => ExtensionToWebviewMessage[] | void): void;
  waitForPost<T extends PostType>(type: T, timeoutMs?: number): Promise<PostOf<T>>;
  pause(ms: number): Promise<void>;
  moveTo(target: Locator, opts?: { durationMs?: number }): Promise<void>;
  click(target: Locator, opts?: { durationMs?: number }): Promise<void>;
  typeInto(target: Locator, text: string, opts?: { delayMs?: number }): Promise<void>;
  /** Shows `text` below the window, first holding the previous caption for at least MIN_CAPTION_SECONDS. */
  caption(text: string): Promise<void>;
  mark(name: string): void;
  /** Eases the camera in on the union of `targets`, zooming at most `maxZoom`. */
  focus(targets: Locator | Locator[], opts?: { maxZoom?: number }): Promise<void>;
  unfocus(): void;
  windowTitle(text: string): void;
  startRecording(framesDir: string): Promise<void>;
  stopRecording(): Promise<Recording>;
}

const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l16 11.5-7.2 1.1 4.3 7.6-3 1.6-4.2-7.7L4 21z" fill="#fdf6e3" stroke="#002b36" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

async function installCursor(page: Page): Promise<void> {
  await page.evaluate((svg) => {
    const cursor = document.createElement('div');
    cursor.id = '__demo-cursor';
    cursor.innerHTML = svg;
    Object.assign(cursor.style, {
      position: 'fixed', left: '0', top: '0', width: '26px', height: '26px', zIndex: '2147483647',
      pointerEvents: 'none', transform: 'translate(1180px, 640px)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.5))',
      transitionProperty: 'transform', transitionTimingFunction: 'cubic-bezier(.45,.05,.25,1)',
    });
    document.body.appendChild(cursor);
  }, CURSOR_SVG);
}

/** Resizes the headless window until the page's inner size is exactly VIEWPORT; window chrome size varies. */
async function fitWindow(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  // setWindowBounds does not land exactly on the requested size, so each pass corrects the previous request.
  const request = { width: 0, height: 0 };
  for (let i = 0; i < 4; i++) {
    const [iw, ih, ow, oh] = await page.evaluate(() => [innerWidth, innerHeight, outerWidth, outerHeight], undefined, false);
    if (iw === VIEWPORT.width && ih === VIEWPORT.height) return void (await cdp.detach());
    request.width = (i === 0 ? ow! : request.width) + VIEWPORT.width - iw!;
    request.height = (i === 0 ? oh! : request.height) + VIEWPORT.height - ih!;
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: request });
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Could not size the headless window to the viewport');
}

/** Opens the webview in a fresh page and answers its `ready` with `boot`, as the extension would. */
export async function openStage(browser: Browser, url: string, boot: ExtensionToWebviewMessage[]): Promise<Stage> {
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error('[webview error]', err.message));

  const posted: WebviewToExtensionMessage[] = [];
  const responders = new Map<PostType, Responder>([['ready', () => boot]]);
  const waiters: { type: PostType; from: number; resolve: (m: WebviewToExtensionMessage) => void }[] = [];
  let cursor = { x: 1180, y: 640 };

  const send = async (...messages: ExtensionToWebviewMessage[]): Promise<void> => {
    await page.evaluate((batch) => { for (const m of batch) window.postMessage(m, '*'); }, messages, false);
  };

  const drain = async (): Promise<void> => {
    const batch = await page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted.splice(0), undefined, false);
    for (const msg of batch as WebviewToExtensionMessage[]) {
      posted.push(msg);
      const replies = responders.get(msg.type)?.(msg);
      if (replies?.length) await send(...replies);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!;
        if (w.type === msg.type && posted.length - 1 >= w.from) {
          waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    }
  };

  const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let polling = true;
  const poll = async (): Promise<void> => {
    while (polling) {
      await drain().catch(() => {});
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  await fitWindow(page);
  await page.goto(url);
  await page.waitForSelector('#app *');
  await installCursor(page);
  void poll();
  await pause(900);

  let recording: { cdp: CDPSession; dir: string; t0: number | null; frames: Recording['frames']; writes: Promise<void>[]; startedAt: number } | null = null;
  const captions: Caption[] = [];
  const camera: CameraKey[] = [];
  const titles: Caption[] = [];
  const marks: Record<string, number> = {};
  const elapsed = (): number => {
    if (!recording) throw new Error('called outside a recording');
    return (Date.now() - recording.startedAt) / 1000;
  };

  const moveTo: Stage['moveTo'] = async (target, opts = {}) => {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`moveTo: ${target} has no box`);
    const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const distance = Math.hypot(to.x - cursor.x, to.y - cursor.y);
    const duration = opts.durationMs ?? Math.round(Math.min(1100, Math.max(350, distance * 1.1)));
    await page.evaluate(({ x, y, duration }) => {
      const el = document.getElementById('__demo-cursor')!;
      el.style.transitionDuration = `${duration}ms`;
      el.style.transform = `translate(${x - 5}px, ${y - 3}px)`;
    }, { ...to, duration });
    await pause(duration + 60);
    await page.mouse.move(to.x, to.y);
    cursor = to;
  };

  const click: Stage['click'] = async (target, opts) => {
    await moveTo(target, opts);
    await page.evaluate(({ x, y }) => {
      const ripple = document.createElement('div');
      Object.assign(ripple.style, {
        position: 'fixed', left: `${x - 18}px`, top: `${y - 18}px`, width: '36px', height: '36px', borderRadius: '50%',
        border: '2px solid #b58900', zIndex: '2147483646', pointerEvents: 'none', transition: 'transform .45s ease-out, opacity .45s ease-out',
        transform: 'scale(.3)', opacity: '1',
      });
      document.body.appendChild(ripple);
      requestAnimationFrame(() => { ripple.style.transform = 'scale(1.4)'; ripple.style.opacity = '0'; });
      setTimeout(() => ripple.remove(), 500);
    }, cursor);
    await page.mouse.down();
    await pause(70);
    await page.mouse.up();
    await pause(200);
  };

  const stage: Stage = {
    page,
    send,
    respond: (type, fn) => responders.set(type, fn as Responder),
    waitForPost: (type, timeoutMs = 15_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for the webview to post "${type}"`)), timeoutMs);
        waiters.push({ type, from: posted.length, resolve: (m) => { clearTimeout(timer); resolve(m as never); } });
      }),
    pause,
    moveTo,
    click,
    typeInto: async (target, text, opts = {}) => {
      await click(target);
      await target.pressSequentially(text, { delay: opts.delayMs ?? 32 });
    },
    caption: async (text) => {
      if (!recording) throw new Error('caption() outside a recording');
      const last = captions.at(-1);
      const now = () => (Date.now() - recording!.startedAt) / 1000;
      if (last) await pause(Math.max(0, (last.t + MIN_CAPTION_SECONDS - now()) * 1000));
      captions.push({ t: now(), text });
    },
    mark: (name) => {
      marks[name] = elapsed();
    },
    focus: async (targets, opts = {}) => {
      const boxes = await Promise.all((Array.isArray(targets) ? targets : [targets]).map((l) => l.boundingBox()));
      const found = boxes.filter((b) => b !== null);
      if (!found.length) throw new Error('focus: no target has a box');
      const x = Math.min(...found.map((b) => b.x));
      const y = Math.min(...found.map((b) => b.y));
      const width = Math.max(...found.map((b) => b.x + b.width)) - x;
      const height = Math.max(...found.map((b) => b.y + b.height)) - y;
      camera.push({ t: elapsed(), rect: { x, y, width, height }, maxZoom: opts.maxZoom ?? 1.45 });
    },
    unfocus: () => {
      camera.push({ t: elapsed(), rect: null, maxZoom: 1 });
    },
    windowTitle: (text) => {
      titles.push({ t: elapsed(), text });
    },
    startRecording: async (dir) => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      captions.length = 0;
      camera.length = 0;
      titles.length = 0;
      for (const k of Object.keys(marks)) delete marks[k];
      const cdp = await page.context().newCDPSession(page);
      const rec = { cdp, dir, t0: null as number | null, frames: [] as Recording['frames'], writes: [] as Promise<void>[], startedAt: Date.now() };
      recording = rec;
      cdp.on('Page.screencastFrame', (frame) => {
        void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
        const stamp = frame.metadata.timestamp ?? Date.now() / 1000;
        rec.t0 ??= stamp;
        const file = path.join(dir, `${String(rec.frames.length).padStart(6, '0')}.jpg`);
        rec.frames.push({ file, t: stamp - rec.t0 });
        rec.writes.push(fs.promises.writeFile(file, Buffer.from(frame.data, 'base64')));
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95 });
      // The first frame arrives with a wall-clock stamp; captions are measured from the same moment.
      while (rec.t0 === null) await pause(10);
      rec.startedAt = Date.now();
    },
    stopRecording: async () => {
      const rec = recording;
      if (!rec) throw new Error('stopRecording() without startRecording()');
      const duration = (Date.now() - rec.startedAt) / 1000;
      await rec.cdp.send('Page.stopScreencast');
      await rec.cdp.detach();
      await Promise.all(rec.writes);
      recording = null;
      return { framesDir: rec.dir, frames: rec.frames, duration, captions: [...captions], camera: [...camera], titles: [...titles], marks: { ...marks } };
    },
  };

  page.on('close', () => { polling = false; });
  return stage;
}
