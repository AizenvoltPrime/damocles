import type {
  CheckpointEntry,
  CheckpointEntryV2,
  CheckpointEntryV3,
  CheckpointRecord,
  FileChange,
  NotRewindableParams,
  NotRewindableRecord,
  PreRewindRecord,
  PreRewindTarget,
  SkippedPattern,
  SkippedSummary,
  SkippedTally,
  StoredCheckpointRecord,
} from './types';
import { isHexCommit, isSafeRefId } from './types';
import { isFolderId } from './resolver';

/** The pi `CustomEntry.customType` under which checkpoints are persisted in the session JSONL. */
const CHECKPOINT_CUSTOM_TYPE = 'damocles-checkpoint';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

/** Exactly `required` plus any of `optional`, so an older or foreign shape is refused. */
function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((k) => k in value) && keys.every((k) => required.includes(k) || optional.includes(k));
}

function isFileChange(value: unknown): value is FileChange {
  return isRecord(value) && isString(value['path']) && isFiniteNumber(value['added']) && isFiniteNumber(value['removed']);
}

function isSkippedTally(value: unknown): value is SkippedTally {
  return isRecord(value) && hasOnlyKeys(value, ['count', 'bytes']) && isCount(value['count']) && isCount(value['bytes']);
}

function isSkippedPattern(value: unknown): value is SkippedPattern {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['pattern', 'reason', 'count', 'bytes']) &&
    isString(value['pattern']) &&
    (value['reason'] === 'category' || value['reason'] === 'lfs') &&
    isCount(value['count']) &&
    isCount(value['bytes'])
  );
}

function isSkippedSummary(value: unknown): value is SkippedSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, ['totalCount', 'totalBytes', 'byReason', 'patterns', 'manifest'])) return false;
  const byReason = value['byReason'];
  const patterns = value['patterns'];
  const manifest = value['manifest'];
  return (
    isCount(value['totalCount']) &&
    isCount(value['totalBytes']) &&
    isRecord(byReason) &&
    hasOnlyKeys(byReason, [], ['size', 'category', 'lfs']) &&
    Object.values(byReason).every(isSkippedTally) &&
    Array.isArray(patterns) &&
    patterns.every(isSkippedPattern) &&
    (manifest === null || (isString(manifest) && isHexCommit(manifest))) &&
    (manifest === null) === (value['totalCount'] === 0)
  );
}

/** The fields v2 and v3 checkpoints share. */
function hasCheckpointFields(value: Record<string, unknown>): boolean {
  return (
    value['kind'] === 'checkpoint' &&
    isString(value['turnId']) &&
    isString(value['userEntryId']) &&
    isString(value['beforeCommit']) &&
    isString(value['afterCommit']) &&
    isString(value['prompt']) &&
    isFiniteNumber(value['fileCount']) &&
    Array.isArray(value['fileChanges']) &&
    value['fileChanges'].every(isFileChange) &&
    isString(value['createdAt'])
  );
}

/**
 * Runtime guards for a `.data` payload. Persisted data is untrusted (older versions, hand-edited
 * JSONL), so every field is checked. A v3 entry fails the v2 check, so a build that only knows v2
 * ignores it rather than resolving it to a per-session repo.
 */
function isCheckpointEntryV2(value: unknown): value is CheckpointEntryV2 {
  return isRecord(value) && value['v'] === 2 && hasCheckpointFields(value);
}

function isCheckpointEntryV3(value: unknown): value is CheckpointEntryV3 {
  return (
    isRecord(value) &&
    value['v'] === 3 &&
    hasCheckpointFields(value) &&
    isHexCommit(value['beforeCommit'] as string) &&
    isHexCommit(value['afterCommit'] as string) &&
    value['repo'] === 'folder' &&
    isString(value['folderId']) &&
    isFolderId(value['folderId']) &&
    isSkippedSummary(value['skipped'])
  );
}

function isNotRewindableParams(value: unknown): value is NotRewindableParams {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [], ['tool', 'waitSeconds', 'error']) &&
    (value['tool'] === undefined || isString(value['tool'])) &&
    (value['waitSeconds'] === undefined || isCount(value['waitSeconds'])) &&
    (value['error'] === undefined || isString(value['error']))
  );
}

function isNotRewindableRecord(value: unknown): value is NotRewindableRecord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['v', 'kind', 'userEntryId', 'reason', 'params', 'createdAt']) &&
    value['v'] === 3 &&
    value['kind'] === 'not-rewindable' &&
    isString(value['userEntryId']) &&
    (value['reason'] === 'baseline-timeout' || value['reason'] === 'baseline-failed') &&
    isNotRewindableParams(value['params']) &&
    isString(value['createdAt'])
  );
}

function isPreRewindTarget(value: unknown): value is PreRewindTarget {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'turn') return hasOnlyKeys(value, ['kind', 'userEntryId']) && isString(value['userEntryId']);
  if (value['kind'] === 'undo') return hasOnlyKeys(value, ['kind', 'preRewindId']) && isString(value['preRewindId']) && isSafeRefId(value['preRewindId']);
  return false;
}

function isPreRewindRecord(value: unknown): value is PreRewindRecord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['v', 'kind', 'id', 'folderId', 'commit', 'skipped', 'target', 'createdAt']) &&
    value['v'] === 3 &&
    value['kind'] === 'pre-rewind' &&
    isString(value['id']) &&
    isSafeRefId(value['id']) &&
    isString(value['folderId']) &&
    isFolderId(value['folderId']) &&
    isString(value['commit']) &&
    isHexCommit(value['commit']) &&
    isSkippedSummary(value['skipped']) &&
    isPreRewindTarget(value['target']) &&
    isString(value['createdAt'])
  );
}

/** The valid record data of every `damocles-checkpoint` custom entry, in array order. */
function storedRecords(entries: readonly unknown[]): StoredCheckpointRecord[] {
  const result: StoredCheckpointRecord[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry['type'] !== 'custom' || entry['customType'] !== CHECKPOINT_CUSTOM_TYPE) continue;
    const data = entry['data'];
    if (isCheckpointEntryV2(data) || isCheckpointEntryV3(data) || isNotRewindableRecord(data) || isPreRewindRecord(data)) result.push(data);
  }
  return result;
}

/**
 * Every valid turn record (checkpoints and not-rewindable records) in a pi session entry array, in array
 * order; pre-rewind records are left out. The input is typed `unknown[]` so callers can pass raw pi
 * entries without coupling this module to the pi types.
 */
export function getCheckpointRecords(entries: readonly unknown[]): readonly CheckpointRecord[] {
  return storedRecords(entries).filter((r): r is CheckpointRecord => r.kind !== 'pre-rewind');
}

/** The checkpoints (v2 and v3) among `entries`, in order; not-rewindable and pre-rewind records are left out. */
export function getCheckpointEntries(entries: readonly unknown[]): readonly CheckpointEntry[] {
  return storedRecords(entries).filter((r): r is CheckpointEntry => r.kind === 'checkpoint');
}

/** The not-rewindable records among `entries`, in order. */
export function getNotRewindableEntries(entries: readonly unknown[]): readonly NotRewindableRecord[] {
  return storedRecords(entries).filter((r): r is NotRewindableRecord => r.kind === 'not-rewindable');
}

/** The pre-rewind records among `entries`, in order. */
export function getPreRewindEntries(entries: readonly unknown[]): readonly PreRewindRecord[] {
  return storedRecords(entries).filter((r): r is PreRewindRecord => r.kind === 'pre-rewind');
}
