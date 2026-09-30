import { describe, it, expect } from 'vitest';
import { getCheckpointEntries, getCheckpointRecords, getNotRewindableEntries, getPreRewindEntries } from '../checkpoint-entry';
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

const FOLDER_ID = '0123456789abcdef';
const MANIFEST = 'b'.repeat(40);

function skipped(): Record<string, unknown> {
  return {
    totalCount: 2,
    totalBytes: 40,
    byReason: { size: { count: 1, bytes: 30 }, category: { count: 1, bytes: 10 } },
    patterns: [{ pattern: '*.mp4', reason: 'category', count: 1, bytes: 10 }],
    manifest: MANIFEST,
  };
}

function v3(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...validData('u1', 't1'), v: 3, beforeCommit: 'd'.repeat(40), afterCommit: 'e'.repeat(40), repo: 'folder', folderId: FOLDER_ID, skipped: skipped(), ...extra };
}

function preRewind(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 3, kind: 'pre-rewind', id: '1750000000000-abcd1234', folderId: FOLDER_ID, commit: 'c'.repeat(40), skipped: skipped(),
    target: { kind: 'turn', userEntryId: 'u1' }, createdAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}

const notRewindable = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 3, kind: 'not-rewindable', userEntryId: 'u2', reason: 'baseline-timeout', params: { tool: 'Edit', waitSeconds: 30 }, createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});

describe('v3 record validators', () => {
  const one = (data: unknown): unknown[] => [customEntry('damocles-checkpoint', data)];

  it('accepts a v3 entry whose skipped summary carries counts, bytes and the manifest id', () => {
    expect(getCheckpointEntries(one(v3()))).toHaveLength(1);
    expect(getCheckpointEntries(one(v3({ skipped: { totalCount: 0, totalBytes: 0, byReason: {}, patterns: [], manifest: null } })))).toHaveLength(1);
  });

  it('rejects a v3 entry whose commits are not object ids', () => {
    expect(getCheckpointEntries(one(v3({ beforeCommit: 'HEAD~1' })))).toEqual([]);
    expect(getCheckpointEntries(one(v3({ afterCommit: '--orphan' })))).toEqual([]);
  });

  it.each([
    ['the earlier shape with a files array', { ...skipped(), files: [{ path: 'a', bytes: 1, reason: 'size' }] }],
    ['patterns without bytes', { ...skipped(), patterns: [{ pattern: '*.mp4', reason: 'category', count: 1 }] }],
    ['a manifest that is not an object id', { ...skipped(), manifest: '--upload-pack=x' }],
    ['a manifest with nothing skipped', { ...skipped(), totalCount: 0 }],
    ['no manifest while files were skipped', { ...skipped(), manifest: null }],
    ['an unknown reason bucket', { ...skipped(), byReason: { huge: { count: 1, bytes: 1 } } }],
    ['a negative count', { ...skipped(), totalCount: -1 }],
  ])('rejects a v3 entry whose skipped summary has %s, without throwing', (_label, summary) => {
    expect(getCheckpointEntries(one(v3({ skipped: summary })))).toEqual([]);
  });

  it('reads a not-rewindable record with reason and params, and rejects the free-text detail shape', () => {
    expect(getNotRewindableEntries(one(notRewindable()))).toHaveLength(1);
    expect(getNotRewindableEntries(one(notRewindable({ params: { error: 'fatal: index.lock exists' } })))).toHaveLength(1);
    const { params: _params, ...withoutParams } = notRewindable();
    expect(getNotRewindableEntries(one({ ...withoutParams, detail: 'Edit waited 30 s' }))).toEqual([]);
    expect(getNotRewindableEntries(one(notRewindable({ params: { waitSeconds: '30' } })))).toEqual([]);
    expect(getNotRewindableEntries(one(notRewindable({ params: { note: 'free text' } })))).toEqual([]);
  });

  it('reads pre-rewind records only through getPreRewindEntries; turn readers and the fork carry never see them', () => {
    const entries = [...one(v3()), ...one(preRewind()), ...one(notRewindable())];
    expect(getPreRewindEntries(entries)).toEqual([preRewind()]);
    expect(getCheckpointEntries(entries).map((e) => e.kind)).toEqual(['checkpoint']);
    expect(getCheckpointRecords(entries).map((e) => e.kind)).toEqual(['checkpoint', 'not-rewindable']);
    expect(getPreRewindEntries(one(preRewind({ target: { kind: 'undo', preRewindId: '1750000000001-abcd1234' } })))).toHaveLength(1);
  });

  it.each([
    ['an id unsafe for a ref', { id: '../x' }],
    ['a commit that is not hex', { commit: 'HEAD' }],
    ['a folder id that is not one', { folderId: 'x' }],
    ['an unknown target kind', { target: { kind: 'branch', name: 'main' } }],
    ['an undo target with an unsafe id', { target: { kind: 'undo', preRewindId: '-x' } }],
    ['an extra field', { note: 'x' }],
    ['the old skipped shape', { skipped: { files: [], totalCount: 0, totalBytes: 0 } }],
  ])('rejects a pre-rewind record with %s', (_label, extra) => {
    expect(getPreRewindEntries(one(preRewind(extra)))).toEqual([]);
  });
});
