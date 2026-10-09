import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { recordedSelection } from '../recorded-selection';

const entry = (value: Record<string, unknown>): SessionEntry => value as unknown as SessionEntry;
const modelChange = (provider: string, modelId: string) => entry({ type: 'model_change', provider, modelId });
const thinking = (thinkingLevel: string) => entry({ type: 'thinking_level_change', thinkingLevel });
const user = () => entry({ type: 'message', message: { role: 'user', content: 'hi' } });
const reply = (provider: string, model: string) => entry({ type: 'message', message: { role: 'assistant', provider, model, content: [] } });

describe("a branch's recorded model and thinking level (pi's resume rule)", () => {
  it('takes the latest model change or assistant reply, and the latest thinking level change', () => {
    expect(recordedSelection([modelChange('anthropic', 'claude-opus-5-5'), thinking('high'), user(), reply('anthropic', 'claude-opus-5-5'), modelChange('openai-codex', 'gpt-6.1-sol'), thinking('xhigh')]))
      .toEqual({ model: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' }, thinkingLevel: 'xhigh' });
    expect(recordedSelection([modelChange('anthropic', 'claude-opus-5-5'), user(), reply('deepseek', 'deepseek-v4-pro')]))
      .toEqual({ model: { provider: 'deepseek', modelId: 'deepseek-v4-pro' }, thinkingLevel: undefined });
  });

  it('is undefined for a branch with no message, as pi starts a new session on its defaults', () => {
    expect(recordedSelection([modelChange('anthropic', 'claude-opus-5-5'), thinking('high')])).toBeUndefined();
    expect(recordedSelection([])).toBeUndefined();
  });

  it('ignores a malformed entry, since a session file is untrusted input', () => {
    expect(recordedSelection([user(), entry({ type: 'model_change', provider: 7, modelId: 'x' }), entry({ type: 'thinking_level_change', thinkingLevel: null })]))
      .toEqual({ model: undefined, thinkingLevel: undefined });
  });
});
