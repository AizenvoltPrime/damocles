// appearance.json: { version: 1, override?, schedule?, ... }, the state of how the shown look is chosen beyond the settings.
// Every write keeps the keys it does not change, so a newer app's fields survive.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pendingConfirmOf, type PendingConfirm } from '../../shared/themes/agent';
import { APPEARANCE_FILE, parseAppearanceSchedule, type AppearanceSchedule, type ScheduleOverride, type ThemeSchedule } from '../../shared/themes/schedule';
import { createThemePathRule, type ThemePathRule } from './network-rule';
import { editableState, MAX_STATE_FILE_BYTES, readCappedOrNull, readVersioned } from './state-file';

export { APPEARANCE_FILE };
export const APPEARANCE_VERSION = 1;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Each method runs inside the store's write lane.
export interface AppearanceStore {
  // the file's object when it is version 1; undefined when it is missing, unreadable or another version
  read(): Promise<Record<string, unknown> | undefined>;
  // the schedule and the pick that holds over it, as main reads them; a missing or unreadable file reads as off
  schedule(): Promise<AppearanceSchedule>;
  // a manual pick that holds over a schedule ends, and a schedule stops; nothing is written when neither is there, and a file
  // of another version is left alone
  reset(): Promise<void>;
  // the file's text for the undo history, without pendingConfirm, which is the running countdown's and no look's; null when
  // there is no file or it holds nothing but the mark
  readText(): Promise<string | null>;
  // puts the file back as `text`, or removes it for null, keeping the pendingConfirm the file holds now
  writeText(text: string | null): Promise<void>;
  // the applied change the keep-changes banner has not settled; undefined when there is none or the file is unreadable
  pendingConfirm(): Promise<PendingConfirm | undefined>;
  // sets or clears the mark, keeping every other key; refused for a file of another version
  setPendingConfirm(value: PendingConfirm | undefined): Promise<void>;
  // replaces the schedule, keeping every other key; refused for a file of another version
  setSchedule(schedule: ThemeSchedule): Promise<void>;
  // sets or clears the pick that holds over the schedule; refused for a file of another version
  setOverride(override: ScheduleOverride | undefined): Promise<void>;
}

export type { ThemeSchedule as ThemeScheduleData, Weekday } from '../../shared/themes/schedule';
export { WEEKDAYS } from '../../shared/themes/schedule';

export function createAppearanceStore(
  root: string,
  writeText: (file: string, text: string) => Promise<void>,
  rule: ThemePathRule = createThemePathRule(root),
  log?: (line: string) => void,
): AppearanceStore {
  const file = path.join(root, APPEARANCE_FILE);
  // the object of a version-1 text; undefined for another version or text that does not parse
  const parseVersioned = (text: string): Record<string, unknown> | undefined => {
    const parsed = readVersioned(text, APPEARANCE_VERSION);
    return parsed.kind === 'ok' ? parsed.json : undefined;
  };
  const read = async (): Promise<Record<string, unknown> | undefined> => {
    try {
      await rule.readable(file);
      const current = await readCappedOrNull(file, MAX_STATE_FILE_BYTES);
      return current === null ? undefined : parseVersioned(current);
    } catch {
      return undefined;
    }
  };
  const text = (): Promise<string | null> => readCappedOrNull(file, MAX_STATE_FILE_BYTES);
  // the file's object to change, by the rule of editableState
  const editable = async (): Promise<Record<string, unknown>> => (await editableState(file, APPEARANCE_VERSION, rule, log)) ?? { version: APPEARANCE_VERSION };
  const write = async (next: Record<string, unknown>): Promise<void> => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await writeText(file, `${JSON.stringify(next, null, 2)}\n`);
  };
  return {
    read,
    schedule: async () => parseAppearanceSchedule(await read()),
    pendingConfirm: async () => pendingConfirmOf(await read()),
    async setPendingConfirm(value) {
      const { pendingConfirm, ...rest } = await editable();
      if (value === undefined && pendingConfirm === undefined) return;
      await write(value === undefined ? rest : { ...rest, pendingConfirm: value });
    },
    async setSchedule(schedule) {
      await write({ ...(await editable()), schedule });
    },
    async setOverride(value) {
      const { override, ...rest } = await editable();
      if (value === undefined && override === undefined) return;
      await write(value === undefined ? rest : { ...rest, override: value });
    },
    async reset() {
      await rule.readable(file);
      const current = await text();
      if (current === null) return;
      const parsed = readVersioned(current, APPEARANCE_VERSION);
      if (parsed.kind !== 'ok') {
        // a file that is no JSON starts again, set aside first; one of another version is left alone
        if (parsed.kind === 'bad') await write(await editable());
        return;
      }
      const { override, ...rest } = parsed.json;
      const schedule = rest['schedule'];
      const scheduleOn = isRecord(schedule) && schedule['enabled'] === true;
      if (override === undefined && !scheduleOn) return;
      await rule.writable(file);
      await write(scheduleOn ? { ...rest, schedule: { ...schedule, enabled: false } } : rest);
    },
    async readText() {
      await rule.readable(file);
      const current = await text();
      if (current === null) return null;
      const json = parseVersioned(current);
      if (!json || !('pendingConfirm' in json)) return current;
      const { pendingConfirm: _mark, ...rest } = json;
      // a file the mark alone made is no file to a snapshot, so undoing the change that started the countdown removes it
      return Object.keys(rest).length === 1 ? null : `${JSON.stringify(rest, null, 2)}\n`;
    },
    async writeText(next) {
      await rule.writable(file);
      const mark = pendingConfirmOf(await read());
      if (next === null && !mark) {
        await fs.rm(file, { force: true });
        return;
      }
      const json = next === null ? { version: APPEARANCE_VERSION } : parseVersioned(next);
      if (json && (mark || 'pendingConfirm' in json)) {
        const { pendingConfirm: _snapshot, ...rest } = json;
        await write(mark ? { ...rest, pendingConfirm: mark } : rest);
        return;
      }
      // a snapshot of another version or one that does not parse goes back as it was, which holds no mark of this version
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await writeText(file, next!);
    },
  };
}
