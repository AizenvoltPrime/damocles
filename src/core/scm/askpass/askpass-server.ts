// The askpass IPC server (plan AD4, "Askpass"; the request and answer shape follow VS Code's extensions/git/src/askpass.ts and
// ipc/ipcServer.ts, MIT, see THIRD-PARTY-NOTICES.md). git and ssh run the helper scripts, which run askpass-main.js; the helper
// sends one JSON line naming its registration's nonce and git's prompt, and gets back one JSON line with the answer or a cancel.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_INPUT_VALUE_LENGTH } from '../../../shared/input-validation';
import { redactUrls } from '../git-runner';

// notice: ssh's information-only message (SSH_ASKPASS_PROMPT=none, a security key's touch request), which ssh ends by
// killing the helper; it takes no answer.
export type CredentialKind = 'username' | 'password' | 'passphrase' | 'confirm' | 'notice';

// SSH_ASKPASS_PROMPT as ssh sets it for the helper: confirm for a yes/no question, none for a notice.
export type SshPromptHint = 'confirm' | 'none';

// text is git's or ssh's prompt, untrusted: control, format and bidi characters removed, URL userinfo redacted, bounded
export interface CredentialPrompt {
  readonly kind: CredentialKind;
  readonly text: string;
}

// The answer, or undefined for a cancel; confirm resolves 'yes' only on the user's explicit Yes, and a notice resolves
// undefined once closed. signal aborts when the helper goes away or the registration ends, and the prompt is then withdrawn.
export type PromptCredential = (prompt: CredentialPrompt, signal: AbortSignal) => Promise<string | undefined>;

export interface AskpassPaths {
  // resources/askpass/askpass.sh and ssh-askpass.sh as the build copies them, mode 0755
  readonly askpass: string;
  readonly sshAskpass: string;
  // process.execPath, which the scripts run with ELECTRON_RUN_AS_NODE=1
  readonly node: string;
  // dist/askpass-main.js
  readonly main: string;
}

export interface AskpassServerDeps {
  readonly paths: AskpassPaths;
  readonly prompt: PromptCredential;
  readonly log: (line: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly tmpdir?: () => string;
  // XDG_RUNTIME_DIR: per user, mode 0700 and short, so preferred to the temp folder for the POSIX socket
  readonly runtimeDir?: () => string | undefined;
}

// interactive prompts the user; background (autofetch) is answered cancel and never prompts (D10)
export type AskpassMode = 'interactive' | 'background';

export interface AskpassRegistration {
  // the variables of the one git call this registration is for
  readonly env: Readonly<Record<string, string>>;
  // ends the registration: its connections are dropped, an open prompt is withdrawn and a late answer is discarded
  dispose(): void;
}

export interface AskpassServer {
  register(mode: AskpassMode, label: string): Promise<AskpassRegistration>;
  dispose(): Promise<void>;
}

// Bounds of one request line, its argv and an answer; past any of them the connection is dropped. The byte bound applies
// on top of the argument bounds: arguments within them can still escape past it.
export const MAX_ASKPASS_REQUEST_BYTES: number = 16 * 1024;
export const MAX_ASKPASS_ARGS = 16;
export const MAX_ASKPASS_ARG_CHARS = 4096;
export const MAX_ASKPASS_ANSWER_CHARS: number = MAX_INPUT_VALUE_LENGTH;
// Characters (code points) of prompt text shown to the user.
export const MAX_PROMPT_TEXT_CHARS = 1000;
// A helper has this long after connecting to send its whole request.
export const ASKPASS_REQUEST_DEADLINE_MS = 5000;
// Connections still owing their request; one more drops the oldest of them, so connections that send nothing cannot hold
// the server shut against a helper, whose request follows its connect at once (docs/invariants.md, the askpass bullet).
export const MAX_WAITING_CONNECTIONS = 16;
// How long a prompt withdrawn while showing may take to close before the next one shows anyway.
export const WITHDRAWN_PROMPT_GRACE_MS = 2000;
const NONCE_HEX = /^[0-9a-f]{64}$/;
const SHORT_POSIX_TMP = '/tmp';
const SOCKET_FOLDER_PREFIX = 'damocles-askpass-';
const SOCKET_NAME = 'askpass.sock';
// sun_path's size less its NUL: 108 bytes on Linux, 104 on macOS and the BSDs
const MAX_LINUX_SOCKET_PATH_BYTES = 107;
const MAX_BSD_SOCKET_PATH_BYTES = 103;

// every control character but tab and line feed, every format character (bidi, zero-width, soft hyphen, BOM), and the
// line and paragraph separators
const UNSAFE_TEXT = /(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** git's or ssh's prompt as the user may see it: plain text, one or more lines, userinfo redacted, bounded by code point. */
export function promptText(argv: readonly string[]): string {
  const text = [...redactUrls(argv.join(' ').replace(UNSAFE_TEXT, '')).trim()];
  return text.length > MAX_PROMPT_TEXT_CHARS ? `${text.slice(0, MAX_PROMPT_TEXT_CHARS - 1).join('')}…` : text.join('');
}

/**
 * VS Code's askpass.ts classification, failing closed: only git's `Username for '<url>': ` shows unmasked; ssh asks for a
 * passphrase, a host key, a secret, or, by SSH_ASKPASS_PROMPT, a yes/no question or a notice.
 */
export function classifyPrompt(kind: 'askpass' | 'ssh', text: string, hint?: SshPromptHint): CredentialKind {
  // anchored: the URL after it can hold the word (a host, or a path under credential.useHttpPath)
  if (kind === 'askpass') return /^username\b/i.test(text) ? 'username' : 'password';
  if (hint === 'none') return 'notice';
  if (hint === 'confirm') return 'confirm';
  if (/passphrase/i.test(text)) return 'passphrase';
  if (/continue connecting|authenticity of host|\(yes\/no/i.test(text)) return 'confirm';
  return 'password';
}

interface AskpassRequest {
  readonly nonce: string;
  readonly kind: 'askpass' | 'ssh';
  readonly argv: readonly string[];
  readonly sshPrompt?: SshPromptHint;
}

/** One request line as the helper sends it, or undefined: exactly nonce, kind and argv, and sshPrompt for ssh, each within its bounds. */
export function parseAskpassRequest(line: Buffer): AskpassRequest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const keys = Object.hasOwn(value, 'sshPrompt') ? 4 : 3;
  if (Object.keys(value).length !== keys || !['nonce', 'kind', 'argv'].every((key) => Object.hasOwn(value, key))) return undefined;
  const { nonce, kind, argv, sshPrompt } = value;
  if (typeof nonce !== 'string' || !NONCE_HEX.test(nonce) || (kind !== 'askpass' && kind !== 'ssh')) return undefined;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ASKPASS_ARGS) return undefined;
  if (!argv.every((arg): arg is string => typeof arg === 'string' && arg.length <= MAX_ASKPASS_ARG_CHARS)) return undefined;
  if (keys === 3) return { nonce, kind, argv };
  return kind === 'ssh' && (sshPrompt === 'confirm' || sshPrompt === 'none') ? { nonce, kind, argv, sshPrompt } : undefined;
}

/** An answer the helper may print: no line break or NUL, which would end git's read early or add a line, and bounded. */
export function isSendableAnswer(answer: string): boolean {
  return answer.length <= MAX_ASKPASS_ANSWER_CHARS && !/[\0\r\n]/.test(answer);
}

interface Registration {
  readonly mode: AskpassMode;
  readonly label: string;
  readonly nonce: Buffer;
  readonly ended: AbortController;
  loggedRefusal: boolean;
}

interface Listening {
  readonly server: net.Server;
  readonly handle: string;
  readonly dir?: string;
}

export function createAskpassServer(deps: AskpassServerDeps): AskpassServer {
  const platform = deps.platform ?? process.platform;
  const registrations = new Set<Registration>();
  const sockets = new Set<net.Socket>();
  // in connect order, so the oldest is dropped first
  const waiting = new Set<net.Socket>();
  let loggedEviction = false;
  let listening: Promise<Listening> | undefined;
  let disposed = false;
  // one prompt at a time: the overlay replaces an open box with the next, which would swap it under the user's fingers
  let prompts: Promise<unknown> = Promise.resolve();

  const drop = (socket: net.Socket, reason: string): void => {
    if (socket.destroyed) return;
    deps.log(`[askpass] dropped a helper connection: ${reason}`);
    socket.destroy();
  };

  const reply = (socket: net.Socket, answer: string | undefined): void => {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify(answer === undefined ? { cancel: true } : { answer })}\n`);
  };

  const find = (nonce: string): Registration | undefined => {
    const wanted = Buffer.from(nonce, 'hex');
    let found: Registration | undefined;
    // every registration is compared, so the time taken says nothing about which one matched
    for (const registration of registrations) if (timingSafeEqual(registration.nonce, wanted) && !registration.ended.signal.aborted) found = registration;
    return found;
  };

  // The prompt's place in line ends once it settles, or WITHDRAWN_PROMPT_GRACE_MS after a withdrawal while it showed, so a
  // prompt that ignores its signal cannot hold every later one.
  const lineEnd = (run: Promise<unknown>, withdrawn: AbortSignal, started: () => boolean): Promise<void> =>
    new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const settled = (): void => {
        clearTimeout(timer);
        withdrawn.removeEventListener('abort', onWithdrawn);
        resolve();
      };
      const onWithdrawn = (): void => {
        if (!started()) return;
        timer = setTimeout(() => {
          deps.log(`[askpass] a withdrawn credential prompt did not close within ${WITHDRAWN_PROMPT_GRACE_MS} ms; the next one shows anyway`);
          resolve();
        }, WITHDRAWN_PROMPT_GRACE_MS);
        timer.unref();
      };
      withdrawn.addEventListener('abort', onWithdrawn, { once: true });
      run.then(settled, settled);
    });

  const answer = async (socket: net.Socket, registration: Registration, request: AskpassRequest): Promise<void> => {
    if (registration.mode === 'background') {
      if (!registration.loggedRefusal) {
        registration.loggedRefusal = true;
        deps.log(`[askpass] ${registration.label} runs in the background, so its credential request was answered with a cancel`);
      }
      reply(socket, undefined);
      return;
    }
    const withdrawn = new AbortController();
    const onEnd = (): void => withdrawn.abort();
    registration.ended.signal.addEventListener('abort', onEnd, { once: true });
    socket.once('close', onEnd);
    const text = promptText(request.argv);
    const prompt: CredentialPrompt = { kind: classifyPrompt(request.kind, text, request.sshPrompt), text };
    const gone = new Promise<undefined>((resolve) => withdrawn.signal.addEventListener('abort', () => resolve(undefined), { once: true }));
    let started = false;
    const run = prompts.then(async () => {
      if (withdrawn.signal.aborted) return undefined;
      started = true;
      return deps.prompt(prompt, withdrawn.signal);
    });
    prompts = lineEnd(run, withdrawn.signal, () => started);
    try {
      // a withdrawn helper is answered at once, whether its prompt still waits in line or is showing
      const value = await Promise.race([run, gone]);
      if (withdrawn.signal.aborted) {
        socket.destroy();
        return;
      }
      if (value !== undefined && !isSendableAnswer(value)) {
        deps.log('[askpass] refused an answer with a line break or past the length bound');
        reply(socket, undefined);
        return;
      }
      reply(socket, prompt.kind === 'notice' ? undefined : value);
    } finally {
      registration.ended.signal.removeEventListener('abort', onEnd);
      socket.off('close', onEnd);
    }
  };

  const onConnection = (socket: net.Socket): void => {
    if (disposed) {
      socket.destroy();
      return;
    }
    if (waiting.size >= MAX_WAITING_CONNECTIONS) {
      const oldest = waiting.values().next().value!;
      waiting.delete(oldest);
      if (!loggedEviction) {
        loggedEviction = true;
        deps.log(`[askpass] more than ${MAX_WAITING_CONNECTIONS} connections waited for their request; the oldest are dropped`);
      }
      oldest.destroy();
    }
    sockets.add(socket);
    waiting.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      waiting.delete(socket);
    });
    socket.on('error', () => undefined);
    // a deadline from connect, not an idle timer, so a helper sending a byte at a time cannot hold a connection
    const deadline = setTimeout(() => drop(socket, 'no request in time'), ASKPASS_REQUEST_DEADLINE_MS);
    socket.on('close', () => clearTimeout(deadline));
    let received = Buffer.alloc(0);
    let requested = false;
    socket.on('data', (chunk: Buffer) => {
      if (requested) {
        drop(socket, 'bytes after the request');
        return;
      }
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf(0x0a);
      if ((end < 0 ? received.length : end) > MAX_ASKPASS_REQUEST_BYTES) {
        drop(socket, 'request too large');
        return;
      }
      if (end < 0) return;
      if (end !== received.length - 1) {
        drop(socket, 'bytes after the request');
        return;
      }
      requested = true;
      waiting.delete(socket);
      clearTimeout(deadline);
      const request = parseAskpassRequest(received.subarray(0, end));
      if (!request) {
        drop(socket, 'malformed request');
        return;
      }
      const registration = find(request.nonce);
      if (!registration) {
        drop(socket, 'unknown nonce');
        return;
      }
      answer(socket, registration, request).catch((err: unknown) => {
        deps.log(`[askpass] the credential prompt failed: ${err instanceof Error ? err.name : 'unknown error'}`);
        reply(socket, undefined);
      });
    });
  };

  const listenOn = (server: net.Server, handle: string): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(handle, () => {
        server.off('error', reject);
        resolve();
      });
    });

  // A folder only this user can enter, removed again when the socket cannot listen in it (EACCES), so a failed start leaves
  // nothing behind. A base whose socket path would pass sun_path is skipped first: libuv truncates such a path on some
  // versions, which binds the socket outside the folder.
  const listenInPrivateFolder = async (server: net.Server, base: string): Promise<Listening> => {
    const maxBytes = platform === 'linux' ? MAX_LINUX_SOCKET_PATH_BYTES : MAX_BSD_SOCKET_PATH_BYTES;
    if (Buffer.byteLength(path.join(base, `${SOCKET_FOLDER_PREFIX}XXXXXX`, SOCKET_NAME)) > maxBytes) {
      throw new Error(`The askpass socket path under ${base} would pass ${maxBytes} bytes`);
    }
    const dir = await fs.mkdtemp(path.join(base, SOCKET_FOLDER_PREFIX));
    try {
      const stat = await fs.lstat(dir);
      // the socket's own mode is not honoured everywhere, so the folder's 0700 is what keeps other users out
      if (!stat.isDirectory() || (process.getuid !== undefined && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
        throw new Error('The askpass folder is not private to this user');
      }
      const handle = path.join(dir, SOCKET_NAME);
      await listenOn(server, handle);
      return { server, handle, dir };
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true });
      throw err;
    }
  };

  const start = async (): Promise<Listening> => {
    const server = net.createServer(onConnection);
    server.on('error', (err) => deps.log(`[askpass] the server failed: ${err.message}`));
    if (platform === 'win32') {
      // libuv creates the first instance exclusively, so a name another process holds fails and a new one is tried
      for (let attempt = 0; ; attempt++) {
        const handle = `\\\\.\\pipe\\damocles-askpass-${randomBytes(16).toString('hex')}`;
        try {
          await listenOn(server, handle);
          return { server, handle };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 2) throw err;
        }
      }
    }
    const runtimeDir = (deps.runtimeDir ?? (() => process.env['XDG_RUNTIME_DIR']))();
    // /tmp last, for a TMPDIR too deep for a socket path
    const bases = [...new Set([...(runtimeDir !== undefined && path.posix.isAbsolute(runtimeDir) ? [runtimeDir] : []), (deps.tmpdir ?? os.tmpdir)(), SHORT_POSIX_TMP])];
    let failure: unknown;
    for (const base of bases) {
      try {
        return await listenInPrivateFolder(server, base);
      } catch (err) {
        failure = err;
      }
    }
    throw failure;
  };

  return {
    async register(mode, label) {
      if (disposed) throw new Error('The askpass server was disposed');
      if (!listening) {
        const started = start();
        listening = started;
        // a failed start is the caller's error; the next registration tries again
        started.catch(() => {
          if (listening === started) listening = undefined;
        });
      }
      const { handle } = await listening;
      if (disposed) throw new Error('The askpass server was disposed');
      const nonce = randomBytes(32);
      const registration: Registration = { mode, label, nonce, ended: new AbortController(), loggedRefusal: false };
      registrations.add(registration);
      const env: Record<string, string> = {
        GIT_ASKPASS: deps.paths.askpass,
        SSH_ASKPASS: deps.paths.sshAskpass,
        SSH_ASKPASS_REQUIRE: 'force',
        DAMOCLES_ASKPASS_NODE: deps.paths.node,
        DAMOCLES_ASKPASS_MAIN: deps.paths.main,
        DAMOCLES_ASKPASS_HANDLE: handle,
        DAMOCLES_ASKPASS_NONCE: nonce.toString('hex'),
        // Git Credential Manager runs before askpass and has its own sign-in window
        ...(mode === 'background' ? { GCM_INTERACTIVE: 'never' } : {}),
      };
      return {
        env,
        dispose: () => {
          registration.ended.abort();
          registrations.delete(registration);
        },
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const registration of registrations) registration.ended.abort();
      registrations.clear();
      for (const socket of sockets) socket.destroy();
      if (!listening) return;
      let started: Listening;
      try {
        started = await listening;
      } catch {
        return;
      }
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
      if (started.dir !== undefined) await fs.rm(started.dir, { recursive: true, force: true });
    },
  };
}
