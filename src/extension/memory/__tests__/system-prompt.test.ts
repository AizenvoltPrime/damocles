import { describe, it, expect } from 'vitest';
import { MEMORY_SYSTEM_PROMPT } from '../system-prompt';

describe('MEMORY_SYSTEM_PROMPT — scope/kind + versioning/forget/profile model', () => {
  it('documents the new kind and scope model, not the old tiers', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('Every memory has a KIND and a SCOPE');
    expect(MEMORY_SYSTEM_PROMPT).toContain('fact, preference, observation, note, or episode');
    expect(MEMORY_SYSTEM_PROMPT).toContain('session, project, or global');
    expect(MEMORY_SYSTEM_PROMPT).not.toContain('memory tiers');
  });

  it('documents auto-extraction during consolidation', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('AUTO-EXTRACTION');
    expect(MEMORY_SYSTEM_PROMPT).toContain('extracted automatically from the conversation during consolidation');
  });

  it('documents versioning and the get_memory_history tool', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('VERSIONING');
    expect(MEMORY_SYSTEM_PROMPT).toContain('SUPERSEDES');
    expect(MEMORY_SYSTEM_PROMPT).toContain('GetMemoryHistory');
  });

  it('documents the forget tool and its default chain scope', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('ForgetMemory');
    expect(MEMORY_SYSTEM_PROMPT).toContain('default scope is chain');
    expect(MEMORY_SYSTEM_PROMPT).toContain('scope "version"');
  });

  it('documents the related-memories traversal tool', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('GetRelatedMemories');
    expect(MEMORY_SYSTEM_PROMPT).toContain('fact graph');
  });

  it('documents the auto-maintained user profile injected on the first message', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('<user_profile>');
    expect(MEMORY_SYSTEM_PROMPT).toContain('auto-maintained summary of the user');
    expect(MEMORY_SYSTEM_PROMPT).toContain('static section plus a recent-activity dynamic section');
  });

  it('documents the SaveMemory tool with kind/scope and steers preferences away from SaveNote', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('SaveMemory');
    expect(MEMORY_SYSTEM_PROMPT).toContain('do NOT use SaveNote for a preference');
  });

  it('documents search reranking and include_forgotten', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('semantically reranked');
    expect(MEMORY_SYSTEM_PROMPT).toContain('include_forgotten');
  });

  it('preserves the [stale] verification semantics', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('[stale]');
    expect(MEMORY_SYSTEM_PROMPT).toContain('ResetObservationStaleness');
  });

  it('preserves the observation-recording guidance', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('<recording_observations>');
    expect(MEMORY_SYSTEM_PROMPT).toContain('Record observations after:');
    expect(MEMORY_SYSTEM_PROMPT).toContain('Save observations for non-obvious decisions, reasoning, or caveats');
  });
});
