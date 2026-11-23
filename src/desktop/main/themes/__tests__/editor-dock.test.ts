import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { BUILTIN_THEME } from '../../../../shared/themes/builtin';
import type { ThemeFile } from '../../../../shared/themes/schema';
import type { ThemeShowRefusal } from '../../../../shared/themes/agent';
import { THEME_EDITOR_CHANNELS, type ThemeEditorResult, type ThemeEditorSession } from '../../../preload/overlay-channels';
import type { ThemeEditorRead } from '../editor-dock';

// The theme editor dock's main side: every call is checked against the open session before and after it waits, a built-in
// theme's session edits nothing, a crashed page's contents is closed, Duplicate leaves a dock the user closed meanwhile as
// they left it, a dock with unsaved edits moves only once its page agrees, and a save names the file its draft came from.

const H = vi.hoisted(() => {
  type Handler = (event: unknown, raw?: unknown) => unknown;
  class FakeContents {
    readonly id = 7;
    readonly ipc = {
      handlers: new Map<string, Handler>(),
      listeners: new Map<string, Handler>(),
      handle: (channel: string, handler: Handler): void => void this.ipc.handlers.set(channel, handler),
      on: (channel: string, handler: Handler): void => void this.ipc.listeners.set(channel, handler),
    };
    readonly events = new Map<string, (...args: unknown[]) => void>();
    readonly sent: Array<readonly [string, ...unknown[]]> = [];
    destroyed = false;
    closed = 0;
    on(event: string, listener: (...args: unknown[]) => void): void {
      this.events.set(event, listener);
    }
    send(channel: string, ...args: unknown[]): void {
      this.sent.push([channel, ...args]);
    }
    close(): void {
      this.closed++;
      this.destroyed = true;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isCrashed(): boolean {
      return false;
    }
    focus(): void {}
  }
  class FakeView {
    readonly webContents = new FakeContents();
    private visible = true;
    constructor() {
      views.push(this);
    }
    setBackgroundColor(): void {}
    setBounds(): void {}
    setVisible(visible: boolean): void {
      this.visible = visible;
    }
    getVisible(): boolean {
      return this.visible;
    }
  }
  const views: FakeView[] = [];
  return { FakeView, views };
});

vi.mock('electron', () => ({ WebContentsView: H.FakeView }));
vi.mock('../../protocol', () => ({ THEME_EDITOR_PAGE_URL: 'app://damocles/overlay/index.html#theme-editor' }));
vi.mock('../../security', () => ({
  loadAppPage: async () => undefined,
  loggableUrl: (url: string) => url,
  mainFrameLoadFailed: () => false,
  registerLocalFontsContents: () => undefined,
}));
vi.mock('../../views', () => ({ isPanelSender: () => true }));

const { pinEditsOf, stripOf, ThemeEditorDock } = await import('../editor-dock');

const USER_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const COPY_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const THEME: ThemeFile = { schemaVersion: 1, id: USER_ID, name: 'Mine', looks: { dark: { colors: { ...BUILTIN_THEME.looks.dark!.colors } } } };
const EVENT = { sender: { id: 7 }, senderFrame: { url: 'app://damocles/overlay/index.html' } };
const CLOSED = { ok: false, closed: true };
const HASH = (n: number): string => n.toString(16).padStart(64, '0');
const SPRITE = { sha256: HASH(9), asset: { kind: 'sprite' as const, mime: 'image/svg+xml', bytes: 100, width: 16, height: 16, license: {} } };

function setup() {
  const removed: unknown[] = [];
  const previews: unknown[] = [];
  const window = { isDestroyed: () => false, contentView: { addChildView: () => undefined, removeChildView: (view: unknown) => void removed.push(view) } } as unknown as BrowserWindow;
  const state: { refused: ThemeShowRefusal | undefined } = { refused: undefined };
  const session = vi.fn(async (themeId: string): Promise<ThemeEditorRead | undefined> => ({ themeId, builtin: themeId === 'damocles', theme: { ...THEME, id: themeId }, kind: 'dark', nextWallpaperShortcut: 'Ctrl+Alt+Shift+.', ...(themeId === 'damocles' ? {} : { baseHash: HASH(1) }) }));
  const save = vi.fn(async (): Promise<ThemeEditorResult & { readonly baseHash?: string }> => ({ ok: true, baseHash: HASH(2) }));
  const baseHash = vi.fn(async (): Promise<string | null | undefined> => HASH(1));
  const duplicate = vi.fn(async (): Promise<{ readonly themeId: string } | { readonly error: string }> => ({ themeId: COPY_ID }));
  const pickFontFile = vi.fn(async () => undefined);
  const pickImageFile = vi.fn(async () => undefined);
  const pickSpriteFile = vi.fn(async () => undefined);
  const importFont = vi.fn();
  const importSprite = vi.fn(async () => SPRITE);
  const allowFlash = vi.fn();
  const closed = vi.fn();
  const dock = new ThemeEditorDock({
    window,
    preloadPath: 'preload-overlay.js',
    log: () => undefined,
    onChange: () => undefined,
    onRestack: () => undefined,
    theme: () => ({ kind: 'dark', css: '', trustedCss: '', reducedMotion: false, fileIconTheme: 'material' }),
    background: () => '#000000',
    session,
    preview: (preview) => {
      previews.push(preview);
      return state.refused;
    },
    save,
    baseHash,
    arrangement: () => ({ sidebarWidth: 300 }),
    duplicate,
    copyNotOpened: () => 'The copy was made, but the theme editor could not open it.',
    engineDown: () => 'The engine is not running.',
    closed,
    openSettings: () => undefined,
    peeked: () => undefined,
    pickFontFile,
    importFont,
    fontTooLarge: () => 'too large',
    pickImageFile,
    importImage: vi.fn(),
    allowFlash,
    notChecked: () => 'not checked',
    pickSpriteFile,
    importSprite,
  });
  const view = (): InstanceType<typeof H.FakeView> => H.views.at(-1)!;
  const invoke = (channel: string, raw?: unknown): Promise<unknown> => Promise.resolve(view().webContents.ipc.handlers.get(channel)!(EVENT, raw));
  const send = (channel: string, raw?: unknown): void => void view().webContents.ipc.listeners.get(channel)!(EVENT, raw);
  const sessionId = async (): Promise<number> => ((await invoke(THEME_EDITOR_CHANNELS.getSession)) as ThemeEditorSession).sessionId;
  // the page finished loading: main sends to it from here on
  const load = (): void => view().webContents.events.get('did-finish-load')!();
  const sent = (channel: string): unknown[][] => view().webContents.sent.filter(([name]) => name === channel).map(([, ...args]) => args);
  return { dock, view, invoke, send, sessionId, load, sent, state, removed, previews, session, save, baseHash, duplicate, pickFontFile, pickImageFile, pickSpriteFile, importFont, importSprite, allowFlash, closed };
}

beforeEach(() => {
  H.views.length = 0;
});

describe('pinEditsOf', () => {
  it('keeps well-formed pin changes and drops everything else', () => {
    expect(pinEditsOf([{ projectKey: '/work/app', character: 'Pip' }, { projectKey: '/work/site', character: null, everyTheme: 'Pals' }])).toEqual([
      { projectKey: '/work/app', character: 'Pip' },
      { projectKey: '/work/site', character: null, everyTheme: 'Pals' },
    ]);
    expect(pinEditsOf('nope')).toEqual([]);
    expect(pinEditsOf([null, 3, { projectKey: '' }, { projectKey: 7 }, { projectKey: 'x'.repeat(4097) }, { projectKey: '/a', character: '' }, { projectKey: '/a', character: 'x'.repeat(65) }, { projectKey: '/a', extra: 1 }])).toEqual([]);
  });

  it('reads no more pin changes than a projects file holds pins', () => {
    const many = Array.from({ length: 5000 }, (_, at) => ({ projectKey: `/work/${at}` }));
    const kept = pinEditsOf(many);
    expect(kept.length).toBeLessThan(many.length);
    expect(kept[0]).toEqual({ projectKey: '/work/0' });
  });
});

describe('stripOf', () => {
  it('reads a cut of whole frames at a frame rate within the caps, and nothing else', () => {
    expect(stripOf({ frames: 4, fps: 12 })).toEqual({ frames: 4, fps: 12 });
    for (const raw of [undefined, null, 'x', { frames: 0, fps: 12 }, { frames: 257, fps: 12 }, { frames: 1.5, fps: 12 }, { frames: 4, fps: 0 }, { frames: 4, fps: Infinity }, { frames: 4, fps: 1000 }, { frames: '4', fps: 12 }]) {
      expect(stripOf(raw)).toBeUndefined();
    }
  });
});

describe('ThemeEditorDock', () => {
  it('answers a call that names another session than the open one as closed, and runs nothing for it', async () => {
    const d = setup();
    await d.dock.open(USER_ID);
    const stale = (await d.sessionId()) + 1;
    for (const channel of [THEME_EDITOR_CHANNELS.save, THEME_EDITOR_CHANNELS.duplicate, THEME_EDITOR_CHANNELS.importFontFile, THEME_EDITOR_CHANNELS.importFontBytes, THEME_EDITOR_CHANNELS.importImageFile, THEME_EDITOR_CHANNELS.importSpriteFile, THEME_EDITOR_CHANNELS.allowFlash]) {
      expect(await d.invoke(channel, { sessionId: stale, theme: THEME, sha256: 'a'.repeat(64), bytes: new Uint8Array(1) })).toEqual(CLOSED);
    }
    d.send(THEME_EDITOR_CHANNELS.preview, { sessionId: stale, kind: 'dark', theme: THEME });
    d.send(THEME_EDITOR_CHANNELS.close, { sessionId: stale });
    expect(d.dock.isOpen()).toBe(true);
    for (const dep of [d.save, d.duplicate, d.pickFontFile, d.importFont, d.pickImageFile, d.pickSpriteFile, d.allowFlash, d.closed]) expect(dep).not.toHaveBeenCalled();
    // open() itself ends any preview; the stale call painted nothing after it
    expect(d.previews).toEqual([undefined]);
  });

  it('paints a valid draft of the open session, and nothing for a draft that does not validate', async () => {
    const d = setup();
    await d.dock.open(USER_ID);
    const sessionId = await d.sessionId();
    d.send(THEME_EDITOR_CHANNELS.preview, { sessionId, kind: 'dark', theme: { ...THEME, name: 7 } });
    d.send(THEME_EDITOR_CHANNELS.preview, { sessionId, kind: 'sepia', theme: THEME });
    expect(d.previews).toEqual([undefined]);
    d.send(THEME_EDITOR_CHANNELS.preview, { sessionId, kind: 'dark', theme: THEME, setIndex: 2 });
    expect(d.previews.at(-1)).toMatchObject({ themeId: USER_ID, kind: 'dark', setIndex: 2 });
  });

  it("previews, saves and imports nothing in a built-in theme's session, which can only be duplicated", async () => {
    const d = setup();
    await d.dock.open('damocles');
    const sessionId = await d.sessionId();
    d.send(THEME_EDITOR_CHANNELS.preview, { sessionId, kind: 'dark', theme: THEME });
    expect(d.previews).toEqual([undefined]);
    for (const channel of [THEME_EDITOR_CHANNELS.save, THEME_EDITOR_CHANNELS.importFontFile, THEME_EDITOR_CHANNELS.importFontBytes, THEME_EDITOR_CHANNELS.importImageFile, THEME_EDITOR_CHANNELS.importSpriteFile, THEME_EDITOR_CHANNELS.allowFlash]) {
      expect(await d.invoke(channel, { sessionId, theme: THEME, sha256: 'a'.repeat(64), bytes: new Uint8Array(1) })).toEqual(CLOSED);
    }
    expect(d.save).not.toHaveBeenCalled();
    expect(d.pickFontFile).not.toHaveBeenCalled();
    expect(await d.invoke(THEME_EDITOR_CHANNELS.duplicate, { sessionId })).toEqual({ ok: true });
    expect(d.dock.editing()).toBe(COPY_ID);
  });

  it('closes the contents of a page that crashed, closes the dock, and loads a new page at the next open', async () => {
    const d = setup();
    await d.dock.open(USER_ID);
    const crashed = d.view();
    crashed.webContents.events.get('render-process-gone')!({}, { reason: 'crashed' });
    expect(d.removed).toEqual([crashed]);
    expect(crashed.webContents.closed).toBe(1);
    expect(d.dock.isOpen()).toBe(false);
    expect(d.previews.at(-1)).toBeUndefined();
    await d.dock.open(USER_ID);
    expect(H.views).toHaveLength(2);
    expect(d.view()).not.toBe(crashed);
    d.dock.dispose();
    expect(d.view().webContents.closed).toBe(1);
    expect(crashed.webContents.closed).toBe(1);
  });

  it('leaves a dock the user closed while the copy was made closed, and one moved to another theme on that theme', async () => {
    const d = setup();
    let made!: (copy: { readonly themeId: string }) => void;
    d.duplicate.mockImplementation(() => new Promise((resolve) => {
      made = resolve;
    }));
    await d.dock.open('damocles');
    const closing = d.invoke(THEME_EDITOR_CHANNELS.duplicate, { sessionId: await d.sessionId() });
    await vi.waitFor(() => expect(d.duplicate).toHaveBeenCalledTimes(1));
    d.dock.close();
    made({ themeId: COPY_ID });
    expect(await closing).toEqual({ ok: true });
    expect(d.dock.isOpen()).toBe(false);
    expect(d.session).not.toHaveBeenCalledWith(COPY_ID);

    await d.dock.open('damocles');
    const moving = d.invoke(THEME_EDITOR_CHANNELS.duplicate, { sessionId: await d.sessionId() });
    await vi.waitFor(() => expect(d.duplicate).toHaveBeenCalledTimes(2));
    await d.dock.open(USER_ID);
    made({ themeId: COPY_ID });
    expect(await moving).toEqual({ ok: true });
    expect(d.dock.editing()).toBe(USER_ID);
  });

  it("says, in the UI's words, when the copy was made and cannot be opened, and passes a failed copy's reason on", async () => {
    const d = setup();
    await d.dock.open('damocles');
    const sessionId = await d.sessionId();
    d.session.mockImplementation(async () => undefined);
    expect(await d.invoke(THEME_EDITOR_CHANNELS.duplicate, { sessionId })).toEqual({ ok: false, error: 'The copy was made, but the theme editor could not open it.' });
    expect(d.dock.editing()).toBe('damocles');
    d.duplicate.mockResolvedValueOnce({ error: 'The engine is not running.' });
    expect(await d.invoke(THEME_EDITOR_CHANNELS.duplicate, { sessionId })).toEqual({ ok: false, error: 'The engine is not running.' });
  });

  it('saves the draft whole against the file its session read, then against what the save wrote, and holds the theme as stored', async () => {
    const d = setup();
    await d.dock.open(USER_ID);
    const sessionId = await d.sessionId();
    const layout = { sidebarWidth: 280 };
    const renamed = { ...THEME, name: 'Renamed', layout };
    // what core stored differs from what was sent: the session takes the stored theme
    d.session.mockImplementation(async (themeId) => ({ themeId, builtin: false, theme: { ...THEME, name: 'Stored' }, kind: 'dark', nextWallpaperShortcut: '', baseHash: HASH(7) }));
    expect(await d.invoke(THEME_EDITOR_CHANNELS.save, { sessionId, theme: renamed, pins: [{ projectKey: '/work/app', character: 'Pip' }] })).toEqual({ ok: true });
    expect(d.save).toHaveBeenLastCalledWith(USER_ID, expect.objectContaining({ name: 'Renamed', layout }), [{ projectKey: '/work/app', character: 'Pip' }], HASH(1));
    const held = (await d.invoke(THEME_EDITOR_CHANNELS.getSession)) as ThemeEditorSession;
    expect(held).toMatchObject({ sessionId, theme: { name: 'Stored' } });
    expect(held).not.toHaveProperty('baseHash');
    // the next save names what this save wrote, never the hash of a later read
    await d.invoke(THEME_EDITOR_CHANNELS.save, { sessionId, theme: renamed });
    expect(d.save).toHaveBeenLastCalledWith(USER_ID, expect.anything(), [], HASH(2));
  });

  // the engine was down when the dock opened, so the session has no hash of the file its draft came from
  describe('a session opened with no base', () => {
    const opened = async () => {
      const d = setup();
      d.session.mockImplementationOnce(async (themeId) => ({ themeId, builtin: false, theme: THEME, kind: 'dark', nextWallpaperShortcut: '' }));
      await d.dock.open(USER_ID);
      return { d, sessionId: await d.sessionId() };
    };
    const read = (theme: ThemeFile, baseHash?: string) => async (themeId: string): Promise<ThemeEditorRead> => ({ themeId, builtin: false, theme, kind: 'dark', nextWallpaperShortcut: '', ...(baseHash !== undefined ? { baseHash } : {}) });

    it('takes its base at the save, from a file that still reads as the theme it opened', async () => {
      const { d, sessionId } = await opened();
      d.session.mockImplementation(read(THEME, HASH(5)));
      expect(await d.invoke(THEME_EDITOR_CHANNELS.save, { sessionId, theme: { ...THEME, name: 'Renamed' } })).toEqual({ ok: true });
      expect(d.save).toHaveBeenLastCalledWith(USER_ID, expect.objectContaining({ name: 'Renamed' }), [], HASH(5));
    });

    it('saves nothing over a file that reads as another theme now', async () => {
      const { d, sessionId } = await opened();
      d.session.mockImplementation(read({ ...THEME, name: 'Edited elsewhere' }, HASH(5)));
      expect(await d.invoke(THEME_EDITOR_CHANNELS.save, { sessionId, theme: { ...THEME, name: 'Renamed' } })).toEqual({ ok: false, reason: 'changed' });
      d.session.mockImplementation(async () => undefined);
      expect(await d.invoke(THEME_EDITOR_CHANNELS.save, { sessionId, theme: { ...THEME, name: 'Renamed' } })).toEqual({ ok: false, reason: 'changed' });
      expect(d.save).not.toHaveBeenCalled();
    });

    it('saves nothing while it still cannot take one: the engine is down, or its file is no theme the engine edits', async () => {
      const { d, sessionId } = await opened();
      d.session.mockImplementation(read(THEME));
      d.baseHash.mockResolvedValueOnce(undefined);
      expect(await d.invoke(THEME_EDITOR_CHANNELS.save, { sessionId, theme: THEME })).toEqual({ ok: false, error: 'The engine is not running.' });
      d.baseHash.mockResolvedValueOnce(null);
      expect(await d.invoke(THEME_EDITOR_CHANNELS.save, { sessionId, theme: THEME })).toEqual({ ok: false, reason: 'changed' });
      expect(d.save).not.toHaveBeenCalled();
      // the engine is back: the same Save goes through, checked
      d.session.mockImplementation(read(THEME, HASH(6)));
      expect(await d.invoke(THEME_EDITOR_CHANNELS.save, { sessionId, theme: THEME })).toEqual({ ok: true });
      expect(d.save).toHaveBeenLastCalledWith(USER_ID, expect.anything(), [], HASH(6));
    });
  });

  it('answers a draft that is no valid theme with a reason, not text, and writes nothing', async () => {
    const d = setup();
    await d.dock.open(USER_ID);
    expect(await d.invoke(THEME_EDITOR_CHANNELS.save, { sessionId: await d.sessionId(), theme: { ...THEME, name: 7 } })).toEqual({ ok: false, reason: 'invalid' });
    expect(d.save).not.toHaveBeenCalled();
  });

  it('runs one save and one copy at a time', async () => {
    const d = setup();
    await d.dock.open(USER_ID);
    const sessionId = await d.sessionId();
    let saved!: (result: ThemeEditorResult) => void;
    d.save.mockImplementationOnce(() => new Promise((resolve) => {
      saved = resolve;
    }));
    const first = d.invoke(THEME_EDITOR_CHANNELS.save, { sessionId, theme: THEME });
    expect(await d.invoke(THEME_EDITOR_CHANNELS.save, { sessionId, theme: THEME })).toEqual({ ok: false, reason: 'busy' });
    saved({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(d.save).toHaveBeenCalledTimes(1);

    let made!: (copy: { readonly themeId: string }) => void;
    d.duplicate.mockImplementationOnce(() => new Promise((resolve) => {
      made = resolve;
    }));
    const copying = d.invoke(THEME_EDITOR_CHANNELS.duplicate, { sessionId });
    expect(await d.invoke(THEME_EDITOR_CHANNELS.duplicate, { sessionId })).toEqual({ ok: false, reason: 'busy' });
    made({ themeId: COPY_ID });
    expect(await copying).toEqual({ ok: true });
    expect(d.duplicate).toHaveBeenCalledTimes(1);
  });

  it('passes on that the file changed since the session read it, and tells the page when the library shows it changed or gone', async () => {
    const d = setup();
    await d.dock.open(USER_ID);
    d.load();
    const sessionId = await d.sessionId();
    await d.dock.libraryChanged();
    expect(d.sent(THEME_EDITOR_CHANNELS.outside)).toEqual([]);
    // nothing can say while the engine is down
    d.baseHash.mockResolvedValueOnce(undefined);
    await d.dock.libraryChanged();
    expect(d.sent(THEME_EDITOR_CHANNELS.outside)).toEqual([]);
    d.baseHash.mockResolvedValue(HASH(5));
    await d.dock.libraryChanged();
    await d.dock.libraryChanged();
    expect(d.sent(THEME_EDITOR_CHANNELS.outside)).toEqual([['changed']]);
    d.save.mockResolvedValueOnce({ ok: false, reason: 'changed' });
    expect(await d.invoke(THEME_EDITOR_CHANNELS.save, { sessionId, theme: THEME })).toEqual({ ok: false, reason: 'changed' });
    d.baseHash.mockResolvedValue(null);
    await d.dock.libraryChanged();
    expect(d.sent(THEME_EDITOR_CHANNELS.outside)).toEqual([['changed'], ['gone']]);
    // Reload opens the theme as its file is now, as a new session
    d.send(THEME_EDITOR_CHANNELS.reload, { sessionId });
    await vi.waitFor(async () => expect(await d.sessionId()).toBe(sessionId + 1));
    expect(d.dock.editing()).toBe(USER_ID);
  });

  it('names a sprite its session imported for the blob route before the import answers, and until the session ends', async () => {
    const d = setup();
    await d.dock.open(USER_ID);
    const sessionId = await d.sessionId();
    d.pickSpriteFile.mockResolvedValue('/art/blink.svg' as never);
    expect(d.dock.namedBlob(SPRITE.sha256)).toBeUndefined();
    d.importSprite.mockImplementationOnce(async () => {
      expect(d.dock.namedBlob(SPRITE.sha256)).toBeUndefined();
      return SPRITE;
    });
    const answer = d.invoke(THEME_EDITOR_CHANNELS.importSpriteFile, { sessionId });
    const named = answer.then(() => d.dock.namedBlob(SPRITE.sha256));
    expect(await answer).toEqual({ ok: true, sprite: SPRITE, name: 'blink.svg' });
    expect(await named).toEqual({ kind: 'sprite', mime: 'image/svg+xml' });
    d.dock.close();
    expect(d.dock.namedBlob(SPRITE.sha256)).toBeUndefined();
  });

  it('answers an import whose session ended during its file dialog or its import as closed, and names nothing for it', async () => {
    const d = setup();
    await d.dock.open(USER_ID);
    let picked!: (file: string | undefined) => void;
    const dialog = (): Promise<undefined> => new Promise<string | undefined>((resolve) => {
      picked = resolve;
    }) as Promise<undefined>;
    for (const [channel, pick] of [[THEME_EDITOR_CHANNELS.importSpriteFile, d.pickSpriteFile], [THEME_EDITOR_CHANNELS.importImageFile, d.pickImageFile], [THEME_EDITOR_CHANNELS.importFontFile, d.pickFontFile]] as const) {
      pick.mockImplementationOnce(dialog);
      const answer = d.invoke(channel, { sessionId: await d.sessionId() });
      await vi.waitFor(() => expect(pick).toHaveBeenCalled());
      await d.dock.open(USER_ID);
      picked('/art/file');
      expect(await answer).toEqual(CLOSED);
    }
    expect(d.importSprite).not.toHaveBeenCalled();
    expect(d.importFont).not.toHaveBeenCalled();

    d.pickSpriteFile.mockResolvedValue('/art/blink.svg' as never);
    let stored!: () => void;
    d.importSprite.mockImplementationOnce(() => new Promise((resolve) => {
      stored = () => resolve(SPRITE);
    }));
    const answer = d.invoke(THEME_EDITOR_CHANNELS.importSpriteFile, { sessionId: await d.sessionId() });
    await vi.waitFor(() => expect(d.importSprite).toHaveBeenCalled());
    await d.dock.open(USER_ID);
    stored();
    expect(await answer).toEqual(CLOSED);
    expect(d.dock.namedBlob(SPRITE.sha256)).toBeUndefined();
  });

  it('stays on its theme while its page reports unsaved edits, asks the page before moving to another, and moves on Discard only', async () => {
    const d = setup();
    await d.dock.open(USER_ID);
    d.load();
    const sessionId = await d.sessionId();
    d.send(THEME_EDITOR_CHANNELS.dirty, { sessionId, dirty: true });
    // the same theme asked for again keeps the draft and asks nothing
    expect(await d.dock.open(USER_ID)).toBe(true);
    expect(await d.sessionId()).toBe(sessionId);
    expect(d.sent(THEME_EDITOR_CHANNELS.moveAsked)).toHaveLength(0);

    expect(await d.dock.open(COPY_ID)).toBe(true);
    expect(d.dock.editing()).toBe(USER_ID);
    expect(d.sent(THEME_EDITOR_CHANNELS.moveAsked)).toHaveLength(1);
    d.send(THEME_EDITOR_CHANNELS.moveAnswer, { sessionId, discard: false });
    expect(d.dock.editing()).toBe(USER_ID);
    // Keep editing ended the question: a later Discard with nothing asked moves nothing
    d.send(THEME_EDITOR_CHANNELS.moveAnswer, { sessionId, discard: true });
    expect(d.dock.editing()).toBe(USER_ID);

    await d.dock.open(COPY_ID);
    d.send(THEME_EDITOR_CHANNELS.moveAnswer, { sessionId, discard: true });
    await vi.waitFor(() => expect(d.dock.editing()).toBe(COPY_ID));
    // the new session starts with no unsaved edits
    expect(await d.dock.open(USER_ID)).toBe(true);
    expect(d.dock.editing()).toBe(USER_ID);
  });

  it('reads the window arrangement only when its page asks, for an editable session', async () => {
    const d = setup();
    await d.dock.open(USER_ID);
    const sessionId = await d.sessionId();
    expect(await d.invoke(THEME_EDITOR_CHANNELS.captureArrangement, { sessionId })).toEqual({ ok: true, arrangement: { sidebarWidth: 300 } });
    expect(await d.invoke(THEME_EDITOR_CHANNELS.captureArrangement, { sessionId: sessionId + 1 })).toEqual(CLOSED);
    await d.dock.open('damocles');
    expect(await d.invoke(THEME_EDITOR_CHANNELS.captureArrangement, { sessionId: await d.sessionId() })).toEqual(CLOSED);
  });

  it('tells its page why the window paints no preview, once, and when it can again', async () => {
    const d = setup();
    await d.dock.open(USER_ID);
    d.load();
    const sessionId = await d.sessionId();
    d.state.refused = 'forcedColors';
    d.send(THEME_EDITOR_CHANNELS.preview, { sessionId, kind: 'dark', theme: THEME });
    d.send(THEME_EDITOR_CHANNELS.preview, { sessionId, kind: 'dark', theme: null });
    expect(d.sent(THEME_EDITOR_CHANNELS.previewRefused)).toEqual([['forcedColors']]);
    // a page that loads again hears it again
    d.load();
    expect(d.sent(THEME_EDITOR_CHANNELS.previewRefused)).toEqual([['forcedColors'], ['forcedColors']]);
    d.dock.previewRefused('safeStart');
    d.dock.previewRefused(undefined);
    d.dock.previewRefused(undefined);
    expect(d.sent(THEME_EDITOR_CHANNELS.previewRefused).slice(2)).toEqual([['safeStart'], [null]]);
  });
});
