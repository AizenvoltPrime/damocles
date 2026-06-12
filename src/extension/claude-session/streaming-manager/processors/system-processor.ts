import { randomUUID } from 'crypto';
import { log } from '../../../logger';
import { readLatestCompactSummary } from '../../../session';
import type { ProcessorContext, ProcessorDependencies, MessageProcessor } from '../types';
import type { SystemInitData } from '../../../../shared/types/session';
import type { AccountInfo } from '../../../../shared/types/settings';
import type { PluginInfo } from '../../../../shared/types/plugins';

interface SystemMessage {
  subtype?: string;
  [key: string]: unknown;
}

interface CompactMetadata {
  trigger: 'manual' | 'auto';
  preTokens?: number;
  pre_tokens?: number;
}

function handleInit(message: Record<string, unknown>, ctx: ProcessorContext): void {
  const sysMsg = message as SystemMessage;
  const sessionId = sysMsg['session_id'] as string | undefined;
  if (sessionId && ctx.state.sessionId !== sessionId) {
    ctx.state.setSessionId(sessionId);
  } else if (!sessionId) {
    log('[StreamingManager] system init missing session_id');
  }

  const mcpServers = (sysMsg['mcp_servers'] as { name: string; status: string }[]) || [];
  const plugins = (sysMsg['plugins'] as PluginInfo[]) || [];
  const outputStyle = sysMsg['output_style'] as string | undefined;
  const initData: SystemInitData = {
    model: (sysMsg['model'] as string) || '',
    tools: (sysMsg['tools'] as string[]) || [],
    mcpServers,
    plugins,
    permissionMode: (sysMsg['permissionMode'] as string) || 'default',
    slashCommands: (sysMsg['slash_commands'] as string[]) || [],
    apiKeySource: (sysMsg['apiKeySource'] as string) || '',
    cwd: (sysMsg['cwd'] as string) || '',
    ...(outputStyle !== undefined && { outputStyle }),
  };
  ctx.deps.callbacks.onMessage({ type: 'systemInit', data: initData });
  ctx.deps.callbacks.onMessage({
    type: 'accountInfo',
    data: { model: initData.model, apiKeySource: initData.apiKeySource } as AccountInfo,
  });

  const fastModeState = sysMsg['fast_mode_state'] as 'off' | 'cooldown' | 'on' | undefined;
  if (fastModeState) {
    ctx.deps.callbacks.onMessage({
      type: 'fastModeStateUpdate',
      state: fastModeState,
    });
  }
}

function handleCompactBoundary(message: Record<string, unknown>, ctx: ProcessorContext): void {
  const sysMsg = message as SystemMessage;
  log('[StreamingManager] Received compact_boundary system message');
  const metadata = (sysMsg['compactMetadata'] ?? sysMsg['compact_metadata']) as CompactMetadata | undefined;

  if (!metadata) return;

  log(
    '[StreamingManager] Sending compactBoundary to webview: trigger=%s, preTokens=%d',
    metadata.trigger,
    metadata.preTokens ?? metadata.pre_tokens ?? 0
  );
  ctx.deps.callbacks.onMessage({
    type: 'compactBoundary',
    preTokens: metadata.preTokens ?? metadata.pre_tokens ?? 0,
    trigger: metadata.trigger,
  });

  ctx.deps.checkpointTracker.onCompactComplete();

  const sessionId = ctx.state.sessionId;
  if (sessionId && !ctx.deps.recallService?.isEnabled) {
    void readLatestCompactSummary(ctx.deps.cwd, sessionId)
      .then((summary) => {
        if (summary) {
          log('[StreamingManager] Read compact summary from JSONL, length=%d', summary.length);
          ctx.deps.callbacks.onMessage({
            type: 'compactSummary',
            summary,
          });
        } else {
          log('[StreamingManager] No compact summary found in JSONL');
        }
      })
      .catch((err) => {
        log('[StreamingManager] Error reading compact summary: %s', err);
      });
  }
}

function handleModelFallback(message: Record<string, unknown>, ctx: ProcessorContext): void {
  const fromModel = typeof message['original_model'] === 'string' ? message['original_model'] : '';
  const toModel = typeof message['fallback_model'] === 'string' ? message['fallback_model'] : '';
  const trigger = typeof message['trigger'] === 'string' ? message['trigger'] : 'unknown';
  const uuid = typeof message['uuid'] === 'string' ? message['uuid'] : `fallback-${randomUUID()}`;
  log('[StreamingManager] model_fallback: %s -> %s (trigger=%s)', fromModel, toModel, trigger);
  ctx.deps.callbacks.onMessage({
    type: 'modelFallback',
    id: uuid,
    fromModel,
    toModel,
    trigger,
    timestamp: Date.now(),
  });
}

export function createSystemProcessors(_deps: ProcessorDependencies): Record<string, MessageProcessor> {
  return {
    'system:init': handleInit,
    'system:compact_boundary': handleCompactBoundary,
    'system:model_fallback': handleModelFallback,
  };
}
