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
import { registerTurnEndImagePruning, registerAgentStartImageReconcile } from './context-image-pruning';
import { createToolSearchTool } from './tools/tool-search-tool';

/**
 * The configured-hooks wiring threaded from `FolderRuntime` (US-004/005/006). Optional — the factory works
 * without it (tests, no config) and every per-event handler is `hasEntries`-gated for zero cost (FR-14).
 */
export interface HooksWiring {
  config: HooksConfigService;
  workspaceRoot: string | undefined;
  userHome: string;
  /** Rename the session, preferring the live mutator (anti-fork) over the file writer. */
  renameSession: (sessionId: string, cwd: string, newName: string) => Promise<void>;
}

/** Build the per-tool-call PreToolUse gate (Section 3.3): runs `tool_call` hooks + raises the notice that a hook allowed or blocked the call. */
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
    onDecision: (toolName, decision, reason, terminate) => {
      log('[Hooks] PreToolUse %s%s for %s%s', decision, terminate ? ' (terminate)' : '', toolName, reason ? `: ${reason}` : '');
      // A terminating block is the only one the user gets no other signal about: the run settles
      // normally, so without this line the panel just goes idle mid-task.
      const blocked = terminate
        ? `A hook blocked ${toolName} and ended the turn`
        : `A hook blocked ${toolName}`;
      panel.postMessage({
        type: 'notification',
        notificationType: decision === 'allow' || terminate ? 'warning' : 'info',
        message: (decision === 'allow' ? `A hook force-allowed ${toolName}` : blocked) + (reason ? `: ${reason}` : ''),
      });
    },
    notify: (messages) => postHookSystemMessages((m) => panel.postMessage(m), messages),
    stashContext: (toolCallId, context) => stashPreToolUseContext(contextStash, common.session_id, toolCallId, context),
  };
}

/** Lookup the gate uses to route a folder-wide `tool_call` event to the right panel by sessionId. */
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
 * The Damocles pi extension, one per folder loader (registered via
 * `resourceLoaderOptions.extensionFactories`). It owns the cross-cutting hooks that pi intentionally
 * ships without — the permission gate (`tool_call`) and the plan-mode system-prompt injection
 * (`before_agent_start`). Every panel on the folder shares it, so every hook routes to the correct
 * panel by `ctx.sessionManager.getSessionId()` → `registry`.
 */
export function createDamoclesExtensionFactory(
  registry: PanelRegistryReader,
  checkpoints: CheckpointRegistryReader,
  registerMcpTools?: (pi: ExtensionAPI) => void,
  hooks?: HooksWiring,
  /** Receives this instance's ToolSearch republisher and returns a disposer this instance owns. */
  onToolSearchRepublish?: (republish: () => void) => () => void,
): ExtensionFactory {
  const hookDispatch: DispatchDeps | undefined = hooks
    ? { config: hooks.config, workspaceRoot: hooks.workspaceRoot, userHome: hooks.userHome }
    : undefined;
  return (pi) => {
    // PreToolUse `additionalContext` waiting to be delivered on its tool's result (keyed by toolCallId).
    // Per-runtime: shared between the gate below (writes) and the tool_result handler (drains).
    const preToolUseContextStash = createPreToolUseContextStash();

    // Prune stale tool-result screenshots so a long browser session's retained images stay near the
    // model's published caps (user attachments are exempt, so the totals can still exceed them). Both
    // halves register here rather than in the panel-routed handlers below so that pruning survives a
    // session whose panel entry is already unregistered. This factory serves only the main runtime;
    // nested sessions register the same pair themselves (`subagents/subagent-extension-factory.ts:203`
    // and `pi-session.ts:2545`), so deleting either of those leaves those sessions unpruned.
    registerTurnEndImagePruning(pi);
    registerAgentStartImageReconcile(pi);

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
    // (browser, compass, web, MCP). Registered here rather than in `buildCustomTools` because
    // `setActiveTools`/`getActiveTools` exist only on `ExtensionAPI`.
    const toolSearch = createToolSearchTool({
      deferrable: (sessionId) => registry.get(sessionId)?.deferrableTools?.() ?? null,
      activate: (sessionId, names) => registry.get(sessionId)?.activateDeferredTools?.(names),
      // The description getter carries no session id: every panel registered here shares one folder, and
      // its enabled subsystems and MCP servers are the same for each, so any registered panel answers
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
    // Retirement is deterministic and ownership-based: `onToolSearchRepublish` returns a disposer for
    // exactly this instance's entry, called from its own `session_shutdown` below. Nothing infers
    // deadness from a thrown `assertActive`. That handler is only reachable for an instance a session
    // BINDS; a reload with no bind following it (compat-dir watcher, subscription-plugin swap) mints an
    // instance that receives no session event, so `FolderRuntime` retires that one instead.
    const republishToolSearch = (): void => pi.registerTool(toolSearch);
    // Declared outside the try so the `session_shutdown` handler below can close over it: registration
    // is conditional on the initial publish succeeding, but the teardown handler is not.
    let disposeRepublisher: (() => void) | undefined;
    try {
      // Fail-soft like the MCP block above — a registration failure must never break the permission
      // gate. Only `registerTool` can throw here; building the definition cannot.
      republishToolSearch();
      disposeRepublisher = onToolSearchRepublish?.(republishToolSearch);
    } catch (err) {
      log('[DamoclesExtension] ToolSearch registration failed: %O', err);
    }

    // The republisher is the only thing this instance owns outright, so it is the only thing retired
    // here. The event handlers stay registered: this instance is shared by the folder and a session shutdown
    // says nothing about the other sessions bound to it, or about the one that binds it next.
    //
    // Retire on EVERY shutdown reason, `'reload'` INCLUDED — a deliberate divergence from the
    // observe-only handlers in `hooks/index.ts`, which skip `'reload'`. Do not "unify" them: skipping a
    // user's hook for an internal rebuild is right, but `resourceLoader.reload()` supersedes this
    // instance without invalidating it, so its republisher would keep succeeding into an extension
    // object no session references — never throwing, never prunable, invoked on every toggle forever.
    //
    // ACCEPTED WINDOW, do not add recovery machinery. That shutdown fires BEFORE the reload it precedes,
    // so if the reload then throws (it does git work for pinned packages) no replacement is minted and
    // this panel runs on an unregistered instance — its menu frozen, silently, since `runMcpReload` only
    // logs. Accepted: it self-heals on the next successful reload and costs one stale menu line, not a
    // broken tool. If ever observed, the fix is idempotent re-registration from `session_start`, guarded
    // on `disposeRepublisher === undefined`.
    pi.on('session_shutdown', () => {
      disposeRepublisher?.();
      disposeRepublisher = undefined;
    });

    pi.on('tool_call', async (event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const panel = registry.get(sessionId);
      // A closing panel unregisters while its agent can still reach this handler, and no other session
      // kind dispatches here, so a missing entry is an absent approval authority, not an ungated kind.
      if (!panel) {
        log('[DamoclesExtension] no panel registered for session %s; %s takes the fail-closed fallback', sessionId, event.toolName);
        return gateErrorFallback(event.toolName);
      }
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

    // A warm refresh bills against the same budget cap the user set, so a budget stop cancels it too.
    pi.on('cache_warming_decision', (_event, ctx) => {
      const panel = registry.get(ctx.sessionManager.getSessionId());
      // No registered panel means the session's panel was disposed; pi keeps warming until told to stop.
      if (!panel || panel.budgetStopRequested()) return { action: 'stop' };
      return undefined;
    });

    // The two continuation holds: wait for background subagents and carry their results into one more
    // request, or nudge a plan-mode turn that ended without ExitPlanMode. Panel-routed because both are
    // panel-session concepts, unlike the image pruning above.
    pi.on('agent_before_settle', async (event, ctx) => {
      const panel = registry.get(ctx.sessionManager.getSessionId());
      if (!panel?.onBeforeSettle) return undefined;
      try {
        const draft = await panel.onBeforeSettle(event);
        if (!draft) return undefined;
        // Spread: pi replaces the draft accumulator with whatever this returns, so a bare list would
        // discard every earlier handler's drafts.
        return { entries: [...event.entries, draft], continue: true };
      } catch (err) {
        log('[DamoclesExtension] agent_before_settle hold failed: %O', err);
        return undefined;
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

    // `agent_settled`, not `agent_end`: a boundary continuation stays inside the same run, so finalizing
    // per run segment would mint a second checkpoint against the same user entry.
    pi.on('agent_settled', async (_event, ctx) => {
      const service = checkpoints.get(ctx.sessionManager.getSessionId());
      if (!service) return;
      try {
        const entries = await service.onSettled(ctx.sessionManager);
        for (const entry of entries) pi.appendEntry(DAMOCLES_CHECKPOINT_ENTRY, entry);
      } catch (err) {
        log('[DamoclesExtension] checkpoint agent_settled failed: %O', err);
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
