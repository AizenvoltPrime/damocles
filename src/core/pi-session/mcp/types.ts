import type { TextContent, ImageContent } from '@earendil-works/pi-ai';
import type {
  McpOAuthConfig,
  McpServerConfig,
  McpToolExposure,
  McpToolExposureSetting,
  McpToolExposureSource,
} from '../../../shared/types/mcp';

/** A tool advertised by an MCP server (`tools/list`). */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: McpToolAnnotations;
}

/** Standard MCP tool behavior hints. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A resource advertised by an MCP server (`resources/list`). */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** Content block returned by `tools/call` / `resources/read` over the wire. */
export interface McpContent {
  type: 'text' | 'image' | 'audio' | 'resource' | 'resource_link';
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
  uri?: string;
  name?: string;
  description?: string;
}

/** pi content block (the inference layer's text/image union). */
export type ContentBlock = TextContent | ImageContent;

/** Flat, all-optional runtime view of a server config used by the connection layer. */
export interface McpServerDefinition {
  type?: 'stdio' | 'http' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  debug?: boolean;
  url?: string;
  headers?: Record<string, string>;
  auth?: 'oauth' | 'bearer' | false;
  oauth?: McpOAuthConfig | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  lifecycle?: 'eager' | 'lazy' | 'keep-alive';
  idleTimeout?: number;
  exposeResources?: boolean;
  description?: string;
  /** Seconds. */
  timeout?: number;
  exposure?: McpToolExposure;
  toolExposure?: Record<string, McpToolExposure>;
}

/**
 * One enabled server as the host hands it to an MCP manager: the config plus what its values may do.
 * `valueFormat` picks the expansion rules (pi's `resolveConfigValue` or the legacy interpolation),
 * `folderScoped` and `trusted` gate `!command` values for files a repository could have authored.
 */
export interface McpServerSpec {
  config: McpServerConfig;
  valueFormat: 'pi' | 'legacy';
  folderScoped: boolean;
  trusted: boolean;
}

/** Collapse the shared discriminated-union config into the flat connection view. */
export function normalizeServerConfig(config: McpServerConfig): McpServerDefinition {
  return { ...config };
}

/**
 * Handler for an `elicitation/create` request (form-only in v1, US-014.7). Receives the raw
 * request params and the originating server name; returns the MCP elicitation response.
 */
export type McpElicitationHandler = (
  params: unknown,
  serverName: string,
) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>;

/**
 * A single pi-facing MCP tool, resolved from a server's `tools/list` or `resources/list`. `piName` is
 * what the model and the permission gate see; ToolSearch groups by `serverName`, never by parsing it.
 */
export interface McpToolDescriptor {
  piName: string;
  /** The server's name in its config file. */
  serverName: string;
  /**
   * Opaque identity of the serving manager plus server name. A `piName` can pass to a different
   * server when names move, so a frozen snapshot compares this, never `piName` or `serverName`.
   */
  serverId: string;
  kind: 'tool' | 'resource';
  /** The server's own tool name (kind='tool'), or `get_<slug>` (kind='resource'). */
  rawToolName: string;
  /** Resource URI to read (kind='resource'). */
  resourceUri?: string;
  description: string;
  /** The server's ToolSearch menu line: control characters stripped, at most 120 characters. */
  serverDescription?: string;
  /** JSON Schema for parameters (kind='tool'); resources take no parameters. */
  inputSchema?: unknown;
  readOnly: boolean;
  /** Effective exposure: `off` is never eligible, `deferred` waits for ToolSearch, `direct` is active from the first turn. */
  exposure: McpToolExposureSetting;
  exposureSource: McpToolExposureSource;
  /** The server config's value alone; `exposure` overlays `damocles.mcp.toolExposure` on it. */
  configExposure: McpToolExposureSetting;
}
