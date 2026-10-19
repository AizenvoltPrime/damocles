import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY } from './constants';

/**
 * The payload Damocles persists for a prompt sent with attachments: how many blocks lead its stored text, and how
 * many of its images, the last ones, are the attachments' own (an attached image resource), which their chips stand for.
 * `images` is written only when pi stored every image the prompt was given.
 */
export interface TerminalAttachmentsData {
  userEntryId: string;
  count: number;
  images?: number;
}

const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

/** A persisted `.data` payload (untrusted: hand-edited JSONL, older versions); a malformed `images` drops only that field. */
function readAttachmentsData(value: unknown): TerminalAttachmentsData | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { userEntryId, count, images } = value as Record<string, unknown>;
  if (typeof userEntryId !== 'string' || userEntryId.length === 0 || !isPositiveInteger(count)) return null;
  return { userEntryId, count, ...(isPositiveInteger(images) ? { images } : {}) };
}

function attachmentData(branch: readonly SessionEntry[]): TerminalAttachmentsData[] {
  return branch.flatMap((entry) => {
    if (entry.type !== 'custom' || entry.customType !== DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY) return [];
    const data = readAttachmentsData((entry as { data?: unknown }).data);
    return data ? [data] : [];
  });
}

/**
 * Map each user entry id to the number of terminal attachment blocks its prompt carries. Only an entry listed here has
 * blocks stripped from its text, so typed text that imitates a block stays text.
 */
export function extractTerminalAttachmentCounts(branch: readonly SessionEntry[]): Map<string, number> {
  return new Map(attachmentData(branch).map((data) => [data.userEntryId, data.count]));
}

/** Map each user entry id to the number of its prompt's last images that belong to its attachments. */
export function extractAttachmentImageCounts(branch: readonly SessionEntry[]): Map<string, number> {
  return new Map(attachmentData(branch).flatMap((data) => (data.images ? [[data.userEntryId, data.images] as const] : [])));
}
