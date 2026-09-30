import type { McpServerConfig } from "../../../../shared/types/mcp";

/**
 * Validation for user-authored MCP server definitions on their way to `~/.damocles/mcp.json`.
 *
 * Pure and I/O-free on purpose: the handler runs it *before* anything is queued, so an invalid
 * definition can never reach the write critical section and a rejected write is structurally
 * incapable of touching the file. The webview mirrors these rules for inline errors, but this module
 * is the authority — a malformed or stale webview must not be able to persist anything the runtime
 * would then feed to the MCP spawn chokepoint.
 *
 * Every assert throws a plain `Error` whose message is human-readable, matching `assertEffortSupported`
 * in `../utils`. The handler wraps it in an l10n'd notification.
 */

/** Anchored so a name can never contain a path separator, whitespace or JSON-hostile character. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_SERVER_NAME_LENGTH = 64;

/** POSIX environment-variable name: the form takes a variable NAME, never a token value. */
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The complete key set the form may produce, per transport. Anything else is rejected rather than
 * silently stripped or silently persisted: stripping would discard the user's intent without telling
 * them, and persisting would let an unreviewed key (`bearerToken`, `oauth.clientSecret`, …) reach a
 * file Damocles hands to the runtime.
 */
const STDIO_KEYS = new Set(["type", "command", "args", "env", "cwd"]);
const REMOTE_KEYS = new Set(["type", "url", "headers", "bearerTokenEnv"]);

export function assertValidMcpServerName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("a server name is required");
  }
  if (name !== name.trim()) {
    throw new Error("a server name must not start or end with whitespace");
  }
  if (name.length > MAX_SERVER_NAME_LENGTH) {
    throw new Error(`a server name must be at most ${MAX_SERVER_NAME_LENGTH} characters`);
  }
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error("a server name may only contain letters, digits, '.', '_' and '-'");
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
}

/**
 * As above, and also rejects surrounding whitespace. Applied to `command` only: it is stored verbatim
 * and handed to `spawn`, so `" node "` looks for a binary of that literal name and can never resolve.
 *
 * Deliberately NOT applied to `cwd` or to `args`, which are also verbatim but where padding can be
 * meaningful — a POSIX directory may legitimately end in a space, and trimming them here would
 * silently rewrite a stored definition on an untouched edit (the defect the verbatim rule fixed).
 */
function assertNonEmptyUnpaddedString(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (value !== value.trim()) {
    throw new Error(`${label} must not start or end with whitespace`);
  }
}

/** RFC 9110 token: what a header name may contain before undici rejects the request outright. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&*+.^_|~-]+$/;

function assertStringMap(value: unknown, label: string, keyPattern: RegExp, keyRule: string): void {
  const map = asRecord(value, label);
  for (const [key, entry] of Object.entries(map)) {
    if (key.trim().length === 0) throw new Error(`${label} has an entry with an empty name`);
    // Keys are checked here rather than left to fail at use: an `env` key containing `=` yields a
    // server that cannot spawn, and a header name containing CR/LF surfaces as an opaque undici
    // ERR_INVALID_HTTP_TOKEN at request time instead of something the user can act on.
    if (!keyPattern.test(key)) throw new Error(`${label} entry "${key}" ${keyRule}`);
    // The VALUE is never quoted back: an `env`/`headers` value can be a credential, and this message
    // reaches the panel and the disk-backed output channel.
    if (typeof entry !== "string") throw new Error(`${label} entry "${key}" must be a string`);
  }
}

function assertKnownKeys(config: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) throw new Error(`"${key}" is not a supported server option`);
  }
}

function assertValidStdioConfig(config: Record<string, unknown>): void {
  assertKnownKeys(config, STDIO_KEYS);
  assertNonEmptyUnpaddedString(config["command"], "a command");

  if ("args" in config) {
    const args = config["args"];
    if (!Array.isArray(args)) throw new Error("arguments must be a list");
    if (args.length === 0) throw new Error("arguments must be omitted rather than left empty");
    for (const arg of args) {
      if (typeof arg !== "string" || arg.length === 0) throw new Error("every argument must be a non-empty string");
    }
  }

  if ("env" in config) {
    assertStringMap(config["env"], "the environment", ENV_VAR_NAME_PATTERN, "is not a valid variable name");
    if (Object.keys(config["env"] as object).length === 0) {
      throw new Error("the environment must be omitted rather than left empty");
    }
  }

  if ("cwd" in config) assertNonEmptyString(config["cwd"], "a working directory");
}

function assertValidRemoteConfig(config: Record<string, unknown>): void {
  assertKnownKeys(config, REMOTE_KEYS);
  assertNonEmptyString(config["url"], "a URL");

  let parsed: URL;
  try {
    parsed = new URL(config["url"]);
  } catch {
    // The rejected value is NOT echoed. A URL is a documented credential carrier
    // (`https://user:token@host`, `?access_token=…`), "unparseable" and "holds a secret" are not
    // mutually exclusive — a typo'd scheme on a tokened URL lands here — and this message reaches both
    // a notification and the disk-backed output channel.
    throw new Error("a URL must be absolute and include a scheme, for example https://example.com/mcp");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("a URL must use http or https");
  }

  if ("headers" in config) {
    assertStringMap(config["headers"], "the headers", HEADER_NAME_PATTERN, "is not a valid header name");
    if (Object.keys(config["headers"] as object).length === 0) {
      throw new Error("headers must be omitted rather than left empty");
    }
  }

  if ("bearerTokenEnv" in config) {
    const envVar = config["bearerTokenEnv"];
    if (typeof envVar !== "string" || !ENV_VAR_NAME_PATTERN.test(envVar)) {
      throw new Error("the bearer-token environment variable must be a valid variable name");
    }
  }
}

/**
 * Validate one server definition arriving from the webview. Rejects a raw `bearerToken` before
 * anything else: the form never offers one, so its presence means a malformed or tampered payload,
 * and letting it through would write a live credential into `~/.damocles/mcp.json` in plain text.
 * The token value is never echoed into the error.
 */
export function assertValidMcpServerConfig(raw: unknown): asserts raw is McpServerConfig {
  const config = asRecord(raw, "a server definition");

  if ("bearerToken" in config) {
    throw new Error("a bearer token cannot be stored here; use a bearer-token environment variable instead");
  }

  const type = config["type"];
  if (type === "http" || type === "sse") {
    assertValidRemoteConfig(config);
    return;
  }
  if (type === undefined || type === "stdio") {
    if ("url" in config) throw new Error('a remote server must set its type to "http" or "sse"');
    assertValidStdioConfig(config);
    return;
  }
  throw new Error(`"${String(type)}" is not a supported server type`);
}

/**
 * Whether the edit form can represent `config` losslessly — defined as "the write path would accept it
 * back verbatim", so the two can never drift apart. Anything the form cannot render (a hand-authored
 * `lifecycle`, `oauth`, `debug`, or a raw `bearerToken`) is not editable, because pre-populating a form
 * that silently drops those keys on save would quietly destroy the user's definition.
 *
 * The boolean IS the answer here — there is no failure being swallowed; `assertValidMcpServerConfig`
 * signals "not representable" by throwing, and this is its predicate form.
 */
export function isFormEditableMcpServerConfig(config: unknown): boolean {
  try {
    assertValidMcpServerConfig(config);
    return true;
  } catch {
    return false;
  }
}
