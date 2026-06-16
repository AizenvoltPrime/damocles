import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/**
 * Minimal stream adapter for the Phase 0 spike: subscribes to a pi `AgentSession` and writes
 * its events to a sink (the Damocles OutputChannel). This is NOT the webview adapter (US-003) —
 * it only proves the embed streams text/thinking/tool deltas and terminal stop reasons.
 *
 * It also flags `compaction_start`, which under blocker B3 must never fire (compaction is
 * disabled both via seeded settings and `setAutoCompactionEnabled(false)`).
 *
 * Returns an unsubscribe function.
 */
export function attachSpikeLogger(session: AgentSession, write: (line: string) => void): () => void {
  let text = '';
  let thinking = '';

  const flush = (): void => {
    if (text) {
      write(`[pi:text] ${text}`);
      text = '';
    }
    if (thinking) {
      write(`[pi:thinking] ${thinking}`);
      thinking = '';
    }
  };

  const handle = (event: AgentSessionEvent): void => {
    switch (event.type) {
      case 'message_update': {
        const ame = event.assistantMessageEvent;
        if (ame.type === 'text_delta') {
          text += ame.delta;
        } else if (ame.type === 'thinking_delta') {
          thinking += ame.delta;
        } else if (ame.type === 'toolcall_end') {
          flush();
          write(`[pi:toolcall] ${ame.toolCall.name} ${JSON.stringify(ame.toolCall.arguments)}`);
        } else if (ame.type === 'done') {
          flush();
          write(`[pi:done] stopReason=${ame.reason}`);
        } else if (ame.type === 'error') {
          flush();
          write(`[pi:error] reason=${ame.reason} message=${ame.error.errorMessage ?? '(none)'}`);
        }
        break;
      }
      case 'message_end': {
        const m = event.message;
        if (m.role === 'assistant') {
          write(`[pi:message-end] stopReason=${m.stopReason} error=${m.errorMessage ?? ''} content=[${m.content.map((c) => c.type).join(',')}]`);
        }
        break;
      }
      case 'tool_execution_start':
        write(`[pi:tool-start] ${event.toolName} (${event.toolCallId})`);
        break;
      case 'tool_execution_end':
        write(`[pi:tool-end] ${event.toolName} isError=${event.isError}`);
        break;
      case 'agent_end':
        flush();
        write(`[pi:agent-end] messages=${event.messages.length} willRetry=${event.willRetry}`);
        break;
      case 'compaction_start':
        write(`[pi:WARN] compaction_start fired (reason=${event.reason}) — B3 invariant violated`);
        break;
      case 'auto_retry_start':
        write(`[pi:retry] attempt=${event.attempt}/${event.maxAttempts} delayMs=${event.delayMs} — ${event.errorMessage}`);
        break;
      default:
        break;
    }
  };

  return session.subscribe(handle);
}
