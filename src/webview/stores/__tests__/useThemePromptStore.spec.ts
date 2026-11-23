import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, getActivePinia, setActivePinia } from 'pinia';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import { useThemePromptStore, type ThemeChangePromptView, type ThemeInstallPromptView } from '@/stores/useThemePromptStore';
import { installThumbs } from '@/utils/install-thumbs';
import { installPreview } from '@/components/theme/__tests__/install-preview';

const CHANGE: ThemeChangePromptView = {
  promptId: 'tc-1', toolUseId: 'call_1', action: 'theme', theme: BUILTIN_THEME, themeName: 'Amber', looks: ['dark'], isNew: true,
  changes: [], contrast: [], state: 'waiting', planMode: false, canShowInWindow: true, showInWindow: false, owner: { kind: 'main' },
};
const THUMB = 'data:image/webp;base64,UklGRg==';

function install(overrides: Partial<ThemeInstallPromptView> = {}): ThemeInstallPromptView {
  const preview = installPreview();
  return { promptId: 'ti-1', toolUseId: 'call_3', owner: { kind: 'main' }, preview: { ...preview, wallpapers: [{ ...preview.wallpapers[0]!, thumb: THUMB }, preview.wallpapers[1]!] }, ...overrides };
}
const STILL = installPreview().wallpapers[0]!.sha256;
const MOVING = installPreview().wallpapers[1]!.sha256;

let revoked: string[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  revoked = [];
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));
});

afterEach(() => {
  useThemePromptStore().$reset();
  vi.restoreAllMocks();
});

describe('the theme prompt store', () => {
  it('replaces a prompt posted again under its id, of each kind, and keeps the order', () => {
    const store = useThemePromptStore();
    store.setChangePrompt(CHANGE);
    store.setChangePrompt({ ...CHANGE, promptId: 'tc-2' });
    store.setChangePrompt({ ...CHANGE, state: 'outdated' });
    expect(store.changePrompts.map((held) => [held.promptId, held.state])).toEqual([['tc-1', 'outdated'], ['tc-2', 'waiting']]);

    const shot = { promptId: 'ts-1', toolUseId: 'call_2', url: 'app://damocles/theme-shot/a', width: 1280, height: 800, owner: { kind: 'main' } } as const;
    store.setScreenshotPrompt(shot);
    const first = store.screenshotPrompts[0];
    store.setScreenshotPrompt({ ...shot });
    expect(store.screenshotPrompts).toHaveLength(1);
    expect(store.screenshotPrompts[0]).not.toBe(first);

    store.setInstallPrompt(install());
    store.setInstallPrompt(install());
    expect(store.installPrompts).toHaveLength(1);
  });

  it('takes each state core sends and leaves a card it does not hold alone', () => {
    const store = useThemePromptStore();
    store.setChangePrompt(CHANGE);
    for (const state of ['applying', 'waiting', 'outdated'] as const) {
      store.updateChangePrompt('tc-1', { state });
      expect(store.changePrompts[0]!.state).toBe(state);
    }
    store.updateChangePrompt('tc-9', { state: 'applying' });
    expect(store.changePrompts).toHaveLength(1);
  });

  it('drops the Show in window note as core does: when it turns on, and when it turns off with no note', () => {
    const store = useThemePromptStore();
    store.setChangePrompt({ ...CHANGE, showInWindow: true });
    store.updateChangePrompt('tc-1', { showInWindow: false, showNote: 'takenOver' });
    expect(store.changePrompts[0]).toMatchObject({ showInWindow: false, showNote: 'takenOver' });
    store.updateChangePrompt('tc-1', { state: 'applying' });
    expect(store.changePrompts[0]!.showNote).toBe('takenOver');
    store.updateChangePrompt('tc-1', { showInWindow: false });
    expect(store.changePrompts[0]).not.toHaveProperty('showNote');

    store.updateChangePrompt('tc-1', { showInWindow: false, showNote: 'forcedColors' });
    store.updateChangePrompt('tc-1', { showInWindow: true });
    expect(store.changePrompts[0]).toMatchObject({ showInWindow: true });
    expect(store.changePrompts[0]).not.toHaveProperty('showNote');
  });

  it('keeps a running flash check\'s progress when the same staged install is posted again, and not for another', () => {
    const store = useThemePromptStore();
    store.setInstallPrompt(install());
    store.updateInstallProgress('ti-1', MOVING, 0.42);
    store.setInstallPrompt(install());
    expect(store.installPrompts[0]!.progress).toEqual({ [MOVING]: 0.42 });
    store.updateInstallPrompt('ti-1', installPreview());
    expect(store.installPrompts[0]!.progress).toEqual({ [MOVING]: 0.42 });

    store.setInstallPrompt(install({ preview: { ...installPreview(), installId: 'install-2' } }));
    expect(store.installPrompts[0]!.progress).toBeUndefined();
  });

  it('keeps an install card\'s thumbnails in the page\'s image cache and never in itself', () => {
    const store = useThemePromptStore();
    store.setInstallPrompt(install());
    expect(JSON.stringify(getActivePinia()!.state.value)).not.toContain('data:image');
    expect(store.installPrompts[0]!.preview.wallpapers.every((wallpaper) => !('thumb' in wallpaper))).toBe(true);
    const held = installThumbs('ti-1');
    expect(Object.keys(held)).toEqual([STILL]);
    expect(held[STILL]).toMatch(/^blob:/);

    // an update carries the whole preview again: the thumbnail held is kept, a new one is added
    const preview = installPreview();
    store.updateInstallPrompt('ti-1', { ...preview, wallpapers: preview.wallpapers.map((wallpaper) => ({ ...wallpaper, thumb: THUMB })) });
    expect(JSON.stringify(getActivePinia()!.state.value)).not.toContain('data:image');
    expect(installThumbs('ti-1')[STILL]).toBe(held[STILL]);
    expect(installThumbs('ti-1')[MOVING]).toMatch(/^blob:/);
    expect(revoked).toEqual([]);

    const urls = Object.values(installThumbs('ti-1'));
    store.removeInstallPrompt('ti-1');
    expect(installThumbs('ti-1')).toEqual({});
    expect(revoked.sort()).toEqual([...urls].sort());
  });

  it('takes a thumbnail only as a WebP data URL, and none for a prompt it does not hold', () => {
    const store = useThemePromptStore();
    const preview = installPreview();
    const thumbs = ['https://example.com/a.webp', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/webp;base64,not base64!'];
    store.setInstallPrompt(install({ preview: { ...preview, wallpapers: thumbs.map((thumb, at) => ({ ...preview.wallpapers[0]!, sha256: String(at).repeat(64), thumb })) } }));
    expect(installThumbs('ti-1')).toEqual({});
    expect(JSON.stringify(getActivePinia()!.state.value)).not.toContain('example.com');

    store.updateInstallPrompt('ti-9', install().preview);
    expect(installThumbs('ti-9')).toEqual({});
  });

  it('names the call a prompt waits on, and forgets every prompt and thumbnail on a reset', () => {
    const store = useThemePromptStore();
    store.setChangePrompt(CHANGE);
    store.setInstallPrompt(install());
    expect(store.awaitedBy('call_1')).toBe(true);
    expect(store.awaitedBy('call_3')).toBe(true);
    expect(store.awaitedBy('call_9')).toBe(false);

    store.$reset();
    expect([store.changePrompts, store.screenshotPrompts, store.installPrompts]).toEqual([[], [], []]);
    expect(store.awaitedBy('call_1')).toBe(false);
    expect(installThumbs('ti-1')).toEqual({});
    expect(revoked).toHaveLength(1);
  });
});
