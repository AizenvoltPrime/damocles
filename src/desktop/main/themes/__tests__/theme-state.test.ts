import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cycleAt, THEME_STATE_FILE, ThemeState, untilNextSet, WallpaperCycle, type CycleLook, type CyclePosition } from '../theme-state';

// Which wallpaper set each look shows, kept in <userData>/theme-state.json so a relaunch shows the same set.

const ID = '6e0c1a4e-2b7d-4c1e-8a2f-5d6e7f809a1c';
const MINUTE = 60_000;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-state-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ThemeState', () => {
  it('keeps a look\'s position across a reopen, per theme and kind', async () => {
    const state = await ThemeState.open(dir, () => undefined);
    expect(state.position(ID, 'dark')).toBeUndefined();
    await state.set(ID, 'dark', { index: 2, at: 5 });
    await state.flush();
    const reopened = await ThemeState.open(dir, () => undefined);
    expect(reopened.position(ID, 'dark')).toEqual({ index: 2, at: 5 });
    expect(reopened.position(ID, 'light')).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir, THEME_STATE_FILE), 'utf8'))).toEqual({ version: 1, cycle: { [`${ID}:dark`]: { index: 2, at: 5 } } });
  });

  it('starts empty from a file it cannot read or of another version, and says so', async () => {
    const lines: string[] = [];
    fs.writeFileSync(path.join(dir, THEME_STATE_FILE), JSON.stringify({ version: 2, cycle: { [`${ID}:dark`]: { index: 1, at: 1 } } }));
    expect((await ThemeState.open(dir, (line) => lines.push(line))).position(ID, 'dark')).toBeUndefined();
    fs.writeFileSync(path.join(dir, THEME_STATE_FILE), '{');
    await ThemeState.open(dir, (line) => lines.push(line));
    expect(lines).toHaveLength(2);
  });

  it('drops malformed entries and tells its listeners only after a write landed', async () => {
    fs.writeFileSync(path.join(dir, THEME_STATE_FILE), JSON.stringify({ version: 1, cycle: { [`${ID}:dark`]: { index: -1, at: 1 }, 'x:sepia': { index: 1, at: 1 }, [`${ID}:light`]: { index: 3, at: 9 } } }));
    const state = await ThemeState.open(dir, () => undefined);
    expect(state.position(ID, 'dark')).toBeUndefined();
    expect(state.position(ID, 'light')).toEqual({ index: 3, at: 9 });
    const seen: Array<number | undefined> = [];
    state.onDidChange(() => seen.push(state.position(ID, 'light')?.index));
    await state.set(ID, 'light', { index: 4, at: 10 });
    expect(seen).toEqual([4]);
  });

  it('shows the first set of a look that never showed one, however late the clock is, and the caught-up set of a stored one', async () => {
    const state = await ThemeState.open(dir, () => undefined);
    const look: CycleLook = { themeId: ID, kind: 'dark', sets: 3, minutes: 10 };
    expect(state.shownIndex(look, 1_700_000_000_000)).toBe(0);
    await state.set(ID, 'dark', { index: 1, at: 1_000 });
    await state.flush();
    // a relaunch four periods later paints the set the timer would have reached, before any timer runs
    const reopened = await ThemeState.open(dir, () => undefined);
    expect(reopened.shownIndex(look, 1_000 + 9 * MINUTE)).toBe(1);
    expect(reopened.shownIndex(look, 1_000 + 40 * MINUTE)).toBe(2);
    expect(reopened.shownIndex({ ...look, minutes: null }, 1_000 + 40 * MINUTE)).toBe(1);
    expect(reopened.position(ID, 'dark')).toEqual({ index: 1, at: 1_000 });
  });
});

describe('ThemeState.advance', () => {
  it('counts each of two steps made in a row, the second from the position the first left', async () => {
    const state = await ThemeState.open(dir, () => undefined);
    const step = (position: CyclePosition | undefined): CyclePosition => ({ index: ((position?.index ?? 0) + 1) % 3, at: (position?.at ?? 0) + 1 });
    const first = state.advance(ID, 'dark', step);
    const second = state.advance(ID, 'dark', step);
    await Promise.all([first, second]);
    expect(state.position(ID, 'dark')).toEqual({ index: 2, at: 2 });
    await state.flush();
    expect((await ThemeState.open(dir, () => undefined)).position(ID, 'dark')).toEqual({ index: 2, at: 2 });
  });

  it('keys a look by a theme id as the theme format spells one, lowercase', async () => {
    fs.writeFileSync(path.join(dir, THEME_STATE_FILE), JSON.stringify({ version: 1, cycle: { [`${ID.toUpperCase()}:dark`]: { index: 1, at: 1 }, [`${ID}:dark`]: { index: 2, at: 2 } } }));
    const state = await ThemeState.open(dir, () => undefined);
    expect(state.position(ID.toUpperCase(), 'dark')).toBeUndefined();
    expect(state.position(ID, 'dark')).toEqual({ index: 2, at: 2 });
    await state.set(ID.toUpperCase(), 'dark', { index: 1, at: 9 });
    expect(state.position(ID.toUpperCase(), 'dark')).toBeUndefined();
  });
});

describe('the shown look\'s cycle timer', () => {
  const LOOK: CycleLook = { themeId: ID, kind: 'dark', sets: 3, minutes: 10 };

  // ThemeState's positions without its file: a change tells the listeners, whatever the window paints.
  function fakeState(start: CyclePosition | undefined) {
    let position = start;
    const listeners = new Set<() => void>();
    const advances: CyclePosition[] = [];
    return {
      advances,
      position: () => position,
      advance: async (_themeId: string, _kind: 'dark' | 'light', next: (current: CyclePosition | undefined) => CyclePosition) => {
        position = next(position);
        advances.push(position);
        for (const listener of [...listeners]) listener();
      },
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      listeners,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts from its own schedule call and goes on from each change of the position, with no change of the look in between', async () => {
    const state = fakeState({ index: 0, at: 0 });
    const cycle = new WallpaperCycle({ state, shown: () => LOOK, now: () => Date.now(), log: () => undefined });
    cycle.schedule();
    await vi.advanceTimersByTimeAsync(10 * MINUTE + 50);
    expect(state.advances).toEqual([{ index: 1, at: 10 * MINUTE }]);
    // nothing but the position changed, and the timer is set again from it
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(state.advances.map((position) => position.index)).toEqual([1, 2, 0]);
    cycle.dispose();
    expect(state.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(state.advances).toHaveLength(3);
  });

  it('counts from Next Wallpaper\'s step, never from the position it had when the timer was set', async () => {
    const state = fakeState({ index: 0, at: 0 });
    const cycle = new WallpaperCycle({ state, shown: () => LOOK, now: () => Date.now(), log: () => undefined });
    cycle.schedule();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    await state.advance(ID, 'dark', (position) => ({ index: (position?.index ?? 0) + 1, at: Date.now() }));
    state.advances.length = 0;
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 50);
    expect(state.advances).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(state.advances).toEqual([{ index: 2, at: 15 * MINUTE }]);
    cycle.dispose();
  });

  it('starts the count of a look that never showed a set at its first show, and stays on set 0 for one full period', async () => {
    vi.setSystemTime(1_700_000_000_000);
    const state = fakeState(undefined);
    const cycle = new WallpaperCycle({ state, shown: () => LOOK, now: () => Date.now(), log: () => undefined });
    cycle.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.advances).toEqual([{ index: 0, at: 1_700_000_000_000 }]);
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(state.advances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(51);
    expect(state.advances.at(-1)).toEqual({ index: 1, at: 1_700_000_000_000 + 10 * MINUTE });
    cycle.dispose();
  });

  it('stores nothing for a never-shown look that does not cycle', async () => {
    const state = fakeState(undefined);
    const cycle = new WallpaperCycle({ state, shown: () => ({ ...LOOK, minutes: null }), now: () => Date.now(), log: () => undefined });
    cycle.schedule();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(state.advances).toEqual([]);
    cycle.dispose();
  });

  it('sets no timer for a look with one set, with the shortcut only, or with no look to cycle', async () => {
    const state = fakeState({ index: 0, at: 0 });
    let look: CycleLook | undefined = { ...LOOK, sets: 1 };
    const cycle = new WallpaperCycle({ state, shown: () => look, now: () => Date.now(), log: () => undefined });
    cycle.schedule();
    look = { ...LOOK, minutes: null };
    cycle.schedule();
    look = undefined;
    cycle.schedule();
    expect(vi.getTimerCount()).toBe(0);
    look = LOOK;
    cycle.schedule();
    expect(vi.getTimerCount()).toBe(1);
    cycle.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the cycle timer', () => {
  it('moves one set on per full period since the set started, wrapping to the look\'s sets', () => {
    expect(cycleAt({ index: 0, at: 0 }, 3, 15, 14 * MINUTE)).toEqual({ index: 0, at: 0 });
    expect(cycleAt({ index: 0, at: 0 }, 3, 15, 15 * MINUTE)).toEqual({ index: 1, at: 15 * MINUTE });
    expect(cycleAt({ index: 2, at: 0 }, 3, 15, 31 * MINUTE)).toEqual({ index: 1, at: 30 * MINUTE });
  });

  it('never moves on with one set or with the shortcut only', () => {
    expect(cycleAt({ index: 0, at: 0 }, 1, 15, 99 * MINUTE)).toEqual({ index: 0, at: 0 });
    expect(cycleAt({ index: 0, at: 0 }, 3, null, 99 * MINUTE)).toEqual({ index: 0, at: 0 });
    expect(untilNextSet({ index: 0, at: 0 }, 3, null, 0)).toBeUndefined();
    expect(untilNextSet({ index: 0, at: 0 }, 1, 5, 0)).toBeUndefined();
    expect(untilNextSet({ index: 0, at: 0 }, 2, 5, 2 * MINUTE)).toBe(3 * MINUTE);
    expect(untilNextSet({ index: 0, at: 0 }, 2, 5, 9 * MINUTE)).toBe(0);
  });
});
