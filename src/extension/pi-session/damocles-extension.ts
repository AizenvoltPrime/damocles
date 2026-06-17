import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { PanelGateContext } from './permission-gate';
import { runPermissionGate } from './permission-gate';
import { log } from '../logger';

/** Lookup the gate uses to route a process-global `tool_call` event to the right panel by sessionId. */
export interface PanelRegistryReader {
  get(sessionId: string): PanelGateContext | undefined;
}

const PLAN_MODE_INSTRUCTION = [
  'IMPORTANT: Plan mode is active. You MUST NOT make any edits, run any non-read-only commands, or',
  'otherwise modify the system. Research and design only, then present your plan and call ExitPlanMode',
  'to request approval before taking any action.',
].join(' ');

/**
 * The single shared Damocles pi extension (B1: one per process, registered via
 * `resourceLoaderOptions.extensionFactories`). It owns the cross-cutting hooks that pi intentionally
 * ships without — the permission gate (`tool_call`) and the plan-mode system-prompt injection
 * (`before_agent_start`). Because it is process-global, every hook routes to the correct panel by
 * `ctx.sessionManager.getSessionId()` → `registry`.
 */
export function createDamoclesExtensionFactory(registry: PanelRegistryReader): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      const panel = registry.get(ctx.sessionManager.getSessionId());
      if (!panel) return undefined;
      try {
        return await runPermissionGate(event, panel, ctx.signal);
      } catch (err) {
        log('[DamoclesExtension] permission gate threw for %s: %O', event.toolName, err);
        return undefined;
      }
    });

    pi.on('before_agent_start', (event, ctx) => {
      const panel = registry.get(ctx.sessionManager.getSessionId());
      if (!panel?.isPlanMode()) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_INSTRUCTION}` };
    });
  };
}
