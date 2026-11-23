// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref, type Component } from 'vue';
import SettingSelect from '@/components/settings/controls/SettingSelect.vue';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import { lookPalette } from '@/components/theme/theme-view';
import { LOOK_SEEDS, type AssetMeta, type Look, type LookColors, type ThemeFile, type WallpaperSet } from '@shared/themes/schema';
import { PANE_SURFACES } from '@shared/themes/tokens';
import type { LookKind } from '@shared/themes/tokens';
import { contrastOverImage, MAX_WALLPAPER_SETS, thumbUrl, type FlashRecord, type ImageStats, type WallpaperImport, type WallpaperPalette } from '@shared/themes/wallpapers';
import type { DamoclesOverlayApi, ThemeEditorImageResult } from '../../preload/overlay-channels';
import { createEditorImports, type EditorImports } from '../overlay/theme-editor/editor-imports';
import WallpaperPanelMap from '../overlay/theme-editor/WallpaperPanelMap.vue';
import WallpapersSection from '../overlay/theme-editor/WallpapersSection.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// The theme editor's Wallpapers section: one image per panel or one across chosen panels, with fit, dim and blur; the look's
// wallpaper sets and how the window cycles them; a moving image's flash check; surface opacity; and Palette from wallpaper.

globalThis.ResizeObserver ??= FakeResizeObserver as unknown as typeof ResizeObserver;
const SHA = (n: number): string => n.toString(16).padStart(64, '0');
const still = (bytes = 2 * 1024 * 1024): AssetMeta => ({ kind: 'image', mime: 'image/png', bytes, width: 1920, height: 1080, license: {} });
const animated: AssetMeta = { kind: 'animated', mime: 'image/gif', bytes: 3 * 1024 * 1024, width: 640, height: 360, frames: 24, license: {} };
const STATS: ImageStats = { p10: 0.05, p90: 0.3, mean: 0.15 };
const PROPOSED: LookColors = { background: '#101418', panel: '#161b20', text: '#e1e6ec', accent: '#7cc4ff', success: '#5fbf7a', warning: '#d9b45a', danger: '#e0675c', info: '#6aa7e8' };
const PALETTE: WallpaperPalette = { dark: PROPOSED, light: { ...PROPOSED, background: '#f8fafc', panel: '#eef2f6', text: '#161b20' } };

const LOOK = BUILTIN_THEME.looks.dark!;
const theme = (look: Partial<Look> = {}, assets: ThemeFile['assets'] = {}): ThemeFile => {
  const draft: ThemeFile = { ...BUILTIN_THEME, id: '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10', name: 'Dusk', looks: { dark: { ...LOOK, ...look } } };
  return Object.keys(assets).length > 0 ? { ...draft, assets } : draft;
};
const ownImage = (n: number, extra: Partial<WallpaperSet> = {}): WallpaperSet => ({ panels: { chat: { asset: SHA(n), fit: 'fill', dim: 0.55, blur: 4 } }, ...extra });

interface Harness {
  readonly wrapper: VueWrapper;
  readonly imports: EditorImports;
  readonly kind: { value: LookKind };
  readonly look: () => Look;
  readonly draft: () => ThemeFile;
  readonly setIndex: () => number;
  readonly updates: ThemeFile[];
}

const mounted: VueWrapper[] = [];
// The section as the editor holds it: each update replaces the draft, and the set being edited follows update:setIndex.
function section(start: ThemeFile, options: { known?: Record<string, { stats: ImageStats; palette?: WallpaperPalette; flash?: FlashRecord }>; readOnly?: boolean; api?: DamoclesOverlayApi; contrast?: 'raiseDim' | 'warn' } = {}): Harness {
  const api = options.api ?? fakeOverlayApi();
  const draft = ref(start);
  const setIndex = ref(0);
  const kind = ref<LookKind>('dark');
  const updates: ThemeFile[] = [];
  const edit = (next: ThemeFile): void => {
    updates.push(next);
    draft.value = next;
  };
  // the editor owns the imports: an import's answer edits the draft as it is then, through the editor
  const imports = createEditorImports({ api, sessionId: () => 7, draft: () => draft.value, edit, t: shellI18n.global.t });
  const Host = defineComponent({
    setup: () => () => h(WallpapersSection, {
      imports, draft: draft.value, kind: kind.value, readOnly: options.readOnly ?? false, setIndex: setIndex.value, known: options.known ?? {}, contrast: options.contrast ?? 'raiseDim',
      nextShortcut: 'Ctrl+Alt+Shift+.',
      onUpdate: edit,
      'onUpdate:setIndex': (next: number) => {
        setIndex.value = next;
      },
    }),
  });
  const wrapper = mount(Host, { global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, imports, kind, look: () => draft.value.looks.dark!, draft: () => draft.value, setIndex: () => setIndex.value, updates };
}

const button = (wrapper: VueWrapper, name: string) => wrapper.findAll('button').find((candidate) => (candidate.attributes('aria-label') ?? candidate.text()) === name)!;
const radio = (wrapper: VueWrapper, group: string, name: string) => wrapper.get(`[role="radiogroup"][aria-label="${group}"]`).findAll('[role="radio"]').find((candidate) => candidate.text() === name)!;
const slider = (wrapper: VueWrapper, label: string) => wrapper.get<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`);
async function slide(wrapper: VueWrapper, label: string, value: number): Promise<void> {
  const input = slider(wrapper, label);
  input.element.value = String(value);
  await input.trigger('change');
}
const cell = (wrapper: VueWrapper, panel: string) => wrapper.get(`[data-testid="wallpaper-panel-map"] [data-panel="${panel}"]`);
const imported = (sha: string, asset: AssetMeta = still(), flash?: FlashRecord): { ok: true; image: WallpaperImport; name: string } => ({ ok: true, image: { sha256: sha, asset, stats: STATS, palette: PALETTE, ...(flash ? { flash } : {}) }, name: 'dunes.png' });
// an import main answers when the test says so
function deferredImport(api: DamoclesOverlayApi): (result: ThemeEditorImageResult) => void {
  let answer!: (result: ThemeEditorImageResult) => void;
  vi.mocked(api.themeEditor.importImageFile).mockImplementation(() => new Promise((resolve) => {
    answer = resolve;
  }));
  return (result) => answer(result);
}

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

describe('the panel map', () => {
  it('draws the five panels, each named with whether it has an image and showing its thumbnail, and reports a toggle', async () => {
    const wrapper = mount(WallpaperPanelMap, { props: { pressed: ['chat'], images: { chat: SHA(1) }, disabled: false, describedBy: 'desc' }, global: { plugins: [shellI18n] } });
    mounted.push(wrapper);
    const map = wrapper.get('[data-testid="wallpaper-panel-map"]');
    expect(map.attributes()).toMatchObject({ role: 'group', 'aria-label': 'Panel', 'aria-describedby': 'desc' });
    expect(map.findAll('button').map((candidate) => candidate.attributes('aria-label'))).toEqual([
      'Title bar, no image', 'Sidebar, no image', 'Chat, has an image', 'Editor, no image', 'Terminal, no image',
    ]);
    expect(cell(wrapper, 'chat').attributes('aria-pressed')).toBe('true');
    expect(cell(wrapper, 'editor').attributes('aria-pressed')).toBe('false');
    expect((cell(wrapper, 'chat').element as HTMLElement).style.backgroundImage).toContain(thumbUrl(SHA(1)));
    expect((cell(wrapper, 'editor').element as HTMLElement).style.backgroundImage).toBe('');
    await cell(wrapper, 'terminal').trigger('click');
    expect(wrapper.emitted('toggle')).toEqual([['terminal']]);

    await wrapper.setProps({ disabled: true });
    expect(map.findAll('button').every((candidate) => candidate.attributes('disabled') !== undefined)).toBe(true);
  });
});

describe('one image per panel', () => {
  it('picks the panel to edit on the map and gives it the chosen image at the default fit, dim and blur', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.themeEditor.importImageFile).mockResolvedValue(imported(SHA(2)));
    const { wrapper, look, draft } = section(theme({ wallpapers: [ownImage(1)] }, { [SHA(1)]: still() }), { api });
    await flushPromises();
    expect(radio(wrapper, 'Wallpaper', 'One image per panel').attributes('aria-checked')).toBe('true');
    expect(wrapper.get('#theme-wallpaper-target').text()).toBe('Chat');

    await cell(wrapper, 'editor').trigger('click');
    expect(wrapper.get('#theme-wallpaper-target').text()).toBe('Editor');
    expect(cell(wrapper, 'editor').attributes('aria-pressed')).toBe('true');
    expect(wrapper.text()).toContain('No image');
    await wrapper.get('[data-testid="wallpaper-choose"]').trigger('click');
    await flushPromises();

    expect(api.themeEditor.importImageFile).toHaveBeenCalledWith(7);
    expect(look().wallpapers).toEqual([{ panels: { chat: ownImage(1).panels!.chat, editor: { asset: SHA(2), fit: 'fill', dim: 0.55, blur: 4 } } }]);
    expect(draft().assets).toEqual({ [SHA(1)]: still(), [SHA(2)]: still() });
    expect(wrapper.text()).toContain('dunes.png');
    expect(wrapper.text()).toContain('1920 × 1080 · 2.0 MB · still');
  });

  it('sets fit, dim and blur of the edited panel alone, capping a moving image\'s blur at 8 px', async () => {
    const { wrapper, look } = section(theme({ wallpapers: [{ panels: { chat: { asset: SHA(1), fit: 'fill', dim: 0.55, blur: 20 }, editor: { asset: SHA(2), fit: 'fill', dim: 0.55, blur: 4 } } }] }, { [SHA(1)]: still(), [SHA(2)]: animated }));
    await flushPromises();

    await radio(wrapper, 'Fit', 'Tile').trigger('click');
    await slide(wrapper, 'Dim', 0.3);
    await slide(wrapper, 'Blur', 12);
    expect(look().wallpapers![0]!.panels!.chat).toEqual({ asset: SHA(1), fit: 'tile', dim: 0.3, blur: 12 });
    expect(slider(wrapper, 'Blur').attributes('max')).toBe('24');

    await cell(wrapper, 'editor').trigger('click');
    expect(slider(wrapper, 'Blur').attributes('max')).toBe('8');
    expect(wrapper.text()).toContain('Moving');
    await slide(wrapper, 'Dim', 0.7);
    expect(look().wallpapers![0]!.panels).toEqual({
      chat: { asset: SHA(1), fit: 'tile', dim: 0.3, blur: 12 },
      editor: { asset: SHA(2), fit: 'fill', dim: 0.7, blur: 4 },
    });
  });

  it('removes the edited panel\'s image, dropping a wallpaper asset no look names any more', async () => {
    const { wrapper, look, draft } = section(theme({ wallpapers: [{ panels: { chat: ownImage(1).panels!.chat!, editor: { asset: SHA(2), fit: 'fit', dim: 0.4, blur: 0 } } }] }, { [SHA(1)]: still(), [SHA(2)]: still() }));
    await flushPromises();
    await button(wrapper, 'Remove image').trigger('click');
    expect(look().wallpapers).toEqual([{ panels: { editor: { asset: SHA(2), fit: 'fit', dim: 0.4, blur: 0 } } }]);
    expect(draft().assets).toEqual({ [SHA(2)]: still() });
  });

  it('puts an image that arrives late on the panel it was chosen for, in the draft as it is then, and nowhere once its set is gone', async () => {
    const api = fakeOverlayApi();
    const answer = deferredImport(api);
    const { wrapper, look } = section(theme({ wallpapers: [ownImage(1, { name: 'A' }), ownImage(2, { name: 'B' })] }, { [SHA(1)]: still(), [SHA(2)]: still() }), { api });
    await flushPromises();
    await cell(wrapper, 'editor').trigger('click');
    await wrapper.get('[data-testid="wallpaper-choose"]').trigger('click');
    // while the file dialog is open the user picks another panel and changes the chat panel's dim
    await cell(wrapper, 'terminal').trigger('click');
    await cell(wrapper, 'chat').trigger('click');
    await slide(wrapper, 'Dim', 0.3);
    answer(imported(SHA(5)));
    await flushPromises();
    expect(look().wallpapers![0]!.panels).toEqual({ chat: { asset: SHA(1), fit: 'fill', dim: 0.3, blur: 4 }, editor: { asset: SHA(5), fit: 'fill', dim: 0.55, blur: 4 } });

    // chosen for the second set, which is removed before the image arrives
    await button(wrapper, 'Edit B').trigger('click');
    await wrapper.get('[data-testid="wallpaper-choose"]').trigger('click');
    await button(wrapper, 'Remove B').trigger('click');
    const before = look().wallpapers;
    answer(imported(SHA(6)));
    await flushPromises();
    expect(look().wallpapers).toEqual(before);
  });

  it('says in its own words that an import or an allowance main rejected failed, and shows main\'s reason for one it refused', async () => {
    const api = fakeOverlayApi();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.themeEditor.importImageFile).mockRejectedValueOnce(new Error("Error invoking remote method 'damocles:theme-editor:import-image-file': Error: Rejected"));
    const flagged: FlashRecord = { flagged: true, atMs: 59_960, kind: 'general' };
    const { wrapper } = section(theme({ wallpapers: [ownImage(1)] }, { [SHA(1)]: animated }), { api, known: { [SHA(1)]: { stats: STATS, flash: flagged } } });
    await flushPromises();
    await wrapper.get('[data-testid="wallpaper-choose"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Damocles could not do that. Try again.');
    expect(wrapper.get('[data-testid="wallpaper-choose"]').attributes('disabled')).toBeUndefined();

    vi.mocked(api.themeEditor.importImageFile).mockResolvedValueOnce({ ok: false, error: 'This image is larger than 20 MB.' });
    await wrapper.get('[data-testid="wallpaper-choose"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('This image is larger than 20 MB.');

    vi.mocked(api.themeEditor.allowFlash).mockRejectedValueOnce(new Error('Rejected'));
    await wrapper.get('[data-testid="wallpaper-allow-flashing"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Damocles could not do that. Try again.');
    expect(wrapper.get('[data-testid="wallpaper-allow-flashing"]').attributes('disabled')).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('shows a moving image\'s flash check: how far it is while it runs, blocked with the time, allowed here, or not checked yet', async () => {
    const api = fakeOverlayApi();
    const answer = deferredImport(api);
    const flagged: FlashRecord = { flagged: true, atMs: 59_960, kind: 'general' };
    const { wrapper, imports } = section(theme({ wallpapers: [{ panels: { chat: { asset: SHA(1), fit: 'fill', dim: 0.55, blur: 4 }, editor: { asset: SHA(2), fit: 'fill', dim: 0.55, blur: 4 } } }] }, { [SHA(1)]: animated, [SHA(2)]: animated }), { api });
    await flushPromises();
    // the saved theme's image has no check on this computer yet
    expect(wrapper.text()).toContain('Not checked for flashing yet, so it shows its still frame.');

    await wrapper.get('[data-testid="wallpaper-choose"]').trigger('click');
    expect(wrapper.find('[data-testid="wallpaper-flash-progress"]').exists()).toBe(false);
    imports.progress(0.42);
    await flushPromises();
    expect(wrapper.get('[data-testid="wallpaper-flash-progress"]').text()).toBe('Checking every frame for flashing… 42%');
    answer(imported(SHA(7), animated, flagged));
    await flushPromises();
    expect(wrapper.find('[data-testid="wallpaper-flash-progress"]').exists()).toBe(false);
    const blocked = wrapper.get('[data-testid="wallpaper-flash-blocked"]');
    expect(blocked.text()).toContain('Blocked: flashes');
    // 59.96 s rounds to the next minute, never to 0:60.0
    expect(blocked.text()).toContain('from 1:00.0');

    vi.mocked(api.themeEditor.allowFlash).mockResolvedValue({ ok: true, flash: { ...flagged, allowed: true } });
    await wrapper.get('[data-testid="wallpaper-allow-flashing"]').trigger('click');
    await flushPromises();
    expect(api.themeEditor.allowFlash).toHaveBeenCalledWith(7, SHA(7));
    expect(wrapper.find('[data-testid="wallpaper-flash-blocked"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="wallpaper-flash-allowed"]').text()).toBe('Flashing is allowed for this file on this computer. Reduce motion still pauses it.');
  });

  it('names how muted text reads over the image, and the dim the window raises it to', async () => {
    const { wrapper } = section(theme({ wallpapers: [{ panels: { chat: { asset: SHA(1), fit: 'fill', dim: 0, blur: 0 } } }] }, { [SHA(1)]: still() }), { known: { [SHA(1)]: { stats: { p10: 0.2, p90: 0.95, mean: 0.6 } } } });
    await flushPromises();
    expect(wrapper.get('[data-testid="wallpaper-readability"]').text()).toMatch(/^Muted text would read at [\d.]+:1, so the window dims this image to \d+% to keep it at 4\.5:1\.$/);
  });
});

describe('how text reads over the image', () => {
  // stats under which muted text over the chat surface reads at a ratio just below 4.5:1 with no dim
  const justBelow = (): { stats: ImageStats; ratio: number } => {
    const palette = lookPalette(theme(), 'dark')!;
    const surface = palette[PANE_SURFACES.chat]!.slice(0, 7);
    for (let p90 = 0; p90 <= 1; p90 += 0.0005) {
      const stats = { p10: 0, p90, mean: p90 / 2 };
      const ratio = contrastOverImage(palette['--d-muted']!, surface, 0, stats);
      if (ratio < 4.5 && ratio >= 4.45) return { stats, ratio };
    }
    throw new Error('no stats give a ratio between 4.45 and 4.5');
  };

  it('rounds a ratio down, so one just below 4.5:1 never reads as 4.5:1, and writes numbers as the language does', async () => {
    const { stats, ratio } = justBelow();
    expect(ratio.toFixed(1)).toBe('4.5');
    const { wrapper } = section(theme({ wallpapers: [{ panels: { chat: { asset: SHA(1), fit: 'fill', dim: 0, blur: 0 } } }] }, { [SHA(1)]: still(2.5 * 1024 * 1024) }), { known: { [SHA(1)]: { stats } }, contrast: 'warn' });
    await flushPromises();
    expect(wrapper.get('[data-testid="wallpaper-readability"]').text()).toBe('Muted text reads at 4.4:1 over this image, below 4.5:1. Raise the dim, or let Text over wallpapers raise it for you.');
    expect(slider(wrapper, 'Blur').attributes('aria-valuetext')).toBe('0 px');

    shellI18n.global.locale.value = 'el';
    await flushPromises();
    expect(wrapper.get('[data-testid="wallpaper-readability"]').text()).toContain('με αντίθεση 4,4:1 πάνω στην εικόνα, κάτω από 4,5:1.');
    expect(wrapper.text()).toContain('1920 × 1080 · 2,5 MB · στατική');
  });
});

describe('one image across panels', () => {
  it('keeps the panels\' own images and each panel\'s own dim and blur in a set that has both, and removes only the spanning image', async () => {
    const mixed: WallpaperSet = {
      name: 'Mixed',
      span: { asset: SHA(1), panels: ['sidebar', 'chat'], fit: 'fill' },
      spanLook: { sidebar: { dim: 0.2, blur: 2 }, chat: { dim: 0.6, blur: 10 } },
      panels: { editor: { asset: SHA(2), fit: 'fit', dim: 0.4, blur: 0 } },
    };
    const { wrapper, look, draft } = section(theme({ wallpapers: [mixed] }, { [SHA(1)]: still(), [SHA(2)]: still() }));
    await flushPromises();
    expect(radio(wrapper, 'Wallpaper', 'One image across panels').attributes('aria-checked')).toBe('true');
    // the sliders show the first spanned panel's values; a dim change leaves each panel's blur as it was
    await slide(wrapper, 'Dim', 0.3);
    expect(look().wallpapers![0]).toEqual({ ...mixed, spanLook: { sidebar: { dim: 0.3, blur: 2 }, chat: { dim: 0.3, blur: 10 } } });
    await slide(wrapper, 'Blur', 6);
    expect(look().wallpapers![0]!.spanLook).toEqual({ sidebar: { dim: 0.3, blur: 6 }, chat: { dim: 0.3, blur: 6 } });
    // a panel that joins the span starts at the shown values, and the others keep theirs
    await slide(wrapper, 'Dim', 0.5);
    await cell(wrapper, 'titlebar').trigger('click');
    expect(look().wallpapers![0]!.spanLook).toEqual({ sidebar: { dim: 0.5, blur: 6 }, chat: { dim: 0.5, blur: 6 }, titlebar: { dim: 0.5, blur: 6 } });
    expect(look().wallpapers![0]!.panels).toEqual(mixed.panels);

    await button(wrapper, 'Remove image').trigger('click');
    expect(look().wallpapers).toEqual([{ name: 'Mixed', panels: mixed.panels }]);
    expect(draft().assets).toEqual({ [SHA(2)]: still() });
    expect(radio(wrapper, 'Wallpaper', 'One image per panel').attributes('aria-checked')).toBe('true');
  });

  it('replaces the spanning image of a set that has both without touching the panels\' own images', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.themeEditor.importImageFile).mockResolvedValue(imported(SHA(3)));
    const mixed: WallpaperSet = { span: { asset: SHA(1), panels: ['sidebar', 'chat'], fit: 'fill' }, spanLook: { sidebar: { dim: 0.2, blur: 2 }, chat: { dim: 0.2, blur: 2 } }, panels: { editor: { asset: SHA(2), fit: 'fit', dim: 0.4, blur: 0 } } };
    const { wrapper, look } = section(theme({ wallpapers: [mixed] }, { [SHA(1)]: still(), [SHA(2)]: still() }), { api });
    await flushPromises();
    await wrapper.get('[data-testid="wallpaper-choose"]').trigger('click');
    await flushPromises();
    expect(look().wallpapers![0]).toEqual({ ...mixed, span: { ...mixed.span!, asset: SHA(3) } });
  });

  it('forgets a span chosen before its image when the other look shows', async () => {
    const start = theme();
    const { wrapper, kind } = section({ ...start, looks: { dark: start.looks.dark!, light: BUILTIN_THEME.looks.light! } });
    await flushPromises();
    await radio(wrapper, 'Wallpaper', 'One image across panels').trigger('click');
    expect(radio(wrapper, 'Wallpaper', 'One image across panels').attributes('aria-checked')).toBe('true');
    kind.value = 'light';
    await flushPromises();
    expect(radio(wrapper, 'Wallpaper', 'None').attributes('aria-checked')).toBe('true');
    expect(wrapper.find('[data-testid="wallpaper-panel-map"]').exists()).toBe(false);
  });

  it('spans the chosen panels: the map picks them, then the image covers them all with one fit, dim and blur', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.themeEditor.importImageFile).mockResolvedValue(imported(SHA(3)));
    const { wrapper, look, draft } = section(theme({ wallpapers: [ownImage(1)] }, { [SHA(1)]: still() }), { api });
    await flushPromises();

    await radio(wrapper, 'Wallpaper', 'One image across panels').trigger('click');
    expect(wrapper.text()).toContain('Choose the panels the image spans.');
    expect(['sidebar', 'chat'].map((panel) => cell(wrapper, panel).attributes('aria-pressed'))).toEqual(['true', 'true']);
    await cell(wrapper, 'titlebar').trigger('click');
    await cell(wrapper, 'sidebar').trigger('click');
    expect(wrapper.get('#theme-wallpaper-target').text()).toBe('Across Chat, Title bar');

    await wrapper.get('[data-testid="wallpaper-choose"]').trigger('click');
    await flushPromises();
    expect(look().wallpapers).toEqual([{ span: { asset: SHA(3), panels: ['chat', 'titlebar'], fit: 'fill' }, spanLook: { chat: { dim: 0.55, blur: 4 }, titlebar: { dim: 0.55, blur: 4 } } }]);
    expect(draft().assets).toEqual({ [SHA(3)]: still() });

    await radio(wrapper, 'Fit', 'Center').trigger('click');
    await slide(wrapper, 'Dim', 0.25);
    await cell(wrapper, 'editor').trigger('click');
    expect(look().wallpapers).toEqual([{ span: { asset: SHA(3), panels: ['chat', 'editor', 'titlebar'], fit: 'center' }, spanLook: { chat: { dim: 0.25, blur: 4 }, editor: { dim: 0.25, blur: 4 }, titlebar: { dim: 0.25, blur: 4 } } }]);
    expect(['chat', 'editor', 'titlebar'].map((panel) => cell(wrapper, panel).attributes('aria-label'))).toEqual(['Chat, has an image', 'Editor, has an image', 'Title bar, has an image']);

    // the last spanned panel stays: a span covers at least one
    await cell(wrapper, 'chat').trigger('click');
    await cell(wrapper, 'editor').trigger('click');
    await cell(wrapper, 'titlebar').trigger('click');
    expect(look().wallpapers![0]!.span!.panels).toEqual(['titlebar']);

    await radio(wrapper, 'Wallpaper', 'None').trigger('click');
    expect(look().wallpapers).toBeUndefined();
    expect(draft().assets).toBeUndefined();
  });
});

describe('wallpaper sets', () => {
  const setNames = (wrapper: VueWrapper): string[] => wrapper.get('[data-testid="wallpaper-sets"]').findAll('li input').map((input) => (input.element as HTMLInputElement).value);

  it('adds sets up to the cap, each picked for editing as it is added', async () => {
    const { wrapper, look, setIndex } = section(theme());
    await flushPromises();
    expect(wrapper.text()).toContain(`0 of ${MAX_WALLPAPER_SETS} sets.`);
    await wrapper.get('[data-testid="wallpaper-set-add"]').trigger('click');
    await wrapper.get('[data-testid="wallpaper-set-add"]').trigger('click');
    expect(look().wallpapers).toEqual([{ name: 'Set 1' }, { name: 'Set 2' }]);
    expect(setIndex()).toBe(1);
    expect(button(wrapper, 'Edit Set 2').attributes('aria-pressed')).toBe('true');
    for (let i = 2; i < MAX_WALLPAPER_SETS; i++) await wrapper.get('[data-testid="wallpaper-set-add"]').trigger('click');
    expect(look().wallpapers).toHaveLength(MAX_WALLPAPER_SETS);
    expect(wrapper.get('[data-testid="wallpaper-set-add"]').attributes('disabled')).toBeDefined();
  });

  it('renames a set, and an empty name falls back to its place', async () => {
    const { wrapper, look } = section(theme({ wallpapers: [ownImage(1, { name: 'Morning' }), ownImage(2)] }, { [SHA(1)]: still(), [SHA(2)]: still() }));
    await flushPromises();
    const input = wrapper.get<HTMLInputElement>('input[aria-label="Name of set 2"]');
    input.element.value = 'Evening';
    await input.trigger('change');
    expect(look().wallpapers!.map((set) => set.name)).toEqual(['Morning', 'Evening']);
    const first = wrapper.get<HTMLInputElement>('input[aria-label="Name of set 1"]');
    first.element.value = '   ';
    await first.trigger('change');
    expect(look().wallpapers![0]).toEqual(ownImage(1));
    expect(first.attributes('placeholder')).toBe('Set 1');
  });

  it('reorders sets, the edited set following the one it was, and removes one', async () => {
    const { wrapper, look, draft, setIndex } = section(theme({ wallpapers: [ownImage(1, { name: 'A' }), ownImage(2, { name: 'B' }), ownImage(3, { name: 'C' })], cycle: { minutes: 5 } }, { [SHA(1)]: still(), [SHA(2)]: still(), [SHA(3)]: still() }));
    await flushPromises();
    expect(button(wrapper, 'Move A up').attributes('disabled')).toBeDefined();
    expect(button(wrapper, 'Move C down').attributes('disabled')).toBeDefined();

    await button(wrapper, 'Move A down').trigger('click');
    expect(setNames(wrapper)).toEqual(['B', 'A', 'C']);
    expect(setIndex()).toBe(1);
    await button(wrapper, 'Edit C').trigger('click');
    await button(wrapper, 'Move C up').trigger('click');
    expect(setNames(wrapper)).toEqual(['B', 'C', 'A']);
    expect(setIndex()).toBe(1);

    await button(wrapper, 'Remove B').trigger('click');
    expect(look().wallpapers!.map((set) => set.name)).toEqual(['C', 'A']);
    expect(setIndex()).toBe(0);
    expect(look().cycle).toEqual({ minutes: 5 });
    // one set left: nothing to cycle through, so the look's cycle goes too, and so does the removed set's image
    await button(wrapper, 'Remove A').trigger('click');
    expect(look().wallpapers).toEqual([ownImage(3, { name: 'C' })]);
    expect(look().cycle).toBeUndefined();
    expect(Object.keys(draft().assets!)).toEqual([SHA(3)]);
  });

  it('cycles on a timer of the minutes chosen, or only with Next Wallpaper, shown once the look has two sets', async () => {
    const { wrapper, look } = section(theme({ wallpapers: [ownImage(1)] }, { [SHA(1)]: still() }));
    await flushPromises();
    expect(wrapper.find('[role="radiogroup"][aria-label="Cycle"]').exists()).toBe(false);
    await wrapper.get('[data-testid="wallpaper-set-add"]').trigger('click');

    expect(radio(wrapper, 'Cycle', 'Only with Next Wallpaper (Ctrl+Alt+Shift+.)').attributes('aria-checked')).toBe('true');
    await radio(wrapper, 'Cycle', 'On a timer').trigger('click');
    expect(look().cycle).toEqual({ minutes: 15 });
    const minutes = wrapper.findComponent(SettingSelect as Component);
    // SettingSelect is generic, so its props are typed by hand
    const props = minutes.props() as { label: string; options: ReadonlyArray<{ label: string }> };
    expect(props.label).toBe('Minutes between wallpaper sets');
    expect(props.options.map((option) => option.label)).toEqual(['Every 5 minutes', 'Every 15 minutes', 'Every 30 minutes', 'Every 60 minutes']);
    minutes.vm.$emit('update:modelValue', '30');
    await flushPromises();
    expect(look().cycle).toEqual({ minutes: 30 });

    await radio(wrapper, 'Cycle', 'Only with Next Wallpaper (Ctrl+Alt+Shift+.)').trigger('click');
    expect(look().cycle).toBeUndefined();
    expect(wrapper.findComponent(SettingSelect as Component).exists()).toBe(false);
  });
});

describe('surface opacity', () => {
  it('sets the look\'s surface opacity in steps of 0.02 from 60%, leaving the key out at 100%', async () => {
    const { wrapper, look } = section(theme());
    await flushPromises();
    const input = slider(wrapper, 'Surface opacity');
    expect(input.attributes()).toMatchObject({ min: '0.6', max: '1', step: '0.02', 'aria-valuetext': '100%' });
    await slide(wrapper, 'Surface opacity', 0.8);
    expect(look().surfaceOpacity).toBe(0.8);
    expect(slider(wrapper, 'Surface opacity').attributes('aria-valuetext')).toBe('80%');
    await slide(wrapper, 'Surface opacity', 1);
    expect('surfaceOpacity' in look()).toBe(false);
  });

  it('paints the window while a slider is dragged, before it is released', async () => {
    const { wrapper, look } = section(theme({ wallpapers: [ownImage(1)] }, { [SHA(1)]: still() }));
    await flushPromises();
    for (const [label, value, read] of [['Surface opacity', 0.7, () => look().surfaceOpacity], ['Dim', 0.2, () => look().wallpapers![0]!.panels!.chat!.dim], ['Blur', 9, () => look().wallpapers![0]!.panels!.chat!.blur]] as const) {
      const input = slider(wrapper, label);
      input.element.value = String(value);
      await input.trigger('input');
      expect(read(), label).toBe(value);
    }
  });
});

describe('palette from wallpaper', () => {
  it('shows the look\'s colors beside the 8 the image proposes, and Apply palette makes them the look\'s', async () => {
    const { wrapper, look, updates } = section(theme({ wallpapers: [ownImage(1)] }, { [SHA(1)]: still() }), { known: { [SHA(1)]: { stats: STATS, palette: PALETTE } } });
    await flushPromises();
    const toggle = button(wrapper, 'Palette from wallpaper');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    const strips = wrapper.get('#theme-wallpaper-palette').findAll('[role="img"]');
    const named = (colors: LookColors): string => LOOK_SEEDS.map((seed) => `${seed[0]!.toUpperCase()}${seed.slice(1)} ${colors[seed]}`).join(', ');
    expect(strips.map((strip) => strip.attributes('aria-label'))).toEqual([`Now: ${named(LOOK.colors)}`, `Proposed: ${named(PROPOSED)}`]);

    await button(wrapper, 'Keep mine').trigger('click');
    expect(wrapper.find('#theme-wallpaper-palette').exists()).toBe(false);
    expect(updates).toEqual([]);

    await toggle.trigger('click');
    await button(wrapper, 'Apply palette').trigger('click');
    expect(look().colors).toEqual(PROPOSED);
    expect(look().wallpapers).toEqual([ownImage(1)]);
    expect(wrapper.find('#theme-wallpaper-palette').exists()).toBe(false);
  });

  it('proposes the palette of an image chosen in this session, and none for a look without an image', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.themeEditor.importImageFile).mockResolvedValue(imported(SHA(4)));
    const { wrapper, look } = section(theme(), { api });
    await flushPromises();
    expect(wrapper.text()).not.toContain('Palette from wallpaper');
    await radio(wrapper, 'Wallpaper', 'One image per panel').trigger('click');
    await wrapper.get('[data-testid="wallpaper-choose"]').trigger('click');
    await flushPromises();
    await button(wrapper, 'Palette from wallpaper').trigger('click');
    await button(wrapper, 'Apply palette').trigger('click');
    expect(look().colors).toEqual(PROPOSED);
  });
});

describe('a built-in theme', () => {
  it('shows its wallpapers read-only and sends no edit', async () => {
    const { wrapper, updates } = section(theme({ wallpapers: [ownImage(1), ownImage(2)] }, { [SHA(1)]: still(), [SHA(2)]: still() }), { readOnly: true, known: { [SHA(1)]: { stats: STATS, palette: PALETTE } } });
    await flushPromises();
    expect(wrapper.get('[data-testid="wallpaper-choose"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="wallpaper-set-add"]').attributes('disabled')).toBeDefined();
    expect(button(wrapper, 'Palette from wallpaper').attributes('disabled')).toBeDefined();
    expect(slider(wrapper, 'Surface opacity').attributes('disabled')).toBeDefined();
    // every segmented control is disabled, not only deaf
    for (const group of ['Wallpaper', 'Fit', 'Cycle']) {
      const radios = wrapper.get(`[role="radiogroup"][aria-label="${group}"]`).findAll('[role="radio"]');
      expect(radios.every((candidate) => candidate.attributes('disabled') !== undefined), group).toBe(true);
    }
    await radio(wrapper, 'Wallpaper', 'None').trigger('click');
    await radio(wrapper, 'Cycle', 'On a timer').trigger('click');
    await slide(wrapper, 'Dim', 0.2);
    expect(updates).toEqual([]);
  });
});
