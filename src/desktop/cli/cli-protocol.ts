// The damocles command's request and answer: one JSON request per connection, at most MAX_CLI_REQUEST_BYTES, answered with one
// JSON line (docs/invariants.md "The damocles command"). Parsed with the core-protocol schema helpers, so it lives here and not
// in src/remote, which imports only Node built-ins.
import type * as net from 'node:net';
import * as path from 'node:path';
import { arr, bool, int, INVALID, nonEmpty, obj, oneOf, opt, str, type ParsedShape, type Parser } from '../core-protocol/schema';

export const MAX_CLI_REQUEST_BYTES: number = 64 * 1024;
// A connection has this long after connecting to send its whole request line.
export const CLI_REQUEST_DEADLINE_MS = 5000;
export const MAX_CLI_PATH_CHARS = 4096;
export const MAX_CLI_ITEMS = 64;
const MAX_URL_CHARS = 8192;
const MAX_REMOTE_CHARS = 1024;
// a refusal's text, which the relay and the CLI's answer bound alike
export const MAX_CLI_MESSAGE_CHARS: number = 4096;
const MAX_LINE = 1_000_000_000;

export interface CliOpenItem {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

export type CliRequest =
  | { readonly kind: 'open'; readonly cwd: string; readonly items: readonly CliOpenItem[]; readonly wait: boolean }
  | { readonly kind: 'diff'; readonly cwd: string; readonly left: string; readonly right: string; readonly wait: boolean }
  | { readonly kind: 'openExternal'; readonly url: string }
  | { readonly kind: 'status' };

export type CliLanguage = 'en' | 'el';

// tooLarge, malformed, oneRequest: the socket refused the request; notConnected: no client has the terminal's view attached;
// refused: main refused it, saying why in its client's language
export type CliAnswer =
  | { readonly ok: true }
  | { readonly ok: true; readonly version: string; readonly connected: boolean; readonly language: CliLanguage }
  | { readonly ok: false; readonly code: 'refused'; readonly message: string }
  | { readonly ok: false; readonly code: 'notConnected'; readonly language: CliLanguage }
  | { readonly ok: false; readonly code: 'tooLarge' | 'malformed' | 'oneRequest' };

// A request the daemon relays to a client. projectKey stays optional on the wire: daemons that predate it being dropped still
// send their terminal's project, which main does not read.
export interface CliRelay {
  readonly projectKey?: string;
  readonly request: CliRequest;
}

// The answer a client gives the daemon for a relayed request: main's localized refusal, or success.
export type CliRelayAnswer = { readonly ok: true } | { readonly ok: false; readonly message: string };

// Every key of value must be one shape names: an unknown field is refused, never dropped.
function strict<T>(shape: Record<string, Parser<unknown>>, parser: Parser<T>): Parser<T> {
  return (raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return INVALID;
    if (Object.keys(raw).some((key) => !Object.hasOwn(shape, key))) return INVALID;
    return parser(raw);
  };
}

function strictObj<S extends Record<string, Parser<unknown>>>(shape: S): Parser<ParsedShape<S>> {
  return strict(shape, obj(shape));
}

const filePath = nonEmpty(MAX_CLI_PATH_CHARS);
const position = opt(int(1, MAX_LINE));
const ITEM = strictObj({ path: filePath, line: position, column: position });
const OPEN = strictObj({ kind: oneOf(['open'] as const), cwd: filePath, items: arr(ITEM, MAX_CLI_ITEMS), wait: bool });
const DIFF = strictObj({ kind: oneOf(['diff'] as const), cwd: filePath, left: filePath, right: filePath, wait: bool });
const OPEN_EXTERNAL = strictObj({ kind: oneOf(['openExternal'] as const), url: nonEmpty(MAX_URL_CHARS) });
const STATUS = strictObj({ kind: oneOf(['status'] as const) });

/** A request, or undefined for anything outside the contract: an unknown kind or field, a missing field, a bound exceeded. */
export function parseCliRequest(raw: unknown): CliRequest | undefined {
  for (const parser of [OPEN, DIFF, OPEN_EXTERNAL, STATUS] as const) {
    const parsed = parser(raw);
    if (parsed !== INVALID) return parsed as CliRequest;
  }
  return undefined;
}

export const CLI_REQUEST: Parser<CliRequest> = (raw) => parseCliRequest(raw) ?? INVALID;

// A bound of the contract a request breaks, which the command names before it sends anything.
export type CliLimit =
  | { readonly kind: 'items'; readonly max: number }
  | { readonly kind: 'chars'; readonly value: string; readonly max: number }
  | { readonly kind: 'bytes'; readonly max: number };

/** The first bound request breaks with text of lineBytes bytes, or undefined within every bound. */
export function cliRequestLimit(request: CliRequest, lineBytes: number): CliLimit | undefined {
  const chars = (value: string, max: number): CliLimit | undefined => (value.length > max ? { kind: 'chars', value, max } : undefined);
  const paths = (values: readonly string[]): CliLimit | undefined => values.reduce<CliLimit | undefined>((found, value) => found ?? chars(value, MAX_CLI_PATH_CHARS), undefined);
  let found: CliLimit | undefined;
  switch (request.kind) {
    case 'open':
      found = request.items.length > MAX_CLI_ITEMS ? { kind: 'items', max: MAX_CLI_ITEMS } : paths([request.cwd, ...request.items.map((item) => item.path)]);
      break;
    case 'diff':
      found = paths([request.cwd, request.left, request.right]);
      break;
    case 'openExternal':
      found = chars(request.url, MAX_URL_CHARS);
      break;
    case 'status':
      break;
  }
  return found ?? (lineBytes > MAX_CLI_REQUEST_BYTES ? { kind: 'bytes', max: MAX_CLI_REQUEST_BYTES } : undefined);
}

export const CLI_RELAY: Parser<CliRelay> = obj({ projectKey: opt(filePath), request: CLI_REQUEST });

const LANGUAGE = oneOf(['en', 'el'] as const);
const okTrue: Parser<true> = (raw) => (raw === true ? true : INVALID);
const okFalse: Parser<false> = (raw) => (raw === false ? false : INVALID);
const PLAIN_OK = strictObj({ ok: okTrue });
const STATUS_OK = strictObj({ ok: okTrue, version: nonEmpty(256), connected: bool, language: LANGUAGE });
const REFUSED = strictObj({ ok: okFalse, code: oneOf(['refused'] as const), message: str(MAX_CLI_MESSAGE_CHARS) });
const NOT_CONNECTED = strictObj({ ok: okFalse, code: oneOf(['notConnected'] as const), language: LANGUAGE });
const SOCKET_REFUSAL = strictObj({ ok: okFalse, code: oneOf(['tooLarge', 'malformed', 'oneRequest'] as const) });

/** An answer, or undefined for one outside the contract. */
export function parseCliAnswer(raw: unknown): CliAnswer | undefined {
  for (const parser of [PLAIN_OK, STATUS_OK, REFUSED, NOT_CONNECTED, SOCKET_REFUSAL] as const) {
    const parsed = parser(raw);
    if (parsed !== INVALID) return parsed as CliAnswer;
  }
  return undefined;
}

export const CLI_RELAY_ANSWER: Parser<CliRelayAnswer> = (raw) => {
  const ok = PLAIN_OK(raw);
  if (ok !== INVALID) return ok;
  const refused = strictObj({ ok: okFalse, message: str(MAX_CLI_MESSAGE_CHARS) })(raw);
  return refused === INVALID ? INVALID : refused;
};

const answerLine = (answer: CliAnswer): string => `${JSON.stringify(answer)}\n`;

/**
 * Serves one connection: reads one request line, hands it to handle, writes its answer and ends the connection. The client keeps
 * its side open until the answer came, since a Windows pipe has no half-close.
 * Over MAX_CLI_REQUEST_BYTES, malformed JSON, a request outside the contract, or any byte after the request is refused, and the
 * connection ends; a refusal after the request went to handle drops handle's answer. A connection that ends before its request
 * line is malformed, and one whose request line is not complete deadlineMs after it connected is destroyed.
 */
export function serveCliConnection(socket: net.Socket, handle: (request: CliRequest) => Promise<CliAnswer>, log: (line: string) => void, deadlineMs: number = CLI_REQUEST_DEADLINE_MS): void {
  const chunks: Buffer[] = [];
  let size = 0;
  // reading: no request yet; handling: the request went to handle; done: an answer or a refusal went out
  let phase: 'reading' | 'handling' | 'done' = 'reading';
  // from connect, not an idle timer, so a peer sending a byte at a time cannot hold the connection
  const deadline = setTimeout(() => {
    log('[cli] dropped a connection that sent no request in time');
    socket.destroy();
  }, deadlineMs);
  socket.on('close', () => clearTimeout(deadline));
  const finish = (answer: CliAnswer): void => {
    if (phase === 'done') return;
    phase = 'done';
    clearTimeout(deadline);
    socket.end(answerLine(answer));
  };
  const refuse = (code: 'tooLarge' | 'malformed' | 'oneRequest'): void => {
    log(`[cli] refused a request: ${code}`);
    finish({ ok: false, code });
  };
  const take = (text: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      refuse('malformed');
      return;
    }
    const request = parseCliRequest(raw);
    if (!request) {
      refuse('malformed');
      return;
    }
    phase = 'handling';
    clearTimeout(deadline);
    handle(request).then(finish, (err: unknown) => {
      log(`[cli] a ${request.kind} request failed: ${err instanceof Error ? err.message : String(err)}`);
      finish({ ok: false, code: 'refused', message: (err instanceof Error ? err.message : String(err)).slice(0, MAX_CLI_MESSAGE_CHARS) });
    });
  };
  socket.on('error', (err) => log(`[cli] a connection failed: ${err.message}`));
  socket.on('data', (chunk: Buffer) => {
    if (phase === 'done') return;
    if (phase === 'handling') {
      refuse('oneRequest');
      return;
    }
    const newline = chunk.indexOf(0x0a);
    const kept = newline === -1 ? chunk : chunk.subarray(0, newline);
    size += kept.length;
    if (size > MAX_CLI_REQUEST_BYTES) {
      refuse('tooLarge');
      return;
    }
    chunks.push(kept);
    if (newline === -1) return;
    if (chunk.subarray(newline + 1).length > 0) {
      refuse('oneRequest');
      return;
    }
    take(Buffer.concat(chunks).toString('utf8'));
  });
  socket.on('end', () => {
    if (phase === 'reading') refuse('malformed');
  });
}

/** Sends one request on a fresh connection to hook and reads its one answer line. */
export function sendCliRequest(connect: () => net.Socket, request: CliRequest): Promise<CliAnswer> {
  return new Promise((resolve, reject) => {
    const socket = connect();
    const chunks: Buffer[] = [];
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const newline = text.indexOf('\n');
      let raw: unknown;
      try {
        raw = JSON.parse(newline === -1 ? text : text.slice(0, newline));
      } catch {
        reject(new Error('the answer is not JSON'));
        return;
      }
      const answer = parseCliAnswer(raw);
      if (answer) resolve(answer);
      else reject(new Error('the answer is outside the contract'));
    });
  });
}

// dist/cli.js hands the app its request as one switch, whose base64url JSON value Chromium keeps as typed, whatever order it
// gives the command line in second-instance.
export const COMMAND_LINE_SWITCH = '--damocles-cli';
// --wait on this computer: a marker file in waitMarkerFolder, which main claims by writing its pid into it and deletes once the
// request's tabs closed
export const WAIT_MARKER_NAME: RegExp = /^damocles-wait-[0-9a-f]{32}$/;

/** The folder of the --wait markers, under the ~/.damocles both the command and main resolve alike (unlike TMPDIR). */
export const waitMarkerFolder = (damoclesHome: string): string => path.join(damoclesHome, 'cli-wait');

export interface CliCommandLine {
  readonly request: Extract<CliRequest, { readonly kind: 'open' | 'diff' }>;
  // wsl+<distro>, ssh+<host> or loopback; the paths are then the host's
  readonly remote?: string;
  readonly waitMarker?: string;
}

const COMMAND_LINE = strictObj({ request: CLI_REQUEST, remote: opt(nonEmpty(MAX_REMOTE_CHARS)), waitMarker: opt(filePath) });

const commandLineJson = (commandLine: CliCommandLine): string => JSON.stringify(commandLine);

export function commandLineSwitch(commandLine: CliCommandLine): string {
  return `${COMMAND_LINE_SWITCH}=${Buffer.from(commandLineJson(commandLine), 'utf8').toString('base64url')}`;
}

/** The first bound of the switch's contract commandLine breaks, or undefined within every bound. */
export function commandLineLimit(commandLine: CliCommandLine): CliLimit | undefined {
  if (commandLine.remote !== undefined && commandLine.remote.length > MAX_REMOTE_CHARS) return { kind: 'chars', value: commandLine.remote, max: MAX_REMOTE_CHARS };
  if (commandLine.waitMarker !== undefined && commandLine.waitMarker.length > MAX_CLI_PATH_CHARS) return { kind: 'chars', value: commandLine.waitMarker, max: MAX_CLI_PATH_CHARS };
  return cliRequestLimit(commandLine.request, Buffer.byteLength(commandLineJson(commandLine)));
}

/** A --damocles-cli switch main refuses; waitMarker is the marker it names, when its JSON names one, which main still deletes. */
export class CommandLineRefusal extends Error {
  override readonly name: string = 'CommandLineRefusal';
  readonly waitMarker: string | undefined;

  constructor(message: string, waitMarker: string | undefined) {
    super(message);
    this.waitMarker = waitMarker;
  }
}

const isWaitMarker = (value: string): boolean => path.isAbsolute(value) && WAIT_MARKER_NAME.test(path.basename(value));

/** The request a command line carries, undefined when it carries none; a switch outside the contract throws CommandLineRefusal. */
export function parseCommandLine(argv: readonly string[]): CliCommandLine | undefined {
  const prefix = `${COMMAND_LINE_SWITCH}=`;
  const found = argv.filter((arg) => arg.startsWith(prefix));
  if (found.length === 0) return undefined;
  if (found.length > 1) throw new CommandLineRefusal(`The command line names ${COMMAND_LINE_SWITCH} ${found.length} times`, undefined);
  const bytes = Buffer.from(found[0]!.slice(prefix.length), 'base64url');
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new CommandLineRefusal(`The ${COMMAND_LINE_SWITCH} request is not JSON`, undefined);
  }
  // main deletes the marker, so it may name only a wait marker's file name; main checks its folder is waitMarkerFolder's
  const named = typeof raw === 'object' && raw !== null && 'waitMarker' in raw && typeof raw.waitMarker === 'string' && isWaitMarker(raw.waitMarker) ? raw.waitMarker : undefined;
  const refuse = (message: string): CommandLineRefusal => new CommandLineRefusal(message, named);
  if (bytes.length > MAX_CLI_REQUEST_BYTES) throw refuse(`The ${COMMAND_LINE_SWITCH} request is over ${MAX_CLI_REQUEST_BYTES} bytes`);
  const parsed = COMMAND_LINE(raw);
  if (parsed === INVALID || (parsed.request.kind !== 'open' && parsed.request.kind !== 'diff')) throw refuse(`The ${COMMAND_LINE_SWITCH} request is outside the contract`);
  if (parsed.waitMarker !== undefined && !isWaitMarker(parsed.waitMarker)) throw refuse(`The ${COMMAND_LINE_SWITCH} wait marker is not a damocles-wait file`);
  return parsed as CliCommandLine;
}
