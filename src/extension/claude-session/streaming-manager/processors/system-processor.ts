import { log } from '../../../logger';
import { readLatestCompactSummary } from '../../../session';
import type { ProcessorContext, MessageProcessor } from '../types';
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

function handleInit(sysMsg: SystemMessage, ctx: ProcessorContext): void {
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
}

function handleCompactBoundary(sysMsg: SystemMessage, ctx: ProcessorContext): void {
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
  if (sessionId && !ctx.deps.contextDistillation?.isEnabled) {
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

export function createSystemProcessor(): MessageProcessor {
  return (message: Record<string, unknown>, ctx: ProcessorContext): void => {
    const sysMsg = message as SystemMessage;

    if (sysMsg.subtype === 'init') {
      handleInit(sysMsg, ctx);
    } else if (sysMsg.subtype === 'compact_boundary') {
      handleCompactBoundary(sysMsg, ctx);
    }
  };
}
