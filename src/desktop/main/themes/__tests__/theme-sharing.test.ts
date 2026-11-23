import { describe, expect, it, vi } from 'vitest';
import { MAX_FONT_BYTES } from '../../../../shared/themes/fonts';
import { MAX_EXPORT_FONTS, type ThemeInstallFrom, type ThemeInstallPreview } from '../../../../shared/themes/install';
import type { StoreView } from '../../../../shared/themes/store';
import { OVERLAY_CHANNELS } from '../../../preload/overlay-channels';
import { MAX_WAITING_LINKS } from '../link-queue';
import { parseInstallCommit, parseInstalledFonts, ThemeSharing, type SharingOverlay, type ThemeSharingCore } from '../theme-sharing';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const TARGET = 'https://themes.example.com/aurora.damocles-theme';
const link = (url: string): string => `damocles://theme/install?url=${encodeURIComponent(url)}`;

const preview = (installId: string): ThemeInstallPreview => ({ installId } as unknown as ThemeInstallPreview);

function harness(options: { settingsOpen?: boolean; pick?: string | undefined; openCard?: boolean; engineDown?: boolean } = {}) {
  let settingsOpen = options.settingsOpen ?? true;
  let next = 0;
  const prepared: ThemeInstallFrom[] = [];
  const core = {
    themesInstallPrepare: vi.fn(async ({ from }: { from: ThemeInstallFrom }) => {
      prepared.push(from);
      return { preview: preview(`install-${++next}`) };
    }),
    themesInstallCommit: vi.fn(async ({ installId }: { installId: string }) => ({ installed: { themeId: `theme-${installId}`, name: 'Aurora', replaced: false } })),
    themesInstallCancel: vi.fn(async () => undefined),
    themesInstallAllowFlash: vi.fn(async () => true),
    themesExportPlan: vi.fn(async ({ themeId }: { themeId: string }) => ({ plan: { themeId, name: 'Aurora', fileName: 'Aurora.damocles-theme', fonts: [] } })),
    themesExportWrite: vi.fn(async () => ({ written: { bytes: 1234 } })),
    themesStoreList: vi.fn(async (): Promise<StoreView> => STORE_VIEW),
    themesStoreInstall: vi.fn(async (entryId: string) => (entryId === 'refused' ? { refused: { message: 'Aurora needs Damocles 9.0.0 or newer.' } } : { preview: preview(`store-${entryId}`) })),
  };
  let storeChanges = 0;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: Array<[string, unknown]> = [];
  const overlay: SharingOverlay = {
    handleWhileOpen: (channel, isOpen, handler) => {
      handlers.set(channel, async (...args: unknown[]) => (isOpen() ? { ok: true, value: await handler(...args) } : { ok: false, reason: 'closed' }));
    },
    send: (channel, payload) => sent.push([channel, payload]),
  };
  const cards: ThemeInstallPreview[] = [];
  const notices: string[] = [];
  const exportPaths: string[] = [];
  const sharing = new ThemeSharing({
    core: () => (options.engineDown ? undefined : core as unknown as ThemeSharingCore),
    openInstallCard: async (shown) => {
      cards.push(shown);
      return options.openCard ?? true;
    },
    pickImportFile: async () => ('pick' in options ? options.pick : 'C:\\Users\\me\\aurora.damocles-theme'),
    pickExportPath: async (fileName) => {
      exportPaths.push(fileName);
      return `C:\\Users\\me\\Documents\\${fileName}`;
    },
    notify: (message) => notices.push(message),
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, n: string) => args[Number(n)] ?? ''),
    render: (text) => text.message,
    log: () => undefined,
    storeChanged: () => {
      storeChanges++;
    },
  });
  sharing.attach(overlay, () => settingsOpen);
  const call = async (channel: string, payload: unknown): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(payload);
  };
  return { sharing, core, prepared, call, sent, cards, notices, exportPaths, setSettingsOpen: (open: boolean) => (settingsOpen = open), storeChanges: () => storeChanges };
}

const SHA = 'c'.repeat(64);
const STORE_VIEW: StoreView = {
  state: 'ok',
  fetchedAt: 5,
  entries: [{
    id: 'aurora', name: 'Aurora', author: 'Ada', description: 'Northern lights.', kinds: ['dark'], version: '1.1.0', colors: {}, fonts: [], licenses: ['CC0-1.0'],
    hasCss: false, hasLayout: false, hasCharacters: false, hasMoving: false, minAppVersion: '3.8.0', thumbnails: { dark: [{ panel: 'chat', sha256: SHA }] },
    status: 'update', installedThemeId: 'theme-1', installedVersion: '1.0.0',
  }],
};

describe('community store in Settings', () => {
  it('answers Browse with the view, each verified thumbnail as its app:// URL and the reason in the UI language', async () => {
    const { call, core } = harness();
    const answer = await call(OVERLAY_CHANNELS.themesStoreList, { refresh: true });
    expect(core.themesStoreList).toHaveBeenCalledWith(true);
    expect(answer).toEqual({ ok: true, value: { ok: true, view: { ...STORE_VIEW, entries: [{ ...STORE_VIEW.entries[0], thumbnails: { dark: [{ panel: 'chat', url: `app://damocles/store-thumb/${SHA}` }] } }] } } });
    core.themesStoreList.mockResolvedValueOnce({ state: 'refused', refusedReason: { message: 'The community store list is not signed, so Damocles did not use it.' }, entries: [] });
    expect(await call(OVERLAY_CHANNELS.themesStoreList, { refresh: false })).toEqual({ ok: true, value: { ok: true, view: { state: 'refused', refusedReason: 'The community store list is not signed, so Damocles did not use it.', entries: [] } } });
    for (const bad of [{}, { refresh: 'yes' }, { refresh: true, extra: 1 }]) await expect(call(OVERLAY_CHANNELS.themesStoreList, bad)).rejects.toThrow('Malformed store list request');
  });

  it('opens a store install as the one card, refuses a second, and answers core\'s refusal in the UI language', async () => {
    const { call, core } = harness();
    expect(await call(OVERLAY_CHANNELS.themesStoreInstall, { entryId: 'aurora' })).toEqual({ ok: true, value: { ok: true, preview: preview('store-aurora') } });
    expect(await call(OVERLAY_CHANNELS.themesStoreInstall, { entryId: 'borealis' })).toEqual({ ok: true, value: { ok: false, error: 'Another theme install is open. Install or cancel it first.' } });
    expect(await call(OVERLAY_CHANNELS.themesInstallCommit, { installId: 'store-aurora', useArrangement: false })).toMatchObject({ value: { ok: true } });
    expect(await call(OVERLAY_CHANNELS.themesStoreInstall, { entryId: 'refused' })).toEqual({ ok: true, value: { ok: false, error: 'Aurora needs Damocles 9.0.0 or newer.' } });
    // a refusal frees the slot
    expect(await call(OVERLAY_CHANNELS.themesStoreInstall, { entryId: 'borealis' })).toMatchObject({ value: { ok: true } });
    for (const entryId of ['Aurora', '-x', '../x', 'a'.repeat(65), 7]) await expect(call(OVERLAY_CHANNELS.themesStoreInstall, { entryId })).rejects.toThrow('Malformed store install request');
    expect(core.themesStoreInstall.mock.calls.map(([entryId]) => entryId)).toEqual(['aurora', 'refused', 'borealis']);
  });

  it('pushes core\'s view to Browse, and has Settings read the theme list again for the update badges only after a list was read', () => {
    const { sharing, sent, storeChanges } = harness();
    sharing.storeUpdated(STORE_VIEW, true);
    expect(sent).toEqual([[OVERLAY_CHANNELS.themesStoreUpdated, expect.objectContaining({ state: 'ok', entries: [expect.objectContaining({ status: 'update' })] })]]);
    expect(storeChanges()).toBe(1);
    // the view that follows a theme change: themes.changed already has Settings read the list
    sharing.storeUpdated(STORE_VIEW, false);
    expect(sent).toHaveLength(2);
    expect(storeChanges()).toBe(1);
  });

  // a core call that ends only when its signal aborts
  const untilAborted = (_arg: unknown, signal?: AbortSignal): Promise<never> => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted'))));

  it.each([
    ['Settings closes', (h: ReturnType<typeof harness>): void => h.sharing.settingsClosed()],
    ['the page cancels it', (h: ReturnType<typeof harness>): void => void h.call(OVERLAY_CHANNELS.themesPrepareCancel, {})],
    ['the app quits', (h: ReturnType<typeof harness>): void => h.sharing.dispose()],
  ])('ends a store download when %s, answers cancelled and frees the card slot', async (_name, end) => {
    const h = harness();
    h.core.themesStoreInstall.mockImplementationOnce(untilAborted as never);
    const start = h.call(OVERLAY_CHANNELS.themesStoreInstall, { entryId: 'aurora' });
    await settle();
    expect(await h.call(OVERLAY_CHANNELS.themesStoreInstall, { entryId: 'borealis' })).toMatchObject({ value: { ok: false, error: 'Another theme install is open. Install or cancel it first.' } });
    end(h);
    expect(await start).toEqual({ ok: true, value: { ok: false, cancelled: true } });
    expect(h.core.themesInstallCancel).not.toHaveBeenCalled();
  });

  it('frees the card slot for the next install after a cancelled download, and ends an Install from link the same way', async () => {
    const h = harness();
    h.core.themesStoreInstall.mockImplementationOnce(untilAborted as never);
    const start = h.call(OVERLAY_CHANNELS.themesStoreInstall, { entryId: 'aurora' });
    await settle();
    await h.call(OVERLAY_CHANNELS.themesPrepareCancel, {});
    await start;
    h.core.themesInstallPrepare.mockImplementationOnce(untilAborted as never);
    const link = h.call(OVERLAY_CHANNELS.themesInstallUrl, { url: TARGET });
    await settle();
    h.sharing.settingsClosed();
    expect(await link).toEqual({ ok: true, value: { ok: false, cancelled: true } });
    expect(await h.call(OVERLAY_CHANNELS.themesStoreInstall, { entryId: 'borealis' })).toMatchObject({ value: { ok: true } });
    await expect(h.call(OVERLAY_CHANNELS.themesPrepareCancel, { extra: 1 })).rejects.toThrow('Malformed theme prepare cancel');
  });
});

describe('theme sharing in Settings', () => {
  it('imports a picked file and answers its preview; only that card commits', async () => {
    const { call, core, prepared } = harness();
    const start = await call(OVERLAY_CHANNELS.themesImport, {});
    expect(start).toEqual({ ok: true, value: { ok: true, preview: preview('install-1') } });
    expect(prepared).toEqual([{ kind: 'file', path: 'C:\\Users\\me\\aurora.damocles-theme' }]);
    expect(await call(OVERLAY_CHANNELS.themesInstallCommit, { installId: 'install-9', useArrangement: false })).toMatchObject({ value: { ok: false } });
    expect(core.themesInstallCommit).not.toHaveBeenCalled();
    expect(await call(OVERLAY_CHANNELS.themesInstallCommit, { installId: 'install-1', useArrangement: false, onClash: 'keepBoth' })).toEqual({ ok: true, value: { ok: true, installed: { themeId: 'theme-install-1', name: 'Aurora', replaced: false } } });
    expect(core.themesInstallCommit).toHaveBeenCalledWith({ installId: 'install-1', useArrangement: false, onClash: 'keepBoth' });
    // the card is closed: a second commit of it reaches nothing
    expect(await call(OVERLAY_CHANNELS.themesInstallCommit, { installId: 'install-1', useArrangement: false })).toMatchObject({ value: { ok: false } });
    expect(core.themesInstallCommit).toHaveBeenCalledTimes(1);
  });

  it('answers a cancelled pick and keeps no card', async () => {
    const { call, core } = harness({ pick: undefined });
    expect(await call(OVERLAY_CHANNELS.themesImport, {})).toEqual({ ok: true, value: { ok: false, cancelled: true } });
    expect(core.themesInstallPrepare).not.toHaveBeenCalled();
    expect(await call(OVERLAY_CHANNELS.themesInstallUrl, { url: TARGET })).toMatchObject({ value: { ok: true } });
  });

  it('takes an https URL or a whole theme link from Install from link, and refuses anything else before core', async () => {
    const { call, core, prepared, sharing } = harness();
    expect(await call(OVERLAY_CHANNELS.themesInstallUrl, { url: link(TARGET) })).toMatchObject({ value: { ok: true } });
    expect(prepared).toEqual([{ kind: 'url', url: TARGET }]);
    sharing.settingsClosed();
    for (const url of ['http://themes.example.com/a', 'javascript:alert(1)', 'file:///C:/x.damocles-theme', 'https://user:pw@themes.example.com/a', link('http://themes.example.com/a')]) {
      expect(await call(OVERLAY_CHANNELS.themesInstallUrl, { url }), url).toEqual({ ok: true, value: { ok: false, error: 'Enter an https link, such as https://example.com/aurora.damocles-theme.' } });
    }
    expect(core.themesInstallPrepare).toHaveBeenCalledTimes(1);
  });

  it('shows one card at a time: a second Import while one is open is refused', async () => {
    const { call, core } = harness();
    await call(OVERLAY_CHANNELS.themesImport, {});
    expect(await call(OVERLAY_CHANNELS.themesInstallUrl, { url: TARGET })).toEqual({ ok: true, value: { ok: false, error: 'Another theme install is open. Install or cancel it first.' } });
    expect(core.themesInstallPrepare).toHaveBeenCalledTimes(1);
    await call(OVERLAY_CHANNELS.themesInstallCancel, { installId: 'install-1' });
    expect(core.themesInstallCancel).toHaveBeenCalledWith('install-1');
    expect(await call(OVERLAY_CHANNELS.themesInstallUrl, { url: TARGET })).toMatchObject({ value: { ok: true } });
  });

  it('cancels the open card in core when Settings closes', async () => {
    const { call, core, sharing } = harness();
    await call(OVERLAY_CHANNELS.themesImport, {});
    sharing.settingsClosed();
    expect(core.themesInstallCancel).toHaveBeenCalledWith('install-1');
    // a late cancel from the closing page does not cancel twice
    await call(OVERLAY_CHANNELS.themesInstallCancel, { installId: 'install-1' });
    expect(core.themesInstallCancel).toHaveBeenCalledTimes(1);
  });

  it('drops what core staged when Settings closed during the prepare', async () => {
    const { call, core, setSettingsOpen } = harness();
    core.themesInstallPrepare.mockImplementationOnce(async () => {
      setSettingsOpen(false);
      return { preview: preview('install-7') };
    });
    expect(await call(OVERLAY_CHANNELS.themesImport, {})).toEqual({ ok: true, value: { ok: false, cancelled: true } });
    expect(core.themesInstallCancel).toHaveBeenCalledWith('install-7');
  });

  it('answers closed while Settings is closed', async () => {
    const { call, core } = harness({ settingsOpen: false });
    expect(await call(OVERLAY_CHANNELS.themesImport, {})).toEqual({ ok: false, reason: 'closed' });
    expect(core.themesInstallPrepare).not.toHaveBeenCalled();
  });

  it('refuses malformed requests', async () => {
    const { call } = harness();
    await expect(call(OVERLAY_CHANNELS.themesImport, { path: 'C:\\x' })).rejects.toThrow();
    await expect(call(OVERLAY_CHANNELS.themesInstallUrl, { url: TARGET, kind: 'link' })).rejects.toThrow();
    await expect(call(OVERLAY_CHANNELS.themesInstallUrl, { url: 'x'.repeat(5000) })).rejects.toThrow();
    await expect(call(OVERLAY_CHANNELS.themesInstallCommit, { installId: 'install-1' })).rejects.toThrow();
    await expect(call(OVERLAY_CHANNELS.themesInstallCancel, { installId: '../x' })).rejects.toThrow();
    await expect(call(OVERLAY_CHANNELS.themesExportPlan, { themeId: '../../x' })).rejects.toThrow();
    await expect(call(OVERLAY_CHANNELS.themesExportSave, { themeId: 'aurora' })).rejects.toThrow();
  });

  it("keeps core's updates of the open card only, and tells the page to read the card again", async () => {
    const { call, sharing, sent } = harness();
    await call(OVERLAY_CHANNELS.themesImport, {});
    const newest = { ...preview('install-1'), totalBytes: 7 };
    sharing.installUpdated(preview('install-2'));
    sharing.installUpdated(newest);
    expect(sent).toEqual([[OVERLAY_CHANNELS.themesInstallChanged, {}]]);
    expect(await call(OVERLAY_CHANNELS.themesInstallCurrent, {})).toEqual({ ok: true, value: { preview: newest } });
  });

  it("answers a link's card with its newest preview however early the update came, and no card once it closed", async () => {
    const { sharing, call, cards } = harness();
    expect(await call(OVERLAY_CHANNELS.themesInstallCurrent, {})).toEqual({ ok: true, value: {} });
    sharing.takeArgv(['damocles.exe', '--', link(TARGET)]);
    sharing.markReady();
    await settle();
    expect(cards).toEqual([preview('install-1')]);
    // the flash verdict lands while Settings is still opening: no push reached a page, and the page still reads it
    const newest = { ...preview('install-1'), totalBytes: 7 };
    sharing.installUpdated(newest);
    expect(await call(OVERLAY_CHANNELS.themesInstallCurrent, {})).toEqual({ ok: true, value: { preview: newest } });
    await call(OVERLAY_CHANNELS.themesInstallCancel, { installId: 'install-1' });
    expect(await call(OVERLAY_CHANNELS.themesInstallCurrent, {})).toEqual({ ok: true, value: {} });
    await expect(call(OVERLAY_CHANNELS.themesInstallCurrent, { installId: 'install-1' })).rejects.toThrow();
  });

  it('closes the open card when core dropped its install for waiting too long, says so to the page, and cancels nothing in core', async () => {
    const { sharing, call, core, sent } = harness();
    await call(OVERLAY_CHANNELS.themesImport, {});
    sharing.installExpired('install-9');
    expect(sent).toEqual([]);
    sharing.installExpired('install-1');
    expect(sent).toEqual([[OVERLAY_CHANNELS.themesInstallChanged, {}]]);
    expect(await call(OVERLAY_CHANNELS.themesInstallCurrent, {})).toEqual({ ok: true, value: { expired: 'install-1' } });
    expect(core.themesInstallCancel).not.toHaveBeenCalled();
    expect(await call(OVERLAY_CHANNELS.themesInstallCommit, { installId: 'install-1', useArrangement: false })).toEqual({ ok: true, value: { ok: false, error: 'This theme install is no longer open.' } });
    // the slot is free again
    expect(await call(OVERLAY_CHANNELS.themesImport, {})).toMatchObject({ ok: true, value: { ok: true } });
    expect(await call(OVERLAY_CHANNELS.themesInstallCurrent, {})).toEqual({ ok: true, value: { preview: preview('install-2') } });
  });

  it("forwards the open card's flash check progress only, and allows a file to flash only for the open card", async () => {
    const { call, core, sharing, sent } = harness();
    await call(OVERLAY_CHANNELS.themesImport, {});
    sharing.installProgress({ installId: 'install-2', sha256: SHA, fraction: 0.5 });
    sharing.installProgress({ installId: 'install-1', sha256: SHA, fraction: 0.5 });
    expect(sent).toEqual([[OVERLAY_CHANNELS.themesInstallProgress, { installId: 'install-1', sha256: SHA, fraction: 0.5 }]]);
    expect(await call(OVERLAY_CHANNELS.themesInstallAllowFlash, { installId: 'install-2', sha256: SHA })).toEqual({ ok: true, value: false });
    expect(core.themesInstallAllowFlash).not.toHaveBeenCalled();
    expect(await call(OVERLAY_CHANNELS.themesInstallAllowFlash, { installId: 'install-1', sha256: SHA })).toEqual({ ok: true, value: true });
    expect(core.themesInstallAllowFlash).toHaveBeenCalledWith('install-1', SHA);
    await expect(call(OVERLAY_CHANNELS.themesInstallAllowFlash, { installId: 'install-1', sha256: 'not-a-hash' })).rejects.toThrow('Malformed');
    await expect(call(OVERLAY_CHANNELS.themesInstallAllowFlash, { installId: 'install-1', sha256: SHA, allowed: true })).rejects.toThrow('Malformed');
  });
});

describe('theme links through sharing', () => {
  it('opens the card for a link only once ready, through core\'s prepare as a link, and never commits', async () => {
    const { sharing, prepared, cards, core } = harness();
    sharing.takeArgv(['Damocles.exe', '--', link(TARGET)]);
    await settle();
    expect(cards).toEqual([]);
    sharing.markReady();
    await settle();
    expect(prepared).toEqual([{ kind: 'link', url: TARGET }]);
    expect(cards.map((card) => card.installId)).toEqual(['install-1']);
    expect(core.themesInstallCommit).not.toHaveBeenCalled();
  });

  it('opens nothing for a refused link from the command line or open-url', async () => {
    const { sharing, prepared } = harness();
    sharing.markReady();
    sharing.takeArgv(['Damocles.exe', '--', link('http://themes.example.com/a')]);
    sharing.takeOpenUrl('damocles://theme/install?url=javascript:alert(1)');
    sharing.takeOpenUrl('damocles://theme/uninstall');
    await settle();
    expect(prepared).toEqual([]);
  });

  it('a link waits behind a Settings card and opens once that card closes', async () => {
    const { sharing, call, cards } = harness();
    sharing.markReady();
    await call(OVERLAY_CHANNELS.themesImport, {});
    sharing.takeOpenUrl(link(TARGET));
    await settle();
    expect(cards).toEqual([]);
    await call(OVERLAY_CHANNELS.themesInstallCommit, { installId: 'install-1', useArrangement: false });
    await settle();
    expect(cards.map((card) => card.installId)).toEqual(['install-2']);
  });

  it('cancels a link\'s install when Settings could not open on it, and tells the user of a failed preview', async () => {
    const { sharing, core, notices } = harness({ openCard: false });
    sharing.markReady();
    sharing.takeOpenUrl(link(TARGET));
    await settle();
    await settle();
    expect(core.themesInstallCancel).toHaveBeenCalledWith('install-1');
    core.themesInstallPrepare.mockImplementationOnce(async () => ({ refused: { message: 'This link redirects to another host.' } }) as never);
    sharing.takeOpenUrl(link('https://other.example/b.damocles-theme'));
    await settle();
    await settle();
    expect(notices).toEqual([
      'Damocles could not show the theme from themes.example.com, because Settings could not open.',
      'Damocles could not open the theme from other.example: This link redirects to another host.',
    ]);
  });

  it('tells the user of a link whose prepare failed for a reason that is not theirs to read, without the raw error', async () => {
    const { sharing, core, notices } = harness();
    sharing.markReady();
    core.themesInstallPrepare.mockImplementationOnce(async () => {
      throw new Error('Core protocol violation: the answer to themes.install.prepare');
    });
    sharing.takeOpenUrl(link(TARGET));
    await settle();
    await settle();
    expect(notices).toEqual(['Damocles could not open the theme from themes.example.com.']);
  });

  it('names the number of links that may wait in its refusal notice', async () => {
    const { sharing, notices } = harness();
    // not ready: every link waits
    for (let n = 0; n <= MAX_WAITING_LINKS; n++) sharing.takeOpenUrl(link(`https://themes.example.com/${n}.damocles-theme`));
    expect(notices).toEqual([`Damocles opens one theme install at a time, and ${MAX_WAITING_LINKS} more theme links are already waiting, so it ignored the newest ones.`]);
  });
});

describe('what a failed action answers the page', () => {
  it('is a sentence of the UI for an error that is not the user\'s to read, and the engine\'s own sentence when it is down', async () => {
    const { call, core } = harness();
    const boom = async (): Promise<never> => {
      throw new Error('Core protocol violation: internal');
    };
    core.themesInstallPrepare.mockImplementationOnce(boom);
    expect(await call(OVERLAY_CHANNELS.themesImport, {})).toEqual({ ok: true, value: { ok: false, error: 'Damocles could not prepare this theme install. Try again.' } });
    core.themesStoreInstall.mockImplementationOnce(boom);
    expect(await call(OVERLAY_CHANNELS.themesStoreInstall, { entryId: 'aurora' })).toEqual({ ok: true, value: { ok: false, error: 'Damocles could not prepare this theme install. Try again.' } });
    core.themesStoreList.mockImplementationOnce(boom);
    expect(await call(OVERLAY_CHANNELS.themesStoreList, { refresh: false })).toEqual({ ok: true, value: { ok: false, error: 'Damocles could not read the community store list.' } });
    core.themesExportPlan.mockImplementationOnce(boom);
    expect(await call(OVERLAY_CHANNELS.themesExportPlan, { themeId: 'aurora' })).toEqual({ ok: true, value: { ok: false, error: 'Damocles could not export this theme. Try again.' } });
    core.themesExportPlan.mockImplementationOnce(boom);
    expect(await call(OVERLAY_CHANNELS.themesExportSave, { themeId: 'aurora', installedFonts: [] })).toEqual({ ok: true, value: { ok: false, error: 'Damocles could not export this theme. Try again.' } });
    await call(OVERLAY_CHANNELS.themesImport, {});
    core.themesInstallCommit.mockImplementationOnce(boom);
    expect(await call(OVERLAY_CHANNELS.themesInstallCommit, { installId: 'install-1', useArrangement: false })).toEqual({ ok: true, value: { ok: false, error: 'Damocles could not install this theme. Try again.' } });

    const down = harness({ engineDown: true });
    expect(await down.call(OVERLAY_CHANNELS.themesStoreList, { refresh: false })).toEqual({ ok: true, value: { ok: false, error: "This computer's Damocles engine is not running." } });
  });
});

describe('a second press of Install', () => {
  it('reaches core once while the first commit is in flight, and the card can be committed again after a failure', async () => {
    const { call, core } = harness();
    await call(OVERLAY_CHANNELS.themesImport, {});
    let answer: (value: { refused: { message: string } }) => void = () => undefined;
    core.themesInstallCommit.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve as never;
    }) as never);
    const first = call(OVERLAY_CHANNELS.themesInstallCommit, { installId: 'install-1', useArrangement: false });
    const second = await call(OVERLAY_CHANNELS.themesInstallCommit, { installId: 'install-1', useArrangement: false });
    expect(second).toEqual({ ok: true, value: { ok: false, error: 'This theme is already being installed.' } });
    expect(core.themesInstallCommit).toHaveBeenCalledTimes(1);
    answer({ refused: { message: 'A theme of this name exists.' } });
    expect(await first).toEqual({ ok: true, value: { ok: false, error: 'A theme of this name exists.' } });
    expect(await call(OVERLAY_CHANNELS.themesInstallCommit, { installId: 'install-1', useArrangement: false, onClash: 'keepBoth' })).toMatchObject({ value: { ok: true } });
    expect(core.themesInstallCommit).toHaveBeenCalledTimes(2);
  });
});

describe('export through main', () => {
  it('proposes core\'s file name in the save dialog and writes the installed fonts the overlay read', async () => {
    const { call, core, exportPaths } = harness();
    const fonts = [{ family: 'Fixture Sans', bytes: new Uint8Array([0, 1, 0, 0]) }];
    expect(await call(OVERLAY_CHANNELS.themesExportSave, { themeId: 'aurora', installedFonts: fonts })).toEqual({ ok: true, value: { ok: true, path: 'C:\\Users\\me\\Documents\\Aurora.damocles-theme', bytes: 1234 } });
    expect(exportPaths).toEqual(['Aurora.damocles-theme']);
    expect(core.themesExportWrite).toHaveBeenCalledWith({ themeId: 'aurora', path: 'C:\\Users\\me\\Documents\\Aurora.damocles-theme', installedFonts: fonts });
    expect(await call(OVERLAY_CHANNELS.themesExportPlan, { themeId: 'aurora', installedFonts: fonts })).toMatchObject({ value: { ok: true } });
    expect(core.themesExportPlan).toHaveBeenLastCalledWith({ themeId: 'aurora', installedFonts: fonts });
  });

  it('accepts only installed fonts within the theme\'s bounds', () => {
    const font = (family: string, size = 4): { family: string; bytes: Uint8Array } => ({ family, bytes: new Uint8Array(size) });
    expect(parseInstalledFonts([])).toEqual([]);
    expect(parseInstalledFonts([font('Fixture Sans')])).toEqual([font('Fixture Sans')]);
    expect(parseInstalledFonts([font('Fixture Sans'), font('Fixture Mono')])).toHaveLength(MAX_EXPORT_FONTS);
    expect(parseInstalledFonts(Array.from({ length: MAX_EXPORT_FONTS + 1 }, (_, n) => font(`F${n}`)))).toBeUndefined();
    expect(parseInstalledFonts([font('Fixture Sans', MAX_FONT_BYTES + 1)])).toBeUndefined();
    expect(parseInstalledFonts([font('Fixture Sans', 0)])).toBeUndefined();
    expect(parseInstalledFonts([font('Fixture Sans'), font('Fixture Sans')])).toBeUndefined();
    expect(parseInstalledFonts([font('</style>')])).toBeUndefined();
    expect(parseInstalledFonts([{ family: 'A', bytes: [1, 2] }])).toBeUndefined();
    expect(parseInstalledFonts([{ ...font('A'), path: 'C:\\x' }])).toBeUndefined();
  });

  it('accepts only a commit of the card\'s own fields', () => {
    expect(parseInstallCommit({ installId: 'a-1', useArrangement: true })).toEqual({ installId: 'a-1', useArrangement: true });
    expect(parseInstallCommit({ installId: 'a-1', useArrangement: false, onClash: 'replace' })).toEqual({ installId: 'a-1', useArrangement: false, onClash: 'replace' });
    expect(parseInstallCommit({ installId: 'a-1', useArrangement: 'yes' })).toBeUndefined();
    expect(parseInstallCommit({ installId: 'a-1', useArrangement: true, onClash: 'overwrite' })).toBeUndefined();
    expect(parseInstallCommit({ installId: 'a-1', useArrangement: true, themeId: 'x' })).toBeUndefined();
  });
});
