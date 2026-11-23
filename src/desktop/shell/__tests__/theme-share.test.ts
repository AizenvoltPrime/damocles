// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import type { ThemeExportPlan } from '@shared/themes/install';
import type { OverlayThemes } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { shellI18n } from '../i18n';
import { installVisibilityObserver } from '../../../webview/__tests__/visibility-observer';
import { CLASH, installPreview } from '../../../webview/components/theme/__tests__/install-preview';
import { FakeResizeObserver, fakeOverlayApi, opened } from './fakes';

// Settings › Appearance's sharing: Import and Install from link end at the install card as a dialog, which a damocles://
// link's push opens too; a card's Export lists the theme's fonts with what Export does with each before the save dialog.
const api = fakeOverlayApi();
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

const BLEACH = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const bleach = { ...BUILTIN_THEME, id: BLEACH, name: 'Bleach', style: { fonts: { mono: { installed: 'Fira Code' } } } };
const THEMES: OverlayThemes = {
  themes: [{ status: 'ok', id: BUILTIN_THEME.id, name: BUILTIN_THEME.name, builtin: true, theme: BUILTIN_THEME }, { status: 'ok', id: BLEACH, name: 'Bleach', builtin: false, theme: bleach }],
  shown: { themeId: 'damocles', kind: 'dark', decidedBy: 'system' },
  preferred: { dark: 'damocles', light: 'damocles' },
  mode: 'system',
  schedule: { schedule: { enabled: false, rules: [] }, now: 0, zone: 'UTC', osKind: 'dark', systemLocale: 'en-GB' },
  history: [],
};

const mounted: VueWrapper[] = [];

async function openAppearance(): Promise<void> {
  vi.mocked(api.getThemes).mockResolvedValue(opened({ ok: true as const, ...THEMES }));
  await openSettings();
}

async function openSettings(): Promise<void> {
  const wrapper = mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  api.request('s1', { kind: 'settings', generation: 1, section: 'appearance' });
  await flushPromises();
  await flushPromises();
}

const byTestId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
// a closed dialog's content stays in the document while its leave transition, which happy-dom never ends, runs
const isOpen = (id: string): boolean => {
  const element = byTestId(id);
  return element !== null && element.getAttribute('data-state') !== 'closed';
};
const buttonNamed = (name: string, root: ParentNode = document): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === name);

async function click(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  element!.click();
  await flushPromises();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  installVisibilityObserver(true);
  api.installClosed();
  for (const fn of [api.importTheme, api.installFromUrl, api.installCommit, api.installCancel, api.exportPlan, api.exportSave, api.cancelPrepare, api.storeInstall]) vi.mocked(fn).mockClear();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Install from link', () => {
  it('refuses inline every form main refuses for a link from the OS, and sends the rest as typed', async () => {
    await openAppearance();
    await click(buttonNamed('Install from link…'));
    const input = byTestId('theme-link-url') as HTMLInputElement;
    for (const refused of ['https://', 'file:///C:/a.damocles-theme', 'https://user:pw@example.com/a.damocles-theme', 'https://example.com/a b.damocles-theme',
      'damocles://theme/install?url=http%3A%2F%2Fexample.com%2Fa', 'damocles://theme/install/?url=https%3A%2F%2Fexample.com%2Fa', 'damocles://THEME/install?url=https%3A%2F%2Fexample.com%2Fa',
      'damocles://theme/install?url=https%3A%2F%2Fexample.com%2Fa&silent=1', 'damocles://theme/other?url=https%3A%2F%2Fexample.com%2Fa']) {
      await type(input, refused);
      await click(byTestId('theme-link-continue'));
      expect(byTestId('theme-link-error')?.textContent?.trim(), refused).toBe('Enter an https link, such as https://example.com/aurora.damocles-theme.');
    }
    expect(api.installFromUrl).not.toHaveBeenCalled();
    const link = 'damocles://theme/install?url=https%3A%2F%2Fexample.com%2Fa.damocles-theme';
    await type(input, `  ${link} `);
    await click(byTestId('theme-link-continue'));
    expect(api.installFromUrl).toHaveBeenCalledWith(link);
  });

  it('says what it needs inline and sends only an https link', async () => {
    await openAppearance();
    await click(buttonNamed('Install from link…'));
    const dialog = byTestId('theme-link-dialog')!;
    expect(dialog.textContent).toContain('Install a theme from a link');
    const input = byTestId('theme-link-url') as HTMLInputElement;
    const cont = byTestId('theme-link-continue');

    for (const value of ['', 'http://example.com/a.damocles-theme', 'javascript:alert(1)', 'garbage']) {
      await type(input, value);
      await click(cont);
      expect(byTestId('theme-link-error')?.textContent?.trim(), value).toBe('Enter an https link, such as https://example.com/aurora.damocles-theme.');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toBe('theme-link-error');
    }
    expect(api.installFromUrl).not.toHaveBeenCalled();

    // typing again clears the error; main's refusal shows in the same place
    await type(input, 'https://example.com/aurora.damocles-theme');
    expect(byTestId('theme-link-error')).toBeNull();
    await click(cont);
    expect(api.installFromUrl).toHaveBeenCalledWith('https://example.com/aurora.damocles-theme');
    expect(byTestId('theme-link-error')?.textContent?.trim()).toBe('No theme there.');
    // the refusal was of the text that was sent, so editing it drops the refusal
    await type(input, 'https://example.com/other.damocles-theme');
    expect(byTestId('theme-link-error')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('ends the download when the dialog is cancelled during it, and cancels a card that arrives all the same', async () => {
    let answer: (value: Awaited<ReturnType<typeof api.installFromUrl>>) => void = () => undefined;
    vi.mocked(api.installFromUrl).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await openAppearance();
    await click(buttonNamed('Install from link…'));
    await type(byTestId('theme-link-url') as HTMLInputElement, 'https://example.com/aurora.damocles-theme');
    await click(byTestId('theme-link-continue'));
    expect(byTestId('theme-link-busy')).not.toBeNull();
    await click(byTestId('theme-link-cancel'));
    expect(api.cancelPrepare).toHaveBeenCalledOnce();
    expect(isOpen('theme-link-dialog')).toBe(false);
    // main had the file before it heard the cancel
    answer(opened({ ok: true as const, preview: installPreview() }));
    await flushPromises();
    expect(isOpen('theme-install-dialog')).toBe(false);
    expect(api.installCancel).toHaveBeenCalledWith('install-1');
    await click(buttonNamed('Install from link…'));
    expect(byTestId('theme-link-busy')).toBeNull();
    expect((byTestId('theme-link-continue') as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens the install card for the link and cancels it when closed', async () => {
    vi.mocked(api.installFromUrl).mockResolvedValueOnce(opened({ ok: true as const, preview: installPreview({ source: { kind: 'url', host: 'example.com' } }) }));
    await openAppearance();
    await click(buttonNamed('Install from link…'));
    await type(byTestId('theme-link-url') as HTMLInputElement, 'damocles://theme/install?url=https%3A%2F%2Fexample.com%2Fa.damocles-theme');
    await click(byTestId('theme-link-continue'));
    expect(api.installFromUrl).toHaveBeenCalledWith('damocles://theme/install?url=https%3A%2F%2Fexample.com%2Fa.damocles-theme');
    expect(isOpen('theme-link-dialog')).toBe(false);
    const card = byTestId('theme-install-card')!;
    expect(card.getAttribute('aria-label')).toBe('Install “Aurora Borealis”?');
    expect(byTestId('theme-install-host')?.textContent).toBe('example.com');

    await click(byTestId('theme-install-cancel'));
    expect(api.installCancel).toHaveBeenCalledWith('install-1');
    expect(isOpen('theme-install-dialog')).toBe(false);
  });
});

describe('Import', () => {
  it('opens the card for the picked file, installs it and confirms in a toast', async () => {
    vi.mocked(api.importTheme).mockResolvedValueOnce(opened({ ok: true as const, preview: installPreview({ source: { kind: 'file', fileName: 'aurora.damocles-theme' } }) }));
    vi.mocked(api.installCommit).mockResolvedValueOnce(opened({ ok: true as const, installed: { themeId: 'new-id', name: 'Aurora Borealis', replaced: false } }));
    await openAppearance();
    await click(buttonNamed('Import…'));
    expect(byTestId('theme-import-dialog')?.textContent).toContain('Import a theme');
    await click(byTestId('theme-import-choose'));
    expect(api.importTheme).toHaveBeenCalledOnce();
    expect(byTestId('theme-install-source')?.textContent).toBe('From the file aurora.damocles-theme');
    const toggle = byTestId('theme-install-arrangement')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await click(byTestId('theme-install-go'));
    expect(api.installCommit).toHaveBeenCalledWith({ installId: 'install-1', useArrangement: false });
    expect(isOpen('theme-install-dialog')).toBe(false);
    expect(byTestId('theme-toast')?.textContent).toContain('Installed Aurora Borealis. Pick it as your dark or light look on Installed.');
  });

  it('on a clash sends Keep both by default and Replace when picked, and keeps the card with the error when the install fails', async () => {
    vi.mocked(api.importTheme).mockResolvedValueOnce(opened({ ok: true as const, preview: installPreview({ clash: CLASH }) }));
    vi.mocked(api.installCommit).mockResolvedValueOnce(opened({ ok: false as const, error: 'The theme changed meanwhile.' }));
    await openAppearance();
    await click(buttonNamed('Import…'));
    await click(byTestId('theme-import-choose'));
    expect(byTestId('theme-install-go')?.textContent?.trim()).toBe('Install as “Aurora Borealis 2”');
    await click(byTestId('theme-install-go'));
    expect(api.installCommit).toHaveBeenLastCalledWith({ installId: 'install-1', useArrangement: false, onClash: 'keepBoth' });
    expect(byTestId('theme-install-error')?.textContent?.trim()).toBe('The theme changed meanwhile.');

    vi.mocked(api.installCommit).mockResolvedValueOnce(opened({ ok: true as const, installed: { themeId: CLASH.themeId, name: 'Aurora Borealis', replaced: true } }));
    await click(document.getElementById('theme-install-replace'));
    expect(byTestId('theme-install-go')?.textContent?.trim()).toBe('Replace and install');
    await click(byTestId('theme-install-go'));
    expect(api.installCommit).toHaveBeenLastCalledWith({ installId: 'install-1', useArrangement: false, onClash: 'replace' });
    expect(isOpen('theme-install-dialog')).toBe(false);
  });

  it('opens the card a damocles:// link pushes, and follows its flash checks', async () => {
    await openAppearance();
    const preview = installPreview();
    api.installOpen({ ...preview, wallpapers: [{ ...preview.wallpapers[1]!, flash: 'pending' }] });
    await flushPromises();
    expect(byTestId('theme-install-flash-pending')).not.toBeNull();
    api.installUpdated({ ...preview, wallpapers: [{ ...preview.wallpapers[1]!, flash: 'flagged' }] });
    await flushPromises();
    expect(byTestId('theme-install-flash-blocked')?.getAttribute('aria-label')).toBe('Blocked: flashes');
  });

  it('shows the card main opened before the page was there, with its newest preview', async () => {
    const preview = installPreview();
    api.installOpen({ ...preview, wallpapers: [{ ...preview.wallpapers[1]!, flash: 'pending' }] });
    api.installUpdated({ ...preview, wallpapers: [{ ...preview.wallpapers[1]!, flash: 'flagged' }] });
    await openAppearance();
    expect(isOpen('theme-install-dialog')).toBe(true);
    expect(byTestId('theme-install-flash-blocked')).not.toBeNull();
    expect(byTestId('theme-install-flash-pending')).toBeNull();
  });

  it('shows the card main opens over the schedule page, and confirms its install once the gallery is back', async () => {
    await openAppearance();
    await click(byTestId('theme-schedule-edit'));
    expect(byTestId('schedule-page')).not.toBeNull();
    api.installOpen({ ...installPreview(), installId: 'install-1' });
    await flushPromises();
    await flushPromises();
    expect(byTestId('schedule-page')).not.toBeNull();
    expect(isOpen('theme-install-dialog')).toBe(true);
    vi.mocked(api.installCommit).mockResolvedValueOnce(opened({ ok: true as const, installed: { themeId: 'new-id', name: 'Aurora Borealis', replaced: false } }));
    await click(byTestId('theme-install-go'));
    expect(isOpen('theme-install-dialog')).toBe(false);
    await click(byTestId('schedule-back'));
    expect(byTestId('theme-toast')?.textContent).toContain('Installed Aurora Borealis.');
  });

  it('shows the card main opens while another section shows, where its Cancel frees the card', async () => {
    await openAppearance();
    await click(byTestId('settings-nav-editor'));
    expect(byTestId('theme-gallery')).toBeNull();
    api.installOpen({ ...installPreview(), installId: 'install-1' });
    await flushPromises();
    await flushPromises();
    expect(isOpen('theme-install-dialog')).toBe(true);
    await click(byTestId('theme-install-cancel'));
    expect(api.installCancel).toHaveBeenCalledWith('install-1');
    expect(isOpen('theme-install-dialog')).toBe(false);
  });

  it("shows the card of a store theme's Update that answers after the user left Appearance", async () => {
    const store = { ...bleach, origin: { kind: 'store' as const, store: { entryId: 'bleach-entry', version: '1.0.0', sha256: 'a'.repeat(64) }, installedAt: 0 } };
    vi.mocked(api.getThemes).mockResolvedValue(opened({ ok: true as const, ...THEMES, themes: [THEMES.themes[0]!, { status: 'ok', id: BLEACH, name: 'Bleach', builtin: false, theme: store, storeUpdate: { version: '2.0.0' } }] }));
    let answer: (value: Awaited<ReturnType<typeof api.storeInstall>>) => void = () => undefined;
    vi.mocked(api.storeInstall).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await openSettings();
    await click(document.querySelector<HTMLElement>('[data-testid="theme-card-update"] button'));
    expect(api.storeInstall).toHaveBeenCalledWith('bleach-entry');
    await click(byTestId('settings-nav-editor'));
    answer(opened({ ok: true as const, preview: installPreview({ store: { entryId: 'bleach-entry', version: '2.0.0', update: { themeId: BLEACH, fromVersion: '1.0.0' } } }) }));
    await flushPromises();
    expect(isOpen('theme-install-dialog')).toBe(true);
  });

  it('closes the card and says why when its install waited too long and main dropped it', async () => {
    await openAppearance();
    const preview = { ...installPreview(), installId: 'install-1' };
    api.installOpen(preview);
    await flushPromises();
    expect(isOpen('theme-install-dialog')).toBe(true);
    api.installExpired('another-install');
    await flushPromises();
    expect(isOpen('theme-install-dialog')).toBe(true);
    api.installExpired('install-1');
    await flushPromises();
    expect(isOpen('theme-install-dialog')).toBe(false);
    expect(byTestId('theme-toast')?.textContent).toContain('This theme install waited for over an hour, so it was closed and nothing was installed. Start it again.');
  });

  it("shows the open card's flash check progress, and its Allow flashing for this file asks main for that card's file", async () => {
    await openAppearance();
    const preview = { ...installPreview(), installId: 'install-1' };
    const sha = preview.wallpapers[1]!.sha256;
    api.installOpen({ ...preview, wallpapers: [{ ...preview.wallpapers[1]!, flash: 'pending' }] });
    await flushPromises();
    api.installProgress({ installId: 'another-install', sha256: sha, fraction: 0.9 });
    api.installProgress({ installId: 'install-1', sha256: sha, fraction: 0.3 });
    await flushPromises();
    expect(byTestId('theme-install-flash-progress')?.textContent).toContain('Checking every frame for flashing… 30%');
    api.installUpdated({ ...preview, wallpapers: [{ ...preview.wallpapers[1]!, flash: 'flagged', atMs: 1500 }] });
    await flushPromises();
    expect(byTestId('theme-install-flash-blocked')?.textContent).toContain('Seizure warning');
    await click(byTestId('theme-install-allow-flash'));
    expect(api.installAllowFlash).toHaveBeenCalledWith('install-1', sha);
    api.installUpdated({ ...preview, wallpapers: [{ ...preview.wallpapers[1]!, flash: 'flagged', atMs: 1500, allowed: true }] });
    await flushPromises();
    expect(byTestId('theme-install-flash-allowed')).not.toBeNull();
  });
});

describe('Export', () => {
  const plan = (verdicts: ThemeExportPlan['fonts']): ThemeExportPlan => ({ themeId: BLEACH, name: 'Bleach', fileName: 'Bleach.damocles-theme', fonts: verdicts });

  async function exportFromMenu(name: string): Promise<void> {
    const trigger = document.querySelector<HTMLElement>(`[aria-label="More actions for ${name}"]`)!;
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushPromises();
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent?.trim() === 'Export…');
    expect(item).toBeTruthy();
    item!.click();
    await flushPromises();
  }

  it('lists Export… in the built-in menu', async () => {
    await openAppearance();
    const trigger = document.querySelector<HTMLElement>('[aria-label="More actions for Damocles"]')!;
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushPromises();
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual(['View', 'Duplicate to edit', 'Export…']);
  });

  // a name written right to left would take the brackets and the words beside it into its own run
  it('isolates a right-to-left font family in the export dialog, and keeps its text free of direction marks', async () => {
    const family = 'גופן 2';
    vi.mocked(api.exportPlan).mockResolvedValueOnce(opened({ ok: true as const, plan: plan([
      { family, role: 'mono', source: 'installed', verdict: 'refused', refusal: { message: 'It forbids embedding.' } },
    ]) }));
    await openAppearance();
    await exportFromMenu('Bleach');
    const runs = (root: Element | null): string[] => [...(root?.querySelectorAll('bdi') ?? [])].map((run) => run.textContent ?? '');
    expect(runs(byTestId('theme-export-fonts'))).toEqual([family]);
    expect(runs(byTestId('theme-export-refused'))).toEqual([family]);
    expect(runs(byTestId('theme-export-dialog')!.querySelector('h2'))).toEqual(['Bleach']);
    expect(byTestId('theme-export-dialog')!.textContent).not.toMatch(/[\u2066-\u2069]/);
  });

  it('refuses a theme whose font forbids embedding, naming the font', async () => {
    vi.mocked(api.exportPlan).mockResolvedValueOnce(opened({ ok: true as const, plan: plan([
      { family: 'Fira Code', role: 'mono', source: 'installed', verdict: 'refused', refusal: { message: 'Fira Code forbids embedding (Restricted License).' } },
    ]) }));
    await openAppearance();
    await exportFromMenu('Bleach');
    expect(api.exportPlan).toHaveBeenCalledWith(BLEACH, []);
    expect(byTestId('theme-export-fonts')?.textContent).toContain('Fira Code forbids embedding (Restricted License).');
    expect(byTestId('theme-export-refused')?.textContent?.trim()).toBe('This theme can\'t be exported while it uses Fira Code.');
    expect((byTestId('theme-export-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('packs free fonts after one confirm and others after the responsibility warning, then confirms in a toast', async () => {
    vi.mocked(api.exportPlan).mockResolvedValueOnce(opened({ ok: true as const, plan: plan([
      { family: 'Inter', role: 'ui', source: 'bundled', verdict: 'confirm', spdx: 'OFL-1.1' },
      { family: 'Fira Code', role: 'mono', source: 'installed', verdict: 'warn' },
    ]) }));
    vi.mocked(api.exportSave).mockResolvedValueOnce(opened({ ok: true as const, path: 'C:\\Users\\u\\Bleach.damocles-theme', bytes: 1234 }));
    await openAppearance();
    await exportFromMenu('Bleach');
    const fonts = byTestId('theme-export-fonts')!;
    expect(fonts.textContent).toContain('Inter, interface (OFL-1.1)');
    expect(fonts.textContent).toContain('A free license that allows sharing.');
    expect(fonts.textContent).toContain('sharing it is your responsibility');
    expect(byTestId('theme-export-warning')).not.toBeNull();
    await click(byTestId('theme-export-save'));
    expect(api.exportSave).toHaveBeenCalledWith(BLEACH, []);
    expect(isOpen('theme-export-dialog')).toBe(false);
    expect(byTestId('theme-toast')?.textContent).toContain('Exported Bleach.damocles-theme');
  });

  it('keeps the export dialog open with the reason when the save fails, in its own words when the call to main rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.exportPlan).mockResolvedValueOnce(opened({ ok: true as const, plan: plan([{ family: 'Inter', role: 'ui', source: 'bundled', verdict: 'confirm', spdx: 'OFL-1.1' }]) }));
    vi.mocked(api.exportSave).mockResolvedValueOnce(opened({ ok: false as const, error: 'The disk is full.' }));
    await openAppearance();
    await exportFromMenu('Bleach');
    await click(byTestId('theme-export-save'));
    expect(byTestId('theme-export-error')?.textContent?.trim()).toBe('The disk is full.');
    expect(isOpen('theme-export-dialog')).toBe(true);
    vi.mocked(api.exportSave).mockRejectedValueOnce(new Error("Error invoking remote method 'damocles:overlay:themes:export-save': Error: boom"));
    await click(byTestId('theme-export-save'));
    expect(byTestId('theme-export-error')?.textContent?.trim()).toBe('Damocles could not do that. Try again.');
    expect(isOpen('theme-export-dialog')).toBe(true);
    vi.restoreAllMocks();
  });

  it('goes straight to the save dialog for a theme with no fonts of its own', async () => {
    vi.mocked(api.exportPlan).mockResolvedValueOnce(opened({ ok: true as const, plan: { ...plan([]), themeId: BUILTIN_THEME.id, name: 'Damocles', fileName: 'Damocles.damocles-theme' } }));
    await openAppearance();
    await exportFromMenu('Damocles');
    expect(api.exportPlan).toHaveBeenCalledWith(BUILTIN_THEME.id, []);
    expect(isOpen('theme-export-dialog')).toBe(false);
    expect(api.exportSave).toHaveBeenCalledWith(BUILTIN_THEME.id, []);
  });
});
