import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ImageBlock } from '../../shared/types/content';
import { toImageBlocks } from './branch-text';

/**
 * Tool result images between `tool_execution_end` and the result's `message_end`: in a parallel batch pi
 * persists every `toolResult` only after the whole batch settles, so the session file cannot serve them yet.
 */
export class UnpersistedToolImages {
  private readonly images = new Map<string, readonly ImageBlock[]>();
  private readonly tracked = new Map<AgentSession, { unsubscribe: () => void; ids: Set<string> }>();

  track(session: AgentSession): void {
    if (this.tracked.has(session)) return;
    const ids = new Set<string>();
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'tool_execution_end') {
        if (event.isError) return;
        const blocks = toImageBlocks((event.result as { content?: unknown } | undefined)?.content);
        if (blocks.length === 0) return;
        this.images.set(event.toolCallId, blocks);
        ids.add(event.toolCallId);
      } else if (event.type === 'message_end' && event.message.role === 'toolResult') {
        this.images.delete(event.message.toolCallId);
        ids.delete(event.message.toolCallId);
      } else if (event.type === 'agent_end') {
        // A failed run ends without the `message_end` of results that already finished, so pi never persists them.
        for (const id of ids) this.images.delete(id);
        ids.clear();
      }
    });
    this.tracked.set(session, { unsubscribe, ids });
  }

  untrack(session: AgentSession): void {
    const entry = this.tracked.get(session);
    if (!entry) return;
    entry.unsubscribe();
    for (const id of entry.ids) this.images.delete(id);
    this.tracked.delete(session);
  }

  get(toolCallId: string): readonly ImageBlock[] | undefined {
    return this.images.get(toolCallId);
  }

  clear(): void {
    for (const session of [...this.tracked.keys()]) this.untrack(session);
    this.images.clear();
  }
}
