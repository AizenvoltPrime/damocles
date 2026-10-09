import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY } from './constants';

/** The payload Damocles persists for a prompt sent with terminal attachments: how many blocks lead its stored text. */
export interface TerminalAttachmentsData {
  userEntryId: string;
  count: number;
}

/** Validate a persisted `.data` payload (untrusted: hand-edited JSONL, older versions). */
export function isTerminalAttachmentsData(value: unknown): value is TerminalAttachmentsData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return typeof data['userEntryId'] === 'string' && data['userEntryId'].length > 0 && Number.isInteger(data['count']) && (data['count'] as number) > 0;
}

/**
 * Map each user entry id to the number of terminal attachment blocks its prompt carries. Only an entry listed here has
 * blocks stripped from its text, so typed text that imitates a block stays text.
 */
export function extractTerminalAttachmentCounts(branch: readonly SessionEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY) continue;
    const data = (entry as { data?: unknown }).data;
    if (isTerminalAttachmentsData(data)) map.set(data.userEntryId, data.count);
  }
  return map;
}
