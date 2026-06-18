import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { PanelGateContext } from './permission-gate';
import { runPermissionGate } from './permission-gate';
import { buildAgentStartResult } from './agent-start';
import { log } from '../logger';
import type { CheckpointService } from './checkpoint-service';
import { DAMOCLES_CHECKPOINT_ENTRY } from './session-store/constants';

/** Lookup the gate uses to route a process-global `tool_call` event to the right panel by sessionId. */
export interface PanelRegistryReader {
  get(sessionId: string): PanelGateContext | undefined;
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
): ExtensionFactory {
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
  };
}
