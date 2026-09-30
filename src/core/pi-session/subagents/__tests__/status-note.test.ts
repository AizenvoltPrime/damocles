import { describe, it, expect } from 'vitest';
import { getStatusNote } from '../status-note';

describe('getStatusNote', () => {
  it('a user stop names the id and the resume call', () => {
    expect(getStatusNote('stopped', 'user', 'abc')).toBe(
      ' (STOPPED BY THE USER before completion; output is partial. Resume it with Agent({resume:"abc"}) if the user asks to continue.)',
    );
  });

  it('a shutdown stop names the panel close or window reload, not the user, and the resume call', () => {
    expect(getStatusNote('stopped', 'shutdown', 'abc')).toBe(
      ' (STOPPED before completion because its chat panel closed or the editor window reloaded; output is partial. Resume it with Agent({resume:"abc"}) if the user asks to continue.)',
    );
  });

  it('a budget stop says it cannot be resumed', () => {
    expect(getStatusNote('stopped', 'budget', 'abc')).toBe(
      ' (stopped by the budget limit before completion; output is partial and it cannot be resumed)',
    );
  });

  it('a reset stop names the cleared conversation and says it cannot be resumed', () => {
    expect(getStatusNote('stopped', 'reset', 'abc')).toBe(
      ' (stopped before completion because the conversation was cleared; output is partial and it cannot be resumed)',
    );
  });

  it('a stop with no recorded reason offers no resume', () => {
    expect(getStatusNote('stopped', undefined, 'abc')).toBe(' (STOPPED before completion; output is partial and the task was not finished)');
  });

  it('turn-limit outcomes keep their notes and a clean completion has none', () => {
    expect(getStatusNote('aborted', undefined, 'abc')).toContain('turn limit');
    expect(getStatusNote('steered', undefined, 'abc')).toContain('turn limit');
    expect(getStatusNote('completed', undefined, 'abc')).toBe('');
  });
});
