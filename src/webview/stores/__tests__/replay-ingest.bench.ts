// @vitest-environment happy-dom
import { bench, describe } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { HistoryToolCall } from '@shared/types/content';
import { createHistoryHandlers } from '@/composables/message-handler/handlers/history-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useTeamStore } from '@/stores/useTeamStore';

type ReplayItem = Extract<ExtensionToWebviewMessage, { type: 'userReplay' | 'assistantReplay' }>;

const SUBAGENT_EVERY = 25;

function filler(label: string, chars: number): string {
  const unit = `${label} lorem ipsum dolor sit amet, consectetur adipiscing elit; `;
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

/** Shaped like `loadPiSessionHistory` output: each turn is a user prompt and an assistant reply with two tool calls. */
function replayItems(count: number): ReplayItem[] {
  const items: ReplayItem[] = [];
  for (let turn = 0; items.length < count; turn++) {
    items.push({ type: 'userReplay', content: `Prompt ${turn}: ${filler('ask', 200)}`, isSynthetic: false, sdkMessageId: `u${turn}`, promptIndex: turn });
    if (items.length >= count) break;
    const text = filler('answer', 1000);
    const tools: HistoryToolCall[] = [
      { id: `read${turn}`, name: 'Read', input: { file_path: `src/module${turn}/file.ts` }, result: filler('source', 4000) },
      { id: `bash${turn}`, name: 'Bash', input: { command: `npm test -- module${turn}` }, result: filler('output', 4000) },
    ];
    if (turn % SUBAGENT_EVERY === SUBAGENT_EVERY - 1) {
      tools.push({
        id: `agent${turn}`,
        name: 'Agent',
        input: { subagent_type: 'Explore', description: `Explore ${turn}`, prompt: filler('delegate', 500) },
        result: JSON.stringify({ content: [{ type: 'text', text: filler('agent-result', 1500) }] }),
        sdkAgentId: `agent${turn}`,
        agentStatus: 'completed',
        agentLaunch: { agentType: 'Explore', description: `Explore ${turn}`, prompt: filler('delegate', 500), background: false },
        agentMessages: [{ role: 'assistant', contentBlocks: [{ type: 'text', text: filler('agent', 1000) }] }],
        agentToolCount: 0,
      });
    }
    items.push({
      type: 'assistantReplay',
      content: text,
      thinking: filler('think', 1000),
      tools,
      contentBlocks: [
        { type: 'text', text },
        ...tools.map((t) => ({ type: 'tool_use' as const, id: t.id, name: t.name, input: t.input })),
      ],
    });
  }
  return items;
}

const handlers = createHistoryHandlers();

/** A fresh Pinia per run, so every run ingests into an empty conversation as a replay does after `sessionCleared`. */
function ingest(items: readonly ReplayItem[]): void {
  setActivePinia(createPinia());
  const ctx = {
    stores: {
      uiStore: useUIStore(),
      sessionStore: useSessionStore(),
      streamingStore: useStreamingStore(),
      subagentStore: useSubagentStore(),
      teamStore: useTeamStore(),
    },
    bridge: { postMessage: () => {}, getState: () => undefined, setState: () => {} },
  } as unknown as HandlerContext;
  for (const item of items) {
    const handler = handlers[item.type] as (m: ReplayItem, c: HandlerContext) => void;
    handler(item, ctx);
  }
  // The replay's `done` flushes whatever no animation frame has appended yet.
  ctx.stores.streamingStore.flushReplayQueue();
}

const SIZES = [250, 500, 1000] as const;
const fixtures = new Map(SIZES.map((n) => [n, replayItems(n)]));

// `throws` fails the run on an error; tinybench otherwise records it and reports NaN.
describe('replay ingest into the streaming store', () => {
  for (const n of SIZES) {
    bench(`${n} replay items`, () => {
      ingest(fixtures.get(n)!);
    }, { iterations: 10, time: 0, throws: true });
  }
});
