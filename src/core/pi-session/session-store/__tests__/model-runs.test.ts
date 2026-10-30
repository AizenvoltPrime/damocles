import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { earlierModelRuns } from '../model-runs';

const entry = (value: Record<string, unknown>): SessionEntry => value as unknown as SessionEntry;
const modelChange = (provider: string, modelId: string) => entry({ type: 'model_change', provider, modelId });
const user = () => entry({ type: 'message', message: { role: 'user', content: 'hi' } });
const reply = (provider: string, model: string, stopReason = 'stop') =>
  entry({ type: 'message', message: { role: 'assistant', provider, model, stopReason, content: [] } });

const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';

describe("the models that wrote a branch's replies before its latest switch", () => {
  it('no switch gives no earlier runs', () => {
    expect(earlierModelRuns([], SONNET)).toEqual([]);
    expect(earlierModelRuns([user(), reply('anthropic', SONNET), user(), reply('anthropic', SONNET)], SONNET)).toEqual([]);
  });

  it("Sonnet then Haiku names Sonnet, before and after Haiku's reply", () => {
    const beforeHaiku = [user(), reply('anthropic', SONNET), modelChange('anthropic', HAIKU), user()];

    expect(earlierModelRuns(beforeHaiku, HAIKU)).toEqual([SONNET]);
    expect(earlierModelRuns([...beforeHaiku, reply('anthropic', HAIKU), user(), reply('anthropic', HAIKU)], HAIKU)).toEqual([SONNET]);
  });

  it('a switch away and back before any prompt gives none', () => {
    const branch = [user(), reply('anthropic', SONNET), modelChange('anthropic', HAIKU), modelChange('anthropic', SONNET), user()];

    expect(earlierModelRuns(branch, SONNET)).toEqual([]);
  });

  it('a return to a model after another replied names both, oldest first', () => {
    const branch = [user(), reply('anthropic', SONNET), user(), reply('anthropic', HAIKU), modelChange('anthropic', SONNET), user()];

    expect(earlierModelRuns(branch, SONNET)).toEqual([SONNET, HAIKU]);
    expect(earlierModelRuns([...branch, reply('anthropic', SONNET)], SONNET)).toEqual([SONNET, HAIKU]);
  });

  // pi-ai drops an errored or aborted assistant message from the next request, so the model never reads it.
  it('errored and aborted replies are no runs', () => {
    const branch = [user(), reply('anthropic', SONNET), user(), reply('anthropic', HAIKU, 'error'), user(), reply('anthropic', HAIKU, 'aborted'), user(), reply('anthropic', SONNET)];

    expect(earlierModelRuns(branch, HAIKU)).toEqual([SONNET]);
    expect(earlierModelRuns(branch, SONNET)).toEqual([]);
  });

  it('an OpenAI model on its key and on the ChatGPT sign-in is one run', () => {
    const branch = [user(), reply('anthropic', SONNET), user(), reply('openai', 'gpt-6.1-sol'), user(), reply('openai-codex', 'gpt-6.1-sol')];

    expect(earlierModelRuns(branch, HAIKU)).toEqual([SONNET, 'gpt-6.1-sol']);
  });

  it('a model outside the catalog is named by its pi id', () => {
    expect(earlierModelRuns([user(), reply('ollama', 'llama-local')], HAIKU)).toEqual(['llama-local']);
  });

  // pi's `getBranch()` still lists the entries a compaction summarized.
  it('compaction entries change nothing', () => {
    const before = [user(), reply('anthropic', SONNET), user(), reply('anthropic', HAIKU)];
    const compaction = entry({ type: 'compaction', summary: 'earlier work', firstKeptEntryId: 'e4', tokensBefore: 90_000 });

    expect(earlierModelRuns([...before.slice(0, 2), compaction, ...before.slice(2)], HAIKU)).toEqual(earlierModelRuns(before, HAIKU));
    expect(earlierModelRuns([...before, compaction], HAIKU)).toEqual([SONNET]);
  });

  // A session file is untrusted input.
  it('malformed entries are skipped', () => {
    const malformed = [
      entry({}),
      entry({ type: 'message' }),
      entry({ type: 'message', message: null }),
      entry({ type: 'message', message: { role: 'assistant', provider: 7, model: HAIKU } }),
      entry({ type: 'message', message: { role: 'assistant', provider: 'anthropic' } }),
      entry({ type: 'custom_message', message: { role: 'assistant', provider: 'anthropic', model: HAIKU } }),
    ];

    expect(earlierModelRuns([user(), reply('anthropic', SONNET), ...malformed, modelChange('anthropic', 'claude-opus-5-5')], 'claude-opus-5-5')).toEqual([SONNET]);
  });
});
