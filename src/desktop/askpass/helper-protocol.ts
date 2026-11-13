// The askpass helper's argument and reply parsing (askpass-main.ts), kept apart so tests import it without running the helper.
import { createHash } from 'node:crypto';
import { isCredentialValue, MAX_CREDENTIAL_PASSWORD_CHARS, MAX_CREDENTIAL_USERNAME_CHARS, MAX_REFUSED_MESSAGE_CHARS, parseCredentialFields, TAKEOVER_HELPER_ARG, type GitCredentialAnswer, type GitCredentialFields } from '../../shared/git-credential';

// Must equal MAX_ASKPASS_ARGS and MAX_ASKPASS_ARG_CHARS in src/core/scm/askpass/askpass-server.ts; helper-protocol.test.ts
// compares them, and the helper stays free of core imports.
export const MAX_HELPER_ARGS = 16;
export const MAX_HELPER_ARG_CHARS = 4096;
// The reply: one JSON line holding an answer of at most 4096 characters, each up to 6 bytes once JSON-escaped.
export const MAX_REPLY_BYTES: number = 32 * 1024;

export interface HelperRequest {
  readonly kind: 'askpass' | 'ssh';
  readonly argv: readonly string[];
}

/** The helper's arguments after the script: its kind, then the prompt git or ssh passed; undefined when they are not that. */
export function parseHelperArgs(args: readonly string[]): HelperRequest | undefined {
  const [kind, ...argv] = args;
  if (kind !== 'askpass' && kind !== 'ssh') return undefined;
  if (argv.length === 0 || argv.length > MAX_HELPER_ARGS || argv.some((arg) => arg.length > MAX_HELPER_ARG_CHARS)) return undefined;
  return { kind, argv };
}

/** The request line for the server; an ssh request carries SSH_ASKPASS_PROMPT when ssh set it to one of its two values. */
export function requestLine(nonce: string, request: HelperRequest, sshAskpassPrompt: string | undefined): string {
  const sshPrompt = request.kind === 'ssh' && (sshAskpassPrompt === 'confirm' || sshAskpassPrompt === 'none') ? sshAskpassPrompt : undefined;
  return `${JSON.stringify({ nonce, kind: request.kind, argv: request.argv, ...(sshPrompt !== undefined ? { sshPrompt } : {}) })}\n`;
}

/** The server's reply line: the answer, or undefined for a cancel or anything malformed. */
export function parseReply(line: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const keys = Object.keys(raw);
  const answer = (raw as Record<string, unknown>)['answer'];
  return keys.length === 1 && keys[0] === 'answer' && typeof answer === 'string' && !/[\0\r\n]/.test(answer) ? answer : undefined;
}

// The relay helper's line on stderr when no client is attached, which git shows to the user and to the agent.
export const NOT_CONNECTED_MESSAGE = 'Damocles is not connected. Git credentials from your computer are unavailable.';
// git's description of the credential it wants: a few short lines, far below this
export const MAX_CREDENTIAL_INPUT_BYTES: number = 64 * 1024;

export type CredentialOp = 'get' | 'store' | 'erase';

/** git-credential-relay's arguments: the operation git runs it for, after the takeover's flag when present; undefined for anything else. */
export function parseCredentialOp(args: readonly string[]): { readonly op: CredentialOp; readonly takeover: boolean } | undefined {
  const takeover = args.length === 2 && args[0] === TAKEOVER_HELPER_ARG;
  const op = takeover ? args[1] : args.length === 1 ? args[0] : undefined;
  return op === 'get' || op === 'store' || op === 'erase' ? { op, takeover } : undefined;
}

/**
 * The relayed fields of git's `key=value` description: protocol, host and, when present, path and username. A password git
 * sends with store or erase is never read into them. noHost: the description names no host, as git's `protocol=cert`
 * client-certificate prompt does, which the relay answers with nothing; undefined when a line or value is malformed.
 */
export function credentialFields(input: string): GitCredentialFields | 'noHost' | undefined {
  const values = new Map<string, string>();
  for (const line of input.split('\n')) {
    if (line === '') break;
    const at = line.indexOf('=');
    if (at <= 0) return undefined;
    const key = line.slice(0, at);
    if (key === 'protocol' || key === 'host' || key === 'path' || key === 'username') values.set(key, line.slice(at + 1));
  }
  if (!values.get('host')) return 'noHost';
  return parseCredentialFields(Object.fromEntries(values));
}

/** Reads a stream to its end within `max` bytes and calls back once: the text, or undefined past the bound or on an error. */
export function readBounded(stream: NodeJS.EventEmitter, max: number, onInput: (input: string | undefined) => void): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let over = false;
  let done = false;
  const finish = (input: string | undefined): void => {
    if (done) return;
    done = true;
    onInput(input);
  };
  stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > max) over = true;
    else chunks.push(chunk);
  });
  stream.on('end', () => finish(over ? undefined : Buffer.concat(chunks).toString('utf8')));
  stream.on('error', () => finish(undefined));
}

/**
 * The password git's store or erase names, for the answering process to compare by SHA-256 or hand to the helpers it
 * delegates to; undefined when it names none (an erase from git before 2.4x) or one past the bounds.
 */
export function namedPassword(input: string): string | undefined {
  for (const line of input.split('\n')) {
    if (line === '') break;
    if (!line.startsWith('password=')) continue;
    const password = line.slice('password='.length);
    return password !== '' && isCredentialValue(password, MAX_CREDENTIAL_PASSWORD_CHARS) ? password : undefined;
  }
  return undefined;
}

/** The SHA-256 of a password as hex, the form an erase names it in to another computer. */
export function passwordHashOf(password: string): string {
  return createHash('sha256').update(password, 'utf8').digest('hex');
}

export function credentialRequestLine(nonce: string, op: CredentialOp, cwd: string, fields: GitCredentialFields, password?: string): string {
  return `${JSON.stringify({ nonce, kind: 'credential', op, cwd, fields, ...(password !== undefined && op !== 'get' ? { password } : {}) })}\n`;
}

/** The server's answer line, or undefined when it is not exactly one GitCredentialAnswer within the bounds. */
export function parseCredentialReply(line: string): GitCredentialAnswer | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  if ((value['kind'] === 'none' || value['kind'] === 'notConnected' || value['kind'] === 'delegate') && keys.length === 1) return { kind: value['kind'] };
  if (value['kind'] === 'refused') {
    const refusal = value['message'];
    return keys.length === 2 && isCredentialValue(refusal, MAX_REFUSED_MESSAGE_CHARS) && refusal !== '' ? { kind: 'refused', message: refusal } : undefined;
  }
  const { username, password } = value;
  if (value['kind'] !== 'credential' || keys.length !== 3 || !isCredentialValue(username, MAX_CREDENTIAL_USERNAME_CHARS) || !isCredentialValue(password, MAX_CREDENTIAL_PASSWORD_CHARS) || password === '') return undefined;
  return { kind: 'credential', username, password };
}

/**
 * What the helper prints for git: a credential on stdout; for a refusal quit=1, which stops git asking any helper or the
 * user, and the reason on stderr; the not-connected line on stderr; else nothing. A delegate answer reaches a helper only
 * when its caller already ran the delegation and found nothing, so git goes on as with none.
 */
export function credentialOutput(answer: GitCredentialAnswer): { readonly stdout: string; readonly stderr: string } {
  switch (answer.kind) {
    case 'credential': return { stdout: `username=${answer.username}\npassword=${answer.password}\n`, stderr: '' };
    case 'refused': return { stdout: 'quit=1\n', stderr: `${answer.message}\n` };
    case 'notConnected': return { stdout: '', stderr: `${NOT_CONNECTED_MESSAGE}\n` };
    case 'none':
    case 'delegate':
      return { stdout: '', stderr: '' };
  }
}
