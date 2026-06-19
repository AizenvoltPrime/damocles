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
  /** 'workspace' for .mcp.json entries, 'claude' for read-only Claude Code/Desktop imports (US-014.2). */
  source?: "workspace" | "claude";
  /** True for imported servers the user cannot edit in Damocles. */
  readonly?: boolean;
  /** True when a workspace `.mcp.json` server is withheld because the workspace is untrusted (M3/US-022). */
  untrusted?: boolean;
}
