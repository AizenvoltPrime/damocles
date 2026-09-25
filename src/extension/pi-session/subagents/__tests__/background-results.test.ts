import { describe, it, expect } from 'vitest';
import { backgroundResultsDetails, formatBackgroundResults, SUBAGENT_RESULTS_CUSTOM_TYPE } from '../background-results';
import type { AgentRecord } from '../types';

function rec(over: Partial<AgentRecord>): AgentRecord {
  return {
    id: 'a1', type: 'Explore', description: 'find things', status: 'completed', toolCallId: 'tc1',
    toolUses: 0, startedAt: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, costUsd: 0, compactionCount: 0,
    ...over,
  };
}

describe('formatBackgroundResults', () => {
  it('renders each record as a labelled block with its result text', () => {
    const out = formatBackgroundResults([
      rec({ type: 'Explore', description: 'vehicles', result: 'found A, B' }),
      rec({ id: 'a2', type: 'Explore', description: 'personnel', result: 'found C' }),
    ]);
    expect(out).toContain('## Explore — vehicles\nfound A, B');
    expect(out).toContain('## Explore — personnel\nfound C');
    expect(out).toContain('The background subagents you launched are no longer running.');
  });

  it('uses singular phrasing and shows the error text of a failed agent', () => {
    const out = formatBackgroundResults([rec({ status: 'error', result: undefined, error: 'boom' })]);
    expect(out).toContain('The background subagent you launched is no longer running.');
    expect(out).toContain('## Explore — find things\nboom');
  });

  it('shows "(no output)" for a clean completion with no text', () => {
    expect(formatBackgroundResults([rec({ result: undefined })])).toContain('## Explore — find things\n(no output)');
  });

  it('a user stop from Background Tasks tells the model the output is partial and how to resume', () => {
    const out = formatBackgroundResults([rec({ id: 'a9', status: 'stopped', stopReason: 'user', result: 'half done' })]);
    expect(out).toContain(
      '## Explore — find things\nhalf done (STOPPED BY THE USER before completion; output is partial. Resume it with Agent({resume:"a9"}) if the user asks to continue.)',
    );
    expect(out).not.toContain('finished');
  });

  it('a user stop before any output still carries the stop note', () => {
    const out = formatBackgroundResults([rec({ id: 'a9', status: 'stopped', stopReason: 'user', result: undefined })]);
    expect(out).toContain('## Explore — find things\n(STOPPED BY THE USER before completion;');
  });

  it('a turn-limit outcome carries its note', () => {
    const out = formatBackgroundResults([rec({ status: 'aborted', result: 'partial list' })]);
    expect(out).toContain('## Explore — find things\npartial list (aborted — hit the turn limit before completion; output may be incomplete)');
  });

  it('prefixes user-steer lines into the record block so the parent sees mid-task redirects', () => {
    const out = formatBackgroundResults([
      rec({ type: 'Explore', description: 'vehicles', result: 'found A', userSteers: [{ message: 'focus on tests' }, { message: 'skip UI' }] }),
    ]);
    expect(out).toContain('## Explore — vehicles\n[User steered this agent mid-task: "focus on tests"]\n[User steered this agent mid-task: "skip UI"]\nfound A');
  });

  it('exports a stable custom-message type', () => {
    expect(SUBAGENT_RESULTS_CUSTOM_TYPE).toBe('damocles-subagent-results');
  });
});

describe('backgroundResultsDetails', () => {
  it('lists each finished agent with its invoking tool call, status, stop reason and final text', () => {
    const details = backgroundResultsDetails([
      rec({ id: 'a1', toolCallId: 'tc1', status: 'completed', result: 'found A' }),
      rec({ id: 'a2', toolCallId: 'tc2', status: 'stopped', stopReason: 'user', result: 'half' }),
      rec({ id: 'a3', toolCallId: 'tc3', status: 'error', result: undefined, error: 'no model' }),
    ]);
    expect(details.agents).toEqual([
      { agentId: 'a1', toolCallId: 'tc1', status: 'completed', result: 'found A' },
      { agentId: 'a2', toolCallId: 'tc2', status: 'stopped', stopReason: 'user', result: expect.stringMatching(/^half \(STOPPED BY THE USER/) },
      { agentId: 'a3', toolCallId: 'tc3', status: 'error', result: 'no model' },
    ]);
  });
});
