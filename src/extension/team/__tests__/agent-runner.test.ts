import { describe, it, expect } from 'vitest';
import { resolveAgentModel } from '../agent-runner';
import { DEFAULT_MODELS } from '../../../shared/types/constants';
import type { ModelInfo } from '../../../shared/types/settings';

/** Mirrors session.getModelInfo: looks up the bare model value in the curated catalog. */
const resolveModelInfo = (m: string): ModelInfo | undefined => DEFAULT_MODELS.find((x) => x.value === m);

describe('resolveAgentModel (team 1M-context suffix)', () => {
  it('appends [1m] to an inherited always-1M Anthropic model (Opus 4.8)', () => {
    expect(resolveAgentModel('claude-opus-4-8', resolveModelInfo)).toBe('claude-opus-4-8[1m]');
  });

  it('appends [1m] to Fable 5 (always-1M)', () => {
    expect(resolveAgentModel('claude-fable-5', resolveModelInfo)).toBe('claude-fable-5[1m]');
  });

  it('leaves non-1M models unchanged', () => {
    expect(resolveAgentModel('claude-sonnet-4-6', resolveModelInfo)).toBe('claude-sonnet-4-6');
    expect(resolveAgentModel('claude-haiku-4-5-20251001', resolveModelInfo)).toBe('claude-haiku-4-5-20251001');
  });

  it('does not double-suffix an already-[1m] model', () => {
    expect(resolveAgentModel('claude-opus-4-8[1m]', resolveModelInfo)).toBe('claude-opus-4-8[1m]');
  });

  it('returns the model unchanged when no resolver is provided', () => {
    expect(resolveAgentModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});
