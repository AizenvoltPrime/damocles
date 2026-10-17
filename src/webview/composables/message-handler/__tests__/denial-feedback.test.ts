import { describe, it, expect } from 'vitest';
import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from '@shared/types/constants';
import { convertHistoryTools, extractDenialFeedback, refusedStatus } from '../utils';

/**
 * The webview keys "denied" vs "failed" purely on finding a denial marker in the tool error, and shows
 * the text after it as the reason. Two markers exist so the model is never told a human rejected
 * something the runtime blocked on its own; both must still render as denied.
 */
describe('extractDenialFeedback', () => {
  it('extracts a human approval-prompt rejection', () => {
    const err = `The user doesn't want to proceed with this tool use. The tool use was rejected. ${FEEDBACK_MARKER} not that file`;
    expect(extractDenialFeedback(err)).toEqual({ kind: 'feedback', text: 'not that file' });
  });

  it('extracts an automatic policy block', () => {
    const err = `This tool call was blocked automatically and the user was not consulted. ${POLICY_BLOCK_MARKER} Plan mode is active.`;
    expect(extractDenialFeedback(err)).toEqual({ kind: 'policy', text: 'Plan mode is active.' });
  });

  it('keeps rendering sessions recorded before the policy marker existed', () => {
    // Historic transcripts carry ONLY the feedback marker, including on blocks that are really policy
    // decisions — those must not regress from "denied" to "failed" on replay.
    const legacy = `The user doesn't want to proceed with this tool use. The tool use was rejected. ${FEEDBACK_MARKER} Plan mode is active — only read-only tools are allowed until you exit the plan.`;
    expect(extractDenialFeedback(legacy)).toEqual({ kind: 'feedback', text: 'Plan mode is active — only read-only tools are allowed until you exit the plan.' });
  });

  it('returns undefined for an ordinary tool failure so it renders as failed', () => {
    expect(extractDenialFeedback('ENOENT: no such file or directory')).toBeUndefined();
  });

  // Rule 10: every policy block, the worktree isolation's included, is a Blocked card, never a human rejection.
  it('maps a policy block to the blocked status and a human rejection to denied', () => {
    expect(refusedStatus({ kind: 'policy', text: 'x' })).toBe('blocked');
    expect(refusedStatus({ kind: 'feedback', text: 'x' })).toBe('denied');
  });

  it('replays a recorded policy block as blocked with its reason', () => {
    const reason = 'This chat works in its worktree.';
    const [tool] = convertHistoryTools([{ id: 't1', name: 'Edit', input: {}, isError: true, result: `${POLICY_BLOCK_MARKER} ${reason}` }])!;
    expect(tool).toMatchObject({ status: 'blocked', feedback: reason });
  });
});
