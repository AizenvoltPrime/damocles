import { describe, it, expect } from 'vitest';
import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from '@shared/types/constants';
import { CANCELLED_TOOL_DETAIL_KEY } from '@shared/types/session';
import type { HistoryToolCall } from '@shared/types/content';
import { convertHistoryTools } from '../utils';

/**
 * Replay rebuilds a tool card from the two facts a transcript keeps: whether a result was recorded and
 * whether it was an error. Every status here has to be derivable from those two, because a card that
 * claims more than the transcript holds is read as the truth about a session nobody can re-run.
 */

function convert(tool: HistoryToolCall): NonNullable<ReturnType<typeof convertHistoryTools>>[number] {
  const [converted] = convertHistoryTools([tool]) ?? [];
  if (!converted) throw new Error('convertHistoryTools dropped the call it was given');
  return converted;
}

const CALL: HistoryToolCall = { id: 't-1', name: 'Bash', input: { command: 'ls' } };

describe('convertHistoryTools', () => {
  it('marks a call with no recorded result unrecorded rather than completed', () => {
    const call = convert(CALL);

    expect(call.status).toBe('unrecorded');
    expect(call.result).toBeUndefined();
  });

  it('never gives such a call a pre-terminal status, which renders it as still running', () => {
    const status = convert(CALL).status;

    expect(status).not.toBe('pending');
    expect(status).not.toBe('running');
  });

  it('keeps an empty result as a real outcome, since a tool may legitimately return nothing', () => {
    expect(convert({ ...CALL, result: '' }).status).toBe('completed');
  });

  it('restores a recorded success as completed', () => {
    expect(convert({ ...CALL, result: 'a.ts\nb.ts', isError: false }).status).toBe('completed');
  });

  it('restores an ordinary error as failed, not as a denial the user never made', () => {
    const call = convert({ ...CALL, result: 'ENOENT: no such file or directory', isError: true });

    expect(call.status).toBe('failed');
    expect(call.feedback).toBeUndefined();
  });

  it('restores a rejection at the approval prompt as denied, with the reason the user gave', () => {
    const result = `The user doesn't want to proceed with this tool use. The tool use was rejected. ${FEEDBACK_MARKER} not that file`;
    const call = convert({ ...CALL, result, isError: true });

    expect(call.status).toBe('denied');
    expect(call.feedback).toBe('not that file');
  });

  it('restores an automatic policy block as denied too', () => {
    const result = `This tool call was blocked automatically and the user was not consulted. ${POLICY_BLOCK_MARKER} Plan mode is active.`;

    expect(convert({ ...CALL, result, isError: true }).status).toBe('denied');
  });

  it('keeps a feedback string the transcript already carried', () => {
    const call = convert({ ...CALL, result: 'rejected', isError: true, feedback: 'use Edit instead' });

    expect(call.status).toBe('denied');
    expect(call.feedback).toBe('use Edit instead');
  });

  it('restores a command the user stopped as stopped rather than as a success', () => {
    const call = convert({ ...CALL, result: 'partial output', metadata: { [CANCELLED_TOOL_DETAIL_KEY]: true } });

    expect(call.status).toBe('cancelled');
  });
});
