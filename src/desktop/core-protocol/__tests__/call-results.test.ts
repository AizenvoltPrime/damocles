import { describe, expect, it } from 'vitest';
import { CoreProtocolError, parsedCallText, SCM_CALL_LOCALIZED_TEXT, WORKTREE_CALL_LOCALIZED_TEXT } from '..';

describe('a scm.call or worktrees.call result main renders text from', () => {
  const labels = { current: { title: { message: 'Current' }, marker: 'Current' }, incoming: { title: { message: 'Incoming ({0})', args: ['main'] }, marker: 'main' }, base: { title: { message: 'Base' }, marker: 'Base' } };
  const inputs = { ok: true, base: '', current: 'a', incoming: 'b', labels, operation: 'merge' };

  it('reaches main as it came once its LocalizedText parses', () => {
    expect(parsedCallText('scm.call', 'mergeInputs', SCM_CALL_LOCALIZED_TEXT.mergeInputs, inputs)).toBe(inputs);
    expect(parsedCallText('scm.call', 'mergeInputs', SCM_CALL_LOCALIZED_TEXT.mergeInputs, { ok: false, reason: 'binary' })).toEqual({ ok: false, reason: 'binary' });
    const refused = { kind: 'refused', message: { message: 'git said: {0}', args: ['no'] } };
    expect(parsedCallText('worktrees.call', 'mergeInto', WORKTREE_CALL_LOCALIZED_TEXT.mergeInto, refused)).toBe(refused);
    expect(parsedCallText('worktrees.call', 'apply', WORKTREE_CALL_LOCALIZED_TEXT.apply, { kind: 'ok', files: [] })).toEqual({ kind: 'ok', files: [] });
  });

  it('fails the call at the parse when its text is not LocalizedText', () => {
    expect(() => parsedCallText('scm.call', 'mergeInputs', SCM_CALL_LOCALIZED_TEXT.mergeInputs, { ...inputs, labels: { ...labels, base: { title: 'Base' } } }))
      .toThrow(new CoreProtocolError('Core protocol violation: result of scm.call mergeInputs, whose .labels.base.title is not LocalizedText'));
    for (const method of ['mergeInto', 'rebaseOnto', 'updateFrom'] as const) {
      expect(() => parsedCallText('worktrees.call', method, WORKTREE_CALL_LOCALIZED_TEXT[method], { kind: 'refused', message: 'git said no' })).toThrow(CoreProtocolError);
    }
  });
});
