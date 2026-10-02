import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { DAMOCLES_TURN_STOPPED_ENTRY } from './constants';

/** What one Stop cut short: the tool calls it abandoned and the error entries its wind-down wrote. */
export interface TurnStoppedData {
  toolCallIds: string[];
  entryIds: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Validate a persisted `.data` payload (untrusted: hand-edited JSONL, older versions). */
function isTurnStoppedData(value: unknown): value is TurnStoppedData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isStringArray(v['toolCallIds']) && isStringArray(v['entryIds']);
}

/**
 * The record to persist for a Stop, or null when it cut nothing short. `branch` is read after the run
 * settled; the error entries are the assistant errors appended after `leafAtStop`, the leaf when the
 * user pressed Stop. An unknown `leafAtStop` (the branch moved) records no entries.
 */
export function turnStoppedRecord(
  branch: readonly SessionEntry[],
  leafAtStop: string | null,
  abandonedToolCallIds: readonly string[],
): TurnStoppedData | null {
  const start = leafAtStop === null ? -1 : branch.findIndex((e) => e.id === leafAtStop);
  const entryIds = start === -1 ? [] : branch.slice(start + 1).filter(isAssistantError).map((e) => e.id);
  if (abandonedToolCallIds.length === 0 && entryIds.length === 0) return null;
  return { toolCallIds: [...abandonedToolCallIds], entryIds };
}

function isAssistantError(entry: SessionEntry): boolean {
  if (entry.type !== 'message') return false;
  const message = (entry as { message?: { role?: string; stopReason?: string } }).message;
  return message?.role === 'assistant' && message.stopReason === 'error';
}

/** Every Stop record on the branch, merged. Empty for a session that predates the record. */
export function stoppedOnBranch(branch: readonly SessionEntry[]): { toolCallIds: Set<string>; entryIds: Set<string> } {
  const toolCallIds = new Set<string>();
  const entryIds = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== DAMOCLES_TURN_STOPPED_ENTRY) continue;
    const data = (entry as { data?: unknown }).data;
    if (!isTurnStoppedData(data)) continue;
    for (const id of data.toolCallIds) toolCallIds.add(id);
    for (const id of data.entryIds) entryIds.add(id);
  }
  return { toolCallIds, entryIds };
}
