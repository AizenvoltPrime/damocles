import { Type } from 'typebox';
import type { ToolDefinition, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiCodingAgentModule } from '../pi-loader';
import type { McpClientManager } from '../mcp/mcp-client-manager';
import type { McpToolDescriptor } from '../mcp/types';
import { transformMcpContent } from '../mcp/content';
import { abortableTool } from './browser-tools';
import { log } from '../../logger';

interface McpToolDetails {
  isError: boolean;
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build one pi tool for an MCP tool/resource descriptor. The raw MCP JSON Schema is wrapped with
 * `Type.Unsafe` (pi's validator coerces it); `execute` lazily connects + calls the server with the pi
 * `AbortSignal` (real cancellation) and converts the result to pi blocks. Wrapped with `abortableTool`
 * so the pi side also unblocks instantly on abort. Never throws — errors return a structured result.
 */
export function buildMcpPiTool(
  pi: PiCodingAgentModule,
  descriptor: McpToolDescriptor,
  manager: McpClientManager,
): ToolDefinition {
  const rawSchema = isSchemaObject(descriptor.inputSchema)
    ? descriptor.inputSchema
    : { type: 'object', properties: {} };
  const parameters = Type.Unsafe<Record<string, unknown>>(rawSchema);

  const tool = pi.defineTool<typeof parameters, McpToolDetails | undefined>({
    name: descriptor.piName,
    label: descriptor.originalName,
    description: descriptor.description || `MCP tool ${descriptor.originalName}`,
    parameters,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<McpToolDetails | undefined>> => {
      try {
        const result = await manager.callTool(
          descriptor.piName,
          (params ?? {}) as Record<string, unknown>,
          {
            ...(signal ? { signal } : {}),
            ...(ctx?.ui ? { elicitationUi: ctx.ui } : {}),
          },
        );
        const content = transformMcpContent(result.content);
        return {
          content: content.length > 0 ? content : [{ type: 'text', text: '(no content)' }],
          details: result.isError ? { isError: true } : undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('[McpTools] %s failed: %O', descriptor.piName, err);
        return {
          content: [{ type: 'text', text: `MCP tool "${descriptor.piName}" failed: ${message}` }],
          details: { isError: true },
        };
      }
    },
  });

  return abortableTool(tool);
}

/**
 * Registers MCP tools into the shared Damocles extension's live `pi` (US-014.3). `registerAll` runs
 * inside the extension factory on every runtime reload (fresh `pi` → fresh registry), so the cached
 * tools survive reloads. `syncRegistration` is the mid-session top-up: when a server connects or fires
 * `list_changed`, newly-discovered tools are registered on the captured `pi` (pi has no `unregisterTool`,
 * so removed tools are simply excluded from the per-session active set).
 *
 * Limitation (M6): because pi exposes no unregister/replace, a tool re-advertised under the SAME name
 * with a CHANGED `inputSchema` keeps its first-registered schema for the session's lifetime — routing
 * still works, but the model sees the original parameter shape until the session is restarted.
 */
export class McpToolRegistrar {
  private readonly pi: PiCodingAgentModule;
  private readonly manager: McpClientManager;
  private livePi: ExtensionAPI | null = null;
  private registered = new Set<string>();

  constructor(pi: PiCodingAgentModule, manager: McpClientManager) {
    this.pi = pi;
    this.manager = manager;
  }

  /** Called inside the extension factory body on each run. A reload mints a fresh `pi`/registry. */
  registerAll(extensionApi: ExtensionAPI): void {
    this.livePi = extensionApi;
    this.registered.clear();
    for (const descriptor of this.manager.getAllToolDescriptors()) {
      this.registerOne(extensionApi, descriptor);
    }
  }

  /** Register any descriptors not yet registered on the captured `pi` (cold connect / list_changed). */
  syncRegistration(): void {
    if (!this.livePi) return;
    for (const descriptor of this.manager.getAllToolDescriptors()) {
      if (!this.registered.has(descriptor.piName)) {
        this.registerOne(this.livePi, descriptor);
      }
    }
  }

  private registerOne(extensionApi: ExtensionAPI, descriptor: McpToolDescriptor): void {
    if (this.registered.has(descriptor.piName)) return;
    try {
      extensionApi.registerTool(buildMcpPiTool(this.pi, descriptor, this.manager));
      this.registered.add(descriptor.piName);
    } catch (err) {
      log('[McpToolRegistrar] failed to register %s: %O', descriptor.piName, err);
    }
  }
}
