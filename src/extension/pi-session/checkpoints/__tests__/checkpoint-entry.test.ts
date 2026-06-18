import { describe, it, expect } from 'vitest';
import { getCheckpointEntries } from '../checkpoint-entry';
import type { CheckpointEntry } from '../types';

function validData(userEntryId: string, turnId: string): CheckpointEntry {
  return {
    v: 2,
    kind: 'checkpoint',
    turnId,
    userEntryId,
    beforeCommit: 'before-' + turnId,
    afterCommit: 'after-' + turnId,
    prompt: 'do the thing',
    fileCount: 1,
    fileChanges: [{ path: 'src/x.ts', added: 2, removed: 1 }],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function customEntry(customType: string, data: unknown): Record<string, unknown> {
  return { type: 'custom', id: 'cp', parentId: null, customType, data };
}

describe('getCheckpointEntries', () => {
  it('extracts valid checkpoint payloads in branch order', () => {
    const entries = [
      { type: 'message', id: 'u1', message: { role: 'user' } },
      customEntry('damocles-checkpoint', validData('u1', 't1')),
      { type: 'message', id: 'u2', message: { role: 'user' } },
      customEntry('damocles-checkpoint', validData('u2', 't2')),
    ];
    const result = getCheckpointEntries(entries);
    expect(result.map((c) => c.userEntryId)).toEqual(['u1', 'u2']);
    expect(result.map((c) => c.turnId)).toEqual(['t1', 't2']);
  });

  it('ignores custom entries with a different customType', () => {
    const entries = [customEntry('damocles-user-renamed', validData('u1', 't1'))];
    expect(getCheckpointEntries(entries)).toEqual([]);
  });

  it('ignores non-custom entries', () => {
    expect(getCheckpointEntries([{ type: 'message', id: 'u1' }])).toEqual([]);
  });

  it('rejects payloads with the wrong schema version', () => {
    const bad = { ...validData('u1', 't1'), v: 1 };
    expect(getCheckpointEntries([customEntry('damocles-checkpoint', bad)])).toEqual([]);
  });

  it('rejects payloads missing required string fields', () => {
    const bad = { ...validData('u1', 't1'), beforeCommit: 42 };
    expect(getCheckpointEntries([customEntry('damocles-checkpoint', bad)])).toEqual([]);
  });

  it('rejects payloads with a malformed fileChanges entry', () => {
    const bad = { ...validData('u1', 't1'), fileChanges: [{ path: 'x', added: 'nope', removed: 0 }] };
    expect(getCheckpointEntries([customEntry('damocles-checkpoint', bad)])).toEqual([]);
  });

  it('accepts an empty fileChanges array', () => {
    const data = { ...validData('u1', 't1'), fileCount: 0, fileChanges: [] };
    const result = getCheckpointEntries([customEntry('damocles-checkpoint', data)]);
    expect(result).toHaveLength(1);
    expect(result[0]?.fileChanges).toEqual([]);
  });

  it('tolerates non-record and null entries in the array', () => {
    const entries = [null, 'garbage', 42, customEntry('damocles-checkpoint', validData('u1', 't1'))];
    expect(getCheckpointEntries(entries)).toHaveLength(1);
  });

  it('drops a custom entry whose data is not an object', () => {
    expect(getCheckpointEntries([customEntry('damocles-checkpoint', 'not-an-object')])).toEqual([]);
  });
});
