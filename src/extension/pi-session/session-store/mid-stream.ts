import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { DAMOCLES_MID_STREAM_ENTRY } from './constants';

/** The payload Damocles persists for a user entry that was a delivered mid-stream queued batch. */
export interface MidStreamData {
  userEntryId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a persisted `.data` payload (untrusted: hand-edited JSONL, older versions). */
function isMidStreamData(value: unknown): value is MidStreamData {
  return isRecord(value) && typeof value['userEntryId'] === 'string' && value['userEntryId'].length > 0;
}

/**
 * Collect the set of user entry ids flagged as delivered mid-stream queued batches. Empty when the
 * session predates this feature or queued no messages mid-stream. Reads the same branch the message
 * path reads, so the replay styling stays in sync.
 */
export function extractMidStreamEntryIds(branch: readonly SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== DAMOCLES_MID_STREAM_ENTRY) continue;
    const data = (entry as { data?: unknown }).data;
    if (isMidStreamData(data)) ids.add(data.userEntryId);
  }
  return ids;
}
