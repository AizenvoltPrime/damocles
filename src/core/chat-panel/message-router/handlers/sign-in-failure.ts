import type { ProviderSignInError } from "../../../../shared/types/settings";
import { httpStatusOf } from "../../../pi-session/http-status";
import { l } from "../../../l10n";

const NETWORK_ERROR_CODES: ReadonlySet<unknown> = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"]);

// pi's own phrases, matched only at the start of its text before any punctuation, so a provider body quoted after
// pi's ": " or "(" never classifies (device-code.js:2-3, xai.js:149,152, kimi-coding.js:160,163, meta.js:119,121 in pi-ai 1.4.0).
const PI_EXPIRED = /^(?:Device flow timed out\b|[\w ]*\bdevice (?:code|authorization) expired\b)/;
const PI_DENIED = /^[\w ]*\b(?:authorization|login) was denied\b/;
// pi's whole text for a pasted link or code it refuses (anthropic.js:159,197, openai-chatgpt.js:38, openai-codex.js:304).
const PI_OTHER_SIGN_IN = /^(?:OAuth state|State) mismatch$/;
const PI_NO_CODE = /^Missing authorization code$/;
// "(HTTP 400)" (xai.js:81, openrouter.js:91), "(status 400)" (kimi-coding.js:167, meta.js:147), "with status 400" (kimi-coding.js:62,
// meta.js:73), "failed (400):" (openai-chatgpt.js:122, openai-codex.js:95) and "HTTP request failed. status=400;" (anthropic.js:81).
const PI_STATUS = /^[\w ]*?(?:\((?:HTTP|status) (\d{3})\)|\bwith status (\d{3})\b| \((\d{3})\):)|^HTTP request failed\. status=(\d{3});/;

/** The HTTP status pi's text names before any provider body: Copilot's leading "404 Not Found: …" (github-copilot.js:150) or one of pi's own forms. */
function signInHttpStatus(message: string): number | undefined {
  // only the leading form: httpStatusOf's "(404):" form could find a status inside a body
  if (/^\d{3} /.test(message)) return httpStatusOf(message);
  const own = PI_STATUS.exec(message);
  const status = own?.slice(1).find((group) => group !== undefined);
  return status === undefined ? undefined : Number(status);
}

/**
 * A pi OAuth sign-in's failure as a fixed message per class, never pi's text, which can carry an OAuth response; a cancel is the
 * caller's to tell apart first.
 */
export function signInFailure(err: unknown): ProviderSignInError {
  if (!(err instanceof Error)) return { kind: "provider", message: l("The provider could not complete the sign-in.") };
  if (PI_EXPIRED.test(err.message)) return { kind: "expired", message: l("Code expired. Start the sign-in again.") };
  if (PI_DENIED.test(err.message)) return { kind: "denied", message: l("The sign-in was denied.") };
  if (PI_OTHER_SIGN_IN.test(err.message)) {
    return { kind: "input", message: l("That link is from another sign-in. Paste the link this sign-in opened, or start again.") };
  }
  if (PI_NO_CODE.test(err.message)) return { kind: "input", message: l("That text holds no sign-in code. Paste the whole link or code.") };
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  if (err.name === "TimeoutError" || (err.name === "TypeError" && err.message === "fetch failed") || NETWORK_ERROR_CODES.has(code)) {
    return { kind: "network", message: l("Could not reach the sign-in service. Check the connection and try again.") };
  }
  const httpStatus = signInHttpStatus(err.message);
  return httpStatus === undefined
    ? { kind: "provider", message: l("The provider could not complete the sign-in.") }
    : { kind: "provider", message: l("The provider could not complete the sign-in (HTTP {0}).", httpStatus), status: httpStatus };
}

/** What the log keeps of a failed sign-in: its class, the error's name and the status, never pi's text. */
export function signInFailureLog(err: unknown, failure: ProviderSignInError): string {
  const name = err instanceof Error ? err.name : typeof err;
  return `${failure.kind} (${name})${failure.status !== undefined ? ` (HTTP ${failure.status})` : ""}`;
}
