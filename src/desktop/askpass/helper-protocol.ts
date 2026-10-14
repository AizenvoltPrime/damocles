// The askpass helper's argument and reply parsing (askpass-main.ts), kept apart so tests import it without running the helper.

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
