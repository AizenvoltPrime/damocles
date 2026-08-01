import { Type } from 'typebox';
import type { ToolDefinition, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiCodingAgentModule } from '../pi-loader';
import type { McpClientManager } from '../mcp/mcp-client-manager';
import type { McpToolDescriptor } from '../mcp/types';
import type { ElicitationUI } from '../mcp/elicitation-handler';
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
 *
 * `opts.elicitationUi` is the NESTED route: a subagent/team-agent session never binds the panel's
 * extension UI, so its elicitation bridge has to be handed in explicitly at spawn. Omit it for the
 * panel's own tools, which resolve the bound `ctx.ui` instead.
 *
 * `opts.frozen` says which of the two callers this is, and it changes only the wording of one failure
 * (see the catch below). The panel's registrar leaves it off; `buildNestedMcpToolset` sets it.
 */
export function buildMcpPiTool(
  pi: PiCodingAgentModule,
  descriptor: McpToolDescriptor,
  manager: McpClientManager,
  opts?: { elicitationUi?: ElicitationUI; frozen?: boolean },
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
      // `ctx.ui` is TRUTHY EVEN WHEN THERE IS NO UI: pi's runner returns a getter that falls back to
      // `noOpUIContext` for any session that never called `bindExtensions` — which is every nested
      // session. That no-op's `select` resolves `undefined`, which `runForm` reads as a user cancel, so
      // the server was told "cancelled" and the model was told nothing at all. `ctx.hasUI` is the ONLY
      // correct predicate here. Never `ctx.ui ? …`, never `ctx.ui !== undefined`.
      //
      // And the key must be OMITTED, not set to `undefined`: `callTool` decides whether to push onto
      // `activeCallUis` by KEY PRESENCE (`opts.elicitationUi ? …`), and pushing a no-op is what strands
      // a server's elicitation on a dead bridge.
      const elicitationUi = opts?.elicitationUi ?? (ctx?.hasUI ? ctx.ui : undefined);
      try {
        const result = await manager.callTool(
          descriptor.piName,
          (params ?? {}) as Record<string, unknown>,
          {
            ...(signal ? { signal } : {}),
            ...(elicitationUi ? { elicitationUi } : {}),
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
        // `callTool` throws two shapes of "the tool is gone" — the descriptor was already absent
        // (mcp-client-manager.ts:567) or a reconcile removed it while `ensureConnected` was awaited
        // (line 574). Both are detected by asking the manager for the descriptor rather than by
        // matching the message text: one check, no coupling to wording.
        //
        // Whether that is PERMANENT depends on which caller built this tool, and getting it wrong is a
        // real cost in both directions. For a frozen nested snapshot it is permanent — the agent's
        // descriptor set never refreshes, so a retry loop against a vanished tool is the worst outcome
        // the freeze can produce, and the text has to stop it. For the PANEL it is not: the pi tool
        // stays registered, `rebuildDescriptors` re-adds the descriptor when the server returns, and
        // `callTool` resolves live — so telling a user who toggled a server off and on that a working
        // capability is permanently dead, in wording engineered to prevent retries, is simply false.
        const gone = manager.getToolDescriptor(descriptor.piName) === undefined;
        const text = !gone
          ? `MCP tool "${descriptor.piName}" failed: ${message}`
          : opts?.frozen
            ? `MCP tool "${descriptor.piName}" is no longer available: its server stopped advertising it. ` +
              `This is permanent for the rest of this agent's life — retrying it will fail the same way. ` +
              `Use a different tool or report the missing capability. (${message})`
            : `MCP tool "${descriptor.piName}" is not currently available: its server stopped advertising it. ` +
              `It may return if the server reconnects. (${message})`;
        return {
          content: [{ type: 'text', text }],
          details: { isError: true },
        };
      }
    },
  });

  return abortableTool(tool);
}

/**
 * The MCP tool set granted to ONE nested (subagent / team-agent) session, frozen at spawn.
 *
 * Nested sessions build their own pi services and never bind the shared Damocles extension factory,
 * so the MCP registrar never runs for their registry (a deliberate exemption — see `docs/invariants.md`).
 * They receive MCP as plain `customTools` instead, and every downstream derivation — the `tools:`
 * allowlist, the customTool definitions, the deferred baseline, the gate's read-only classifier and the
 * nested ToolSearch blurbs — comes out of THIS one object.
 */
export interface NestedMcpToolset {
  /** pi names, post-filter, order-stable (descriptor order). */
  readonly names: readonly string[];
  /** One definition per name, SAME ORDER. Set-equal to `names` by construction. */
  readonly tools: readonly ToolDefinition[];
  /**
   * Gate parity (brief §3.5) — a CLASSIFIER (auto-allow vs `canUseTool`), NOT a grant filter.
   *
   * A property holding a closure, not a method: every consumer DETACHES it (`isMcpReadOnly:
   * mcp.isReadOnly`), so a method declaration would advertise a `this` binding no caller preserves —
   * type-checking an implementation that would break the moment one used `this`.
   */
  readonly isReadOnly: (piName: string) => boolean;
  /** Blurb source for the nested ToolSearch inventory (never read back off pi's registry). */
  readonly descriptions: ReadonlyMap<string, string>;
}

export interface NestedMcpToolsetOptions {
  /**
   * Panel eligibility — pass `new Set(fullActiveToolNames())`. That already carries the
   * `damocles.mcp.enabled` master switch AND subtracts `damocles.tools.disabled` (`tool-status.ts:65`),
   * so there is deliberately no second gate here: a duplicate gate is a gate that drifts.
   */
  eligible: ReadonlySet<string>;
  /** The agent's `disallowed_tools`, post-`mapName`. Exact-case, exact-name (agent-toolset.ts G1). */
  disallowed?: ReadonlySet<string>;
  /**
   * The elicitation bridge every tool in this snapshot calls the server with. A nested session never
   * binds the panel's `ExtensionUIContext`, so without this an `elicitation/create` mid-call has no
   * surface to render on and the server is answered `cancel`. Supply
   * `WebviewExtensionUIContext.forAgent(...)` so the prompt renders in the PARENT panel, attributed to
   * this agent. Omitted ⇒ the nested tools carry no UI and elicitation declines, which is the honest
   * degradation, not a silent cancel.
   */
  elicitationUi?: ElicitationUI;
}

/**
 * For callers with no MCP manager (MCP never initialized). `isReadOnly` is always false.
 *
 * ONE object shared by every no-MCP spawn in the process, so its emptiness has to be real rather than
 * conventional: `Object.freeze` is shallow, and a frozen wrapper around a live `[]` would let any
 * caller's `push` reach every other spawn. The arrays and the map are frozen too.
 */
export const EMPTY_NESTED_MCP_TOOLSET: NestedMcpToolset = Object.freeze({
  names: Object.freeze([]) as readonly string[],
  tools: Object.freeze([]) as readonly ToolDefinition[],
  isReadOnly: () => false,
  descriptions: new Map<string, string>() as ReadonlyMap<string, string>,
});

/**
 * Build the frozen per-spawn MCP snapshot for one nested session.
 *
 * THREE properties this function exists to guarantee:
 *  - **One read.** `getAllToolDescriptors()` is called exactly ONCE and all four fields are derived
 *    from that single array in one pass. Three separate live reads inside one spawn is precisely the
 *    divergence that let team agents pass `mcp__*` names into a registry with no matching definitions,
 *    where pi dropped them silently. What ToolSearch advertises is what the session can load, by
 *    construction rather than by agreement.
 *  - **Frozen.** The snapshot is taken at spawn and never refreshed: a server that connects later
 *    reaches the NEXT spawned agent, never this one. Determinism for the agent's whole life; the cost
 *    is stated honestly in the "no longer available" text above. Note this freezes the DESCRIPTOR SET,
 *    not connectivity — a server still connecting but with cached descriptors is in here and callable,
 *    because `callTool` awaits `ensureConnected`.
 *  - **`isReadOnly` classifies, it does not filter.** There is no read-only grant filter (brief §3.4);
 *    this only decides auto-allow vs. routing to `canUseTool`, giving nested sessions the parity the
 *    panel already has. Unknown name ⇒ `false`, i.e. fail-closed to "ask the user".
 */
export function buildNestedMcpToolset(
  pi: PiCodingAgentModule,
  manager: McpClientManager | null,
  opts: NestedMcpToolsetOptions,
): NestedMcpToolset {
  if (manager === null) return EMPTY_NESTED_MCP_TOOLSET;

  const names: string[] = [];
  const tools: ToolDefinition[] = [];
  const descriptions = new Map<string, string>();
  // Closure-private, never exposed: that is what makes the classification frozen. Built from the
  // snapshot below, never re-read from the manager.
  const readOnlyNames = new Set<string>();

  for (const descriptor of manager.getAllToolDescriptors()) {
    if (!opts.eligible.has(descriptor.piName)) continue;
    if (opts.disallowed?.has(descriptor.piName)) continue;
    names.push(descriptor.piName);
    // Already `abortableTool`-wrapped inside `buildMcpPiTool` — do not wrap again. `frozen: true` is
    // what earns these tools the permanent-failure wording: this set never refreshes.
    tools.push(
      buildMcpPiTool(pi, descriptor, manager, {
        frozen: true,
        ...(opts.elicitationUi ? { elicitationUi: opts.elicitationUi } : {}),
      }),
    );
    descriptions.set(descriptor.piName, descriptor.description);
    if (descriptor.readOnly === true) readOnlyNames.add(descriptor.piName);
  }

  return {
    names,
    tools,
    isReadOnly: (piName: string) => readOnlyNames.has(piName),
    descriptions,
  };
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
