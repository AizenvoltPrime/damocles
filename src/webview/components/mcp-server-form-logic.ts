/**
 * Pure logic behind `McpServerFormDialog.vue` — form state, validation and config assembly.
 *
 * Extracted from the component because nothing in this repo unit-tests a `.vue` script block;
 * keeping the rules here means they are covered by ordinary unit tests.
 *
 * Note this file is NOT type-checked by `npm run typecheck` either: the root `tsconfig.json` excludes
 * `src/webview` entirely, and `tsconfig.webview.json` is not wired to a script. The unit tests are the
 * only thing standing behind this module.
 *
 * The rules mirror `mcp-write-contract` §3/§4 exactly. The extension re-validates and is the source
 * of truth — this layer exists so the user sees an inline error on the offending field instead of a
 * notification arriving after the fact.
 */
import type {
  McpServerConfig,
  McpServerStatusInfo,
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpSseServerConfig,
} from '@shared/types/mcp';

/** Which half of the `McpServerConfig` union the form is editing. */
export type McpFormMode = 'stdio' | 'remote';

/** The remote transport discriminant. `stdio` needs no discriminant — `command` identifies it. */
export type McpRemoteType = 'http' | 'sse';

/**
 * Row identity, minted once per row and never reused.
 *
 * `v-for` needs a key that follows the row rather than its position: keyed by index, deleting a middle
 * row makes Vue re-use the DOM nodes under a different identity, so focus lands in the wrong field and
 * an in-flight IME composition commits into it.
 */
let nextRowId = 0;
function mintRowId(): string {
  return `row-${++nextRowId}`;
}

/** One editable row of an `env` / `headers` map. Kept as a list so rows can be blank while typing. */
export interface McpKeyValueRow {
  id: string;
  key: string;
  value: string;
}

/** One editable argument. Wrapped for the same stable-identity reason as `McpKeyValueRow`. */
export interface McpArgRow {
  id: string;
  value: string;
}

export function createKeyValueRow(key = '', value = ''): McpKeyValueRow {
  return { id: mintRowId(), key, value };
}

export function createArgRow(value = ''): McpArgRow {
  return { id: mintRowId(), value };
}

/** Everything the form binds to. Strings are raw user input; nothing here is trimmed. */
export interface McpServerFormState {
  name: string;
  mode: McpFormMode;
  command: string;
  args: McpArgRow[];
  env: McpKeyValueRow[];
  cwd: string;
  url: string;
  remoteType: McpRemoteType;
  headers: McpKeyValueRow[];
  bearerTokenEnv: string;
}

/** Fields that can carry an inline error. */
export type McpFormField =
  | 'name'
  | 'command'
  | 'env'
  | 'url'
  | 'headers'
  | 'bearerTokenEnv';

/** An inline error as an i18n key plus its interpolation params, so no English lives in this file. */
export interface McpFormFieldError {
  key: string;
  params?: Record<string, string>;
}

export type McpFormErrors = Partial<Record<McpFormField, McpFormFieldError>>;

/** The servers the form checks names against — the merged list the panel already renders. */
export type McpCollisionServer = Pick<McpServerStatusInfo, 'name' | 'source'>;

/** `mcp-write-contract` §3: server names are file-map keys, so they stay boring on purpose. */
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_NAME_LENGTH = 64;

/** `mcp-write-contract` §3: `bearerTokenEnv` is an environment-variable NAME, never a token. */
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** RFC 9110 token — what a header name may contain before undici refuses the request. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&*+.^_|~-]+$/;

/** A blank form: a local stdio server, which is what nearly every MCP server is. */
export function createEmptyFormState(): McpServerFormState {
  return {
    name: '',
    mode: 'stdio',
    command: '',
    args: [],
    env: [],
    cwd: '',
    url: '',
    remoteType: 'http',
    headers: [],
    bearerTokenEnv: '',
  };
}

function recordToRows(record: Record<string, string> | undefined): McpKeyValueRow[] {
  if (!record) return [];
  return Object.entries(record).map(([key, value]) => createKeyValueRow(key, value));
}

/**
 * Populate the form from a stored definition for editing. Only the keys the form owns are read; the
 * extension only ever sends a config whose key set the form can represent, so nothing is dropped.
 */
export function formStateFromConfig(name: string, config: McpServerConfig): McpServerFormState {
  const state = createEmptyFormState();
  state.name = name;
  if ('url' in config) {
    state.mode = 'remote';
    state.url = config.url;
    state.remoteType = config.type;
    state.headers = recordToRows(config.headers);
    state.bearerTokenEnv = config.bearerTokenEnv ?? '';
    return state;
  }
  state.mode = 'stdio';
  state.command = config.command;
  state.args = (config.args ?? []).map((arg) => createArgRow(arg));
  state.env = recordToRows(config.env);
  state.cwd = config.cwd ?? '';
  return state;
}

/** A row the user has not started filling in. Dropped silently; a half-filled row is an error. */
function isBlankRow(row: McpKeyValueRow): boolean {
  return row.key.trim() === '' && row.value.trim() === '';
}

/**
 * Validate the `env` / `headers` rows. A row with a value but no key would be silently discarded by
 * `rowsToRecord`, and a duplicate key would silently overwrite its twin — both are data loss, so
 * both are errors rather than something the form quietly swallows.
 */
function validateRows(
  rows: readonly McpKeyValueRow[],
  missingKeyErrorKey: string,
  duplicateKeyErrorKey: string,
  keyPattern: RegExp,
  invalidKeyErrorKey: string,
): McpFormFieldError | null {
  const seen = new Set<string>();
  for (const row of rows) {
    if (isBlankRow(row)) continue;
    const key = row.key.trim();
    if (key === '') return { key: missingKeyErrorKey };
    // Mirrors the extension's key rules. An `env` key containing `=` produces a server that cannot
    // spawn, and a header name with CR/LF fails inside undici as an opaque ERR_INVALID_HTTP_TOKEN —
    // both far better caught on the field than as a rejected write.
    if (!keyPattern.test(key)) return { key: invalidKeyErrorKey, params: { name: key } };
    if (seen.has(key)) return { key: duplicateKeyErrorKey, params: { name: key } };
    seen.add(key);
  }
  return null;
}

/**
 * Mirror of `mcp-write-contract` §4's collision policy, evaluated against the merged server list the
 * panel already holds:
 *  - a name owned by the workspace `.mcp.json` outranks `~/.damocles/mcp.json`, so writing it would
 *    produce a server the user can never see — rejected;
 *  - a name already in `~/.damocles/mcp.json` would overwrite a different server — rejected;
 *  - a name imported from Claude or Codex is deliberately overridable and produces no error.
 */
function validateNameCollision(
  name: string,
  originalName: string | null,
  servers: readonly McpCollisionServer[],
): McpFormFieldError | null {
  if (originalName !== null && name === originalName) return null;
  const clash = servers.find((server) => server.name === name);
  if (!clash) return null;
  if (clash.source === 'workspace') return { key: 'mcp.form.errors.nameShadowedByWorkspace' };
  if (clash.source === 'damocles') return { key: 'mcp.form.errors.nameExists' };
  return null;
}

function validateName(
  raw: string,
  originalName: string | null,
  servers: readonly McpCollisionServer[],
): McpFormFieldError | null {
  const name = raw.trim();
  if (name === '') return { key: 'mcp.form.errors.nameRequired' };
  if (name.length > MAX_NAME_LENGTH) {
    return { key: 'mcp.form.errors.nameTooLong', params: { max: String(MAX_NAME_LENGTH) } };
  }
  if (!NAME_PATTERN.test(name)) return { key: 'mcp.form.errors.nameInvalid' };
  return validateNameCollision(name, originalName, servers);
}

function validateUrl(raw: string): McpFormFieldError | null {
  const url = raw.trim();
  if (url === '') return { key: 'mcp.form.errors.urlRequired' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { key: 'mcp.form.errors.urlInvalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { key: 'mcp.form.errors.urlProtocol' };
  }
  return null;
}

/**
 * Full form validation. An empty result means the form is submittable; anything else blocks submit,
 * so an invalid definition is never sent to the extension.
 */
export function validateMcpServerForm(
  state: McpServerFormState,
  originalName: string | null,
  servers: readonly McpCollisionServer[],
): McpFormErrors {
  const errors: McpFormErrors = {};

  const nameError = validateName(state.name, originalName, servers);
  if (nameError) errors.name = nameError;

  if (state.mode === 'stdio') {
    if (state.command.trim() === '') errors.command = { key: 'mcp.form.errors.commandRequired' };
    const envError = validateRows(
      state.env,
      'mcp.form.errors.envKeyRequired',
      'mcp.form.errors.envDuplicateKey',
      ENV_VAR_NAME_PATTERN,
      'mcp.form.errors.envKeyInvalid',
    );
    if (envError) errors.env = envError;
    return errors;
  }

  const urlError = validateUrl(state.url);
  if (urlError) errors.url = urlError;
  const headerError = validateRows(
    state.headers,
    'mcp.form.errors.headerKeyRequired',
    'mcp.form.errors.headerDuplicateKey',
    HEADER_NAME_PATTERN,
    'mcp.form.errors.headerKeyInvalid',
  );
  if (headerError) errors.headers = headerError;
  const bearerTokenEnv = state.bearerTokenEnv.trim();
  if (bearerTokenEnv !== '' && !ENV_VAR_NAME_PATTERN.test(bearerTokenEnv)) {
    errors.bearerTokenEnv = { key: 'mcp.form.errors.bearerTokenEnvInvalid' };
  }
  return errors;
}

export function isMcpFormValid(errors: McpFormErrors): boolean {
  return Object.keys(errors).length === 0;
}

/**
 * Mirror of `sanitizeServerName` in `pi-session/mcp/naming.ts`: the server name becomes part of every
 * tool name as `mcp__<prefix>__<tool>`, with non-alphanumerics collapsed to `_`.
 */
function sanitizeServerNameForTools(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48).replace(/_+$/, '') || 'server';
}

/**
 * A name that is legal but whose TOOL prefix collides with an existing server's.
 *
 * `my.server` and `my-server` are two distinct, permitted names that both sanitize to `my_server`, so
 * the second one silently ends up exposing `mcp__my_server_2__*`. Not an error — the config is valid
 * and the servers both work — but the user should not have to discover the numbered prefix by reading
 * the tool list.
 */
export function mcpToolPrefixCollision(
  name: string,
  originalName: string | null,
  servers: readonly McpCollisionServer[],
): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return null;
  const prefix = sanitizeServerNameForTools(trimmed);
  const clash = servers.find(
    (server) =>
      server.name !== trimmed &&
      server.name !== originalName &&
      sanitizeServerNameForTools(server.name) === prefix,
  );
  return clash ? clash.name : null;
}

function rowsToRecord(rows: readonly McpKeyValueRow[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const row of rows) {
    if (isBlankRow(row)) continue;
    record[row.key.trim()] = row.value;
  }
  return record;
}

/**
 * Arguments and `cwd` are stored VERBATIM. Trimming them would silently rewrite stored data on an
 * untouched edit: `"--prefix= "` would come back as `"--prefix="`, and an argument of `"  "` would
 * vanish from the list entirely. An argument and a path can legitimately carry significant
 * whitespace, unlike the identifiers this form does trim (the server name, which the extension
 * rejects when padded, and `bearerTokenEnv`, whose pattern forbids whitespace outright). Reported by
 * mcp-backend, who reproduced both cases against the real validator.
 *
 * Trimming still decides INCLUSION, exactly as `isBlankRow` does for `env`/`headers`: "is there a
 * value here?" is a trimmed question, "what is the value?" is a verbatim one. That is why a
 * whitespace-only `cwd` is omitted rather than sent — the extension requires a non-empty-after-trim
 * working directory, so emitting `"   "` would push a plain typing slip onto the rejection path.
 * An argument is the one exception: the extension accepts any non-empty string, and `"  "` may be a
 * deliberate space argument, so only an untouched (exactly `""`) row is dropped.
 */
function buildStdioConfig(state: McpServerFormState): McpStdioServerConfig {
  const config: McpStdioServerConfig = { command: state.command.trim() };
  const args = state.args.map((arg) => arg.value).filter((arg) => arg !== '');
  if (args.length > 0) config.args = args;
  const env = rowsToRecord(state.env);
  if (Object.keys(env).length > 0) config.env = env;
  if (state.cwd.trim() !== '') config.cwd = state.cwd;
  return config;
}

function buildRemoteConfig(state: McpServerFormState): McpHttpServerConfig | McpSseServerConfig {
  const url = state.url.trim();
  const headers = rowsToRecord(state.headers);
  const bearerTokenEnv = state.bearerTokenEnv.trim();
  const optional: { headers?: Record<string, string>; bearerTokenEnv?: string } = {};
  if (Object.keys(headers).length > 0) optional.headers = headers;
  if (bearerTokenEnv !== '') optional.bearerTokenEnv = bearerTokenEnv;
  return state.remoteType === 'sse'
    ? { type: 'sse', url, ...optional }
    : { type: 'http', url, ...optional };
}

/**
 * Assemble the config the extension receives. Only the keys of `mcp-write-contract` §2 are produced
 * and empty optionals are omitted entirely, so the JSON written to `~/.damocles/mcp.json` stays
 * minimal and the extension's reject-unknown-keys check never trips on our own output.
 *
 * `type` is deliberately omitted for stdio: it is optional on `McpStdioServerConfig`, `command` is
 * what discriminates the union everywhere else in this repo (`coerceServerConfig`), and omitting it
 * keeps the written file in the shape every other MCP tool writes.
 *
 * `bearerToken` is not produced here and has no field in the form — the only token-shaped thing the
 * form accepts is `bearerTokenEnv`, the NAME of an environment variable, so no credential can ever
 * reach `~/.damocles/mcp.json` through this path.
 */
export function buildMcpServerConfig(state: McpServerFormState): McpServerConfig {
  return state.mode === 'stdio' ? buildStdioConfig(state) : buildRemoteConfig(state);
}

/** The trimmed name the config will be stored under. */
export function submittedServerName(state: McpServerFormState): string {
  return state.name.trim();
}

/**
 * Whether the panel may offer Delete for a server, per `mcp-write-contract` §7.1.
 *
 * `readonly === false` is the primary gate and is checked with `===` so an absent `readonly` (the
 * field is optional on `McpServerStatusInfo`) fails closed rather than reading as falsy-editable.
 * Damocles ownership is a second, strictly narrowing condition: the brief forbids editing the
 * workspace `.mcp.json` "in any form", yet `READONLY_BY_SOURCE` marks workspace servers
 * `readonly: false` because Damocles owns that file at the merge layer. Requiring `damocles` can
 * only ever remove affordances, and it makes the UI agree with the extension's backstop, which
 * refuses to mutate any name absent from `~/.damocles/mcp.json`.
 */
export function canDeleteMcpServer(server: McpServerStatusInfo): boolean {
  return server.readonly === false && server.source === 'damocles';
}

/**
 * Whether the panel may offer Edit. Everything Delete requires, plus a stored definition to
 * populate the form from. The extension omits `editableConfig` for any server whose stored config
 * uses keys the form cannot represent, so a config can never be silently rewritten without them.
 */
export function canEditMcpServer(server: McpServerStatusInfo): boolean {
  return canDeleteMcpServer(server) && server.editableConfig !== undefined;
}
