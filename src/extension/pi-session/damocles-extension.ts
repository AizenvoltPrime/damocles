import type { ExtensionFactory, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { PanelGateContext, PreToolUseHookGate } from './permission-gate';
import { runPermissionGate, gateErrorFallback } from './permission-gate';
import { buildAgentStartResult } from './agent-start';
import { log } from '../logger';
import type { CheckpointService } from './checkpoint-service';
import { DAMOCLES_CHECKPOINT_ENTRY } from './session-store/constants';
import { mapPiToolName, normalizeToolInput } from './tool-normalization';
import {
  registerConfiguredHooks,
  postHookSystemMessages,
  createPreToolUseContextStash,
  stashPreToolUseContext,
  type HooksConfigService,
  type PreToolUseContextStash,
} from './hooks';
import { dispatchToolCall, type DispatchDeps } from './hooks/dispatch';
import type { HookCommon } from './hooks/payload';
import { registerContextImagePruning } from './context-image-pruning';
import { createToolSearchTool } from './tools/tool-search-tool';

/**
 * The configured-hooks wiring threaded from `PiRuntime` (US-004/005/006). Optional — the factory works
 * without it (tests, no config) and every per-event handler is `hasEntries`-gated for zero cost (FR-14).
 */
export interface HooksWiring {
  config: HooksConfigService;
  workspaceRoot: string | undefined;
  userHome: string;
  /** Rename the session, preferring the live mutator (anti-fork) over the file writer. */
  renameSession: (sessionId: string, cwd: string, newName: string) => Promise<void>;
}

/** Build the per-tool-call PreToolUse gate (Section 3.3): runs `tool_call` hooks + raises the D6 notice. */
function buildPreToolUseGate(
  deps: DispatchDeps,
  ctx: ExtensionContext,
  panel: PanelGateContext,
  contextStash: PreToolUseContextStash,
): PreToolUseHookGate {
  const common: HookCommon = {
    session_id: ctx.sessionManager.getSessionId(),
    transcript_path: ctx.sessionManager.getSessionFile() ?? '',
    cwd: ctx.cwd,
  };
  return {
    run: (event) =>
      dispatchToolCall(deps, {
        common,
        toolName: mapPiToolName(event.toolName),
        toolInput: normalizeToolInput(event.toolName, event.input as Record<string, unknown>),
      }),
    onDecision: (toolName, decision, reason) => {
      log('[Hooks] PreToolUse %s for %s%s', decision, toolName, reason ? `: ${reason}` : '');
      panel.postMessage({
        type: 'notification',
        notificationType: decision === 'allow' ? 'warning' : 'info',
        message:
          decision === 'allow'
            ? `A hook force-allowed ${toolName}${reason ? `: ${reason}` : ''}`
            : `A hook blocked ${toolName}${reason ? `: ${reason}` : ''}`,
      });
    },
    notify: (messages) => postHookSystemMessages((m) => panel.postMessage(m), messages),
    stashContext: (toolCallId, context) => stashPreToolUseContext(contextStash, common.session_id, toolCallId, context),
  };
}

/** Lookup the gate uses to route a process-global `tool_call` event to the right panel by sessionId. */
export interface PanelRegistryReader {
  get(sessionId: string): PanelGateContext | undefined;
  /** Every registered panel. Used only where a hook has no session id to route by — see the ToolSearch
   *  inventory scope below, which needs a workspace fact rather than a per-session one. */
  values(): Iterable<PanelGateContext>;
}

/** Lookup the checkpoint lifecycle hooks use to route to the right session's engine by sessionId. */
export interface CheckpointRegistryReader {
  get(sessionId: string): CheckpointService | undefined;
}

/**
 * The single shared Damocles pi extension (B1: one per process, registered via
 * `resourceLoaderOptions.extensionFactories`). It owns the cross-cutting hooks that pi intentionally
 * ships without — the permission gate (`tool_call`) and the plan-mode system-prompt injection
 * (`before_agent_start`). Because it is process-global, every hook routes to the correct panel by
 * `ctx.sessionManager.getSessionId()` → `registry`.
 */
export function createDamoclesExtensionFactory(
  registry: PanelRegistryReader,
  checkpoints: CheckpointRegistryReader,
  registerMcpTools?: (pi: ExtensionAPI) => void,
  hooks?: HooksWiring,
  /** Receives a callback that re-publishes ToolSearch's description. See the registration below. */
  onToolSearchRepublish?: (republish: () => void) => void,
): ExtensionFactory {
  const hookDispatch: DispatchDeps | undefined = hooks
    ? { config: hooks.config, workspaceRoot: hooks.workspaceRoot, userHome: hooks.userHome }
    : undefined;
  return (pi) => {
    // PreToolUse `additionalContext` waiting to be delivered on its tool's result (keyed by toolCallId).
    // Per-runtime: shared between the gate below (writes) and the tool_result handler (drains).
    const preToolUseContextStash = createPreToolUseContextStash();

    // Prune stale tool-result screenshots from the outbound context so long browser sessions stay
    // under the provider byte cap (413 request_too_large). Outbound-only; never touches persisted state.
    registerContextImagePruning(pi);

    // Register cached MCP tools (Phase 6). Re-runs on every reload (fresh runtime → fresh registry),
    // so MCP tools survive `resourceLoader.reload()`; mid-session new tools are topped up via the
    // captured `pi` handle the registrar keeps. Fail-soft: MCP must never break the gate/checkpoint hooks.
    if (registerMcpTools) {
      try {
        registerMcpTools(pi);
      } catch (err) {
        log('[DamoclesExtension] MCP tool registration failed: %O', err);
      }
    }

    // The always-active ToolSearch tool: the sole path that activates this session's deferred tools
    // (browser, compass, MCP). Registered here rather than in `buildCustomTools` because
    // `setActiveTools`/`getActiveTools` exist only on `ExtensionAPI`.
    const toolSearch = createToolSearchTool({
      deferrable: (sessionId) => registry.get(sessionId)?.deferrableTools?.() ?? null,
      activate: (sessionId, names) => registry.get(sessionId)?.activateDeferredTools?.(names),
      // The description getter carries no session id, but it does not need one: which subsystems are
      // enabled is a WORKSPACE fact (`damocles.browser.enabled`, compass, MCP, `tools.disabled`), so
      // every panel here resolves the same deferrable set. Any registered panel therefore answers
      // correctly. Null before any panel registers → list every built-in group.
      //
      // Answered from the PANEL, never from `pi.getAllTools()`: that materializes `description` for
      // every registered tool, ToolSearch included, so sourcing the inventory from it recurses until
      // the stack overflows and no session can start.
      inventory: () => {
        for (const panel of registry.values()) {
          const snapshot = panel.deferrableTools?.();
          if (snapshot) {
            return {
              names: snapshot.names,
              ...(snapshot.mcpDescriptions ? { mcpDescriptions: snapshot.mcpDescriptions } : {}),
            };
          }
        }
        return null;
      },
    });
    // `registerTool` is the ONLY public re-wrap trigger, and a re-wrap is what re-materializes the
    // description. pi's `wrapToolDefinition` copies `description` as a plain property, so the getter is
    // evaluated ONCE per wrap and the model sees a frozen string until the next one — a subsystem
    // toggled off mid-session would otherwise stay advertised for the life of the session. Re-
    // registering the SAME definition is the sanctioned way to ask for that refresh (it is what
    // `McpToolRegistrar` already relies on), and `_refreshToolRegistry` preserves the active set.
    //
    // Deliberately NOT try/catch'd: once this extension instance is superseded, `assertActive` throws,
    // and that throw is the only signal the runtime has that this closure is retired. Swallowing it
    // here would leak a dead closure per reload forever.
    const republishToolSearch = (): void => pi.registerTool(toolSearch);
    try {
      // Fail-soft like the MCP block above — a registration failure must never break the permission
      // gate. Only `registerTool` can throw here; building the definition cannot.
      republishToolSearch();
      onToolSearchRepublish?.(republishToolSearch);
    } catch (err) {
      log('[DamoclesExtension] ToolSearch registration failed: %O', err);
    }

    pi.on('tool_call', async (event, ctx) => {
      const panel = registry.get(ctx.sessionManager.getSessionId());
      if (!panel) return undefined;
      const preToolUse =
        hookDispatch && hookDispatch.config.hasEntries('tool_call')
          ? buildPreToolUseGate(hookDispatch, ctx, panel, preToolUseContextStash)
          : undefined;
      try {
        return await runPermissionGate(event, panel, ctx.signal, null, preToolUse);
      } catch (err) {
        log('[DamoclesExtension] permission gate threw for %s: %O', event.toolName, err);
        return gateErrorFallback(event.toolName);
      }
    });

    pi.on('before_agent_start', async (event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const panel = registry.get(sessionId);
      if (!panel) return undefined;
      try {
        return await buildAgentStartResult(event, panel, sessionId);
      } catch (err) {
        log('[DamoclesExtension] before_agent_start failed: %O', err);
        return undefined;
      }
    });

    // Keep-alive: hold the parent turn until its background subagents finish, then inject their results
    // so the same turn continues into a synthesis round. Awaited before the turn settles (runs ahead of
    // the checkpoint agent_end below, which is fine — it persists the post-hold state).
    pi.on('agent_end', async (event, ctx) => {
      const panel = registry.get(ctx.sessionManager.getSessionId());
      if (!panel?.onAgentEnd) return;
      try {
        await panel.onAgentEnd(event);
      } catch (err) {
        log('[DamoclesExtension] agent_end keep-alive failed: %O', err);
      }
    });

    // ---- checkpoint lifecycle (US-013b) -----------------------------------
    // Each hook routes to the session's CheckpointService and persists any entries it mints via the
    // extension `appendEntry` API. All fail soft — a checkpoint error never breaks the turn (FR-6).
    // Resume/fork hydration is owned solely by `PiSession.bindSession` (which registers the service
    // then hydrates); a session_start hook here would fire before that registration and no-op.

    pi.on('message_start', async (event, ctx) => {
      const service = checkpoints.get(ctx.sessionManager.getSessionId());
      if (!service) return;
      try {
        const entries = await service.onMessageStart(event.message, ctx.sessionManager);
        for (const entry of entries) pi.appendEntry(DAMOCLES_CHECKPOINT_ENTRY, entry);
      } catch (err) {
        log('[DamoclesExtension] checkpoint message_start failed: %O', err);
      }
    });

    pi.on('turn_end', async (_event, ctx) => {
      const service = checkpoints.get(ctx.sessionManager.getSessionId());
      if (!service) return;
      try {
        await service.onTurnEnd(ctx.sessionManager);
      } catch (err) {
        log('[DamoclesExtension] checkpoint turn_end failed: %O', err);
      }
    });

    pi.on('agent_end', async (_event, ctx) => {
      const service = checkpoints.get(ctx.sessionManager.getSessionId());
      if (!service) return;
      try {
        const entries = await service.onAgentEnd(ctx.sessionManager);
        for (const entry of entries) pi.appendEntry(DAMOCLES_CHECKPOINT_ENTRY, entry);
      } catch (err) {
        log('[DamoclesExtension] checkpoint agent_end failed: %O', err);
      }
    });

    // Mint an exact-snapshot checkpoint keyed by the compaction entry id so the anchor becomes
    // rewindable. Fires on every successful compaction; fail-soft like the other checkpoint hooks.
    pi.on('session_compact', async (event, ctx) => {
      const service = checkpoints.get(ctx.sessionManager.getSessionId());
      if (!service) return;
      try {
        const entries = await service.onSessionCompact(event.compactionEntry.id, ctx.sessionManager);
        for (const entry of entries) pi.appendEntry(DAMOCLES_CHECKPOINT_ENTRY, entry);
      } catch (err) {
        log('[DamoclesExtension] checkpoint session_compact failed: %O', err);
      }
    });

    // ---- configured hooks (US-004/005/006/007) ----------------------------
    // tool_result / input (+ before_agent_start context drain) / agent_end Stop / session lifecycle /
    // Tier-2 observe-only. PreToolUse lives in the gate above (Section 3.3), not here. Fail-soft.
    if (hooks && hookDispatch) {
      registerConfiguredHooks(pi, { dispatch: hookDispatch, registry, renameSession: hooks.renameSession, preToolUseContextStash });
    }
  };
}
