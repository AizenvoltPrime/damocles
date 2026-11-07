// The channel between main and the design renderer process (docs/invariants.md "Design mode" D85): Node IPC with advanced
// serialization. Main parses every message the renderer sends as hostile; a message outside this contract ends the process.

/** The command-line switch that starts the app's executable as the design renderer. */
export const DESIGN_RENDERER_SWITCH = '--damocles-design-renderer';
/** Its userData folder, a fresh temporary one per process, which main removes when the process ended. */
export const DESIGN_RENDERER_DATA_SWITCH = '--damocles-design-renderer-data=';
export const DESIGN_RENDERER_DATA_PREFIX = 'damocles-design-renderer-';

export type PageOp = 'load' | 'resize' | 'insertCss' | 'evaluate' | 'screenshot' | 'cdp' | 'close';

/** Main to renderer. */
export type MainToRenderer =
  | { readonly t: 'open'; readonly id: number; readonly page: number; readonly origin: string; readonly width: number }
  | { readonly t: 'page'; readonly id: number; readonly page: number; readonly op: PageOp; readonly args: readonly unknown[] }
  | { readonly t: 'ping'; readonly id: number }
  | { readonly t: 'read'; readonly id: number; readonly status: number; readonly headers: readonly (readonly [string, string])[]; readonly body: Uint8Array };

/** Renderer to main. */
export type RendererToMain =
  | { readonly t: 'ready' }
  | { readonly t: 'done'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly t: 'done'; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly t: 'read'; readonly id: number; readonly method: string; readonly url: string }
  | { readonly t: 'console'; readonly page: number; readonly text: string }
  | { readonly t: 'gone'; readonly page: number; readonly reason: string };

export const MAX_SCREENSHOT_BYTES: number = 32 * 1024 * 1024;
export const MAX_TEXT_CHARS = 4096;
export const MAX_URL_CHARS = 8192;
export const MAX_METHOD_CHARS = 16;

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

/** A message of the renderer's, or undefined when it is outside the contract. */
export function parseRendererMessage(raw: unknown): RendererToMain | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const message = raw as Record<string, unknown>;
  switch (message['t']) {
    case 'ready':
      return { t: 'ready' };
    case 'done':
      if (!isId(message['id'])) return undefined;
      if (message['ok'] === true) return { t: 'done', id: message['id'], ok: true, value: message['value'] };
      return message['ok'] === false && isText(message['error'], MAX_TEXT_CHARS) ? { t: 'done', id: message['id'], ok: false, error: message['error'] } : undefined;
    case 'read':
      return isId(message['id']) && isText(message['method'], MAX_METHOD_CHARS) && isText(message['url'], MAX_URL_CHARS) ? { t: 'read', id: message['id'], method: message['method'], url: message['url'] } : undefined;
    case 'console':
      return isId(message['page']) && isText(message['text'], MAX_TEXT_CHARS) ? { t: 'console', page: message['page'], text: message['text'] } : undefined;
    case 'gone':
      return isId(message['page']) && isText(message['reason'], MAX_TEXT_CHARS) ? { t: 'gone', page: message['page'], reason: message['reason'] } : undefined;
    default:
      return undefined;
  }
}

/** The read a renderer sends for a design scheme request, or undefined when main would refuse it as outside the contract. */
export function readRequest(id: number, method: string, url: string): RendererToMain | undefined {
  return method.length <= MAX_METHOD_CHARS && url.length <= MAX_URL_CHARS ? { t: 'read', id, method, url } : undefined;
}

// What the renderer's Electron, Chromium and the OS need to start, display and find its temporary folder; nothing else of
// main's environment (which holds the login shell's exports, keys among them) reaches the process that loads designs.
const RENDERER_ENV: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> & { readonly linux: readonly string[] } = {
  win32: ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'],
  darwin: ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'SHELL'],
  linux: ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'],
};

/** Main's environment cut to the renderer's allowlist, matched without case on Windows, plus the locale's LC_* on POSIX. */
export function rendererEnvironment(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): Record<string, string> {
  const allowed = new Set((RENDERER_ENV[platform] ?? RENDERER_ENV.linux).map((name) => (platform === 'win32' ? name.toUpperCase() : name)));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const key = platform === 'win32' ? name.toUpperCase() : name;
    if (allowed.has(key) || (platform !== 'win32' && /^LC_[A-Z]+$/.test(name))) out[name] = value;
  }
  return out;
}
