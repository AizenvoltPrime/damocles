import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { DAMOCLES_ORIGINAL_INPUT_ENTRY } from './constants';

/** The payload Damocles persists for a turn whose typed input was expanded before pi stored it. */
export interface OriginalInputData {
  userEntryId: string;
  original: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a persisted `.data` payload (untrusted: hand-edited JSONL, older versions). */
function isOriginalInputData(value: unknown): value is OriginalInputData {
  return (
    isRecord(value) &&
    typeof value['userEntryId'] === 'string' &&
    value['userEntryId'].length > 0 &&
    typeof value['original'] === 'string'
  );
}

/**
 * Map each user entry id to the original typed input Damocles recorded for it (latest wins, so a forked
 * branch's re-record supersedes a stale one). Empty when the session predates this feature or used no
 * slash commands. Reads the same branch the message/preview paths read, so substitution stays in sync.
 */
export function extractOriginalInputs(branch: readonly SessionEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== DAMOCLES_ORIGINAL_INPUT_ENTRY) continue;
    const data = (entry as { data?: unknown }).data;
    if (isOriginalInputData(data)) map.set(data.userEntryId, data.original);
  }
  return map;
}
