// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../App.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, STATE, fakeShellApi } from './fakes';
import type { ShellState } from '../../preload/shell-channels';

// Main captures the window for a draft screenshot only once the shell acknowledged the revision it published, which needs both
// ShellState.themeRevision and the theme message of that revision; they come on separate channels, in either order. Frames
// are drawn only when a test draws them, so a check that nothing was acknowledged holds after every frame ran.

const mounted: VueWrapper[] = [];
let frames: Array<() => void> = [];
// the wallpaper layer's wait for its images, which a test settles
let whenDrawn: () => Promise<void> = async () => undefined;
const WallpaperLayer = defineComponent({
  name: 'WallpaperLayer',
  setup(_props, { expose }) {
    expose({ whenDrawn: () => whenDrawn() });
    return () => h('div');
  },
});

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  frames = [];
  whenDrawn = async () => undefined;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
  delete document.documentElement.dataset['themeRevision'];
  // happy-dom has no FontFaceSet
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Runs every promise and every frame the page waits on, until nothing is left.
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await flushPromises();
    for (const frame of frames.splice(0)) frame();
  }
  await flushPromises();
}

async function shell(state: Partial<ShellState> = {}) {
  const api = fakeShellApi([], { getState: vi.fn(async () => ({ ...STATE, themeRevision: 1, ...state })) });
  api.pushThemeRevision(1);
  mounted.push(mount(App, { props: { api }, global: { plugins: [shellI18n], stubs: { WallpaperLayer } }, attachTo: document.body }));
  await settle();
  return api;
}

const acked = (api: ReturnType<typeof fakeShellApi>): number[] => vi.mocked(api.reportThemeApplied).mock.calls.map(([revision]) => revision);

describe('the shell acknowledges a theme revision', () => {
  it('once its state and its theme both carry it, when the theme comes second', async () => {
    const api = await shell();
    expect(acked(api)).toEqual([1]);
    api.push({ ...STATE, themeRevision: 2 });
    await settle();
    expect(acked(api)).toEqual([1]);
    api.pushThemeRevision(2);
    await settle();
    expect(acked(api)).toEqual([1, 2]);
  });

  it('once its state and its theme both carry it, when the state comes second', async () => {
    const api = await shell();
    api.pushThemeRevision(2);
    await settle();
    expect(acked(api)).toEqual([1]);
    api.push({ ...STATE, themeRevision: 2 });
    await settle();
    expect(acked(api)).toEqual([1, 2]);
  });

  it('not for a revision a newer one replaced during the wait, only for the newer one', async () => {
    const api = await shell();
    api.push({ ...STATE, themeRevision: 2 });
    api.pushThemeRevision(2);
    await flushPromises();
    // the frames of revision 2 have not run when revision 3 lands
    api.pushThemeRevision(3);
    api.push({ ...STATE, themeRevision: 3 });
    await settle();
    expect(acked(api)).toEqual([1, 3]);
  });

  it('not while its wallpapers fail to draw, saying so in the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // the layer draws only while a wallpaper shows
    const WALLPAPERS = { regions: [] } as unknown as NonNullable<ShellState['wallpapers']>;
    const api = await shell({ wallpapers: WALLPAPERS });
    expect(acked(api)).toEqual([1]);
    whenDrawn = async () => {
      throw new Error('the wallpaper image app://missing did not load');
    };
    api.push({ ...STATE, wallpapers: WALLPAPERS, themeRevision: 2 });
    api.pushThemeRevision(2);
    await settle();
    expect(acked(api)).toEqual([1]);
    expect(warn).toHaveBeenCalledWith('[damocles] theme revision 2 was not drawn: the wallpaper image app://missing did not load');
  });

  it('with a character that does not decode, which shows its letter instead', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = await shell();
    const avatar = document.createElement('span');
    avatar.dataset['avatar'] = 'character';
    const image = document.createElement('img');
    Object.defineProperty(image, 'decode', { value: () => Promise.reject(new Error('broken sprite')) });
    avatar.append(image);
    document.body.append(avatar);
    api.push({ ...STATE, themeRevision: 2 });
    api.pushThemeRevision(2);
    await settle();
    expect(acked(api)).toEqual([1, 2]);
    expect(warn).toHaveBeenCalledWith('[damocles] a project character did not decode: broken sprite');
  });
});
