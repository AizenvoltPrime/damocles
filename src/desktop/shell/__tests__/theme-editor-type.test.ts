// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref, type Component } from 'vue';
import { Command } from '@/components/ui/command';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import { MAX_FONT_BYTES, type FontImport } from '@shared/themes/fonts';
import type { AssetMeta, ThemeFile } from '@shared/themes/schema';
import type { DamoclesOverlayApi } from '../../preload/overlay-channels';
import { createEditorImports } from '../overlay/theme-editor/editor-imports';
import { forgetInstalledFonts, installedFamilies, installedFontFile } from '../overlay/theme-editor/installed-fonts';
import TypeSection from '../overlay/theme-editor/TypeSection.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// The theme editor's Type section: the fonts a theme may name, bundling a font file or an installed font, and the list of
// installed fonts when this page may not read it.

globalThis.ResizeObserver ??= FakeResizeObserver as unknown as typeof ResizeObserver;
const SHA = (n: number): string => n.toString(16).padStart(64, '0');
const fontAsset = (family: string): AssetMeta => ({ kind: 'font', mime: 'font/woff2', bytes: 1000, family, license: { spdx: 'OFL-1.1' } });
const wallpaper: AssetMeta = { kind: 'image', mime: 'image/png', bytes: 1000, width: 1920, height: 1080, license: {} };
const THEME: ThemeFile = { ...BUILTIN_THEME, id: '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10', name: 'Dusk', assets: { [SHA(5)]: wallpaper } };
const imported = (n: number, family: string): FontImport => ({ sha256: SHA(n), family, asset: fontAsset(family), embedding: 'installable' });

interface Face {
  readonly family: string;
  readonly style: string;
  readonly fullName: string;
  readonly postscriptName: string;
  blob(): Promise<Blob>;
}
const face = (family: string, blob: () => Promise<Blob> = async () => new Blob([new Uint8Array(4)])): Face => ({ family, style: 'Regular', fullName: family, postscriptName: family, blob });

const mounted: VueWrapper[] = [];
function section(start: ThemeFile = THEME, api: DamoclesOverlayApi = fakeOverlayApi()) {
  const draft = ref(start);
  const edit = (next: ThemeFile): void => {
    draft.value = next;
  };
  const imports = createEditorImports({ api, sessionId: () => 7, draft: () => draft.value, edit, t: shellI18n.global.t });
  const Host = defineComponent({ setup: () => () => h(TypeSection, { api, imports, draft: draft.value, readOnly: false, onUpdate: edit }) });
  const wrapper = mount(Host, { global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, api, draft: () => draft.value };
}
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  forgetInstalledFonts();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openList(wrapper: VueWrapper, role: 'ui' | 'mono' = 'ui'): Promise<void> {
  await wrapper.get(`[data-testid="theme-type-${role}-font"]`).trigger('click');
  await flushPromises();
}
// each row: the font's name, then its kind
const options = (): string[] => [...document.querySelectorAll('[role="option"]')].map((option) => [...option.querySelectorAll('span')].map((part) => part.textContent!.trim()).join(' '));
async function search(text: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Search UI fonts"]')!;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
// Picks a row of the open list as the list's own selection does.
async function pick(wrapper: VueWrapper, key: string): Promise<void> {
  wrapper.findComponent(Command as Component).vm.$emit('update:modelValue', key);
  await flushPromises();
}
const fontShas = (theme: ThemeFile): string[] => Object.entries(theme.assets ?? {}).filter(([, asset]) => asset.kind === 'font').map(([sha]) => sha);

describe('the installed fonts', () => {
  it('lists only the families a theme may name, so no pick makes the draft invalid', async () => {
    const long = 'L'.repeat(65);
    vi.stubGlobal('queryLocalFonts', async () => [face('Inter'), face('A+B'), face(long), face('Geist Variable'), face('dt-12345678-Stolen'), face('  '), face('Inter')]);
    expect(await installedFamilies()).toEqual(['Inter']);
    const { wrapper, draft } = section();
    await openList(wrapper);
    expect(options()).toEqual(['Geist Built-in', 'Inter Installed']);
    await pick(wrapper, 'installed:Inter');
    expect(draft().style?.fonts).toEqual({ ui: { installed: 'Inter' } });
  });

  it('says so under the list when this page may not read them, and keeps Damocles\' own font pickable', async () => {
    vi.stubGlobal('queryLocalFonts', undefined);
    const { wrapper } = section();
    await openList(wrapper);
    expect(options()).toEqual(['Geist Built-in']);
    expect(document.querySelector('[data-testid="theme-type-installed-unavailable"]')!.textContent!.trim()).toBe('Damocles cannot list the fonts installed on this computer.');
  });

  it('says that no font matches a search that leaves the list empty', async () => {
    vi.stubGlobal('queryLocalFonts', async () => [face('Inter')]);
    const { wrapper } = section();
    await openList(wrapper);
    expect(document.body.textContent).not.toContain('No installed font matches.');
    await search('zzzz');
    expect(options()).toEqual([]);
    expect(document.body.textContent).toContain('No installed font matches.');
    expect(document.querySelector('[data-testid="theme-type-installed-unavailable"]')).toBeNull();
    await search('int');
    expect(options()).toEqual(['Inter Installed']);
  });

  it('refuses a font larger than a theme bundles before it reads the file, and reads the list again for the next session', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const big = { size: MAX_FONT_BYTES + 1, arrayBuffer } as unknown as Blob;
    const query = vi.fn(async () => [face('Huge', async () => big), face('Small')]);
    vi.stubGlobal('queryLocalFonts', query);
    expect(await installedFontFile('Huge')).toBe('tooLarge');
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(await installedFontFile('Small')).toBeInstanceOf(Uint8Array);
    expect(await installedFontFile('Missing')).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    forgetInstalledFonts();
    await installedFamilies();
    expect(query).toHaveBeenCalledTimes(2);

    const { wrapper, api } = section({ ...THEME, style: { fonts: { ui: { installed: 'Huge' } } } });
    await flushPromises();
    await wrapper.findAll('button').find((candidate) => candidate.text() === 'Bundle with the theme')!.trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Huge is larger than 10 MB, the most a theme bundles.');
    expect(api.themeEditor.importFontBytes).not.toHaveBeenCalled();
  });
});

describe('a bundled font', () => {
  it('goes into the theme with the role that takes it, and leaves the theme when no role names it any more', async () => {
    vi.stubGlobal('queryLocalFonts', async () => []);
    const api = fakeOverlayApi();
    vi.mocked(api.themeEditor.importFontFile).mockResolvedValueOnce({ ok: true, font: imported(1, 'Fixture Sans') }).mockResolvedValueOnce({ ok: true, font: imported(2, 'Fixture Mono') });
    const { wrapper, draft } = section(THEME, api);
    await openList(wrapper, 'ui');
    await [...document.querySelectorAll('button')].find((candidate) => candidate.textContent!.trim() === 'Add a font file…')!.click();
    await flushPromises();
    expect(api.themeEditor.importFontFile).toHaveBeenCalledWith(7);
    expect(draft().style?.fonts).toEqual({ ui: { asset: SHA(1), family: 'Fixture Sans' } });
    expect(fontShas(draft())).toEqual([SHA(1)]);
    expect(wrapper.get('[data-testid="theme-type-ui-note"]').text()).toContain('Bundled');

    // the mono font takes another file, then the UI font goes back to Damocles' own: its file leaves, the others stay
    await openList(wrapper, 'mono');
    await [...document.querySelectorAll('button')].find((candidate) => candidate.textContent!.trim() === 'Add a font file…')!.click();
    await flushPromises();
    expect(fontShas(draft()).sort()).toEqual([SHA(1), SHA(2)]);
    await openList(wrapper, 'ui');
    await pick(wrapper, 'builtin');
    expect(draft().style?.fonts).toEqual({ mono: { asset: SHA(2), family: 'Fixture Mono' } });
    expect(Object.keys(draft().assets!).sort()).toEqual([SHA(2), SHA(5)]);
  });

  it('shows main\'s reason when it refuses the file, and its own words when the call fails', async () => {
    vi.stubGlobal('queryLocalFonts', async () => []);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = fakeOverlayApi();
    vi.mocked(api.themeEditor.importFontFile).mockResolvedValueOnce({ ok: false, error: 'This font may not be embedded.' }).mockRejectedValueOnce(new Error('Rejected'));
    const { wrapper, draft } = section(THEME, api);
    for (const text of ['This font may not be embedded.', 'Damocles could not do that. Try again.']) {
      await openList(wrapper, 'ui');
      await [...document.querySelectorAll('button')].find((candidate) => candidate.textContent!.trim() === 'Add a font file…')!.click();
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toBe(text);
    }
    expect(draft()).toEqual(THEME);
    expect(wrapper.get('[data-testid="theme-type-ui-font"]').attributes('disabled')).toBeUndefined();
  });
});

describe('the style sliders', () => {
  it('paint the window while they are dragged, and write numbers as the language does', async () => {
    vi.stubGlobal('queryLocalFonts', async () => []);
    const { wrapper, draft } = section();
    await flushPromises();
    const slider = wrapper.get<HTMLInputElement>('input[type="range"][aria-label="Line spacing"]');
    expect(slider.attributes('aria-valuetext')).toBe('×1.00');
    slider.element.value = '1.2';
    await slider.trigger('input');
    expect(draft().style?.lineHeight).toBe(1.2);
    expect(wrapper.get('input[type="range"][aria-label="Chat column"]').attributes('aria-valuetext')).toMatch(/^\d+ rem$/);
    shellI18n.global.locale.value = 'el';
    await flushPromises();
    expect(wrapper.get('input[type="range"]').attributes('aria-valuetext')).toBe('×1,20');
    shellI18n.global.locale.value = 'en';
  });
});
