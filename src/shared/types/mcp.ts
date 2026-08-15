/** OAuth configuration for a remote MCP server (US-014.5). */
export interface McpOAuthConfig {
  /** OAuth grant type (defaults to authorization_code). */
  grantType?: "authorization_code" | "client_credentials";
  /** Pre-registered client ID (dynamic registration used if absent). */
  clientId?: string;
  /** Client secret for confidential clients. */
  clientSecret?: string;
  /** Requested OAuth scopes. */
  scope?: string;
  /** Exact authorization-code redirect URI for pre-registered clients. */
  redirectUri?: string;
  /** Client display name for dynamic registration. */
  clientName?: string;
  /** Client homepage URI for dynamic registration. */
  clientUri?: string;
}

/** Fields shared by every transport, controlling lifecycle and resource exposure (US-014.2). */
interface McpServerCommonConfig {
  /** eager (default) connects at MCP-client init; lazy connects on first use; keep-alive auto-reconnects. */
  lifecycle?: "eager" | "lazy" | "keep-alive";
  /** Idle-shutdown timeout in minutes (non-keep-alive only); overrides the global default. */
  idleTimeout?: number;
  /** When false, the server's resources are not exposed as get_* tools. */
  exposeResources?: boolean;
}

export interface McpStdioServerConfig extends McpServerCommonConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Inherit the child's stderr instead of discarding it. */
  debug?: boolean;
}

interface McpRemoteServerConfig extends McpServerCommonConfig {
  url: string;
  headers?: Record<string, string>;
  /** 'oauth' | 'bearer' | false; auto-detected from the URL when unset. */
  auth?: "oauth" | "bearer" | false;
  /** OAuth settings, or false to disable OAuth for this server. */
  oauth?: McpOAuthConfig | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
}

export interface McpSseServerConfig extends McpRemoteServerConfig {
  type: "sse";
}

export interface McpHttpServerConfig extends McpRemoteServerConfig {
  type: "http";
}

export type McpServerConfig = McpStdioServerConfig | McpSseServerConfig | McpHttpServerConfig;

/**
 * Where a merged server's definition came from. The single declaration of this union: `readonly` is
 * derived from it in one place (`mcp-config-import.READONLY_BY_SOURCE`), and adding a member without
 * deciding its editability fails to compile there.
 *
 * `workspace` is the project `.mcp.json` and `damocles` the user-global `~/.damocles/mcp.json` — the
 * two Damocles owns. `claude` (Claude Code/Desktop, US-014.2) and `codex` (`~/.codex/config.toml`)
 * belong to other tools and are imported read-only.
 */
export type McpServerSource = "workspace" | "damocles" | "claude" | "codex";

/**
 * A config file that exists but could not be used, so its servers are missing from the list.
 *
 * The location is numbers, never a prose fragment: the parser's own message quotes the text it choked
 * on — possibly the line holding a credential — and this reaches both the disk-backed output channel
 * and the webview. Numbers also leave the wording to the webview, so the message gets translated.
 *
 * `line` is 1-based; null when the parser gave no position, and always null for `unreadable`.
 */
export interface McpConfigError {
  /** Absolute, for opening in the editor. */
  path: string;
  /**
   * The same path with the home directory collapsed to `~`, for rendering. These panels get
   * screenshotted into bug reports, and the absolute form carries the OS username.
   */
  displayPath: string;
  kind: "parse" | "unreadable";
  line: number | null;
  column: number | null;
}

/**
 * Why a write to `~/.damocles/mcp.json` was refused, in a form the webview can translate.
 *
 * Only outcomes the form cannot predict are enumerated. It mirrors every syntactic rule and reports
 * those inline, so a syntactic rejection arriving here means a stale or tampered payload — those
 * collapse into `invalidDefinition` rather than growing translations a working UI never shows.
 * `nameExists`/`nameMissing` are genuinely unpredictable: the extension checks the RAW file, which
 * holds hand-authored entries the merged list has dropped.
 */
export type McpWriteErrorCode =
  | "nameExists"
  | "nameMissing"
  | "nameShadowed"
  | "fileUnparseable"
  | "fileNotObject"
  | "fileServersNotObject"
  | "fileUnreadable"
  | "writeFailed"
  | "invalidDefinition";

/** A refused write. `params` carries only server names and validator text — never a config value. */
export interface McpWriteErrorInfo {
  code: McpWriteErrorCode;
  params?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
  };
}

export interface McpServerStatusInfo {
  name: string;
  displayName?: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "idle";
  enabled: boolean;
  error?: string;
  serverInfo?: {
    name: string;
    version: string;
  };
  tools?: McpToolInfo[];
  /**
   * Where this server's definition came from: `workspace` for the project `.mcp.json`, `damocles` for
   * the user-global `~/.damocles/mcp.json`, `claude` for the read-only Claude Code/Desktop imports
   * (US-014.2), and `codex` for the read-only `~/.codex/config.toml` import. Later sources in that list
   * are the ones Damocles does not own.
   */
  source?: McpServerSource;
  /** True for imported servers the user cannot edit in Damocles (`claude` and `codex`). */
  readonly?: boolean;
  /**
   * The stored definition, sent ONLY for `damocles`-sourced servers whose config the edit form can
   * represent losslessly — i.e. exactly those the write path would accept back verbatim. Absent means
   * the UI must not offer Edit, because saving would silently drop whatever it could not render.
   *
   * **This field carries secrets.** `env` and `headers` hold arbitrary values and are the usual home
   * for an MCP token, so a `damocles` server's plaintext credentials are serialised to the webview and
   * held in the Pinia store. They are not persisted to `setState`, and the imported `claude`/`codex`
   * configs — the likeliest home for another tool's keys — are never sent at all because of the
   * `damocles` gate. Anything added downstream of this field must assume it may hold a live credential.
   */
  editableConfig?: McpServerConfig;
  /** True when a workspace `.mcp.json` server is withheld because the workspace is untrusted (M3/US-022). */
  untrusted?: boolean;
  /** True when this server uses OAuth (definition has a URL and auth is not disabled). */
  supportsOAuth?: boolean;
}
