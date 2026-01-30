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

function handleInit(sysMsg: SystemMessage, deps: ProcessorDependencies): void {
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
  deps.callbacks.onMessage({ type: 'systemInit', data: initData });
  deps.callbacks.onMessage({
    type: 'accountInfo',
    data: { model: initData.model, apiKeySource: initData.apiKeySource } as AccountInfo,
  });
}

function handleCompactBoundary(
  sysMsg: SystemMessage,
  ctx: ProcessorContext,
  deps: ProcessorDependencies
): void {
  log('[StreamingManager] Received compact_boundary system message');
  const metadata = (sysMsg['compactMetadata'] ?? sysMsg['compact_metadata']) as CompactMetadata | undefined;

  if (!metadata) return;

  log(
    '[StreamingManager] Sending compactBoundary to webview: trigger=%s, preTokens=%d',
    metadata.trigger,
    metadata.preTokens ?? metadata.pre_tokens ?? 0
  );
  deps.callbacks.onMessage({
    type: 'compactBoundary',
    preTokens: metadata.preTokens ?? metadata.pre_tokens ?? 0,
    trigger: metadata.trigger,
  });

  deps.checkpointTracker.onCompactComplete();

  const sessionId = ctx.state.sessionId;
  if (sessionId) {
    void readLatestCompactSummary(deps.cwd, sessionId)
      .then((summary) => {
        if (summary) {
          log('[StreamingManager] Read compact summary from JSONL, length=%d', summary.length);
          deps.callbacks.onMessage({
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

export function createSystemProcessor(deps: ProcessorDependencies): MessageProcessor {
  return (message: Record<string, unknown>, ctx: ProcessorContext): void => {
    const sysMsg = message as SystemMessage;

    if (sysMsg.subtype === 'init') {
      handleInit(sysMsg, deps);
    } else if (sysMsg.subtype === 'compact_boundary') {
      handleCompactBoundary(sysMsg, ctx, deps);
    }
  };
}
