/*
 * Ported from pi-coding-agent/src/extensions/mcp/resources.ts (pi 1.3.0): `list_mcp_resources`,
 * `list_mcp_resource_templates` and `read_mcp_resource`, the names Codex and opencode use. Each takes a
 * `server` argument and reaches every server the caller sees with resources. Listings are pi's JSON;
 * MCP App resources (`ui://` URIs, `profile=mcp-app` HTML) and icons are left out. Reads become text,
 * images, and saved files for other binary content. Server output is untrusted throughout.
 */
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ReadResourceResult } from '@earendil-works/pi-mcp';
import type { McpResourceToolName } from '../../../shared/tool-names';
import type { McpResourceRuleFilter } from '../../permission-handler/mcp-resource-rule';
import type { McpResourceServer, McpToolCallOptions, McpToolSource } from '../mcp/tool-source';
import type { ElicitationUI } from '../mcp/elicitation-handler';
import type { ContentBlock } from '../mcp/types';
import { McpResourceServerGoneError, printableServerName, quotedServerName } from '../mcp/resource-errors';
import { formatSize, limitMcpContent, saveMcpBinaryToTempFile } from '../mcp/content';
import { failureForLog } from '../mcp/connect-failure';
import { isAttachableImageMimeType, isTextMimeType } from '../../../shared/mcp-resource-mime';
import { classifyInlineImage } from '../../../shared/inline-image';
import { abortableTool } from './abortable-tool';
import { log } from '../../logger';

export const LIST_MCP_RESOURCES_TOOL: McpResourceToolName = 'list_mcp_resources';
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL: McpResourceToolName = 'list_mcp_resource_templates';
export const READ_MCP_RESOURCE_TOOL: McpResourceToolName = 'read_mcp_resource';

export interface McpResourceToolDetails {
  server: string;
  tool: McpResourceToolName;
  /** The file holding the full text of a result cut to fit the model's context. */
  fullOutputPath?: string;
}

export interface McpResourceToolsOptions {
  /** The MCP source the tools call; null while the panel has none. */
  source: () => McpToolSource | null;
  /** Per list call, what the settings rules leave out of a list (`PermissionHandler.mcpResourceRuleFilter`). */
  ruleFilter: (toolName: McpResourceToolName) => Promise<McpResourceRuleFilter>;
  /**
   * Per call, the resources this agent's tool lists turn off (`disabledResourceMatcher`): the panel's read
   * live from `damocles.tools.disabled`, a nested agent's frozen at spawn with its `disallowed_tools`.
   */
  disabledResource: () => (server: string, uri: string) => boolean;
  /**
   * A nested agent's resource servers, frozen at spawn. Omitted for the panel, whose tools reach the
   * source's live list. A frozen call passes each server's `serverId` as `expectedServerId`.
   */
  frozenServers?: readonly McpResourceServer[];
  /** A nested agent's elicitation bridge; the panel's tools use the bound `ctx.ui`. */
  elicitationUi?: ElicitationUI;
}

const stringProperty = (description: string) => Type.String({ description });

const listParameters = Type.Object(
  {
    server: Type.Optional(stringProperty('MCP server name. Omit to list every server with resources.')),
    cursor: Type.Optional(stringProperty('Opaque cursor from a previous call with the same server; omit for the first page.')),
  },
  { additionalProperties: false },
);

const readParameters = Type.Object(
  {
    server: stringProperty("MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources."),
    uri: stringProperty('Resource URI to read. Must be one of the URIs returned by list_mcp_resources.'),
  },
  { additionalProperties: false },
);

/** A listed resource or template, or one content of a read, as a server sent it: every field unchecked. */
export interface ServerItem {
  uri?: unknown;
  uriTemplate?: unknown;
  mimeType?: unknown;
  text?: unknown;
  blob?: unknown;
  [key: string]: unknown;
}

/** MCP App user interfaces, which only hosts that render them can use. */
export function isMcpAppResource(item: ServerItem): boolean {
  const uri = typeof item.uri === 'string' ? item.uri : typeof item.uriTemplate === 'string' ? item.uriTemplate : '';
  const mimeType = typeof item.mimeType === 'string' ? item.mimeType : '';
  return uri.startsWith('ui://') || /;\s*profile\s*=\s*"?mcp-app"?/i.test(mimeType);
}

/** A listed item without `_meta` and icons, tagged with its server; an item's own `server` key cannot replace it. */
function listed(server: string, item: ServerItem): Record<string, unknown> {
  const { _meta: _ignoredMeta, icons: _ignoredIcons, server: _ignoredServer, ...rest } = item;
  return { server, ...rest };
}

function asItems(value: unknown): ServerItem[] {
  return Array.isArray(value) ? value.filter((item): item is ServerItem => typeof item === 'object' && item !== null) : [];
}

/**
 * A string argument exactly as sent, or undefined when absent or empty. Not trimmed: the permission gate
 * and the hooks match the server and URI as sent, so the call must use those same strings.
 */
function stringArgument(params: unknown, key: string): string | undefined {
  const value = (params as Record<string, unknown> | undefined)?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value === '' ? undefined : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the rules left out, so the agent knows the list is not the whole story. */
function leftOutNotice(servers: readonly string[], resourceCounts: ReadonlyMap<string, number>): string | undefined {
  const parts: string[] = [];
  if (servers.length > 0) parts.push(`MCP server${servers.length === 1 ? '' : 's'} ${servers.map(printableServerName).join(', ')}`);
  for (const [server, count] of resourceCounts) parts.push(`${count} resource${count === 1 ? '' : 's'} of server ${printableServerName(server)}`);
  return parts.length > 0 ? `[Left out because the user's permission settings cover them: ${parts.join('; ')}]` : undefined;
}

async function jsonResult(
  tool: McpResourceToolName,
  server: string | undefined,
  payload: Record<string, unknown>,
  notice: string | undefined,
): Promise<AgentToolResult<McpResourceToolDetails>> {
  const { content, fullOutputPath } = await limitMcpContent([
    { type: 'text', text: JSON.stringify(payload) },
    ...(notice ? [{ type: 'text' as const, text: notice }] : []),
  ]);
  return { content, details: { server: server ?? '', tool, ...(fullOutputPath ? { fullOutputPath } : {}) } };
}

/**
 * One content of a read: text as text, an image the providers take as an image block, other binary content (an
 * image `classifyInlineImage` refuses included) saved to a file.
 */
async function readContentToBlock(entry: unknown): Promise<ContentBlock> {
  const c = (typeof entry === 'object' && entry !== null ? entry : {}) as ServerItem;
  const uri = typeof c.uri === 'string' ? c.uri : '(no URI)';
  const mimeType = typeof c.mimeType === 'string' ? c.mimeType : undefined;
  if (typeof c.text === 'string') return { type: 'text', text: c.text };
  if (typeof c.blob !== 'string') return { type: 'text', text: `[Resource ${uri} has no content]` };
  if (isAttachableImageMimeType(mimeType)) {
    const image = classifyInlineImage(c.blob, mimeType);
    if (image.ok) return { type: 'image', data: image.data, mimeType: image.mediaType };
  }
  const data = Buffer.from(c.blob, 'base64');
  if (isTextMimeType(mimeType)) return { type: 'text', text: data.toString('utf8') };
  const kind = `${mimeType ?? 'unknown type'}, ${formatSize(data.length)}`;
  try {
    const path = await saveMcpBinaryToTempFile(data);
    return { type: 'text', text: `[Binary resource ${uri} (${kind}) saved to ${path}]` };
  } catch (error) {
    log('[McpResourceTools] saving a binary resource failed: %s', failureForLog(error));
    return { type: 'text', text: `[Binary resource ${uri} (${kind}) could not be saved: ${errorMessage(error)}]` };
  }
}

/**
 * pi labels each content with its URI when a read returns several (a directory, for example). A child
 * this agent's lists turn off is dropped silently, as it is from a list; one the rules cover is counted.
 */
async function readResultToBlocks(
  result: ReadResourceResult,
  turnedOff: (uri: string) => boolean,
  covered: (uri: string) => boolean,
): Promise<{ blocks: ContentBlock[]; leftOut: number }> {
  const offered = (Array.isArray(result.contents) ? result.contents : [] as unknown[]).filter((entry) => {
    const uri = (entry as { uri?: unknown } | null)?.uri;
    return typeof uri !== 'string' || !turnedOff(uri);
  });
  const contents = offered.filter((entry) => {
    const uri = (entry as { uri?: unknown } | null)?.uri;
    return typeof uri !== 'string' || !covered(uri);
  });
  const blocks: ContentBlock[] = [];
  for (const entry of contents) {
    if (contents.length > 1) {
      const uri = (entry as { uri?: unknown } | null)?.uri;
      blocks.push({ type: 'text', text: `${typeof uri === 'string' ? uri : '(no URI)'}:` });
    }
    blocks.push(await readContentToBlock(entry));
  }
  return { blocks, leftOut: offered.length - contents.length };
}

/** The three resource tools over `options.source`, each wrapped in `abortableTool`. */
export function createMcpResourceTools(options: McpResourceToolsOptions): ToolDefinition[] {
  const { source, ruleFilter, disabledResource, frozenServers, elicitationUi: nestedUi } = options;
  const frozen = frozenServers !== undefined;

  const requireSource = (): McpToolSource => {
    const current = source();
    if (!current) throw new Error('MCP is not available in this session');
    return current;
  };

  const serversNow = (): McpResourceServer[] => (frozenServers ? [...frozenServers] : (source()?.resourceServers() ?? []));

  const callOptions = (
    signal: AbortSignal | undefined,
    ctxUi: ElicitationUI | undefined,
    server: McpResourceServer | undefined,
  ): McpToolCallOptions => {
    const elicitationUi = nestedUi ?? ctxUi;
    return {
      ...(signal ? { signal } : {}),
      ...(elicitationUi ? { elicitationUi } : {}),
      ...(frozen && server ? { expectedServerId: server.serverId } : {}),
    };
  };

  /** The frozen entry for a named server; the panel resolves names live in the source. */
  const frozenServer = (name: string): McpResourceServer | undefined => {
    if (!frozenServers) return undefined;
    const server = frozenServers.find((candidate) => candidate.serverName === name);
    if (server) return server;
    const available = frozenServers.map((candidate) => printableServerName(candidate.serverName)).join(', ');
    throw new Error(
      `MCP server ${quotedServerName(name)} is no longer available to this agent: it was not among the servers with resources when the agent started. ` +
        `This is permanent for the rest of this agent's life, so retrying it will fail the same way. ` +
        (available ? `Servers with resources: ${available}.` : 'No server with resources was available when the agent started.'),
    );
  };

  /** A frozen server whose identity is gone says so permanently, as a vanished nested MCP tool does. */
  const permanent = (error: unknown): unknown => {
    if (!frozen || !(error instanceof McpResourceServerGoneError)) return error;
    return new Error(`${error.message}. This is permanent for the rest of this agent's life, so retrying it will fail the same way.`);
  };

  const uiOf = (ctx: { hasUI?: boolean; ui?: unknown } | undefined): ElicitationUI | undefined =>
    ctx?.hasUI ? (ctx.ui as ElicitationUI) : undefined;

  type Page = { items: unknown; nextCursor?: unknown };

  /** One page of one server, or every page of every server the rules leave in. */
  const list = async (
    tool: McpResourceToolName,
    key: 'resources' | 'resourceTemplates',
    params: unknown,
    signal: AbortSignal | undefined,
    ctxUi: ElicitationUI | undefined,
    page: (server: string, cursor: string | undefined, opts: McpToolCallOptions) => Promise<Page>,
    all: (server: string, opts: McpToolCallOptions) => Promise<unknown[]>,
  ): Promise<AgentToolResult<McpResourceToolDetails>> => {
    const serverName = stringArgument(params, 'server');
    const cursor = stringArgument(params, 'cursor');
    const filter = await ruleFilter(tool);
    const turnedOff = disabledResource();
    // URI-scoped entries apply to concrete resources; templates are filtered by server only.
    const denied = (server: string, item: ServerItem): boolean =>
      key === 'resources' && (typeof item.uri !== 'string' || filter.resourceDenied(server, item.uri));
    const deniedCounts = new Map<string, number>();
    const keep = (server: string) => (item: ServerItem): boolean => {
      if (isMcpAppResource(item)) return false;
      if (key === 'resources' && typeof item.uri === 'string' && turnedOff(server, item.uri)) return false;
      if (!denied(server, item)) return true;
      deniedCounts.set(server, (deniedCounts.get(server) ?? 0) + 1);
      return false;
    };

    if (serverName !== undefined) {
      const server = frozenServer(serverName);
      let result: Page;
      try {
        result = await page(serverName, cursor, callOptions(signal, ctxUi, server));
      } catch (error) {
        throw permanent(error);
      }
      const payload = {
        server: serverName,
        [key]: asItems(result.items).filter(keep(serverName)).map((item) => listed(serverName, item)),
        ...(typeof result.nextCursor === 'string' ? { nextCursor: result.nextCursor } : {}),
      };
      return jsonResult(tool, serverName, payload, leftOutNotice([], deniedCounts));
    }
    if (cursor !== undefined) throw new Error('cursor can only be used when a server is specified');

    const candidates = serversNow();
    const covered = candidates.filter((server) => filter.serverCovered(server.serverName)).map((server) => server.serverName);
    const servers = candidates.filter((server) => !covered.includes(server.serverName));
    const results = await Promise.allSettled(servers.map((server) => all(server.serverName, callOptions(signal, ctxUi, server))));
    const items: ServerItem[] = [];
    const errors: { server: string; error: string }[] = [];
    results.forEach((result, index) => {
      const server = servers[index]!.serverName;
      if (result.status === 'fulfilled') {
        items.push(...asItems(result.value).filter(keep(server)).map((item) => listed(server, item)));
      } else {
        log('[McpResourceTools] %s failed for %s: %s', tool, server, failureForLog(result.reason));
        errors.push({ server, error: errorMessage(permanent(result.reason)) });
      }
    });
    return jsonResult(tool, undefined, { [key]: items, ...(errors.length > 0 ? { errors } : {}) }, leftOutNotice(covered, deniedCounts));
  };

  const listResources: ToolDefinition<typeof listParameters, McpResourceToolDetails> = {
    name: LIST_MCP_RESOURCES_TOOL,
    label: LIST_MCP_RESOURCES_TOOL,
    description:
      'Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.',
    parameters: listParameters,
    execute: (_toolCallId, params, signal, _onUpdate, ctx) =>
      list(
        LIST_MCP_RESOURCES_TOOL,
        'resources',
        params,
        signal,
        uiOf(ctx),
        async (server, cursor, opts) => {
          const result = await requireSource().listResourcesPage(server, cursor, opts);
          return { items: result.resources, nextCursor: result.nextCursor };
        },
        (server, opts) => requireSource().listResources(server, opts),
      ),
  };

  const listTemplates: ToolDefinition<typeof listParameters, McpResourceToolDetails> = {
    name: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
    label: LIST_MCP_RESOURCE_TEMPLATES_TOOL,
    description:
      'Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.',
    parameters: listParameters,
    execute: (_toolCallId, params, signal, _onUpdate, ctx) =>
      list(
        LIST_MCP_RESOURCE_TEMPLATES_TOOL,
        'resourceTemplates',
        params,
        signal,
        uiOf(ctx),
        async (server, cursor, opts) => {
          const result = await requireSource().listResourceTemplatesPage(server, cursor, opts);
          return { items: result.resourceTemplates, nextCursor: result.nextCursor };
        },
        (server, opts) => requireSource().listResourceTemplates(server, opts),
      ),
  };

  const readResource: ToolDefinition<typeof readParameters, McpResourceToolDetails> = {
    name: READ_MCP_RESOURCE_TOOL,
    label: READ_MCP_RESOURCE_TOOL,
    description: 'Read a specific resource from an MCP server given the server name and resource URI.',
    parameters: readParameters,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const serverName = stringArgument(params, 'server');
      const uri = stringArgument(params, 'uri');
      if (serverName === undefined) throw new Error('server must be provided');
      if (uri === undefined) throw new Error('uri must be provided');
      const server = frozenServer(serverName);
      const turnedOff = disabledResource();
      if (turnedOff(serverName, uri)) {
        throw new Error(`Resource ${JSON.stringify(uri)} of MCP server ${quotedServerName(serverName)} is turned off for this agent in the user's settings.`);
      }
      let result: ReadResourceResult;
      try {
        result = await requireSource().readResource(serverName, uri, callOptions(signal, uiOf(ctx), server));
      } catch (error) {
        throw permanent(error);
      }
      const filter = await ruleFilter(READ_MCP_RESOURCE_TOOL);
      const { blocks, leftOut } = await readResultToBlocks(
        result,
        (contentUri) => turnedOff(serverName, contentUri),
        (contentUri) => filter.contentCovered(serverName, contentUri, uri),
      );
      const notice = leftOut > 0
        ? `[Left out because the user's permission settings cover them: ${leftOut} content${leftOut === 1 ? '' : 's'} of server ${printableServerName(serverName)}]`
        : undefined;
      const { content, fullOutputPath } = await limitMcpContent([
        ...(blocks.length > 0 || notice ? blocks : [{ type: 'text' as const, text: `Resource ${uri} is empty.` }]),
        ...(notice ? [{ type: 'text' as const, text: notice }] : []),
      ]);
      return {
        content,
        details: { server: serverName, tool: READ_MCP_RESOURCE_TOOL, ...(fullOutputPath ? { fullOutputPath } : {}) },
      };
    },
  };

  return [listResources, listTemplates, readResource].map((tool) => abortableTool(tool as unknown as ToolDefinition));
}
