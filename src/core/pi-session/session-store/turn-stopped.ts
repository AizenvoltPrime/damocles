import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { DAMOCLES_TURN_STOPPED_ENTRY } from './constants';

/**
 * What one Stop cut short: the tool calls in flight and the error entries its wind-down wrote. A nested
 * session's entry names one call its aborted run settled before it ran (`registerAbortSettledCallRecord`),
 * and any session's entry can name one error entry its aborted run wrote (`registerWindDownErrorRecord`).
 */
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
 * user pressed Stop, less those a wind-down record already names. An unknown `leafAtStop` (the branch
 * moved) records no entries.
 */
export function turnStoppedRecord(
  branch: readonly SessionEntry[],
  leafAtStop: string | null,
  abandonedToolCallIds: readonly string[],
): TurnStoppedData | null {
  const start = leafAtStop === null ? -1 : branch.findIndex((e) => e.id === leafAtStop);
  const named = stoppedOnBranch(branch).entryIds;
  const entryIds = start === -1 ? [] : branch.slice(start + 1).filter((e) => isAssistantError(e) && !named.has(e.id)).map((e) => e.id);
  if (abandonedToolCallIds.length === 0 && entryIds.length === 0) return null;
  return { toolCallIds: [...abandonedToolCallIds], entryIds };
}

function isAssistantError(entry: SessionEntry): boolean {
  if (entry.type !== 'message') return false;
  const message = (entry as { message?: { role?: string; stopReason?: string } }).message;
  return message?.role === 'assistant' && message.stopReason === 'error';
}

function turnStoppedData(entry: unknown): TurnStoppedData | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
  if (e.type !== 'custom' || e.customType !== DAMOCLES_TURN_STOPPED_ENTRY || !isTurnStoppedData(e.data)) return null;
  return e.data;
}

/** The tool calls a turn-stopped entry names; none for any other entry. Takes untrusted parsed entries and `entry_appended` events. */
export function turnStoppedToolCallIds(entry: unknown): readonly string[] {
  return turnStoppedData(entry)?.toolCallIds ?? [];
}

/** The wind-down error entries a turn-stopped entry names; none for any other entry. Takes untrusted parsed entries. */
export function turnStoppedEntryIds(entry: unknown): readonly string[] {
  return turnStoppedData(entry)?.entryIds ?? [];
}

/**
 * Whether a turn-stopped entry after `message`'s own entry names it: the wind-down record of an error stop
 * (`registerWindDownErrorRecord`). pi commits that record before listeners get the stop's `turn_end`
 * (`agent-session.js:515`, `:636-641` in pi-coding-agent 1.1.0), so a live transcript reading it there decides
 * the stop exactly as a reload does.
 */
export function windDownRecorded(branch: readonly SessionEntry[], message: unknown): boolean {
  const named = new Set<string>();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry) continue;
    if (entry.type === 'message' && entry.message === message) return named.has(entry.id);
    for (const id of turnStoppedEntryIds(entry)) named.add(id);
  }
  return false;
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
