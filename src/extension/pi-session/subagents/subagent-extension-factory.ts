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
 * is not a panel); the gate context is captured directly in the closure.
 */

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { log } from '../../logger';
import { runPermissionGate, gateErrorFallback, type GatePermissionContext } from '../permission-gate';

/** The state a subagent's gate hook routes to: the parent handler + mode reader + the spawning tool id. */
export interface SubagentGateContext extends GatePermissionContext {
  /** The spawning `Agent` tool-call id — stamped on nested approval messages. */
  parentToolUseId: string;
}

/** Build a per-subagent extension factory whose `tool_call` hook inherits the parent's gate + mode. */
export function createSubagentExtensionFactory(ctx: SubagentGateContext): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event, hookCtx) => {
      try {
        return await runPermissionGate(event, ctx, hookCtx.signal, ctx.parentToolUseId);
      } catch (err) {
        log('[SubagentExtension] permission gate threw for %s: %O', event.toolName, err);
        return gateErrorFallback(event.toolName);
      }
    });
  };
}
