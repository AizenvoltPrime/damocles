import { describe, it, expect } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { DAMOCLES_TURN_STOPPED_ENTRY } from '../constants';
import { stoppedOnBranch, turnStoppedRecord } from '../turn-stopped';

const assistantError = (id: string): SessionEntry =>
  ({ type: 'message', id, message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'x' } }) as unknown as SessionEntry;
const toolResult = (id: string): SessionEntry =>
  ({ type: 'message', id, message: { role: 'toolResult', toolCallId: 'tc-1', content: [], isError: true } }) as unknown as SessionEntry;
const record = (id: string, data: unknown): SessionEntry =>
  ({ type: 'custom', id, customType: DAMOCLES_TURN_STOPPED_ENTRY, data }) as unknown as SessionEntry;

describe('turnStoppedRecord', () => {
  it('keeps only the assistant errors written after the leaf at Stop', () => {
    const branch = [assistantError('before'), toolResult('leaf'), toolResult('r2'), assistantError('after')];
    expect(turnStoppedRecord(branch, 'leaf', ['tc-1'])).toEqual({ toolCallIds: ['tc-1'], entryIds: ['after'] });
  });

  it('records no entries when the leaf at Stop is unknown or no longer on the branch', () => {
    const branch = [toolResult('r1'), assistantError('after')];
    expect(turnStoppedRecord(branch, null, ['tc-1'])).toEqual({ toolCallIds: ['tc-1'], entryIds: [] });
    expect(turnStoppedRecord(branch, 'gone', ['tc-1'])).toEqual({ toolCallIds: ['tc-1'], entryIds: [] });
  });

  it('is null when the Stop cut nothing short', () => {
    expect(turnStoppedRecord([toolResult('leaf')], 'leaf', [])).toBeNull();
  });
});

describe('stoppedOnBranch', () => {
  it('merges every record and skips a malformed payload', () => {
    const branch = [
      record('s1', { toolCallIds: ['a'], entryIds: ['e1'] }),
      record('s2', { toolCallIds: 'a', entryIds: [] }),
      record('s3', { toolCallIds: ['b'], entryIds: [] }),
    ];
    const stopped = stoppedOnBranch(branch);
    expect([...stopped.toolCallIds]).toEqual(['a', 'b']);
    expect([...stopped.entryIds]).toEqual(['e1']);
  });
});
