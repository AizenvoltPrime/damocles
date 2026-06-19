import type { TextContent, ImageContent } from '@earendil-works/pi-ai';
import type { McpOAuthConfig, McpServerConfig } from '../../../shared/types/mcp';

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
  type?: 'stdio' | 'sse' | 'http';
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
 * A single pi-facing MCP tool, resolved from a server's `tools/list` or `resources/list`.
 * The `piName` is what the model and the permission gate see (`mcp__{server}__{tool}`).
 */
export interface McpToolDescriptor {
  piName: string;
  serverName: string;
  kind: 'tool' | 'resource';
  /** Original MCP tool name (kind='tool'). */
  originalName: string;
  /** Resource URI to read (kind='resource'). */
  resourceUri?: string;
  description: string;
  /** JSON Schema for parameters (kind='tool'); resources take no parameters. */
  inputSchema?: unknown;
  readOnly: boolean;
}
