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

/** The state a subagent's gate hook routes to: the parent handler + mode reader + the spawning tool id. */
export interface SubagentGateContext extends GatePermissionContext {
  /** The spawning `Agent` tool-call id — stamped on nested approval messages + the SubagentStop payload. */
  parentToolUseId: string;
  /** Configured-hooks dispatch deps (US-008). When present, subagent tool/Stop hooks fire; else they don't. */
  hooks?: DispatchDeps;
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
