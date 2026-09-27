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

  it('documents the auto-maintained user profile, included once per context', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('<user_profile>');
    expect(MEMORY_SYSTEM_PROMPT).toContain('auto-maintained summary of the user');
    expect(MEMORY_SYSTEM_PROMPT).toContain('a static section for identity and environment plus a current-focus dynamic section');
    expect(MEMORY_SYSTEM_PROMPT).toContain('it never repeats preferences');
    expect(MEMORY_SYSTEM_PROMPT).toContain('Included once per context without needing to match the prompt, as many as fit a fixed budget');
    expect(MEMORY_SYSTEM_PROMPT).toContain('Others arrive when a prompt matches them.');
    expect(MEMORY_SYSTEM_PROMPT).toContain('They come back after the context is compacted.');
  });

  it('documents delta injection: once per context, updates, and what an absent block means', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('Each memory is shown once per context');
    expect(MEMORY_SYSTEM_PROMPT).toContain('<memory_updates>');
    expect(MEMORY_SYSTEM_PROMPT).toContain('forgotten by the user, or retired from memory');
    expect(MEMORY_SYSTEM_PROMPT).toContain('forgotten="true"');
    expect(MEMORY_SYSTEM_PROMPT).toContain('When a prompt carries no block, nothing new was relevant');
    expect(MEMORY_SYSTEM_PROMPT).toContain('<compact>');
    expect(MEMORY_SYSTEM_PROMPT).toContain('…[truncated: GetMemoryDetails <id>]');
  });

  it('makes no first-message, handoff or catalog statement anywhere', () => {
    expect(MEMORY_SYSTEM_PROMPT).not.toMatch(/first message/i);
    expect(MEMORY_SYSTEM_PROMPT).not.toMatch(/handoff/i);
    expect(MEMORY_SYSTEM_PROMPT).not.toMatch(/catalog/i);
  });

  it('documents the SaveMemory tool with kind/scope and steers preferences away from SaveNote', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('SaveMemory');
    expect(MEMORY_SYSTEM_PROMPT).toContain('do NOT use SaveNote for a preference');
  });

  it('documents search reranking and include_forgotten', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('semantically reranked');
    expect(MEMORY_SYSTEM_PROMPT).toContain('include_forgotten');
  });

  it('preserves the stale verification semantics', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('stale="true"');
    expect(MEMORY_SYSTEM_PROMPT).toContain('[stale]');
    expect(MEMORY_SYSTEM_PROMPT).toContain('ResetObservationStaleness');
  });

  it('preserves the observation-recording guidance', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('<recording_observations>');
    expect(MEMORY_SYSTEM_PROMPT).toContain('Record observations after:');
    expect(MEMORY_SYSTEM_PROMPT).toContain('Save observations for non-obvious decisions, reasoning, or caveats');
  });

  it('tells the agent to record lessons, never progress, and that files decide the workspace', () => {
    expect(MEMORY_SYSTEM_PROMPT).toContain('Never record progress or status');
    expect(MEMORY_SYSTEM_PROMPT).toContain('a title that states the lesson itself');
    expect(MEMORY_SYSTEM_PROMPT).toContain('Those files decide which workspace the observation is filed under');
  });
});
