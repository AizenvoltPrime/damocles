import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_THEME } from '../../../../shared/themes/builtin';
import { KEEP_CHANGES_MS } from '../../../../shared/themes/agent';
import { AgentThemes, CaptureStopped, DRAFT_CAPTURE_GAP_MS, LAUNCH_HOLD_WAIT_MS, SCREENSHOT_NOTICE_MS, WINDOW_CAPTURE_TIMEOUT_MS, type AgentThemesDeps, type CaptureAsk } from '../agent-themes';
import { HeldTimers } from '../held-timers';
import { KEEP_RESULT_LINGER_MS } from '../keep-changes';
import type { RenderServed, ThemeRenderer } from '../theme-renderer';
import type { RenderAppearance } from '../../../../shared/themes/agent';
import type { TransientPreview } from '../appearance';
import { characterSheetLayout, SIDEBAR_AVATAR_PX, type CharacterSheetLayout } from '../../../../shared/themes/character-sheet';

// Main's side of the theme tools: one transient preview at a time between the editor dock and a card's Show in window (the
// newest wins and the other hears so), the strip, and the launch hold of an unsettled on-the-fly change.

const PROPOSAL = { schemaVersion: 1, id: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'Proposal', looks: { dark: { colors: { ...BUILTIN_THEME.looks.dark!.colors } } } };
const EDITOR: TransientPreview = { themeId: 'editing', kind: 'dark', look: BUILTIN_THEME.looks.dark! };
const APPEARANCE: RenderAppearance = {
  kind: 'dark', css: '', trustedCss: '', platform: 'linux',
  arrangement: { grid: { slots: { main: 'chat', side: 'editor', bottom: 'terminal' }, visible: { editor: false, terminal: false }, sideWidth: 400, bottomHeight: 200 }, sidebarWidth: 280, sectionOrder: [], sections: {} },
};

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

function setup(revert: AgentThemesDeps['core']['revert'] = async () => ({ reverted: true }), timers?: AgentThemesDeps['timers'], notices: Pick<AgentThemesDeps, 'noticeTimers' | 'noticeRaised'> = {}) {
  const previews: Array<TransientPreview | undefined> = [];
  const cards = new Map<string, unknown>();
  // what the window shows, and whether the live inputs resolve to a held look; a test changes either
  const window = { decidedBy: 'system', settled: true, chat: false, kind: 'dark' as 'dark' | 'light', state: 'shown' as 'shown' | 'covered' | 'hidden' | 'none', slotSession: undefined as string | undefined, slotOrigin: 'local' };
  // the pages' acknowledgement of the look painted last: a test answers it, or leaves it waiting
  let acknowledge: (applied: boolean) => void = () => undefined;
  const themeApplied = vi.fn((signal: AbortSignal) => new Promise<boolean>((resolve, reject) => {
    acknowledge = resolve;
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  }));
  const captured = vi.fn();
  const captureWindow = vi.fn(async (): ReturnType<AgentThemesDeps['captureWindow']> => {
    captured(previews.at(-1));
    return { shell: PNG_1X1, ...(window.chat ? { chat: { png: PNG_1X1, bounds: { x: 0, y: 0, width: 1, height: 1 } } } : {}) };
  });
  const readPreviewRecords = vi.fn(async (_preview: TransientPreview): Promise<void> => undefined);
  const revokeGrant = vi.fn(async (): Promise<void> => undefined);
  // main's own records of a chat: its chat list's titles by session, and the host store's names by authority
  const titles = new Map<string, string>([['s1', 'Warm']]);
  const noticeNames = vi.fn((origin: string, session: string) => ({ chat: titles.get(session) ?? '', ...(origin === 'local' ? {} : { host: { name: 'prod-1', color: 'danger' as const } }) }));
  const noticeFocusLeft = vi.fn();
  const preview = vi.fn(async (): Promise<Uint8Array> => PNG_1X1);
  const served: RenderServed = { blobs: new Map(), stills: new Set() };
  const renderAppearance = vi.fn(async (_theme: unknown, kind: 'dark' | 'light') => ({ appearance: { ...APPEARANCE, kind }, served }));
  const composite = vi.fn(async (): Promise<Uint8Array> => PNG_1X1);
  const characterSheets = vi.fn(async (_appearance: RenderAppearance, layout: CharacterSheetLayout): Promise<Uint8Array[]> => layout.sheets.map(() => PNG_1X1));
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
    renderer: { window: preview, composite, characterSheets } as unknown as ThemeRenderer,
    shotUrlPrefix: 'app://damocles/theme-shot/',
    captureWindow,
    chatSlot: () => (window.slotSession !== undefined ? { origin: window.slotOrigin, session: window.slotSession } : undefined),
    windowState: () => window.state,
    readPreviewRecords,
    themeApplied,
    revokeGrant,
    noticeNames,
    noticeFocusLeft,
    core: { keep: async () => undefined, revert, showEnded, screenshotGone: async () => undefined },
    setPreview: (preview) => previews.push(preview),
    cardTheme: (stageId, theme) => {
      if (theme === undefined) cards.delete(stageId);
      else cards.set(stageId, theme);
    },
    editorTakenOver,
    editorRefused,
    shownKind: () => window.kind,
    renderAppearance,
    shownState: () => ({ kind: 'dark', themeId: 'damocles', decidedBy: window.decidedBy }),
    projectCharacter: (key) => (key === 'c:/work/app' ? { themeId: PROPOSAL.id, character: 'Pip', by: 'themePin' } : undefined),
    setHeldLook,
    heldLookSettled: () => window.settled,
    currentArrangement: () => ({ sidebarWidth: 280 }),
    applyArrangement,
    shellChanged,
    countdownEnded,
    ...(timers ? { timers } : {}),
    ...notices,
    log: (line) => lines.push(line),
  };
  const themes = new AgentThemes(deps);
  made.push(themes);
  const services = themes.services();
  const show = (promptId: string): Promise<unknown> => Promise.resolve(services['themes.showInWindow']({ promptId, chatTitle: 'Warm', theme: PROPOSAL }, new AbortController().signal));
  const applied = (value: boolean): void => acknowledge(value);
  return { themes, services, show, previews, cards, showEnded, themeApplied, applied, captured, captureWindow, readPreviewRecords, revokeGrant, noticeNames, noticeFocusLeft, titles, editorTakenOver, editorRefused, setHeldLook, applyArrangement, lines, window, preview, composite, characterSheets, shellChanged, countdownEnded, renderAppearance, served };
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

  it("paints a proposal's characters, CSS and assets with its look", async () => {
    const { services, previews } = setup();
    const sprite = 'd'.repeat(64);
    const theme = {
      ...PROPOSAL,
      characters: { name: 'Pals', characters: [{ name: 'Pip', states: { idle: { asset: sprite } } }] },
      assets: { [sprite]: { kind: 'sprite', mime: 'image/png', bytes: 10, width: 16, height: 16, license: {} } },
    };
    await services['themes.showInWindow']({ promptId: 'card-1', theme }, new AbortController().signal);
    expect(previews.at(-1)).toMatchObject({ themeId: PROPOSAL.id, kind: 'dark', characters: theme.characters, assets: theme.assets });
  });

  it("answers a project's character with what decided it, and nothing for a project that shows its letter", async () => {
    const { services } = setup();
    expect(await services['themes.projectCharacter']({ key: 'c:/work/app' }, new AbortController().signal)).toEqual({ character: { themeId: PROPOSAL.id, name: 'Pip', by: 'themePin' } });
    expect(await services['themes.projectCharacter']({ key: 'c:/other' }, new AbortController().signal)).toEqual({});
  });

  it("serves an open card's theme from cardOpened until cardClosed, and refuses one that does not validate", async () => {
    const { services, cards } = setup();
    await services['themes.cardOpened']({ stageId: 'stage-1', theme: PROPOSAL }, new AbortController().signal);
    expect(cards.get('stage-1')).toMatchObject({ id: PROPOSAL.id });
    await services['themes.cardClosed']({ stageId: 'stage-1' }, new AbortController().signal);
    expect(cards.has('stage-1')).toBe(false);
    expect(() => services['themes.cardOpened']({ stageId: 'stage-2', theme: { name: 'broken' } }, new AbortController().signal)).toThrow('not valid');
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
    const { services, preview, composite, window, served } = setup();
    const stop = new AbortController();
    await services['themes.render']({ theme: PROPOSAL, view: 'sidebar' }, stop.signal);
    expect(preview).toHaveBeenCalledWith({ kind: 'window', view: 'sidebar', appearance: APPEARANCE, width: 1280, height: 800 }, served, stop.signal);
    window.chat = true;
    await services['themes.screenshotTake']({ chat: { id: 's1' } }, stop.signal);
    expect(composite).toHaveBeenCalledWith(PNG_1X1, PNG_1X1, { x: 0, y: 0, width: 1, height: 1 }, stop.signal);
  });

  it('keeps no screenshot for a call that was given up while the window was captured', async () => {
    const { themes, services, composite, window } = setup();
    window.chat = true;
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    await expect(Promise.resolve().then(() => services['themes.screenshotTake']({ chat: { id: 's1' } }, stop.signal))).rejects.toThrow('stopped');
    expect(composite).not.toHaveBeenCalled();
    const kept = await services['themes.screenshotTake']({ chat: { id: 's1' } }, new AbortController().signal);
    expect(kept.kind).toBe('shot');
    expect(kept.kind === 'shot' && themes.shot(kept.shot.shotId)).toBeInstanceOf(Uint8Array);
  });
});

describe('AgentThemes: a screenshot of a draft (captureDraft)', () => {
  const DRAFT = { ...PROPOSAL, id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', name: 'Draft' };
  const CHAT = { id: 's1', title: 'Warm' };
  const ticks = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };

  it('paints the draft, waits for the pages to paint it, captures, then paints the owner again, telling no card', async () => {
    const { themes, services, show, previews, applied, captured, showEnded, themeApplied } = setup();
    await show('card-1');
    const taking = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    expect(previews.at(-1)).toMatchObject({ themeId: DRAFT.id, kind: 'dark' });
    expect(themeApplied).toHaveBeenCalledTimes(1);
    expect(captured).not.toHaveBeenCalled();
    applied(true);
    const taken = await taking;
    expect(taken.kind).toBe('shot');
    expect(taken.kind === 'shot' && themes.shot(taken.shot.shotId)).toBeDefined();
    // the capture saw the draft, and the card's proposal shows again after it
    expect(captured).toHaveBeenCalledWith(expect.objectContaining({ themeId: DRAFT.id }));
    expect(previews.at(-1)).toMatchObject({ themeId: PROPOSAL.id });
    expect(themes.proposalStrip()).toEqual({ promptId: 'card-1', chatTitle: 'Warm' });
    expect(showEnded).not.toHaveBeenCalled();
  });

  it('paints an owner change made during the capture after it, and none before', async () => {
    const { themes, services, previews, applied, editorTakenOver } = setup();
    const taking = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    themes.editorPreview(EDITOR);
    expect(previews.at(-1)).toMatchObject({ themeId: DRAFT.id });
    applied(true);
    await taking;
    expect(previews.at(-1)).toBe(EDITOR);
    expect(editorTakenOver).not.toHaveBeenCalled();
  });

  it('restores the window when the caller gives up, when the pages never paint in time, and when the window closes', async () => {
    const stopped = setup();
    const stop = new AbortController();
    const giving = stopped.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, stop.signal);
    await ticks();
    stop.abort(new Error('stopped'));
    await expect(giving).rejects.toThrow('stopped');
    expect(stopped.previews.at(-1)).toBeUndefined();
    expect(stopped.captured).not.toHaveBeenCalled();

    const slow = setup();
    const waiting = slow.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    slow.applied(false);
    expect(await waiting).toEqual({ kind: 'refused', reason: 'timeout' });
    expect(slow.previews.at(-1)).toBeUndefined();
    expect(slow.captured).not.toHaveBeenCalled();

    const closing = setup();
    const closed = closing.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    closing.themes.windowClosed();
    expect(await closed).toEqual({ kind: 'refused', reason: 'noWindow' });
    expect(closing.previews.at(-1)).toBeUndefined();
  });

  it('restores the window when this computer\'s engine ends during a capture it asked for', async () => {
    const { themes, services, previews } = setup();
    const taking = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    themes.coreEnded();
    await expect(taking).rejects.toBeInstanceOf(CaptureStopped);
    await expect(taking).rejects.toMatchObject({ stop: 'coreEnded' });
    expect(previews.at(-1)).toBeUndefined();
  });

  it('refuses under forced colors or safe start, and for a window minimized, hidden, covered or closed, painting nothing', async () => {
    const { services, previews, window, captured } = setup();
    const take = (): Promise<unknown> => Promise.resolve(services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal));
    window.decidedBy = 'forcedColors';
    expect(await take()).toEqual({ kind: 'refused', reason: 'forcedColors' });
    window.decidedBy = 'safeStart';
    expect(await take()).toEqual({ kind: 'refused', reason: 'safeStart' });
    window.decidedBy = 'system';
    window.state = 'hidden';
    expect(await take()).toEqual({ kind: 'refused', reason: 'windowHidden' });
    // another app covers the whole window, whose pages then draw no frame to acknowledge
    window.state = 'covered';
    expect(await take()).toEqual({ kind: 'refused', reason: 'covered' });
    expect(await Promise.resolve(services['themes.screenshotTake']({ chat: CHAT }, new AbortController().signal))).toEqual({ kind: 'refused', reason: 'covered' });
    window.state = 'none';
    expect(await take()).toEqual({ kind: 'refused', reason: 'noWindow' });
    // a plain screenshot shows what is on screen, so only a window that is not there refuses it
    expect(await Promise.resolve(services['themes.screenshotTake']({ chat: CHAT }, new AbortController().signal))).toEqual({ kind: 'refused', reason: 'noWindow' });
    expect(previews).toEqual([]);
    expect(captured).not.toHaveBeenCalled();
  });

  it('starts two draft captures at least a second apart', async () => {
    vi.useFakeTimers();
    try {
      const { services, themeApplied } = setup();
      const starts: number[] = [];
      themeApplied.mockImplementation(async () => {
        starts.push(Date.now());
        return true;
      });
      const first = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
      const second = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(DRAFT_CAPTURE_GAP_MS - 1);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([first, second]);
      expect(starts).toHaveLength(2);
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(DRAFT_CAPTURE_GAP_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("raises the notice for a capture under the grant while another chat shows in the slot, and its Revoke ends that chat's grant", async () => {
    vi.useFakeTimers();
    try {
      const { themes, services, window, shellChanged, revokeGrant } = setup();
      window.slotSession = 's1';
      await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
      expect(themes.screenshotNotice()).toBeUndefined();
      // a remote host's chat of the same session id is another chat
      await themes.take({ chat: CHAT, granted: true, origin: 'ssh+prod-1' }, new AbortController().signal);
      expect(themes.screenshotNotice()).toEqual({ id: expect.any(String), chat: 'Warm', origin: 'ssh+prod-1', host: { name: 'prod-1', color: 'danger' } });
      themes.dismissNotice(themes.screenshotNotice()!.id);
      expect(themes.screenshotNotice()).toBeUndefined();
      window.slotSession = 'other';
      // a card's Allow is no capture under the grant
      await services['themes.screenshotTake']({ chat: CHAT }, new AbortController().signal);
      expect(themes.screenshotNotice()).toBeUndefined();
      await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
      const notice = themes.screenshotNotice();
      expect(notice).toEqual({ id: expect.any(String), chat: 'Warm', origin: 'local' });
      expect(shellChanged).toHaveBeenCalled();
      // another chat's capture replaces it under a new id, and closes on its own
      await services['themes.screenshotTake']({ chat: { id: 's2' }, granted: true }, new AbortController().signal);
      const newer = themes.screenshotNotice();
      expect(newer).toEqual({ id: expect.any(String), chat: '', origin: 'local' });
      expect(newer?.id).not.toBe(notice?.id);
      await themes.revokeNotice(notice!.id);
      expect(revokeGrant).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SCREENSHOT_NOTICE_MS);
      expect(themes.screenshotNotice()).toBeUndefined();
      await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
      await themes.revokeNotice(themes.screenshotNotice()!.id);
      expect(revokeGrant).toHaveBeenCalledWith('local', 's1');
      expect(themes.screenshotNotice()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // trusted UI names a chat only from this computer's records: a core's title, a remote's above all, is never shown
  it("names the chat from main's own records, never by the title the core that asked sent", async () => {
    const { themes, window, noticeNames, titles } = setup();
    window.slotSession = 'other';
    titles.set('s1', 'Warm');
    await themes.take({ chat: { id: 's1', title: 'Your bank chat' } as CaptureAsk['chat'], granted: true, origin: 'ssh+prod-1' }, new AbortController().signal);
    expect(noticeNames).toHaveBeenLastCalledWith('ssh+prod-1', 's1');
    expect(themes.screenshotNotice()).toMatchObject({ chat: 'Warm', host: { name: 'prod-1' } });
    titles.delete('s1');
    await themes.take({ chat: { id: 's1', title: 'Your bank chat' } as CaptureAsk['chat'], granted: true, origin: 'local' }, new AbortController().signal);
    expect(themes.screenshotNotice()).toEqual({ id: expect.any(String), chat: '', origin: 'local' });
  });

  it("replaces a notice of the same chat in place, keeping its id and starting its time again", async () => {
    vi.useFakeTimers();
    try {
      const { themes, services, window, titles } = setup();
      window.slotSession = 'other';
      await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
      const first = themes.screenshotNotice()!;
      await vi.advanceTimersByTimeAsync(SCREENSHOT_NOTICE_MS - 1);
      titles.set('s1', 'Warmer');
      await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
      expect(themes.screenshotNotice()).toEqual({ ...first, chat: 'Warmer' });
      await vi.advanceTimersByTimeAsync(SCREENSHOT_NOTICE_MS - 1);
      expect(themes.screenshotNotice()?.id).toBe(first.id);
      await vi.advanceTimersByTimeAsync(1);
      expect(themes.screenshotNotice()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts its time only while nothing holds it: the pointer or focus in it, the window unseen, a view over the shell', async () => {
    vi.useFakeTimers();
    try {
      const { themes, services, window } = setup();
      window.slotSession = 'other';
      // the window was unseen before the capture: the notice waits for it with its whole time
      themes.setNoticeHold('window', true);
      await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
      const { id } = themes.screenshotNotice()!;
      await vi.advanceTimersByTimeAsync(SCREENSHOT_NOTICE_MS * 4);
      expect(themes.screenshotNotice()?.id).toBe(id);
      themes.setNoticeHold('window', false);
      await vi.advanceTimersByTimeAsync(SCREENSHOT_NOTICE_MS - 2_000);
      // two reasons at once: it waits until both end, then runs out the 2 s it had left
      themes.holdNotice(id, 'pointer', true);
      themes.setNoticeHold('covered', true);
      await vi.advanceTimersByTimeAsync(SCREENSHOT_NOTICE_MS * 4);
      themes.holdNotice(id, 'pointer', false);
      await vi.advanceTimersByTimeAsync(SCREENSHOT_NOTICE_MS);
      expect(themes.screenshotNotice()?.id).toBe(id);
      themes.setNoticeHold('covered', false);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(themes.screenshotNotice()?.id).toBe(id);
      await vi.advanceTimersByTimeAsync(1);
      expect(themes.screenshotNotice()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the shell's hold only for the notice showing, and its release whatever notice it names", async () => {
    vi.useFakeTimers();
    try {
      const { themes, services, window } = setup();
      window.slotSession = 'other';
      await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
      const { id } = themes.screenshotNotice()!;
      themes.holdNotice('another', 'pointer', true);
      themes.holdNotice(id, 'focus', true);
      // another chat's notice replaced it in place while the focus was in it, and the release names the old id
      await services['themes.screenshotTake']({ chat: { id: 's2' }, granted: true }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(SCREENSHOT_NOTICE_MS * 2);
      expect(themes.screenshotNotice()).toMatchObject({ chat: '' });
      themes.holdNotice(id, 'focus', false);
      await vi.advanceTimersByTimeAsync(SCREENSHOT_NOTICE_MS);
      expect(themes.screenshotNotice()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on Revoke only once the grant ended, and stays when the revoke fails", async () => {
    const { themes, services, window, revokeGrant } = setup();
    window.slotSession = 'other';
    await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
    const { id } = themes.screenshotNotice()!;
    let end: () => void = () => undefined;
    revokeGrant.mockImplementationOnce(() => new Promise<void>((resolve) => (end = resolve)));
    const revoking = themes.revokeNotice(id);
    await Promise.resolve();
    expect(themes.screenshotNotice()?.id).toBe(id);
    end();
    await revoking;
    expect(themes.screenshotNotice()).toBeUndefined();

    await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
    const again = themes.screenshotNotice()!.id;
    revokeGrant.mockRejectedValueOnce(new Error("This computer's Damocles engine is restarting"));
    await expect(themes.revokeNotice(again)).rejects.toThrow('restarting');
    expect(themes.screenshotNotice()?.id).toBe(again);
  });

  it('gives keyboard focus back when it closes with focus in it, and not otherwise', async () => {
    const { themes, services, window, noticeFocusLeft } = setup();
    window.slotSession = 'other';
    await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
    themes.dismissNotice(themes.screenshotNotice()!.id);
    expect(noticeFocusLeft).not.toHaveBeenCalled();
    await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
    const { id } = themes.screenshotNotice()!;
    themes.holdNotice(id, 'focus', true);
    await themes.revokeNotice(id);
    expect(noticeFocusLeft).toHaveBeenCalledTimes(1);
    // the hold went with the notice: the next one counts its time and gives no focus back
    await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
    themes.dismissNotice(themes.screenshotNotice()!.id);
    expect(noticeFocusLeft).toHaveBeenCalledTimes(1);
  });

  it('runs its time on the timers it was given, which an end-to-end run holds, and tells each notice raised', async () => {
    vi.useFakeTimers();
    try {
      const timers = new HeldTimers();
      const noticeRaised = vi.fn();
      const { themes, services, window } = setup(undefined, undefined, { noticeTimers: timers, noticeRaised });
      window.slotSession = 'other';
      timers.hold(0);
      await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
      await services['themes.screenshotTake']({ chat: CHAT, granted: true }, new AbortController().signal);
      expect(noticeRaised.mock.calls).toEqual([[themes.screenshotNotice()], [themes.screenshotNotice()]]);
      await vi.advanceTimersByTimeAsync(SCREENSHOT_NOTICE_MS * 4);
      expect(themes.screenshotNotice()).toBeDefined();
      expect(timers.fire()).toBe(1);
      expect(themes.screenshotNotice()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentThemes: how long a draft stays painted', () => {
  const DRAFT = { ...PROPOSAL, id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', name: 'Draft' };
  const BOTH = { ...DRAFT, looks: { dark: PROPOSAL.looks.dark, light: { colors: { ...BUILTIN_THEME.looks.light!.colors } } } };
  const CHAT = { id: 's1', title: 'Warm' };
  const ticks = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  // a composite the test settles, which ends with its signal as the renderer's does
  const heldComposite = (composite: ReturnType<typeof setup>['composite']) => {
    const held = { resolve: (_png: Uint8Array): void => undefined, started: false };
    composite.mockImplementationOnce((...args: unknown[]) => new Promise<Uint8Array>((resolve, reject) => {
      const signal = args[3] as AbortSignal;
      held.started = true;
      held.resolve = resolve;
      signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    }));
    return held;
  };

  it('ends the overlay once the pixels are taken, while the composite still waits in the renderer', async () => {
    const { services, show, previews, applied, window, composite } = setup();
    await show('card-1');
    window.chat = true;
    const held = heldComposite(composite);
    const taking = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    applied(true);
    await ticks();
    expect(held.started).toBe(true);
    expect(previews.at(-1)).toMatchObject({ themeId: PROPOSAL.id });
    held.resolve(PNG_1X1);
    expect((await taking).kind).toBe('shot');
    expect(previews.at(-1)).toMatchObject({ themeId: PROPOSAL.id });
  });

  it('stops the capture when the window closes, the engine ends or the caller gives up during the composite, keeping nothing', async () => {
    const closing = setup();
    closing.window.chat = true;
    const closingHeld = heldComposite(closing.composite);
    const closed = closing.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    closing.applied(true);
    await ticks();
    expect(closingHeld.started).toBe(true);
    closing.themes.windowClosed();
    expect(await closed).toEqual({ kind: 'refused', reason: 'noWindow' });

    const ending = setup();
    ending.window.chat = true;
    heldComposite(ending.composite);
    const ended = ending.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    ending.applied(true);
    await ticks();
    ending.themes.coreEnded();
    await expect(ended).rejects.toMatchObject({ stop: 'coreEnded' });

    const giving = setup();
    giving.window.chat = true;
    heldComposite(giving.composite);
    const stop = new AbortController();
    const given = giving.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, stop.signal);
    await ticks();
    giving.applied(true);
    await ticks();
    stop.abort(new Error('stopped'));
    await expect(given).rejects.toThrow('stopped');
    expect(giving.previews.at(-1)).toBeUndefined();
  });

  it('bounds a window capture that never settles, restores the window, and lets the next capture run', async () => {
    vi.useFakeTimers();
    try {
      const { services, previews, applied, captureWindow, themeApplied } = setup();
      captureWindow.mockImplementationOnce(() => new Promise(() => undefined));
      const stuck = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
      const failed = expect(stuck).rejects.toThrow('The window capture did not finish');
      await vi.advanceTimersByTimeAsync(0);
      applied(true);
      await vi.advanceTimersByTimeAsync(WINDOW_CAPTURE_TIMEOUT_MS);
      await failed;
      expect(previews.at(-1)).toBeUndefined();
      themeApplied.mockResolvedValue(true);
      const next = services['themes.screenshotTake']({ chat: CHAT }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      expect((await next).kind).toBe('shot');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the window when the capture or the composite fails', async () => {
    const capturing = setup();
    capturing.captureWindow.mockRejectedValueOnce(new Error('UnknownVizError'));
    const capture = capturing.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    capturing.applied(true);
    await expect(capture).rejects.toThrow('UnknownVizError');
    expect(capturing.previews.at(-1)).toBeUndefined();

    const compositing = setup();
    compositing.window.chat = true;
    compositing.composite.mockRejectedValueOnce(new Error('render timed out'));
    const composed = compositing.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    compositing.applied(true);
    await expect(composed).rejects.toThrow('render timed out');
    expect(compositing.previews.at(-1)).toBeUndefined();
  });

  it('refuses, restored, when forced colors begin after the pages painted the draft, or the window is covered when the wait times out', async () => {
    const forced = setup();
    const taking = forced.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    forced.window.decidedBy = 'forcedColors';
    forced.applied(true);
    expect(await taking).toEqual({ kind: 'refused', reason: 'forcedColors' });
    expect(forced.previews.at(-1)).toBeUndefined();
    expect(forced.captured).not.toHaveBeenCalled();

    const covered = setup();
    const waiting = covered.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    covered.window.state = 'covered';
    covered.applied(false);
    expect(await waiting).toEqual({ kind: 'refused', reason: 'covered' });
  });

  it("reads the draft's wallpaper records before it paints, and paints nothing when the caller gives up meanwhile", async () => {
    const { services, previews, readPreviewRecords, applied } = setup();
    let read = (): void => undefined;
    readPreviewRecords.mockImplementationOnce(() => new Promise<void>((resolve) => { read = resolve; }));
    const taking = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    expect(readPreviewRecords).toHaveBeenCalledWith(expect.objectContaining({ themeId: DRAFT.id }));
    expect(previews).toEqual([]);
    read();
    await ticks();
    expect(previews.at(-1)).toMatchObject({ themeId: DRAFT.id });
    applied(true);
    expect((await taking).kind).toBe('shot');

    const stop = new AbortController();
    readPreviewRecords.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const given = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, stop.signal);
    await ticks();
    const painted = previews.length;
    stop.abort(new Error('stopped'));
    await expect(given).rejects.toThrow('stopped');
    expect(previews.slice(painted).every((preview) => preview === undefined)).toBe(true);
  });

  it('raises the notice when a granted draft capture for a chat not on screen starts painting, once, whatever its end', async () => {
    vi.useFakeTimers();
    try {
      const { themes, services, window, applied } = setup();
      window.slotSession = 'other';
      const taking = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT, granted: true }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      const notice = themes.screenshotNotice();
      expect(notice).toEqual({ id: expect.any(String), chat: 'Warm', origin: 'local' });
      applied(true);
      expect((await taking).kind).toBe('shot');
      expect(themes.screenshotNotice()?.id).toBe(notice?.id);

      themes.dismissNotice(notice!.id);
      await vi.advanceTimersByTimeAsync(DRAFT_CAPTURE_GAP_MS);
      const timing = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT, granted: true }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(themes.screenshotNotice()).toEqual({ id: expect.any(String), chat: 'Warm', origin: 'local' });
      applied(false);
      expect(await timing).toEqual({ kind: 'refused', reason: 'timeout' });
      expect(themes.screenshotNotice()).toBeDefined();

      // the chat on screen watches its own capture
      themes.dismissNotice(themes.screenshotNotice()!.id);
      window.slotSession = 's1';
      await vi.advanceTimersByTimeAsync(DRAFT_CAPTURE_GAP_MS);
      const watched = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT, granted: true }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      applied(true);
      await watched;
      expect(themes.screenshotNotice()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the kind on screen after the gap between two captures, not before it', async () => {
    vi.useFakeTimers();
    try {
      const { services, previews, window, themeApplied } = setup();
      themeApplied.mockResolvedValue(true);
      await services['themes.screenshotTake']({ chat: CHAT, theme: BOTH }, new AbortController().signal);
      const second = services['themes.screenshotTake']({ chat: CHAT, theme: BOTH }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(DRAFT_CAPTURE_GAP_MS / 2);
      window.kind = 'light';
      await vi.advanceTimersByTimeAsync(DRAFT_CAPTURE_GAP_MS);
      await second;
      expect(previews.filter((preview) => preview !== undefined).map((preview) => preview!.kind)).toEqual(['dark', 'light']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a queued capture at once when its caller gives up, and keeps the order of the rest', async () => {
    const { services, applied, previews } = setup();
    const first = services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
    await ticks();
    const stop = new AbortController();
    const queued = services['themes.screenshotTake']({ chat: CHAT }, stop.signal);
    const third = Promise.resolve(services['themes.screenshotTake']({ chat: CHAT }, new AbortController().signal));
    let thirdDone = false;
    void third.then(() => { thirdDone = true; });
    stop.abort(new Error('stopped'));
    await expect(queued).rejects.toThrow('stopped');
    await ticks();
    expect(thirdDone).toBe(false);
    expect(previews.at(-1)).toMatchObject({ themeId: DRAFT.id });
    applied(true);
    expect((await first).kind).toBe('shot');
    expect((await third).kind).toBe('shot');
  });

  it('refuses a draft capture queued behind one the window closed during, and gives up in the gap with its caller', async () => {
    vi.useFakeTimers();
    try {
      const closing = setup();
      const first = closing.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
      const queued = closing.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      closing.window.state = 'none';
      closing.themes.windowClosed();
      expect(await first).toEqual({ kind: 'refused', reason: 'noWindow' });
      await vi.advanceTimersByTimeAsync(DRAFT_CAPTURE_GAP_MS);
      expect(await queued).toEqual({ kind: 'refused', reason: 'noWindow' });
      expect(closing.previews.filter((preview) => preview !== undefined)).toHaveLength(1);

      const gap = setup();
      gap.themeApplied.mockResolvedValue(true);
      await gap.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, new AbortController().signal);
      const stop = new AbortController();
      const waiting = gap.services['themes.screenshotTake']({ chat: CHAT, theme: DRAFT }, stop.signal);
      const failed = expect(waiting).rejects.toThrow('stopped');
      await vi.advanceTimersByTimeAsync(DRAFT_CAPTURE_GAP_MS / 2);
      stop.abort(new Error('stopped'));
      await failed;
      await vi.advanceTimersByTimeAsync(DRAFT_CAPTURE_GAP_MS);
      expect(gap.previews.filter((preview) => preview !== undefined)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentThemes: a drawn preview', () => {
  const BOTH = { ...PROPOSAL, looks: { dark: PROPOSAL.looks.dark, light: { colors: { ...BUILTIN_THEME.looks.light!.colors } } } };
  const LIGHT_ONLY = { ...PROPOSAL, looks: { light: BOTH.looks.light } };
  const signal = new AbortController().signal;

  it('draws the look asked for, else the kind on screen when the theme has it, else its only look', async () => {
    const { services, renderAppearance, window } = setup();
    const kinds = (): unknown => renderAppearance.mock.calls.at(-1)?.[1];
    await services['themes.render']({ theme: BOTH, view: 'window', look: 'light' }, signal);
    expect(kinds()).toBe('light');
    await services['themes.render']({ theme: BOTH, view: 'window' }, signal);
    expect(kinds()).toBe('dark');
    window.kind = 'light';
    await services['themes.render']({ theme: BOTH, view: 'window' }, signal);
    expect(kinds()).toBe('light');
    await services['themes.render']({ theme: PROPOSAL, view: 'window' }, signal);
    expect(kinds()).toBe('dark');
    window.kind = 'dark';
    await services['themes.render']({ theme: LIGHT_ONLY, view: 'window' }, signal);
    expect(kinds()).toBe('light');
  });

  it('draws a character sheet page by page at the sizes its layout gives, of the characters asked for, and answers what the pages show', async () => {
    const { services, renderAppearance, characterSheets, preview, served } = setup();
    const SPRITE = 'e'.repeat(64);
    const names = ['Pip', 'Bo', 'Kit'];
    const theme = {
      ...PROPOSAL,
      characters: { name: 'Pals', characters: names.map((name) => ({ name, states: { idle: { strip: { asset: SPRITE, frameWidth: 10, frameHeight: 10, frames: 4, fps: 4 } } } })) },
      assets: { [SPRITE]: { kind: 'sprite', mime: 'image/png', bytes: 10, width: 40, height: 10, frames: 4, durationMs: 1000, license: {} } },
    };
    const views = names.map((name) => ({ name, states: { idle: { url: `app://damocles/theme-blob/${SPRITE}`, strip: { frameWidth: 10, frameHeight: 10, frames: 4, fps: 4 }, moves: true, playable: true } } }));
    const appearance: RenderAppearance = { ...APPEARANCE, characters: { characters: views, pins: {}, motion: 'still', selection: 'outline' } };
    renderAppearance.mockResolvedValueOnce({ appearance, served });
    const drawn = await services['themes.render']({ theme, view: 'characters', characters: [2, 0] }, signal);
    const input = (index: number) => ({ index, states: [{ state: 'idle' as const, frameWidth: 10, frameHeight: 10, frames: 4 }] });
    const layout = characterSheetLayout([input(2), input(0)], { wallpaper: false, sidebarAvatar: SIDEBAR_AVATAR_PX });
    expect(characterSheets).toHaveBeenCalledWith(appearance, layout, new Map([[2, views[2]], [0, views[0]]]), served, signal);
    expect(drawn).toEqual({ pngs: [PNG_1X1], sheet: { sheets: [[2, 0]], omitted: [], unfit: [], undrawn: [], stills: [], clipped: [], selection: 'outline', wallpaper: false } });
    expect(preview).not.toHaveBeenCalled();
  });

  it('draws a built-in theme under its own id, which no card is opened for', async () => {
    const { services, renderAppearance } = setup();
    await services['themes.render']({ theme: BUILTIN_THEME, view: 'window' }, signal);
    expect(renderAppearance).toHaveBeenCalledWith(expect.objectContaining({ id: BUILTIN_THEME.id }), 'dark');
    await expect(Promise.resolve().then(() => services['themes.cardOpened']({ stageId: 's', theme: BUILTIN_THEME }, signal))).rejects.toThrow('reserved for built-in themes');
  });

  it('refuses a look the theme lacks and a theme that does not validate, before anything is built', async () => {
    const { services, renderAppearance, preview } = setup();
    await expect(Promise.resolve().then(() => services['themes.render']({ theme: PROPOSAL, view: 'window', look: 'light' }, signal))).rejects.toThrow('no light look');
    await expect(Promise.resolve().then(() => services['themes.render']({ theme: { ...PROPOSAL, looks: {} }, view: 'window' }, signal))).rejects.toThrow('not valid');
    expect(renderAppearance).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
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
