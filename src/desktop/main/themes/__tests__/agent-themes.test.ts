import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_THEME } from '../../../../shared/themes/builtin';
import { KEEP_CHANGES_MS } from '../../../../shared/themes/agent';
import { AgentThemes, LAUNCH_HOLD_WAIT_MS, type AgentThemesDeps } from '../agent-themes';
import { HeldTimers } from '../held-timers';
import { KEEP_RESULT_LINGER_MS } from '../keep-changes';
import type { ThemeRenderer } from '../theme-renderer';
import type { TransientPreview } from '../appearance';

// Main's side of the theme tools: one transient preview at a time between the editor dock and a card's Show in window (the
// newest wins and the other hears so), the strip, and the launch hold of an unsettled on-the-fly change.

const PROPOSAL = { schemaVersion: 1, id: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'Proposal', looks: { dark: { colors: { ...BUILTIN_THEME.looks.dark!.colors } } } };
const EDITOR: TransientPreview = { themeId: 'editing', kind: 'dark', look: BUILTIN_THEME.looks.dark! };

let root: string;
// every AgentThemes a test made: its countdown and result timers end with the test
const made: AgentThemes[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-agent-themes-'));
});
afterEach(() => {
  for (const themes of made.splice(0)) themes.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

const PNG_1X1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);

function setup(revert: AgentThemesDeps['core']['revert'] = async () => ({ reverted: true }), timers?: AgentThemesDeps['timers']) {
  const previews: Array<TransientPreview | undefined> = [];
  // what the window shows, and whether the live inputs resolve to a held look; a test changes either
  const window = { decidedBy: 'system', settled: true, chat: false };
  const preview = vi.fn(async (): Promise<Uint8Array> => PNG_1X1);
  const composite = vi.fn(async (): Promise<Uint8Array> => PNG_1X1);
  const shellChanged = vi.fn();
  const countdownEnded = vi.fn();
  const showEnded = vi.fn(async (): Promise<void> => undefined);
  const editorTakenOver = vi.fn();
  const editorRefused = vi.fn();
  const setHeldLook = vi.fn();
  const applyArrangement = vi.fn();
  const lines: string[] = [];
  const deps: AgentThemesDeps = {
    root,
    owner: OWNER,
    renderer: { currentTheme: () => undefined, preview, composite } as unknown as ThemeRenderer,
    shotUrlPrefix: 'app://damocles/theme-shot/',
    captureWindow: async () => ({ shell: PNG_1X1, ...(window.chat ? { chat: { png: PNG_1X1, bounds: { x: 0, y: 0, width: 1, height: 1 } } } : {}) }),
    core: { keep: async () => undefined, revert, showEnded, screenshotGone: async () => undefined },
    setPreview: (preview) => previews.push(preview),
    editorTakenOver,
    editorRefused,
    shownKind: () => 'dark',
    shownState: () => ({ kind: 'dark', themeId: 'damocles', decidedBy: window.decidedBy }),
    setHeldLook,
    heldLookSettled: () => window.settled,
    currentArrangement: () => ({ sidebarWidth: 280 }),
    applyArrangement,
    shellChanged,
    countdownEnded,
    ...(timers ? { timers } : {}),
    log: (line) => lines.push(line),
  };
  const themes = new AgentThemes(deps);
  made.push(themes);
  const services = themes.services();
  const show = (promptId: string): Promise<unknown> => Promise.resolve(services['themes.showInWindow']({ promptId, chatTitle: 'Warm', theme: PROPOSAL }, new AbortController().signal));
  return { themes, services, show, previews, showEnded, editorTakenOver, editorRefused, setHeldLook, applyArrangement, lines, window, preview, composite, shellChanged, countdownEnded };
}

// this app among those that share the themes folder, and another one
const OWNER = 'a'.repeat(32);
const OTHER_APP = 'b'.repeat(32);
const writeMark = (entryId: string | undefined, owners: readonly string[] = [OWNER]): void =>
  fs.writeFileSync(path.join(root, 'appearance.json'), JSON.stringify({ version: 1, ...(entryId !== undefined ? { pendingConfirm: { entryId, startedAt: 1, owners } } : {}) }));
const writeEntries = (entries: ReadonlyArray<{ readonly id: string; readonly before: Record<string, unknown> }>): void => {
  fs.mkdirSync(path.join(root, 'history'), { recursive: true });
  fs.writeFileSync(path.join(root, 'history', 'index.json'), JSON.stringify({ version: 1, entries: entries.map(({ id, before }) => ({ id, at: 1, actor: { kind: 'user' }, change: { kind: 'reset' }, before })) }));
};

describe('AgentThemes: one transient preview', () => {
  it("a card's Show in window takes the window from the editor dock, which hears so", async () => {
    const { themes, show, previews, editorTakenOver } = setup();
    themes.editorPreview(EDITOR);
    await show('card-1');
    expect(editorTakenOver).toHaveBeenCalledTimes(1);
    expect(previews.at(-1)).toMatchObject({ themeId: PROPOSAL.id, kind: 'dark' });
    expect(themes.proposalStrip()).toEqual({ promptId: 'card-1', chatTitle: 'Warm' });
  });

  it('a later card takes it from an earlier card, which ends with takenOver; the editor takes it from a card the same way', async () => {
    const { themes, show, showEnded, previews, shellChanged } = setup();
    await show('card-1');
    await show('card-2');
    expect(showEnded).toHaveBeenCalledWith('card-1', 'takenOver');
    const paints = previews.length;
    const strips = shellChanged.mock.calls.length;
    themes.editorPreview(EDITOR);
    expect(showEnded).toHaveBeenCalledWith('card-2', 'takenOver');
    // one paint: the window never shows the look without a preview between the card's proposal and the editor's draft
    expect(previews.slice(paints)).toEqual([EDITOR]);
    expect(shellChanged.mock.calls.length).toBe(strips + 1);
    expect(themes.proposalStrip()).toBeUndefined();
  });

  it("the strip's Stop showing ends the card's preview and tells core; its own stop asks nothing of core", async () => {
    const { themes, services, show, showEnded, previews } = setup();
    await show('card-1');
    await themes.stopShowing();
    expect(showEnded).toHaveBeenCalledWith('card-1', 'stopped');
    expect(previews.at(-1)).toBeUndefined();
    await show('card-2');
    await services['themes.stopShowing']({ promptId: 'card-2' }, new AbortController().signal);
    expect(showEnded).toHaveBeenCalledTimes(1);
    expect(themes.proposalStrip()).toBeUndefined();
  });

  it("the window's close ends a card's Show in window as stopped", async () => {
    const { themes, show, showEnded } = setup();
    await show('card-1');
    themes.windowClosed();
    expect(showEnded).toHaveBeenCalledWith('card-1', 'stopped');
    expect(themes.proposalStrip()).toBeUndefined();
  });

  // With the engine down the wiring has no core to tell, and throws before it returns a promise.
  it("goes on when telling a card throws: the window's close, the editor's takeover and a later card's all finish their own work", async () => {
    const down = (): never => {
      throw new Error("This computer's Damocles engine is not running");
    };
    const closing = setup();
    await closing.show('card-1');
    closing.showEnded.mockImplementation(down);
    expect(() => closing.themes.windowClosed()).not.toThrow();
    expect(closing.themes.proposalStrip()).toBeUndefined();

    const editing = setup();
    await editing.show('card-1');
    editing.showEnded.mockImplementation(down);
    expect(() => editing.themes.editorPreview(EDITOR)).not.toThrow();
    expect(editing.previews.at(-1)).toBe(EDITOR);

    const showing = setup();
    await showing.show('card-1');
    showing.showEnded.mockImplementation(down);
    await showing.show('card-2');
    expect(showing.themes.proposalStrip()).toEqual({ promptId: 'card-2', chatTitle: 'Warm' });

    for (const { lines } of [closing, editing, showing]) {
      await vi.waitFor(() => expect(lines).toEqual(["[themes] the card was not told its preview ended: This computer's Damocles engine is not running"]));
    }
  });

  it.each(['forcedColors', 'safeStart'] as const)('refuses Show in window with the reason while %s picks the look: no preview, no strip, and the earlier owner keeps the window', async (reason) => {
    const { themes, show, previews, editorTakenOver, showEnded, window } = setup();
    themes.editorPreview(EDITOR);
    window.decidedBy = reason;
    expect(await show('card-1')).toEqual({ refused: reason });
    expect(previews).toEqual([EDITOR]);
    expect(themes.proposalStrip()).toBeUndefined();
    expect(editorTakenOver).not.toHaveBeenCalled();
    expect(showEnded).not.toHaveBeenCalled();
    window.decidedBy = 'system';
    expect(await show('card-1')).toEqual({});
    expect(themes.proposalStrip()).toEqual({ promptId: 'card-1', chatTitle: 'Warm' });
  });

  it.each(['forcedColors', 'safeStart'] as const)("ends a card's running preview with the reason when %s starts to pick the look", async (reason) => {
    const { themes, show, previews, showEnded, window } = setup();
    await show('card-1');
    themes.inputsChanged();
    expect(themes.proposalStrip()).toBeDefined();
    window.decidedBy = reason;
    themes.inputsChanged();
    expect(previews.at(-1)).toBeUndefined();
    expect(themes.proposalStrip()).toBeUndefined();
    expect(showEnded).toHaveBeenCalledWith('card-1', reason);
    themes.inputsChanged();
    expect(showEnded).toHaveBeenCalledTimes(1);
  });

  it.each(['forcedColors', 'safeStart'] as const)("sets no preview of the editor's draft while %s picks the look, answers why, and leaves a card's preview alone", async (reason) => {
    const { themes, show, previews, showEnded, window } = setup();
    await show('card-1');
    window.decidedBy = reason;
    expect(themes.editorPreview(EDITOR)).toBe(reason);
    expect(previews).toHaveLength(1);
    expect(showEnded).not.toHaveBeenCalled();
    window.decidedBy = 'system';
    expect(themes.editorPreview(EDITOR)).toBeUndefined();
    expect(previews.at(-1)).toBe(EDITOR);
  });

  it.each(['forcedColors', 'safeStart'] as const)("ends the editor's running preview when %s starts to pick the look, and tells the dock when it starts and when it ends", (reason) => {
    const { themes, previews, editorRefused, window } = setup();
    expect(themes.editorPreview(EDITOR)).toBeUndefined();
    window.decidedBy = reason;
    themes.inputsChanged();
    expect(previews).toEqual([EDITOR, undefined]);
    expect(editorRefused).toHaveBeenLastCalledWith(reason);
    // Show my current theme while it lasts ends nothing twice and still says why
    expect(themes.editorPreview(undefined)).toBe(reason);
    expect(previews).toEqual([EDITOR, undefined]);
    window.decidedBy = 'system';
    themes.inputsChanged();
    expect(editorRefused).toHaveBeenLastCalledWith(undefined);
  });

  it('refuses to show a theme that does not validate', async () => {
    const { services } = setup();
    expect(() => services['themes.showInWindow']({ promptId: 'card-1', theme: { name: 'broken' } }, new AbortController().signal)).toThrow('not valid');
  });
});

describe('AgentThemes: the launch hold', () => {
  it('paints the look from before an unsettled change at launch, and lets go once core cleared the mark', async () => {
    const { themes, setHeldLook } = setup();
    writeMark('e1');
    fs.mkdirSync(path.join(root, 'history'));
    fs.writeFileSync(path.join(root, 'history', 'index.json'), JSON.stringify({ version: 1, entries: [{ id: 'e1', at: 1, actor: { kind: 'user' }, change: { kind: 'reset' }, before: { settings: { dark: null } } }] }));
    await themes.beforeFirstPaint();
    expect(setHeldLook).toHaveBeenLastCalledWith({ look: { preferred: { dark: 'damocles' }, themes: new Map() }, scope: 'window' });
    await themes.themesChanged();
    expect(setHeldLook).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(root, 'appearance.json'), JSON.stringify({ version: 1 }));
    await themes.themesChanged();
    expect(setHeldLook).toHaveBeenLastCalledWith(undefined);
  });

  // The settings, the schedule and the project looks reach main on their own, after core's word that the files changed.
  it('keeps holding after the mark is gone until the inputs main reads itself show the look from before', async () => {
    const { themes, setHeldLook, window } = setup();
    writeMark('e1');
    writeEntries([{ id: 'e1', before: { settings: { dark: null } } }]);
    await themes.beforeFirstPaint();
    window.settled = false;
    writeMark(undefined);
    await themes.themesChanged();
    themes.inputsChanged();
    expect(setHeldLook).toHaveBeenCalledTimes(1);
    window.settled = true;
    themes.inputsChanged();
    expect(setHeldLook).toHaveBeenCalledTimes(2);
    expect(setHeldLook).toHaveBeenLastCalledWith(undefined);
    themes.inputsChanged();
    expect(setHeldLook).toHaveBeenCalledTimes(2);
  });

  it('lets go after a bounded wait when the inputs never show the look from before, and not before the mark is gone', async () => {
    vi.useFakeTimers();
    try {
      const { themes, setHeldLook, window } = setup();
      writeMark('e1');
      writeEntries([{ id: 'e1', before: { settings: { dark: null } } }]);
      await themes.beforeFirstPaint();
      window.settled = false;
      await themes.themesChanged();
      await vi.advanceTimersByTimeAsync(LAUNCH_HOLD_WAIT_MS * 2);
      expect(setHeldLook).toHaveBeenCalledTimes(1);
      writeMark(undefined);
      await themes.themesChanged();
      await vi.advanceTimersByTimeAsync(LAUNCH_HOLD_WAIT_MS - 1);
      expect(setHeldLook).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(setHeldLook).toHaveBeenLastCalledWith(undefined);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // the change stays on disk, so the look from before would be a look no file holds
  it('lets go at once when core says it kept the change it could not revert, and keeps holding for another entry\'s end', async () => {
    vi.useFakeTimers();
    try {
      const { themes, services, setHeldLook, window } = setup();
      writeMark('e1');
      writeEntries([{ id: 'e1', before: { settings: { dark: null } } }]);
      await themes.beforeFirstPaint();
      window.settled = false;
      await services['themes.pendingSettled']({ entryId: 'e0', outcome: 'kept' }, new AbortController().signal);
      expect(setHeldLook).toHaveBeenCalledTimes(1);
      await services['themes.pendingSettled']({ entryId: 'e1', outcome: 'kept' }, new AbortController().signal);
      expect(setHeldLook).toHaveBeenLastCalledWith(undefined);
      expect(vi.getTimerCount()).toBe(0);
      // the mark going afterwards starts no second wait
      writeMark(undefined);
      await themes.themesChanged();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  const ARRANGED = { settings: { dark: null }, arrangement: { sidebarWidth: 300 } };

  // main put the arrangement from before back ahead of the first paint; a change that stays keeps its own
  it('takes back the arrangement the launch replaced when core says it kept the change', async () => {
    const { themes, services, applyArrangement } = setup();
    writeMark('e1');
    writeEntries([{ id: 'e1', before: ARRANGED }]);
    await themes.beforeFirstPaint();
    expect(applyArrangement.mock.calls).toEqual([[{ sidebarWidth: 300 }]]);
    await services['themes.pendingSettled']({ entryId: 'e1', outcome: 'kept', atStart: true }, new AbortController().signal);
    expect(applyArrangement.mock.calls).toEqual([[{ sidebarWidth: 300 }], [{ sidebarWidth: 280 }]]);
    // once: a later word of the same entry moves nothing
    await services['themes.pendingSettled']({ entryId: 'e1', outcome: 'kept', atStart: true }, new AbortController().signal);
    expect(applyArrangement).toHaveBeenCalledTimes(2);
  });

  it('leaves the arrangement from before in place when core says it reverted the change, and touches none for another entry kept', async () => {
    const { themes, services, applyArrangement } = setup();
    writeMark('e1');
    writeEntries([{ id: 'e1', before: ARRANGED }]);
    await themes.beforeFirstPaint();
    await services['themes.pendingSettled']({ entryId: 'e0', outcome: 'kept', atStart: true }, new AbortController().signal);
    await services['themes.pendingSettled']({ entryId: 'e1', outcome: 'reverted', arrangement: { sidebarWidth: 300 }, atStart: true }, new AbortController().signal);
    expect(applyArrangement.mock.calls).toEqual([[{ sidebarWidth: 300 }]]);
  });

  it('moves no arrangement for a kept change that replaced none', async () => {
    const { themes, services, applyArrangement } = setup();
    writeMark('e1');
    writeEntries([{ id: 'e1', before: { settings: { dark: null } } }]);
    await themes.beforeFirstPaint();
    await services['themes.pendingSettled']({ entryId: 'e1', outcome: 'kept', atStart: true }, new AbortController().signal);
    expect(applyArrangement).not.toHaveBeenCalled();
  });

  // the dev build and the installed app share the themes folder; the other one's window and its countdown are its own
  it('holds nothing and moves no arrangement at a launch whose mark names only another app', async () => {
    const { themes, setHeldLook, applyArrangement } = setup();
    writeMark('e1', [OTHER_APP]);
    writeEntries([{ id: 'e1', before: ARRANGED }]);
    await themes.beforeFirstPaint();
    expect(setHeldLook).not.toHaveBeenCalled();
    expect(applyArrangement).not.toHaveBeenCalled();
  });

  it('lets go, with the arrangement the launch replaced, when core says another running app still counts the change', async () => {
    const { themes, services, setHeldLook, applyArrangement, window } = setup();
    writeMark('e1', [OWNER, OTHER_APP]);
    writeEntries([{ id: 'e1', before: ARRANGED }]);
    await themes.beforeFirstPaint();
    window.settled = false;
    expect(setHeldLook).toHaveBeenCalledTimes(1);
    await services['themes.pendingElsewhere']({ entryId: 'e0' }, new AbortController().signal);
    expect(setHeldLook).toHaveBeenCalledTimes(1);
    await services['themes.pendingElsewhere']({ entryId: 'e1' }, new AbortController().signal);
    expect(setHeldLook).toHaveBeenLastCalledWith(undefined);
    expect(applyArrangement.mock.calls).toEqual([[{ sidebarWidth: 300 }], [{ sidebarWidth: 280 }]]);
  });

  it('holds nothing at a launch without a mark', async () => {
    const { themes, setHeldLook, applyArrangement } = setup();
    await themes.beforeFirstPaint();
    expect(setHeldLook).not.toHaveBeenCalled();
    expect(applyArrangement).not.toHaveBeenCalled();
  });

  it("holds the look from before the countdown's first change across every later entry, and puts its window arrangement back", async () => {
    const { themes, setHeldLook, applyArrangement } = setup();
    writeMark('e1');
    fs.mkdirSync(path.join(root, 'history'));
    const entry = (id: string, before: Record<string, unknown>) => ({ id, at: 1, actor: { kind: 'agent', chatId: id, title: '' }, change: { kind: 'reset' }, before });
    fs.writeFileSync(path.join(root, 'history', 'index.json'), JSON.stringify({ version: 1, entries: [
      entry('e0', { settings: { light: 'older' } }),
      entry('e1', { settings: { dark: null }, arrangement: { sidebarWidth: 300 } }),
      entry('e2', { settings: { dark: 'between', light: null }, arrangement: { sidebarWidth: 400 } }),
    ] }));
    await themes.beforeFirstPaint();
    expect(setHeldLook).toHaveBeenLastCalledWith({ look: { preferred: { dark: 'damocles', light: 'damocles' }, themes: new Map() }, scope: 'window' });
    expect(applyArrangement).toHaveBeenCalledWith({ sidebarWidth: 300 });
  });
});

describe('AgentThemes: the countdown and what core says in a row', () => {
  const CHANGE = { kind: 'create', theme: 'Amber' } as const;
  const signal = new AbortController().signal;
  const BEFORE = { look: { preferred: { dark: 'damocles' }, themes: new Map() }, scope: 'trusted' };

  // Core settles a countdown right after it told main of the change: both arrive before main has read a file.
  it('ends as core said when its settle follows the change at once, and leaves no countdown', async () => {
    const { themes, services, setHeldLook } = setup();
    writeMark('e1');
    writeEntries([{ id: 'e1', before: { settings: { dark: null } } }]);
    const outcome = Promise.resolve(services['themes.applied']({ entryId: 'e1', change: CHANGE }, signal));
    void services['themes.pendingSettled']({ entryId: 'e1', outcome: 'reverted' }, signal);
    expect(await outcome).toEqual({ outcome: 'reverted' });
    expect(themes.counting()).toBe(false);
    expect(themes.keepState()).toMatchObject({ phase: 'reverted' });
    expect(setHeldLook.mock.calls.map(([held]) => held)).toEqual([undefined]);
  });

  it('starts no countdown again when Keep was pressed while a change that joined it was being read', async () => {
    const { themes, services, setHeldLook } = setup();
    writeMark('e1');
    writeEntries([{ id: 'e1', before: { settings: { dark: null } } }]);
    const outcome = Promise.resolve(services['themes.applied']({ entryId: 'e1', change: CHANGE }, signal));
    await vi.waitFor(() => expect(setHeldLook).toHaveBeenLastCalledWith(BEFORE));
    const joined = services['themes.pendingExtended']({ entryId: 'e1', change: { kind: 'reset' } }, signal);
    expect(themes.keepState()).toMatchObject({ phase: 'counting', changeCount: 2 });
    await themes.keep();
    await joined;
    expect(await outcome).toEqual({ outcome: 'kept' });
    expect(themes.counting()).toBe(false);
    expect(themes.keepState()).toMatchObject({ phase: 'kept' });
    expect(setHeldLook).toHaveBeenLastCalledWith(undefined);
  });

  it('keeps the look from before on trusted UI while it counts, read again as it covers more, and lets go at every end', async () => {
    for (const end of ['keep', 'revert', 'settled'] as const) {
      const { themes, services, setHeldLook } = setup();
      writeMark('e1');
      writeEntries([{ id: 'e1', before: { settings: { dark: null } } }]);
      void Promise.resolve(services['themes.applied']({ entryId: 'e1', change: CHANGE }, signal));
      await vi.waitFor(() => expect(setHeldLook).toHaveBeenLastCalledWith(BEFORE));
      // a later change of the same countdown touched the light look too
      writeEntries([{ id: 'e1', before: { settings: { dark: null } } }, { id: 'e2', before: { settings: { dark: 'between', light: 'paper' } } }]);
      await services['themes.pendingExtended']({ entryId: 'e1', change: { kind: 'reset' } }, signal);
      expect(setHeldLook).toHaveBeenLastCalledWith({ look: { preferred: { dark: 'damocles', light: 'paper' }, themes: new Map() }, scope: 'trusted' });
      if (end === 'keep') await themes.keep();
      else if (end === 'revert') await themes.revert();
      else await services['themes.pendingSettled']({ entryId: 'e1', outcome: 'kept' }, signal);
      expect(setHeldLook).toHaveBeenLastCalledWith(undefined);
    }
  });

  it('holds nothing for a countdown whose mark names another entry', async () => {
    const { services, setHeldLook } = setup();
    writeMark('other');
    writeEntries([{ id: 'other', before: { settings: { dark: null } } }]);
    void Promise.resolve(services['themes.applied']({ entryId: 'e1', change: CHANGE }, signal));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(setHeldLook).not.toHaveBeenCalled();
  });
});

describe('AgentThemes: timers a test fires', () => {
  const CHANGE = { kind: 'create', theme: 'Amber' } as const;

  it('counts by the timers it was given: a held countdown ends only when it is fired, as its timeout does', async () => {
    vi.useFakeTimers();
    try {
      const timers = new HeldTimers();
      const revert = vi.fn(async () => ({ reverted: true }));
      const { themes, services } = setup(revert, timers);
      timers.hold(KEEP_CHANGES_MS);
      const outcome = Promise.resolve(services['themes.applied']({ entryId: 'e1', change: CHANGE }, new AbortController().signal));
      await vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS * 4);
      expect(revert).not.toHaveBeenCalled();
      expect(themes.keepState()).toMatchObject({ phase: 'counting' });
      expect(timers.fire()).toBe(1);
      expect(await outcome).toEqual({ outcome: 'reverted' });
      expect(revert).toHaveBeenCalledWith('e1');
      // the result still leaves by the clock
      await vi.advanceTimersByTimeAsync(KEEP_RESULT_LINGER_MS);
      expect(themes.keepState()).toBeUndefined();
      expect(timers.fire()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is setTimeout until it is told to hold, and a pressed Keep takes a held countdown with it', async () => {
    vi.useFakeTimers();
    try {
      const timers = new HeldTimers();
      const ran: string[] = [];
      timers.setTimer(() => ran.push('clock'), KEEP_CHANGES_MS);
      await vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS);
      expect(ran).toEqual(['clock']);
      timers.hold(KEEP_CHANGES_MS);
      const held = timers.setTimer(() => ran.push('held'), KEEP_CHANGES_MS);
      timers.setTimer(() => ran.push('short'), KEEP_CHANGES_MS - 1);
      await vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS * 2);
      expect(ran).toEqual(['clock', 'short']);
      timers.clearTimer(held);
      expect(timers.fire()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentThemes: a render or a screenshot its caller gave up', () => {
  it("hands the caller's signal to the renderer for a drawn preview and for a screenshot's composite", async () => {
    const { services, preview, composite, window } = setup();
    const stop = new AbortController();
    await services['themes.render']({ theme: PROPOSAL, mode: 'dark' }, stop.signal);
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ id: PROPOSAL.id }), 'dark', stop.signal);
    window.chat = true;
    await services['themes.screenshotTake']({}, stop.signal);
    expect(composite).toHaveBeenCalledWith(PNG_1X1, PNG_1X1, { x: 0, y: 0, width: 1, height: 1 }, stop.signal);
  });

  it('keeps no screenshot for a call that was given up while the window was captured', async () => {
    const { themes, services, composite, window } = setup();
    window.chat = true;
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    await expect(Promise.resolve().then(() => services['themes.screenshotTake']({}, stop.signal))).rejects.toThrow('stopped');
    expect(composite).not.toHaveBeenCalled();
    const kept = await services['themes.screenshotTake']({}, new AbortController().signal);
    expect(themes.shot(kept.shotId)).toBeDefined();
  });
});

describe('AgentThemes: the engine ending and starting', () => {
  const CHANGE = { kind: 'create', theme: 'Amber' } as const;
  const signal = new AbortController().signal;
  const writeHistory = (ids: readonly string[]): void => {
    fs.mkdirSync(path.join(root, 'history'), { recursive: true });
    fs.writeFileSync(path.join(root, 'history', 'index.json'), JSON.stringify({ version: 1, entries: ids.map((id) => ({ id, at: 1, actor: { kind: 'user' }, change: { kind: 'reset' }, before: { settings: { dark: null } } })) }));
  };

  it("ends a card's Show in window when the engine ends, since its stage went with it", async () => {
    const { themes, show, previews, showEnded } = setup();
    await show('card-1');
    themes.coreEnded();
    expect(previews.at(-1)).toBeUndefined();
    expect(themes.proposalStrip()).toBeUndefined();
    await vi.waitFor(() => expect(showEnded).toHaveBeenCalledWith('card-1', 'stopped'));
  });

  it("leaves the theme editor's preview alone when the engine ends", () => {
    const { themes, previews } = setup();
    themes.editorPreview(EDITOR);
    themes.coreEnded();
    expect(previews.at(-1)).toBe(EDITOR);
  });

  it('ends the banner as reverted once an engine started that reverted the change, and puts the arrangement back when core says so', async () => {
    const { themes, services, applyArrangement } = setup();
    writeMark('e1');
    writeHistory(['e1']);
    const outcome = Promise.resolve(services['themes.applied']({ entryId: 'e1', change: CHANGE }, signal));
    await vi.waitFor(() => expect(themes.counting()).toBe(true));
    themes.coreEnded();
    // the new engine's start: the files go back, the mark goes, and core says how the countdown ended
    writeMark(undefined);
    writeHistory([]);
    await themes.coreStarted();
    expect(themes.keepState()).toMatchObject({ phase: 'reverted' });
    expect(await outcome).toEqual({ outcome: 'reverted' });
    await services['themes.pendingSettled']({ entryId: 'e1', outcome: 'reverted', arrangement: { sidebarWidth: 300 } }, signal);
    expect(applyArrangement).toHaveBeenCalledTimes(1);
    expect(applyArrangement).toHaveBeenCalledWith({ sidebarWidth: 300 });
  });

  it('ends the banner as kept when the engine ended after it cleared the mark and the entry still stands', async () => {
    const { themes, services } = setup();
    writeMark('e1');
    writeHistory(['e1']);
    void Promise.resolve(services['themes.applied']({ entryId: 'e1', change: CHANGE }, signal));
    await vi.waitFor(() => expect(themes.counting()).toBe(true));
    themes.coreEnded();
    writeMark(undefined);
    await themes.coreStarted();
    expect(themes.keepState()).toMatchObject({ phase: 'kept' });
  });

  // main cannot tell how the countdown stands from files it cannot read, so it names no end: core's own word ends it
  it('keeps counting, and says neither Kept nor Reverted, when an engine started and main cannot read the files', async () => {
    const { themes, services } = setup();
    writeMark('e1');
    writeHistory(['e1']);
    const outcome = Promise.resolve(services['themes.applied']({ entryId: 'e1', change: CHANGE }, signal));
    await vi.waitFor(() => expect(themes.counting()).toBe(true));
    themes.coreEnded();
    fs.writeFileSync(path.join(root, 'appearance.json'), '{ "version": 1, "pend');
    fs.writeFileSync(path.join(root, 'history', 'index.json'), '{ "version": 1, "entr');
    await themes.coreStarted();
    expect(themes.keepState()).toMatchObject({ phase: 'counting' });
    expect(themes.keepState()).not.toHaveProperty('engineDown');
    // the engine kept the change it could not revert, and says so
    await services['themes.pendingSettled']({ entryId: 'e1', outcome: 'kept' }, signal);
    expect(themes.keepState()).toMatchObject({ phase: 'kept' });
    expect(await outcome).toEqual({ outcome: 'kept' });
  });

  it('keeps counting when an engine started and the mark still names the entry', async () => {
    const { themes, services } = setup();
    writeMark('e1');
    writeHistory(['e1']);
    void Promise.resolve(services['themes.applied']({ entryId: 'e1', change: CHANGE }, signal));
    await vi.waitFor(() => expect(themes.counting()).toBe(true));
    themes.coreEnded();
    await themes.coreStarted();
    expect(themes.keepState()).toMatchObject({ phase: 'counting' });
    themes.dispose();
  });

  it("publishes who ended the countdown core settled: the engine's start, or the user's Undo of its first change", async () => {
    for (const [params, state] of [
      [{ entryId: 'e1', outcome: 'reverted', atStart: true }, { phase: 'reverted', endedBy: 'engineStart' }],
      [{ entryId: 'e1', outcome: 'kept', atStart: true }, { phase: 'kept', endedBy: 'engineStart' }],
      [{ entryId: 'e1', outcome: 'reverted' }, { phase: 'reverted', endedBy: 'user' }],
    ] as const) {
      const { themes, services } = setup();
      void Promise.resolve(services['themes.applied']({ entryId: 'e1', change: CHANGE }, signal));
      await vi.waitFor(() => expect(themes.counting()).toBe(true));
      await services['themes.pendingSettled'](params, signal);
      expect(themes.keepState()).toMatchObject(state);
    }
    const { themes, services } = setup();
    void Promise.resolve(services['themes.applied']({ entryId: 'e1', change: CHANGE }, signal));
    await vi.waitFor(() => expect(themes.counting()).toBe(true));
    await services['themes.pendingSettled']({ entryId: 'e1', outcome: 'kept' }, signal);
    expect(themes.keepState()).toMatchObject({ phase: 'kept' });
    expect(themes.keepState()).not.toHaveProperty('endedBy');
  });

  it("does not put the arrangement back twice at a launch: beforeFirstPaint did, so core's word of the same revert applies nothing", async () => {
    const { themes, services, applyArrangement } = setup();
    writeMark('e1');
    fs.mkdirSync(path.join(root, 'history'));
    fs.writeFileSync(path.join(root, 'history', 'index.json'), JSON.stringify({ version: 1, entries: [{ id: 'e1', at: 1, actor: { kind: 'user' }, change: { kind: 'reset' }, before: { settings: { dark: null }, arrangement: { sidebarWidth: 300 } } }] }));
    await themes.beforeFirstPaint();
    expect(applyArrangement).toHaveBeenCalledTimes(1);
    await services['themes.pendingSettled']({ entryId: 'e1', outcome: 'reverted', arrangement: { sidebarWidth: 300 } }, signal);
    expect(applyArrangement).toHaveBeenCalledTimes(1);
    // a later engine restart's revert is a new one, which main has not applied
    await services['themes.pendingSettled']({ entryId: 'e2', outcome: 'reverted', arrangement: { sidebarWidth: 320 } }, signal);
    expect(applyArrangement).toHaveBeenLastCalledWith({ sidebarWidth: 320 });
  });
});

describe("AgentThemes: the banner's revert", () => {
  const signal = new AbortController().signal;

  it('says the countdown ended once, before the shell hears of the end, and not while it still counts', async () => {
    const { themes, services, countdownEnded, shellChanged } = setup();
    const outcome = Promise.resolve(services['themes.applied']({ entryId: 'e1', change: { kind: 'create', theme: 'Amber' } }, signal));
    await vi.waitFor(() => expect(themes.counting()).toBe(true));
    const reverting = themes.revert();
    expect(themes.keepState()).toMatchObject({ phase: 'counting', ending: 'reverted' });
    expect(countdownEnded).not.toHaveBeenCalled();
    await reverting;
    await outcome;
    expect(countdownEnded).toHaveBeenCalledTimes(1);
    expect(countdownEnded.mock.invocationCallOrder[0]).toBeLessThan(shellChanged.mock.invocationCallOrder.at(-1)!);
  });

  it('puts back the window arrangement core answers with', async () => {
    const { themes, services, applyArrangement } = setup(async () => ({ reverted: true, arrangement: { sidebarWidth: 300 } }));
    const outcome = Promise.resolve(services['themes.applied']({ entryId: 'e1', change: { kind: 'create', theme: 'Amber' } }, signal));
    await vi.waitFor(() => expect(themes.counting()).toBe(true));
    await themes.revert();
    expect(await outcome).toEqual({ outcome: 'reverted' });
    expect(applyArrangement).toHaveBeenCalledWith({ sidebarWidth: 300 });
    expect(themes.keepState()).toMatchObject({ phase: 'reverted' });
  });

  // Core undid the change before main touches the window, so a stored arrangement that no longer parses must not read as a failed revert.
  it('ends as reverted, never kept, when the arrangement core answers with cannot be put back', async () => {
    const { themes, services, applyArrangement, lines } = setup(async () => ({ reverted: true, arrangement: { sidebarWidth: 'wide' } }));
    applyArrangement.mockImplementation(() => {
      throw new Error('The window arrangement core sent is not valid');
    });
    const outcome = Promise.resolve(services['themes.applied']({ entryId: 'e1', change: { kind: 'create', theme: 'Amber' } }, signal));
    await vi.waitFor(() => expect(themes.counting()).toBe(true));
    await themes.revert();
    expect(await outcome).toEqual({ outcome: 'reverted' });
    expect(themes.keepState()).toMatchObject({ phase: 'reverted' });
    expect(lines).toEqual(['[themes] the window arrangement from before the reverted change was not put back: The window arrangement core sent is not valid']);
  });
});

describe('AgentThemes: the arrangement and a change that joins the countdown', () => {
  it("answers this window's arrangement and puts one core sends in place", async () => {
    const { services, applyArrangement } = setup();
    expect(await services['themes.currentArrangement']({}, new AbortController().signal)).toEqual({ arrangement: { sidebarWidth: 280 } });
    await services['themes.applyArrangement']({ arrangement: { sidebarWidth: 320 }, density: 0.9 }, new AbortController().signal);
    expect(applyArrangement).toHaveBeenCalledWith({ sidebarWidth: 320 }, 0.9);
  });

  it("restarts the running countdown for the user's change, and names no single chat once more than one changed", async () => {
    const { themes, services } = setup();
    const waiting = services['themes.applied']({ entryId: 'e1', chatId: 'chat-a', chatTitle: 'Warm', change: { kind: 'create', theme: 'A' }, previousName: 'Damocles' }, new AbortController().signal);
    await vi.waitFor(() => expect(themes.keepState()).toMatchObject({ phase: 'counting', chatTitle: 'Warm', changeCount: 1 }));
    await services['themes.pendingExtended']({ entryId: 'e1', change: { kind: 'pick', look: 'light', theme: 'B', was: 'Damocles' } }, new AbortController().signal);
    const state = themes.keepState()!;
    expect(state).toMatchObject({ phase: 'counting', changeCount: 2, several: true, previousName: 'Damocles', change: { kind: 'pick', look: 'light', theme: 'B', was: 'Damocles' } });
    expect(state).not.toHaveProperty('chatTitle');
    await themes.keep();
    expect(await waiting).toEqual({ outcome: 'kept' });
  });
});
