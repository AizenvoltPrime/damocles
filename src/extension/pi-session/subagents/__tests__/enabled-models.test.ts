import { describe, it, expect } from 'vitest';
import { resolveEnabledModels, isModelInScope } from '../enabled-models';

const registry = {
  getAvailableSnapshot: () => [
    { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Sonnet' },
    { provider: 'anthropic', id: 'claude-opus-4-8', name: 'Opus' },
    { provider: 'openai', id: 'gpt-5.6-terra', name: 'GPT' },
  ],
};

describe('resolveEnabledModels / isModelInScope', () => {
  it('returns undefined (no scope) when no patterns are given', () => {
    expect(resolveEnabledModels(undefined, registry)).toBeUndefined();
    expect(resolveEnabledModels([], registry)).toBeUndefined();
  });

  it('resolves exact provider/modelId patterns (case-insensitive) and validates scope', () => {
    const scope = resolveEnabledModels(['anthropic/claude-opus-4-8', 'OPENAI/GPT-5.6-TERRA'], registry);
    expect(scope).toBeDefined();
    expect(isModelInScope({ provider: 'anthropic', id: 'claude-opus-4-8' }, scope!)).toBe(true);
    expect(isModelInScope({ provider: 'openai', id: 'gpt-5.6-terra' }, scope!)).toBe(true);
    expect(isModelInScope({ provider: 'anthropic', id: 'claude-sonnet-5' }, scope!)).toBe(false);
  });

  it('denies all (empty set) when an allowlist is configured but nothing resolves', () => {
    // bare-id (no slash) and unmatched patterns resolve to nothing — a configured-but-unresolvable
    // allowlist must deny every model, NOT silently widen to "allow any" (undefined).
    const bare = resolveEnabledModels(['claude-opus-4-8'], registry);
    expect(bare).toBeInstanceOf(Set);
    expect(bare!.size).toBe(0);
    expect(isModelInScope({ provider: 'anthropic', id: 'claude-opus-4-8' }, bare!)).toBe(false);

    const unmatched = resolveEnabledModels(['anthropic/does-not-exist'], registry);
    expect(unmatched).toBeInstanceOf(Set);
    expect(unmatched!.size).toBe(0);
  });

  it('reserves undefined for "no allowlist configured" (allow any)', () => {
    expect(resolveEnabledModels(undefined, registry)).toBeUndefined();
    expect(resolveEnabledModels([], registry)).toBeUndefined();
  });

  it('reflects a registry change between calls (no stale caching)', () => {
    const dynamic = { models: [{ provider: 'anthropic', id: 'claude-opus-4-8', name: 'Opus' }], getAvailableSnapshot() { return this.models; } };
    // Model not present yet → configured allowlist resolves to nothing → deny-all (empty set).
    const before = resolveEnabledModels(['anthropic/gpt-x'], dynamic);
    expect(before).toBeInstanceOf(Set);
    expect(before!.size).toBe(0);
    // Provider/model becomes available → the very next call resolves it (no stale cache).
    dynamic.models.push({ provider: 'anthropic', id: 'gpt-x', name: 'GPT-X' });
    const after = resolveEnabledModels(['anthropic/gpt-x'], dynamic);
    expect(after && isModelInScope({ provider: 'anthropic', id: 'gpt-x' }, after)).toBe(true);
  });
});
