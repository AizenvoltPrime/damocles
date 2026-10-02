import type { McpServerConfig, McpServerErrorInfo } from "../../../../shared/types/mcp";

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
const STDIO_KEYS = new Set(["type", "command", "args", "env", "cwd", "description", "timeout", "enabled"]);
const REMOTE_KEYS = new Set(["type", "url", "headers", "bearerTokenEnv", "description", "timeout", "enabled", "oauth"]);
/** The OAuth keys the form edits. `clientSecret` in particular never comes from the form. */
const FORM_OAUTH_KEYS = new Set(["clientName", "authServerMetadataUrl", "callbackUrl", "callbackPort"]);

export const SSE_UNSUPPORTED_MESSAGE = "legacy SSE transport is not supported; use the server's streamable HTTP URL";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Ported from pi-coding-agent/src/core/mcp-servers.ts `isLoopbackRedirectUri`. */
export function isLoopbackRedirectUri(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && url.search === "" && url.hash === "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === "string");
}

/** Ported from pi-coding-agent/src/core/mcp-servers.ts `validateOAuth`; Damocles adds `grantType` and `clientUri`. */
function validateOAuth(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "oauth must be an object";
  if (value["clientId"] !== undefined && typeof value["clientId"] !== "string") return "oauth.clientId must be a string";
  if (value["clientSecret"] !== undefined && typeof value["clientSecret"] !== "string") {
    return "oauth.clientSecret must be a string";
  }
  const port = value["callbackPort"];
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
    return "oauth.callbackPort must be a port number";
  }
  const callbackUrl = value["callbackUrl"];
  if (callbackUrl !== undefined) {
    if (typeof callbackUrl !== "string" || !isLoopbackRedirectUri(callbackUrl)) {
      return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
    }
    const urlPort = new URL(callbackUrl).port;
    if (urlPort && port !== undefined && Number(urlPort) !== port) {
      return "oauth.callbackUrl and oauth.callbackPort name different ports";
    }
  }
  if (value["scope"] !== undefined && typeof value["scope"] !== "string") return "oauth.scope must be a string";
  const clientName = value["clientName"];
  if (clientName !== undefined && (typeof clientName !== "string" || !clientName.trim())) {
    return "oauth.clientName must be a non-empty string";
  }
  const metadataUrl = value["authServerMetadataUrl"];
  if (metadataUrl !== undefined) {
    const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
    if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) {
      return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
    }
  }
  const grantType = value["grantType"];
  if (grantType !== undefined && grantType !== "authorization_code" && grantType !== "client_credentials") {
    return 'oauth.grantType must be "authorization_code" or "client_credentials"';
  }
  if (value["clientUri"] !== undefined && typeof value["clientUri"] !== "string") return "oauth.clientUri must be a string";
  return undefined;
}

/** pi's exposure values plus its `codemode-deferred` alias (`pi-coding-agent/src/core/mcp-servers.ts`). */
const MCP_EXPOSURES: readonly string[] = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"];
const EXPOSURE_LIST = MCP_EXPOSURES.map(value => `"${value}"`).join(", ");

function isExposure(value: unknown): boolean {
  return typeof value === "string" && MCP_EXPOSURES.includes(value);
}

/** A server definition read from a config file, or why it cannot be used. */
export type McpServerEntryValidation =
  | { ok: true; config: McpServerConfig }
  | { ok: false; error: string; errorInfo: McpServerErrorInfo };

function invalid(detail: string): McpServerEntryValidation {
  return { ok: false, error: detail, errorInfo: { code: "invalidConfig", params: { detail } } };
}

/**
 * Validate one `mcpServers` entry from any source, porting pi's `validateMcpServerConfig`
 * (`pi-coding-agent/src/core/mcp-servers.ts`). pi's server-name rule is not applied: names imported
 * from other tools have always been accepted, and tool names sanitize them. Messages name fields only,
 * never a value. Returns the entry unchanged, so `isFormEditableMcpServerConfig` sees what the file holds.
 */
export function validateMcpServerEntry(raw: Record<string, unknown>): McpServerEntryValidation {
  const { type, exposure, enabled, timeout, toolExposure, description } = raw;
  if (exposure !== undefined && !isExposure(exposure)) return invalid(`exposure must be one of ${EXPOSURE_LIST}`);
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure)) return invalid("toolExposure must map tool names to exposures");
    for (const [tool, value] of Object.entries(toolExposure)) {
      if (!isExposure(value)) return invalid(`toolExposure "${tool}" must be one of ${EXPOSURE_LIST}`);
    }
  }
  if (enabled !== undefined && typeof enabled !== "boolean") return invalid("enabled must be a boolean");
  if (description !== undefined && typeof description !== "string") return invalid("description must be a string");
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
    return invalid("timeout must be a positive number of seconds");
  }
  if (type === "sse") {
    return { ok: false, error: SSE_UNSUPPORTED_MESSAGE, errorInfo: { code: "sseUnsupported" } };
  }

  const url = raw["url"];
  if (typeof url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return invalid("url must be an http or https URL");
    if (raw["headers"] !== undefined && !isStringRecord(raw["headers"])) return invalid("headers must map names to strings");
    if (raw["oauth"] !== false) {
      const oauthError = validateOAuth(raw["oauth"]);
      if (oauthError) return invalid(oauthError);
    }
    const auth = raw["auth"];
    if (isRecord(auth) && "provider" in auth) {
      return {
        ok: false,
        error: "auth.provider is not supported; sign in with OAuth or set a header or bearerTokenEnv instead",
        errorInfo: { code: "authProviderUnsupported" },
      };
    }
    if (auth !== undefined && auth !== "oauth" && auth !== "bearer" && auth !== false) {
      return invalid('auth must be "oauth", "bearer" or false');
    }
    if (raw["bearerToken"] !== undefined && typeof raw["bearerToken"] !== "string") return invalid("bearerToken must be a string");
    if (raw["bearerTokenEnv"] !== undefined && typeof raw["bearerTokenEnv"] !== "string") {
      return invalid("bearerTokenEnv must be a string");
    }
    return { ok: true, config: raw as unknown as McpServerConfig };
  }
  if (typeof raw["command"] === "string" && (type === undefined || type === "stdio")) {
    const args = raw["args"];
    if (args !== undefined && !(Array.isArray(args) && args.every(arg => typeof arg === "string"))) {
      return invalid("args must be an array of strings");
    }
    if (raw["env"] !== undefined && !isStringRecord(raw["env"])) return invalid("env must map names to strings");
    if (raw["cwd"] !== undefined && typeof raw["cwd"] !== "string") return invalid("cwd must be a string");
    return { ok: true, config: raw as unknown as McpServerConfig };
  }
  return invalid('needs either "command" (stdio) or "url" (streamable HTTP)');
}

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

/**
 * The fields both transports share. A description must be omitted rather than left blank, like the
 * other optional fields; it is otherwise stored verbatim.
 */
function assertValidCommonFields(config: Record<string, unknown>): void {
  if ("description" in config) assertNonEmptyString(config["description"], "a description");
  if ("timeout" in config) {
    const timeout = config["timeout"];
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      throw new Error("timeout must be a positive number of seconds");
    }
  }
  if ("enabled" in config && typeof config["enabled"] !== "boolean") throw new Error("enabled must be a boolean");
}

function assertValidStdioConfig(config: Record<string, unknown>): void {
  assertKnownKeys(config, STDIO_KEYS);
  assertNonEmptyUnpaddedString(config["command"], "a command");
  assertValidCommonFields(config);

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

  assertValidCommonFields(config);

  if ("oauth" in config) {
    const oauth = asRecord(config["oauth"], "oauth");
    if (Object.keys(oauth).length === 0) throw new Error("oauth must be omitted rather than left empty");
    for (const key of Object.keys(oauth)) {
      if (!FORM_OAUTH_KEYS.has(key)) throw new Error(`"oauth.${key}" is not a supported server option`);
    }
    const oauthError = validateOAuth(oauth);
    if (oauthError) throw new Error(oauthError);
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
  if (type === "sse") throw new Error(SSE_UNSUPPORTED_MESSAGE);
  // A `url` with no `type` is a streamable HTTP server, as pi and the read path take it.
  if (type === "http" || type === "streamable-http" || (type === undefined && "url" in config && !("command" in config))) {
    assertValidRemoteConfig(config);
    return;
  }
  if (type === undefined || type === "stdio") {
    if ("url" in config) throw new Error('a remote server must set its type to "http" or "streamable-http"');
    assertValidStdioConfig(config);
    return;
  }
  throw new Error("type is not a supported server type");
}

/**
 * Whether the edit form can represent `config` losslessly — defined as "the write path would accept it
 * back verbatim", so the two can never drift apart. Anything the form cannot render (a hand-authored
 * `lifecycle`, `debug`, an `oauth` key beyond the four the form edits, or a raw `bearerToken`) is not editable, because pre-populating a form
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
