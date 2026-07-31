/**
 * subagent-extension-factory.ts — Per-subagent gate-routing extension (Phase 5, US-018.5).
 *
 * New for the Damocles port. Each nested subagent session is created with its OWN extension factory
 * (passed via `createSubagentSession`'s `resourceLoaderOptions.extensionFactories`). It owns a single
 * `tool_call` hook that routes the subagent's tool calls through the SAME central permission gate as
 * the primary agent — using the PARENT panel's `permissionHandler` and current mode (inherit-parent-
 * mode) — and stamps the spawning `Agent` tool-call id as `parentToolUseId` so any approval prompt
 * attaches to the subagent card rather than the primary stream.
 *
 * Unlike the primary path, this does NOT route through `PiRuntime._panelRegistry` (a subagent session
 * is not a panel); the gate context is captured directly in the closure. When configured-hooks dispatch
 * deps are supplied (US-008), the same factory also fires PreToolUse/PostToolUse for the subagent's tool
 * calls and `subagent_end` (= Claude Code SubagentStop) on completion — reusing the primary helpers.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { log } from '../../logger';
import { runPermissionGate, gateErrorFallback, type GatePermissionContext, type PreToolUseHookGate } from '../permission-gate';
import { mapPiToolName, normalizeToolInput } from '../tool-normalization';
import {
  buildHookCommon,
  buildToolResultPatch,
  createPreToolUseContextStash,
  stashPreToolUseContext,
  takePreToolUseContext,
  clearSessionPreToolUseContext,
  type DispatchDeps,
  type PreToolUseContextStash,
} from '../hooks';
import { dispatchToolCall, dispatchObserveOnly } from '../hooks/dispatch';
import { buildAgentEndPayload } from '../hooks/payload';
import { registerContextImagePruning } from '../context-image-pruning';
import { createToolSearchTool, type ToolActivationPort } from '../tools/tool-search-tool';

/** The state a subagent's gate hook routes to: the parent handler + mode reader + the spawning tool id. */
export interface SubagentGateContext extends GatePermissionContext {
  /** The spawning `Agent` tool-call id — stamped on nested approval messages + the SubagentStop payload. */
  parentToolUseId: string;
  /** Configured-hooks dispatch deps (US-008). When present, subagent tool/Stop hooks fire; else they don't. */
  hooks?: DispatchDeps;
  /** This agent's deferrable universe: the names ToolSearch may activate. Empty ⇒ nothing deferred. */
  deferrableToolNames: readonly string[];
}

/**
 * The nested session's activation port, straight over pi's own API — unlike the panel's port in
 * `damocles-extension.ts`, which routes through `PiSession` to keep a durable activated set. A nested
 * session has no `PiSession`, no settings-driven recompute, and nothing that ever re-applies its active
 * set, so there is no clobber to defend against and nothing to remember across turns. That the two
 * differ is the whole reason `ToolActivationPort` exists.
 *
 * The `sessionId` both `deferrable` and `activate` receive is unused: one factory is built per agent
 * spawn and the deferrable names are captured in the closure, so there is no per-session registry to
 * consult.
 */
function buildSubagentActivationPort(pi: ExtensionAPI, deferrableToolNames: readonly string[]): ToolActivationPort {
  const deferrableSet = new Set(deferrableToolNames);
  return {
    // One factory per spawn, so the agent's own universe IS the inventory — an agent is never offered
    // a group its own allowlist cannot reach. Fixed for the agent's lifetime by design: its allowlist
    // is frozen at spawn, unlike the panel's live config. No MCP blurbs: `resolveAgentToolset` strips
    // every `mcp__*` name, so a nested agent's universe never contains one.
    inventory: () => ({ names: [...deferrableToolNames] }),
    deferrable: () => ({
      names: [...deferrableToolNames],
      loaded: new Set(pi.getActiveTools().filter((name) => deferrableSet.has(name))),
      mcpGroups: new Map(),
    }),
    // Additive only: pi diffs the active set around `execute`, and any REMOVAL forces its safe fallback
    // of resending the full active set.
    activate: (_sessionId, names) => pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]),
  };
}

/** A subagent has no webview, so hook `systemMessage`(s) go to the transparency log. */
function logSubagentSystemMessages(messages: readonly string[]): void {
  for (const message of messages) log('[Hooks] subagent systemMessage: %s', message);
}

/** Build the per-subagent PreToolUse gate (Section 3.3). Notices are log-only — a subagent has no webview. */
function buildSubagentPreToolUseGate(
  deps: DispatchDeps,
  ctx: ExtensionContext,
  contextStash: PreToolUseContextStash,
): PreToolUseHookGate {
  const common = buildHookCommon(ctx);
  return {
    run: (event) =>
      dispatchToolCall(deps, {
        common,
        toolName: mapPiToolName(event.toolName),
        toolInput: normalizeToolInput(event.toolName, event.input as Record<string, unknown>),
      }),
    onDecision: (toolName, decision, reason) =>
      log('[Hooks] subagent PreToolUse %s for %s%s', decision, toolName, reason ? `: ${reason}` : ''),
    notify: logSubagentSystemMessages,
    stashContext: (toolCallId, context) => stashPreToolUseContext(contextStash, common.session_id, toolCallId, context),
  };
}

/** Register the configured subagent hooks (PostToolUse + SubagentStop). Fail-soft; never breaks teardown. */
function registerSubagentHooks(
  pi: ExtensionAPI,
  ctx: SubagentGateContext,
  deps: DispatchDeps,
  contextStash: PreToolUseContextStash,
): void {
  pi.on('tool_result', async (event, hookCtx) => {
    const preToolUseContext = takePreToolUseContext(contextStash, event.toolCallId);
    if (!deps.config.hasEntries('tool_result') && !preToolUseContext?.length) return undefined;
    try {
      return await buildToolResultPatch(deps, buildHookCommon(hookCtx), event, {
        ...(preToolUseContext?.length ? { preToolUseContext } : {}),
        notify: logSubagentSystemMessages,
      });
    } catch (err) {
      log('[SubagentExtension] tool_result (PostToolUse) hook failed: %O', err);
      return undefined;
    }
  });

  pi.on('agent_end', async (event, hookCtx) => {
    // The subagent finished: sweep any orphaned PreToolUse context it left (its stash is local to it).
    clearSessionPreToolUseContext(contextStash, hookCtx.sessionManager.getSessionId());
    if (!deps.config.hasEntries('subagent_end')) return;
    try {
      await dispatchObserveOnly(
        deps,
        'subagent_end',
        hookCtx.cwd,
        buildAgentEndPayload(buildHookCommon(hookCtx), event.messages, { subagent: true, parentToolUseId: ctx.parentToolUseId }),
      );
    } catch (err) {
      log('[SubagentExtension] subagent_end (SubagentStop) hook failed: %O', err);
    }
  });
}

/** Build a per-subagent extension factory whose `tool_call` hook inherits the parent's gate + mode. */
export function createSubagentExtensionFactory(ctx: SubagentGateContext): ExtensionFactory {
  return (pi) => {
    // PreToolUse `additionalContext` awaiting delivery on its tool's result (keyed by toolCallId).
    const preToolUseContextStash = createPreToolUseContextStash();

    // Subagent/team sessions can inherit browser tools, so they must prune stale screenshots too
    // (this factory is the ONLY one they register — the main factory's handler would not cover them).
    // btw sessions register the pruner directly via their inline factory in pi-session.ts.
    registerContextImagePruning(pi);

    if (ctx.deferrableToolNames.length > 0) {
      try {
        pi.registerTool(createToolSearchTool(buildSubagentActivationPort(pi, ctx.deferrableToolNames)));
      } catch (err) {
        log('[SubagentExtension] ToolSearch registration failed: %O', err);
      }
    }

    pi.on('tool_call', async (event, hookCtx) => {
      const preToolUse =
        ctx.hooks && ctx.hooks.config.hasEntries('tool_call')
          ? buildSubagentPreToolUseGate(ctx.hooks, hookCtx, preToolUseContextStash)
          : undefined;
      try {
        return await runPermissionGate(event, ctx, hookCtx.signal, ctx.parentToolUseId, preToolUse);
      } catch (err) {
        log('[SubagentExtension] permission gate threw for %s: %O', event.toolName, err);
        return gateErrorFallback(event.toolName);
      }
    });

    if (ctx.hooks) registerSubagentHooks(pi, ctx, ctx.hooks, preToolUseContextStash);
  };
}
