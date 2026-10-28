// The askpass IPC server (plan AD4, "Askpass"; the request and answer shape follow VS Code's extensions/git/src/askpass.ts and
// ipc/ipcServer.ts, MIT, see THIRD-PARTY-NOTICES.md). git and ssh run the helper scripts, which run askpass-main.js; the helper
// sends one JSON line naming its registration's nonce and git's prompt, and gets back one JSON line with the answer or a cancel.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseCredentialFields, PASSWORD_HASH, type GitCredentialAnswer, type GitCredentialFields } from '../../../shared/git-credential';
import { MAX_INPUT_VALUE_LENGTH } from '../../../shared/input-validation';
import { redactUrls } from '../errors';
import type { CredentialRelay, RelayIdentity } from './credential-relay';

// notice: ssh's information-only message (SSH_ASKPASS_PROMPT=none, a security key's touch request), which ssh ends by
// killing the helper; it takes no answer.
export type CredentialKind = 'username' | 'password' | 'passphrase' | 'confirm' | 'notice';

// SSH_ASKPASS_PROMPT as ssh sets it for the helper: confirm for a permission question (a key use), none for a notice. ssh's
// host key yes/no question carries no hint and is told by its text.
export type SshPromptHint = 'confirm' | 'none';

// text is git's or ssh's prompt, untrusted: control, format and bidi characters removed, URL userinfo redacted, bounded
export interface CredentialPrompt {
  readonly kind: CredentialKind;
  readonly text: string;
}

// The user dismissed a prompt without answering it (Escape, Cancel, or No to a yes/no question); its call is then cancelled.
export const PROMPT_CANCELLED: unique symbol = Symbol('promptCancelled');

// The answer, PROMPT_CANCELLED, or undefined when nothing was asked (a notice, once closed) or the prompt was withdrawn;
// confirm answers 'yes' only on the user's explicit Yes. signal aborts when the helper goes away or the registration ends.
export type PromptCredential = (prompt: CredentialPrompt, signal: AbortSignal) => Promise<string | typeof PROMPT_CANCELLED | undefined>;

export interface AskpassPaths {
  // resources/askpass/askpass.sh and ssh-askpass.sh as the build copies them, mode 0755
  readonly askpass: string;
  readonly sshAskpass: string;
  // process.execPath, which the scripts run with ELECTRON_RUN_AS_NODE=1
  readonly node: string;
  // dist/askpass-main.js
  readonly main: string;
  // a daemon's core only: the daemon's relay, whose handle this server listens at (credential-relay.ts)
  readonly credentialRelay?: RelayIdentity;
}

// A get or erase the relay helper sent; cwd is the folder git ran the helper in, on the target.
export interface CredentialRequest {
  readonly op: 'get' | 'erase';
  readonly cwd: string;
  readonly fields: GitCredentialFields;
  // an erase's: the SHA-256 of the password git names, absent when git sent none
  readonly passwordHash?: string;
}

// Answers a relay request; signal aborts when the helper goes away or the server is disposed.
export type RelayCredential = (request: CredentialRequest, signal: AbortSignal) => Promise<GitCredentialAnswer>;

export interface AskpassServerDeps {
  readonly paths: AskpassPaths;
  readonly prompt: PromptCredential;
  // a daemon's core: answers the credential relay, whose nonce is accepted for nothing else; needs paths.credentialRelay
  readonly credential?: RelayCredential;
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
  // aborts when the user cancels one of this call's prompts, before the helper hears the cancel
  readonly cancelled: AbortSignal;
  // ends the registration: its connections are dropped, an open prompt is withdrawn and a late answer is discarded
  dispose(): void;
}

export interface AskpassServer {
  // prompt: this registration's own, answering its helpers instead of the server's
  register(mode: AskpassMode, label: string, prompt?: PromptCredential): Promise<AskpassRegistration>;
  // starts listening; the relay of this server's life, or undefined without deps.credential or paths.credentialRelay; a
  // failed listen rejects and the next call listens again
  relay(): Promise<CredentialRelay | undefined>;
  // the relay's old handle is gone: stops listening there, and the next relay() or register() listens at handle; helpers
  // already connected finish where they are
  moveRelay(handle: string): Promise<void>;
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
// A server makes its socket and listens moments after its folder, so a younger folder may belong to one starting up.
export const ABANDONED_SOCKET_FOLDER_AGE_MS = 60_000;
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

interface RelayRequest extends CredentialRequest {
  readonly nonce: string;
  readonly kind: 'credential';
}

function parseRelayRequest(value: Record<string, unknown>): RelayRequest | undefined {
  const hashed = Object.hasOwn(value, 'passwordHash');
  if (Object.keys(value).length !== (hashed ? 6 : 5) || !['nonce', 'op', 'cwd', 'fields'].every((key) => Object.hasOwn(value, key))) return undefined;
  const { nonce, op, cwd, fields, passwordHash } = value;
  if (typeof nonce !== 'string' || !NONCE_HEX.test(nonce) || (op !== 'get' && op !== 'erase')) return undefined;
  if (typeof cwd !== 'string' || cwd === '' || cwd.length > MAX_ASKPASS_ARG_CHARS || /[\0\r\n]/.test(cwd)) return undefined;
  if (hashed && (op !== 'erase' || typeof passwordHash !== 'string' || !PASSWORD_HASH.test(passwordHash))) return undefined;
  const parsed = parseCredentialFields(fields);
  return parsed && { nonce, kind: 'credential', op, cwd, fields: parsed, ...(hashed ? { passwordHash: passwordHash as string } : {}) };
}

/**
 * One request line as the helper sends it, or undefined: a prompt is exactly nonce, kind and argv, and sshPrompt for ssh; a
 * relay request exactly nonce, kind, op, cwd and fields; each within its bounds.
 */
export function parseAskpassRequest(line: Buffer): AskpassRequest | RelayRequest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value['kind'] === 'credential') return parseRelayRequest(value);
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
  readonly prompt: PromptCredential;
  readonly nonce: Buffer;
  readonly ended: AbortController;
  readonly cancelled: AbortController;
  loggedRefusal: boolean;
}

interface Listening {
  readonly server: net.Server;
  readonly handle: string;
  readonly dir?: string;
}

// The folders a POSIX socket folder may be made in, preferred first; /tmp last, for a TMPDIR too deep for a socket path.
function socketBases(deps: Pick<AskpassServerDeps, 'tmpdir' | 'runtimeDir'>): string[] {
  const runtimeDir = (deps.runtimeDir ?? (() => process.env['XDG_RUNTIME_DIR']))();
  return [...new Set([...(runtimeDir !== undefined && path.posix.isAbsolute(runtimeDir) ? [runtimeDir] : []), (deps.tmpdir ?? os.tmpdir)(), SHORT_POSIX_TMP])];
}

// 'missing': no socket file; 'unknown': any other failure, which may be a live server's (a full backlog)
export type SocketState = 'listening' | 'refused' | 'missing' | 'unknown';

// Connects and lets go at once; a live server drops the connection without a log line.
function probeSocket(socketPath: string): Promise<SocketState> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve('listening');
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(err.code === 'ECONNREFUSED' ? 'refused' : err.code === 'ENOENT' ? 'missing' : 'unknown');
    });
  });
}

export interface AbandonedSocketSweep extends Pick<AskpassServerDeps, 'tmpdir' | 'runtimeDir'> {
  readonly now: number;
  readonly log: (line: string) => void;
  readonly probe?: (socketPath: string) => Promise<SocketState>;
}

/**
 * POSIX: removes the socket folders askpass servers left when their process ended without disposing them (a crash, a kill).
 * A folder goes only when it is this user's, holds nothing but its socket, was last changed ABANDONED_SOCKET_FOLDER_AGE_MS
 * ago, and its socket refuses a connection or is missing. A server that still listens, in any process, answers and keeps its
 * folder, so neither another running app nor a reused pid can lose one.
 */
export async function removeAbandonedSocketFolders(sweep: AbandonedSocketSweep): Promise<void> {
  const probe = sweep.probe ?? probeSocket;
  for (const base of socketBases(sweep)) {
    let names: string[];
    try {
      names = await fs.readdir(base);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') sweep.log(`[askpass] could not look for abandoned socket folders in ${base}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(SOCKET_FOLDER_PREFIX)) continue;
      const dir = path.join(base, name);
      try {
        const stat = await fs.lstat(dir);
        if (!stat.isDirectory() || (process.getuid !== undefined && stat.uid !== process.getuid())) continue;
        if (sweep.now - stat.mtimeMs < ABANDONED_SOCKET_FOLDER_AGE_MS) continue;
        const entries = await fs.readdir(dir);
        if (entries.some((entry) => entry !== SOCKET_NAME)) continue;
        const state = entries.length === 0 ? 'missing' : await probe(path.join(dir, SOCKET_NAME));
        if (state !== 'refused' && state !== 'missing') continue;
        await fs.rm(dir, { recursive: true, force: true });
        sweep.log(`[askpass] removed the socket folder of a server that no longer runs: ${dir}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') sweep.log(`[askpass] could not remove the abandoned socket folder ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
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
  let relayIdentity = deps.credential ? deps.paths.credentialRelay : undefined;
  const relayNonce = relayIdentity && Buffer.from(relayIdentity.nonce, 'hex');
  // aborts every relay request in flight once the server is disposed
  const relayEnded = new AbortController();

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
      return registration.prompt(prompt, withdrawn.signal);
    });
    prompts = lineEnd(run, withdrawn.signal, () => started);
    try {
      // a withdrawn helper is answered at once, whether its prompt still waits in line or is showing
      const value = await Promise.race([run, gone]);
      if (withdrawn.signal.aborted) {
        socket.destroy();
        return;
      }
      if (value === PROMPT_CANCELLED) {
        // before the reply, so the call is cancelled before git can exit on the helper's failure
        registration.cancelled.abort();
        reply(socket, undefined);
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

  const relayAnswer = async (socket: net.Socket, request: RelayRequest): Promise<void> => {
    const gone = new AbortController();
    const onGone = (): void => gone.abort();
    socket.once('close', onGone);
    try {
      const asked: CredentialRequest = { op: request.op, cwd: request.cwd, fields: request.fields, ...(request.passwordHash !== undefined ? { passwordHash: request.passwordHash } : {}) };
      const answer = await deps.credential!(asked, AbortSignal.any([gone.signal, relayEnded.signal]));
      if (!socket.destroyed) socket.end(`${JSON.stringify(answer)}\n`);
    } finally {
      socket.off('close', onGone);
    }
  };

  const isRelayNonce = (nonce: string): boolean => relayNonce !== undefined && timingSafeEqual(relayNonce, Buffer.from(nonce, 'hex'));

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
      if (request.kind === 'credential') {
        if (!isRelayNonce(request.nonce)) {
          drop(socket, 'a credential request without the relay nonce');
          return;
        }
        relayAnswer(socket, request).catch((err: unknown) => {
          deps.log(`[askpass] the credential relay failed: ${err instanceof Error ? err.message : 'unknown error'}`);
          if (!socket.destroyed) socket.end(`${JSON.stringify({ kind: 'none' } satisfies GitCredentialAnswer)}\n`);
        });
        return;
      }
      if (isRelayNonce(request.nonce)) {
        drop(socket, 'a prompt with the credential relay nonce');
        return;
      }
      const registration = find(request.nonce);
      if (!registration) {
        drop(socket, 'unknown nonce');
        return;
      }
      answer(socket, registration, request).catch((err: unknown) => {
        deps.log(`[askpass] the credential prompt failed: ${err instanceof Error ? redactUrls(err.message) : 'unknown error'}`);
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
    const relay = relayIdentity;
    if (relay) {
      // The daemon made the handle's folder private to the user and runs one core at a time, so a socket there is an
      // ended core's; a Windows pipe name frees with its process.
      if (platform !== 'win32') await fs.rm(relay.handle, { force: true });
      await listenOn(server, relay.handle);
      return { server, handle: relay.handle };
    }
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
    let failure: unknown;
    for (const base of socketBases(deps)) {
      try {
        return await listenInPrivateFolder(server, base);
      } catch (err) {
        failure = err;
      }
    }
    throw failure;
  };

  const listen = (): Promise<Listening> => {
    if (!listening) {
      const started = start();
      listening = started;
      // a failed start is the caller's error; the next call tries again
      started.catch(() => {
        if (listening === started) listening = undefined;
      });
    }
    return listening;
  };

  return {
    async relay() {
      if (disposed) throw new Error('The askpass server was disposed');
      if (!relayIdentity) return undefined;
      const { handle } = await listen();
      return { ...relayIdentity, handle, node: deps.paths.node, main: deps.paths.main };
    },
    async moveRelay(handle) {
      if (disposed) throw new Error('The askpass server was disposed');
      if (!relayIdentity) throw new Error('This askpass server relays no credentials');
      if (relayIdentity.handle === handle) return;
      relayIdentity = { ...relayIdentity, handle };
      const previous = listening;
      listening = undefined;
      // stops accepting at once; its close callback would wait for the connections still answering
      (await previous?.catch(() => undefined))?.server.close();
    },
    async register(mode, label, prompt) {
      if (disposed) throw new Error('The askpass server was disposed');
      const { handle } = await listen();
      if (disposed) throw new Error('The askpass server was disposed');
      const nonce = randomBytes(32);
      const registration: Registration = { mode, label, prompt: prompt ?? deps.prompt, nonce, ended: new AbortController(), cancelled: new AbortController(), loggedRefusal: false };
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
        cancelled: registration.cancelled.signal,
        dispose: () => {
          registration.ended.abort();
          registrations.delete(registration);
        },
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      relayEnded.abort();
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
