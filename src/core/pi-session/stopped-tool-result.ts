import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { CANCELLED_TOOL_DETAIL_KEY } from '../../shared/types/session';
import { DAMOCLES_TURN_STOPPED_ENTRY } from './session-store/constants';
import type { TurnStoppedData } from './session-store/turn-stopped';
import { isWindDownError } from './nested-call-failures';

/**
 * Mark an error result that ended while its run was aborted, on the `details` pi persists, so every
 * transcript shows the call stopped rather than failed. pi runs `tool_result` only for a call it executed
 * (`agent-loop.js:604-645` in pi-agent-core 1.4.0), never for one its gate or an abort settled before
 * `execute`, and `ctx.signal` is the run's own signal (`agent-session.js:2818`).
 */
export function registerStoppedToolResultMarker(pi: ExtensionAPI): void {
  pi.on('tool_result', (event, ctx) => {
    if (!event.isError || ctx.signal?.aborted !== true) return undefined;
    const details: unknown = event.details;
    const carried = details !== null && typeof details === 'object' && !Array.isArray(details) ? details : {};
    return { details: { ...carried, [CANCELLED_TOOL_DETAIL_KEY]: true } };
  });
}

/**
 * Record, as a turn-stopped entry, each call an aborted run settled before `execute` (no `durationMs`,
 * `agent-loop.js:506-510`, `:525-529`, `:441-444`). Nested sessions only: the main chat's Stop writes its own
 * record. pi appends it, and emits its `entry_appended`, before listeners get this `tool_execution_end`
 * (`agent-session.js:752-753`, `:2783-2788`), so a live transcript reads the same entry a reload does.
 */
export function registerAbortSettledCallRecord(pi: ExtensionAPI): void {
  pi.on('tool_execution_end', (event, ctx) => {
    if (event.durationMs !== undefined || ctx.signal?.aborted !== true) return;
    const record: TurnStoppedData = { toolCallIds: [event.toolCallId], entryIds: [] };
    pi.appendEntry(DAMOCLES_TURN_STOPPED_ENTRY, record);
  });
}

/**
 * Record, as a turn-stopped entry, an error stop whose `turn_end` arrives while its run's signal is aborted: the abort's
 * wind-down, such as the next call's request setup rejecting under that signal (`lazy.js:57-62` in pi-ai 1.4.0),
 * whatever aborted the run. pi dispatches `turn_end` once it persisted the message (`agent-session.js:755-767`,
 * `:523-525`), so the entry id is known, and commits the draft with its `entry_appended` before listeners get that
 * `turn_end` (`:514`, `:635-640`). Every transcript, live and reloaded, decides the stop from this entry alone
 * (`windDownRecorded`, `stoppedOnBranch`), so they cannot disagree.
 */
export function registerWindDownErrorRecord(pi: ExtensionAPI): void {
  pi.on('turn_end', (event, ctx) => {
    const message = event.message;
    if (message.role !== 'assistant' || !isWindDownError(message.stopReason, ctx.signal)) return undefined;
    const record: TurnStoppedData = { toolCallIds: [], entryIds: [event.messageEntryId] };
    // Spread: pi replaces the draft list with what this returns, so a bare list drops earlier handlers' drafts.
    return { entries: [...event.entries, { type: 'custom', customType: DAMOCLES_TURN_STOPPED_ENTRY, data: record }] };
  });
}
