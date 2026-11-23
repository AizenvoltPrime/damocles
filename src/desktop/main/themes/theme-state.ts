// <userData>/theme-state.json: which wallpaper set each look shows and since when (docs/invariants.md "Desktop themes"), so
// Next Wallpaper and the cycle timer carry over a relaunch. Main is its only writer, through writeJsonConfig, and memory
// changes only after the write landed ("Desktop host").
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { jsonConfigWritesSettled, writeJsonConfig } from '../../../core/config/json-config-write';
import { checkConfigPath, ConfigReadRefused, noticeRefusedConfigRead, type ConfigNotices } from '../../../core/config/local-config-path';
import { THEME_ID } from '../../../shared/themes/limits';
import type { LookKind } from '../../../shared/themes/tokens';

export const THEME_STATE_FILE = 'theme-state.json';
const VERSION = 1;
// looks remembered; the least recently changed goes first
const MAX_LOOKS = 200;
const MINUTE_MS = 60_000;
// setTimeout's longest delay
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// <theme id>:<kind>
const isKey = (key: string): boolean => {
  const at = key.lastIndexOf(':');
  const kind = key.slice(at + 1);
  return at > 0 && THEME_ID.test(key.slice(0, at)) && (kind === 'dark' || kind === 'light');
};

export interface CyclePosition {
  // the set shown, before wrapping to the look's sets
  readonly index: number;
  // when it started showing, epoch ms
  readonly at: number;
}

const isPosition = (value: unknown): value is CyclePosition => {
  if (typeof value !== 'object' || value === null) return false;
  const { index, at } = value as Record<string, unknown>;
  return typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && typeof at === 'number' && Number.isFinite(at) && at >= 0;
};

function parse(text: string): Map<string, CyclePosition> {
  const json: unknown = JSON.parse(text);
  if (typeof json !== 'object' || json === null || (json as Record<string, unknown>)['version'] !== VERSION) throw new Error('unknown schema');
  const cycle = (json as Record<string, unknown>)['cycle'];
  const out = new Map<string, CyclePosition>();
  if (typeof cycle !== 'object' || cycle === null) return out;
  for (const [key, value] of Object.entries(cycle)) if (isKey(key) && isPosition(value)) out.set(key, { index: value.index, at: value.at });
  return out;
}

const keyOf = (themeId: string, kind: LookKind): string => `${themeId}:${kind}`;

/**
 * The set of `sets` a look shows at `now` under a timer of `minutes`: every full period since `at` moves one set on. Returns the
 * position to store, which is `position` itself while no period has passed.
 */
export function cycleAt(position: CyclePosition, sets: number, minutes: number | null | undefined, now: number): CyclePosition {
  if (sets < 2 || !minutes || minutes <= 0) return position;
  const period = minutes * MINUTE_MS;
  const periods = Math.floor((now - position.at) / period);
  if (periods <= 0) return position;
  return { index: (position.index + periods) % sets, at: position.at + periods * period };
}

/** Milliseconds until the look's timer moves on from `position`; undefined without a timer or a second set. */
export function untilNextSet(position: CyclePosition, sets: number, minutes: number | null | undefined, now: number): number | undefined {
  if (sets < 2 || !minutes || minutes <= 0) return undefined;
  return Math.max(0, position.at + minutes * MINUTE_MS - now);
}

export class ThemeState {
  private positions: ReadonlyMap<string, CyclePosition> = new Map();
  private readonly file: string;
  private readonly listeners = new Set<() => void>();

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, THEME_STATE_FILE);
  }

  /** Reads the file; an unreadable one or another version starts empty and is replaced on the next change. */
  static async open(userDataDir: string, log: (line: string) => void, notices?: ConfigNotices): Promise<ThemeState> {
    const state = new ThemeState(userDataDir);
    await state.load(log, notices);
    return state;
  }

  // the file is judged from its own folder, for its read and its writes alike
  async load(log: (line: string) => void, notices?: ConfigNotices): Promise<void> {
    try {
      if ((await checkConfigPath(path.dirname(this.file), this.file)) !== 'ok') {
        noticeRefusedConfigRead(this.file, notices);
        throw new ConfigReadRefused(this.file);
      }
      this.positions = parse(await fs.readFile(this.file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`[themes] ${THEME_STATE_FILE} could not be read, so every look starts at its first wallpaper set: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The look's stored position; undefined for a look that never showed a set, which has no time to count from yet. */
  position(themeId: string, kind: LookKind): CyclePosition | undefined {
    return this.positions.get(keyOf(themeId, kind));
  }

  /** The set `look` shows at `now`: its stored position moved on by every full period since, its first set when none is stored. */
  shownIndex(look: CycleLook, now: number): number {
    return cycleAt(this.position(look.themeId, look.kind) ?? { index: 0, at: now }, look.sets, look.minutes, now).index;
  }

  /** The look's position moves to `next`; memory follows once the file holds it. */
  set(themeId: string, kind: LookKind, next: CyclePosition): Promise<void> {
    return this.advance(themeId, kind, () => next);
  }

  /**
   * The look's position moves to what `next` makes of the one held when this write's turn comes, so each of two calls made
   * in a row counts; memory follows once the file holds it.
   */
  async advance(themeId: string, kind: LookKind, next: (position: CyclePosition | undefined) => CyclePosition): Promise<void> {
    const key = keyOf(themeId, kind);
    if (!isKey(key)) return;
    let written: Map<string, CyclePosition> | undefined;
    await writeJsonConfig(this.file, () => {
      const positions = new Map(this.positions);
      const moved = next(positions.get(key));
      if (!isPosition(moved)) throw new Error('A wallpaper set position must be a set index and a time');
      positions.delete(key);
      positions.set(key, moved);
      while (positions.size > MAX_LOOKS) positions.delete([...positions.entries()].reduce((a, b) => (b[1].at < a[1].at ? b : a))[0]);
      written = positions;
      return `${JSON.stringify({ version: VERSION, cycle: Object.fromEntries(positions) }, null, 2)}\n`;
    }, { baseFolder: path.dirname(this.file) });
    if (!written) return;
    this.positions = written;
    for (const listener of [...this.listeners]) listener();
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  flush(): Promise<void> {
    return jsonConfigWritesSettled(this.file);
  }
}

/** The look whose wallpaper sets the cycle timer moves through. */
export interface CycleLook {
  readonly themeId: string;
  readonly kind: LookKind;
  readonly sets: number;
  readonly minutes: number | null | undefined;
}

export interface WallpaperCycleDeps {
  readonly state: Pick<ThemeState, 'position' | 'advance' | 'onDidChange'>;
  // the look on screen without a transient preview; undefined while it has no sets to cycle (a built-in look)
  shown(): CycleLook | undefined;
  now(): number;
  log(line: string): void;
}

/**
 * The shown look's cycle timer: one timeout to its next set. It is set again on every change of a position, which the timer
 * and Next Wallpaper both make and which need not change what the window paints; the owner calls `schedule` once the first
 * look is resolved and whenever the shown look changes.
 */
export class WallpaperCycle {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscription: { dispose(): void };
  private readonly deps: WallpaperCycleDeps;

  constructor(deps: WallpaperCycleDeps) {
    this.deps = deps;
    this.subscription = deps.state.onDidChange(() => this.schedule());
  }

  schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const look = this.deps.shown();
    if (!look) return;
    const now = this.deps.now();
    const position = this.deps.state.position(look.themeId, look.kind);
    const wait = untilNextSet(position ?? { index: 0, at: now }, look.sets, look.minutes, now);
    if (wait === undefined) return;
    if (!position) {
      // a cycling look's first show starts its count; the change it makes schedules the timer
      this.deps.state.advance(look.themeId, look.kind, (current) => current ?? { index: 0, at: now }).catch(this.failed);
      return;
    }
    this.timer = setTimeout(() => this.due(look), Math.min(wait + 50, MAX_TIMEOUT_MS));
  }

  private readonly failed = (err: unknown): void => this.deps.log(`[themes] the wallpaper set was not changed: ${err instanceof Error ? err.message : String(err)}`);

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.subscription.dispose();
  }

  private due(look: CycleLook): void {
    this.timer = undefined;
    const position = this.deps.state.position(look.themeId, look.kind);
    // a wait longer than a timeout can hold ends before its period has passed
    if (!position || cycleAt(position, look.sets, look.minutes, this.deps.now()) === position) {
      this.schedule();
      return;
    }
    this.deps.state.advance(look.themeId, look.kind, (current) => {
      const now = this.deps.now();
      return cycleAt(current ?? { index: 0, at: now }, look.sets, look.minutes, now);
    }).catch(this.failed);
  }
}
