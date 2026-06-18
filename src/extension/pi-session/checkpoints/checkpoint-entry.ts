import type { CheckpointEntry, FileChange } from './types';

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

function isFileChange(value: unknown): value is FileChange {
  return isRecord(value) && isString(value['path']) && isFiniteNumber(value['added']) && isFiniteNumber(value['removed']);
}

/**
 * Runtime guard validating that an arbitrary `.data` payload matches the `CheckpointEntry` shape.
 * Persisted data is untrusted (older versions, hand-edited JSONL), so every field is checked,
 * including the `v: 2` schema tag and each entry of `fileChanges`.
 */
function isCheckpointEntry(value: unknown): value is CheckpointEntry {
  if (!isRecord(value)) return false;
  return (
    value['v'] === 2 &&
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
 * Extract the valid checkpoint records from a pi session entry array, preserving branch order. We
 * select custom entries tagged `damocles-checkpoint`, then validate each entry's `data` payload and
 * drop anything malformed. The input is typed `unknown[]` so callers can pass raw pi entries without
 * coupling this module to the pi types.
 */
export function getCheckpointEntries(entries: readonly unknown[]): readonly CheckpointEntry[] {
  const result: CheckpointEntry[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry['type'] !== 'custom' || entry['customType'] !== CHECKPOINT_CUSTOM_TYPE) continue;
    const data = entry['data'];
    if (isCheckpointEntry(data)) result.push(data);
  }
  return result;
}
