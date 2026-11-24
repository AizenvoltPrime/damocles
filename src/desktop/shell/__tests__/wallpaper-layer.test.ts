// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { Panel } from '@shared/themes/schema';
import type { ShellWallpaper } from '@shared/themes/wallpapers';
import WallpaperLayer from '../themes/WallpaperLayer.vue';
import { LAYOUT_SETTLED_EVENT } from '../content-bounds';
import { regionLayouts, type Rect } from '../themes/wallpaper-layout';
import { FakeResizeObserver } from './fakes';

// The layer against fake panes: happy-dom lays nothing out, so each pane's rectangle is whatever the test says it is.

const WINDOW: Rect = { x: 0, y: 0, width: 1280, height: 800 };
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const VIDEO = { kind: 'video', still: 'app://still', playable: true } as const;
const image = (panel: Panel, asset = 'i'.repeat(64)): ShellWallpaper => ({ panel, asset, fit: 'fill', dim: 0.2, blur: 0, url: `app://${asset.slice(0, 1)}`, width: 1920, height: 1080 });
const video = (panel: Panel, asset: string, span?: readonly Panel[]): ShellWallpaper => ({ ...image(panel, asset), moving: VIDEO, ...(span ? { span } : {}) });

const rects = new Map<Element, Rect>();
const running = new Set<Element>();
const frames = new Map<HTMLVideoElement, Array<() => void>>();
const restores: Array<() => void> = [];
const mounted: VueWrapper[] = [];
let measures = 0;
let drawImage: ReturnType<typeof vi.fn>;
let play: ReturnType<typeof vi.fn>;
let animationFrames: Array<() => void>;

function stub(target: object, name: string, descriptor: PropertyDescriptor): void {
  const original = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, ...descriptor });
  restores.push(() => {
    if (original) Object.defineProperty(target, name, original);
    else delete (target as Record<string, unknown>)[name];
  });
}

// A region's image box takes its pane's rectangle (no test here blurs, so it has no margin).
function rectOf(element: Element): Rect {
  const region = element.parentElement?.getAttribute('data-wallpaper-region');
  const pane = region ? document.querySelector(`[data-wallpaper-panel="${region}"]`) : null;
  return rects.get(element) ?? (pane ? rects.get(pane) : undefined) ?? { x: 0, y: 0, width: 0, height: 0 };
}

function pane(panel: Panel, rect: Rect): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('data-wallpaper-panel', panel);
  document.body.append(element);
  rects.set(element, rect);
  return element;
}

beforeEach(() => {
  measures = 0;
  animationFrames = [];
  drawImage = vi.fn();
  play = vi.fn(async () => undefined);
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: () => void) => animationFrames.push(callback)));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  stub(window, 'devicePixelRatio', { value: 2 });
  stub(Element.prototype, 'getBoundingClientRect', {
    value(this: Element) {
      measures++;
      const { x, y, width, height } = rectOf(this);
      return { left: x, top: y, width, height, right: x + width, bottom: y + height, x, y };
    },
  });
  stub(Element.prototype, 'getAnimations', { value(this: Element) { return running.has(this) ? [{ playState: 'running' }] : []; } });
  stub(HTMLCanvasElement.prototype, 'getContext', { value: () => ({ clearRect: vi.fn(), drawImage }) });
  stub(HTMLCanvasElement.prototype, 'clientWidth', { get(this: Element) { return rectOf(this.parentElement!).width; } });
  stub(HTMLCanvasElement.prototype, 'clientHeight', { get(this: Element) { return rectOf(this.parentElement!).height; } });
  // happy-dom has no readiness constants
  stub(HTMLMediaElement, 'HAVE_CURRENT_DATA', { value: 2 });
  stub(HTMLVideoElement.prototype, 'videoWidth', { get: () => 1920 });
  stub(HTMLVideoElement.prototype, 'play', { value: play });
  stub(HTMLVideoElement.prototype, 'pause', { value: vi.fn() });
  // an element let go of its source: the browser empties it
  stub(HTMLVideoElement.prototype, 'load', { value(this: HTMLVideoElement) { this.dispatchEvent(new Event('emptied')); } });
  stub(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    value(this: HTMLVideoElement, callback: () => void) {
      frames.set(this, [...(frames.get(this) ?? []), callback]);
      return 1;
    },
  });
  stub(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', { value(this: HTMLVideoElement) { frames.delete(this); } });
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  for (const restore of restores.splice(0)) restore();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-reduced-motion');
  rects.clear();
  running.clear();
  frames.clear();
  vi.unstubAllGlobals();
});

async function layer(wallpapers: readonly ShellWallpaper[], paused = false): Promise<VueWrapper> {
  const wrapper = mount(WallpaperLayer, { props: { wallpapers, paused }, attachTo: document.body });
  mounted.push(wrapper);
  rects.set(wrapper.element, WINDOW);
  (wrapper.vm as unknown as { place: () => void }).place();
  await flushPromises();
  return wrapper;
}

const region = (panel: Panel): HTMLElement => document.querySelector<HTMLElement>(`[data-wallpaper-region="${panel}"]`)!;
const copyIn = (panel: Panel): HTMLCanvasElement | null => region(panel).querySelector('canvas');
const videoOf = (asset: string): HTMLVideoElement => document.querySelector<HTMLVideoElement>(`video[data-wallpaper-video="${asset}"]`)!;
// The video presents a frame: every callback waiting for one runs.
const present = (element: HTMLVideoElement): void => {
  for (const callback of frames.get(element)?.splice(0) ?? []) callback();
};
const place = (wrapper: VueWrapper): void => (wrapper.vm as unknown as { place: () => void }).place();
const whenDrawn = (wrapper: VueWrapper): Promise<void> => (wrapper.vm as unknown as { whenDrawn: () => Promise<void> }).whenDrawn();
// How a promise stands once every job already queued has run.
async function outcomeOf(promise: Promise<void>): Promise<string> {
  let outcome = 'pending';
  promise.then(() => (outcome = 'drawn'), (err: unknown) => (outcome = String(err)));
  await flushPromises();
  return outcome;
}
// Every image decodes; the URLs asked for are the ones returned.
function decodeImages(): string[] {
  const decoded: string[] = [];
  stub(HTMLImageElement.prototype, 'decode', {
    value(this: HTMLImageElement) {
      decoded.push(this.src);
      return Promise.resolve();
    },
  });
  return decoded;
}

describe('the wallpaper layer', () => {
  it('places a region again when its pane came to rest in another slot, which moved it without a resize', async () => {
    const editor = pane('editor', { x: 800, y: 40, width: 480, height: 500 });
    await layer([image('editor')]);
    expect(region('editor').style.left).toBe('800px');

    rects.set(editor, { x: 800, y: 300, width: 480, height: 500 });
    window.dispatchEvent(new Event(LAYOUT_SETTLED_EVENT));
    expect(region('editor').style.top).toBe('300px');
  });

  it('follows a gliding pane frame by frame, one frame ahead at most, and stops once it rests', async () => {
    const editor = pane('editor', { x: 800, y: 40, width: 480, height: 500 });
    const wrapper = await layer([image('editor')]);
    running.add(editor);
    place(wrapper);
    place(wrapper);
    expect(animationFrames).toHaveLength(1);

    rects.set(editor, { x: 400, y: 40, width: 480, height: 500 });
    animationFrames.shift()!();
    expect(region('editor').style.left).toBe('400px');
    expect(animationFrames).toHaveLength(1);

    running.clear();
    animationFrames.shift()!();
    expect(animationFrames).toHaveLength(0);
  });

  it('keeps one observer for its life and places nothing for a state push that carries the same wallpapers', async () => {
    const sidebar = pane('sidebar', { x: 0, y: 40, width: 240, height: 760 });
    const wrapper = await layer([image('sidebar')]);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0]!.observed).toEqual([wrapper.element, sidebar]);

    const before = measures;
    await wrapper.setProps({ wallpapers: [image('sidebar')] });
    await wrapper.setProps({ wallpapers: [image('sidebar')] });
    await flushPromises();
    expect(measures).toBe(before);
    expect(FakeResizeObserver.instances).toHaveLength(1);

    // a pane that mounts later is observed by the same observer from the placement that first measures it
    const chat = pane('chat', { x: 240, y: 40, width: 560, height: 760 });
    await wrapper.setProps({ wallpapers: [image('sidebar'), image('chat')] });
    await flushPromises();
    expect(region('chat').hidden).toBe(false);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0]!.observed).toEqual([wrapper.element, sidebar, chat]);
  });

  it('draws a copy with each axis at its own scale when only one side of its backing store is capped', async () => {
    const all: Partial<Record<Panel, Rect>> = { titlebar: { x: 0, y: 0, width: 2560, height: 40 }, chat: { x: 0, y: 40, width: 2560, height: 1400 } };
    pane('chat', all.chat!);
    pane('titlebar', all.titlebar!);
    const wallpapers = [video('chat', A, ['chat', 'titlebar']), video('titlebar', A, ['chat', 'titlebar'])];
    const wrapper = await layer(wallpapers);
    rects.set(wrapper.element, { x: 0, y: 0, width: 2560, height: 1440 });
    drawImage.mockClear();
    place(wrapper);

    const canvas = copyIn('titlebar')!;
    expect([canvas.width, canvas.height]).toEqual([4096, 80]);
    const placed = regionLayouts(wallpapers, all, { x: 0, y: 0, width: 2560, height: 1440 }).find((layout) => layout.panel === 'titlebar')!.image;
    expect(drawImage).toHaveBeenLastCalledWith(videoOf(A), placed.x * 1.6, placed.y * 2, placed.width * 1.6, placed.height * 2);
  });

  it("moves a region's copy from one video to another: the first video no longer draws it, and it stays when that video goes", async () => {
    pane('sidebar', { x: 0, y: 40, width: 240, height: 760 });
    pane('chat', { x: 240, y: 40, width: 560, height: 760 });
    pane('editor', { x: 800, y: 40, width: 480, height: 760 });
    const wrapper = await layer([video('sidebar', A), video('chat', B), video('editor', A)]);
    expect(copyIn('editor')!.dataset['wallpaperCopy']).toBe(A);
    const first = videoOf(A);

    await wrapper.setProps({ wallpapers: [video('sidebar', A), video('chat', B), video('editor', B)] });
    await flushPromises();
    const copy = copyIn('editor')!;
    expect(copy.dataset['wallpaperCopy']).toBe(B);
    drawImage.mockClear();
    present(first);
    expect(drawImage).not.toHaveBeenCalled();
    // with no copy left the first video stops asking for frames
    expect(frames.get(first) ?? []).toHaveLength(0);

    await wrapper.setProps({ wallpapers: [image('sidebar'), video('chat', B), video('editor', B)] });
    await flushPromises();
    expect(document.querySelector(`video[data-wallpaper-video="${A}"]`)).toBeNull();
    expect(copy.isConnected).toBe(true);
    present(videoOf(B));
    expect(drawImage).toHaveBeenCalledWith(videoOf(B), expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number));
  });

  it("lets go of a hidden region's copy, and asks for no more frames once no copy is left", async () => {
    pane('sidebar', { x: 0, y: 40, width: 240, height: 760 });
    const chat = pane('chat', { x: 240, y: 40, width: 560, height: 760 });
    const wrapper = await layer([video('sidebar', A), video('chat', A)]);
    expect(copyIn('chat')).not.toBeNull();
    expect(frames.get(videoOf(A))).toHaveLength(1);

    rects.set(chat, { x: 240, y: 40, width: 0, height: 760 });
    place(wrapper);
    expect(region('chat').hidden).toBe(true);
    expect(copyIn('chat')).toBeNull();
    drawImage.mockClear();
    present(videoOf(A));
    expect(drawImage).not.toHaveBeenCalled();
    expect(frames.get(videoOf(A)) ?? []).toHaveLength(0);

    // the region shows again: its copy is back and the frames are followed again
    rects.set(chat, { x: 240, y: 40, width: 560, height: 760 });
    place(wrapper);
    expect(copyIn('chat')).not.toBeNull();
    expect(frames.get(videoOf(A))).toHaveLength(1);
  });

  it('gives a sidebar slid out of the window no region, and the video to a region that shows', async () => {
    pane('sidebar', { x: -240, y: 40, width: 240, height: 760 });
    pane('chat', { x: 0, y: 40, width: 1280, height: 760 });
    await layer([video('sidebar', A, ['sidebar', 'chat']), video('chat', A, ['sidebar', 'chat'])]);
    expect(region('sidebar').hidden).toBe(true);
    expect(videoOf(A).closest('[data-wallpaper-region]')).toBe(region('chat'));
  });

  it('plays nothing under reduce motion, though main has not said paused', async () => {
    document.documentElement.setAttribute('data-reduced-motion', '');
    pane('chat', { x: 0, y: 40, width: 1280, height: 760 });
    await layer([video('chat', A)]);
    expect(play).not.toHaveBeenCalled();
    expect((region('chat').firstElementChild as HTMLElement).dataset['wallpaperPlaying']).toBe('false');
    expect((region('chat').firstElementChild as HTMLElement).style.backgroundImage).toContain('app://still');
  });

  it('plays a video main does not pause, and holds it on its still frame once main does', async () => {
    pane('chat', { x: 0, y: 40, width: 1280, height: 760 });
    const wrapper = await layer([video('chat', A)]);
    expect(play).toHaveBeenCalled();
    expect((region('chat').firstElementChild as HTMLElement).dataset['wallpaperPlaying']).toBe('true');
    await wrapper.setProps({ paused: true });
    expect((region('chat').firstElementChild as HTMLElement).dataset['wallpaperPlaying']).toBe('false');
    expect(videoOf(A).style.visibility).toBe('hidden');
  });

  it('is drawn once every shown region\'s image has decoded, a paused video\'s still included, and not when one does not load', async () => {
    const decoded: string[] = [];
    stub(HTMLImageElement.prototype, 'decode', {
      value(this: HTMLImageElement) {
        decoded.push(this.src);
        return this.src.includes('missing') ? Promise.reject(new Error('EncodingError')) : Promise.resolve();
      },
    });
    pane('sidebar', { x: 0, y: 40, width: 240, height: 760 });
    pane('chat', { x: 240, y: 40, width: 1040, height: 760 });
    // a region its pane does not show (no titlebar pane here) waits for nothing
    const drawn = await layer([image('sidebar', A), video('chat', B), image('titlebar', 'c'.repeat(64))], true);
    await (drawn.vm as unknown as { whenDrawn: () => Promise<void> }).whenDrawn();
    expect(decoded.sort()).toEqual(['app://a', 'app://still']);

    const broken = await layer([{ ...image('sidebar', A), url: 'app://missing' }]);
    await expect((broken.vm as unknown as { whenDrawn: () => Promise<void> }).whenDrawn()).rejects.toThrow('the wallpaper image app://missing did not load');
  });

  it('waits for the new image when it is asked in the same flush as a wallpaper change', async () => {
    const decoded = decodeImages();
    pane('sidebar', { x: 0, y: 40, width: 240, height: 760 });
    const wrapper = await layer([image('sidebar', A)]);
    const changed = wrapper.setProps({ wallpapers: [image('sidebar', B)] });
    await whenDrawn(wrapper);
    expect(decoded).toEqual(['app://b']);
    await changed;
  });

  it('is drawn at once when a playing video has a frame, and waits for no frame of a video it holds on its still', async () => {
    decodeImages();
    let ready = 2;
    stub(HTMLVideoElement.prototype, 'readyState', { get: () => ready });
    pane('chat', { x: 0, y: 40, width: 1280, height: 760 });
    expect(await outcomeOf(whenDrawn(await layer([video('chat', A)])))).toBe('drawn');
    ready = 0;
    document.body.innerHTML = '';
    pane('chat', { x: 0, y: 40, width: 1280, height: 760 });
    expect(await outcomeOf(whenDrawn(await layer([video('chat', B)], true)))).toBe('drawn');
  });

  it("waits for a playing video's first frame, and is not drawn when the video fails", async () => {
    decodeImages();
    stub(HTMLVideoElement.prototype, 'readyState', { get: () => 0 });
    pane('chat', { x: 0, y: 40, width: 1280, height: 760 });
    const wrapper = await layer([video('chat', A)]);
    const loading = whenDrawn(wrapper);
    expect(await outcomeOf(loading)).toBe('pending');
    videoOf(A).dispatchEvent(new Event('loadeddata'));
    expect(await outcomeOf(loading)).toBe('drawn');

    const failing = whenDrawn(wrapper);
    expect(await outcomeOf(failing)).toBe('pending');
    videoOf(A).dispatchEvent(new Event('error'));
    expect(await outcomeOf(failing)).toBe(`Error: the wallpaper video ${A} did not load`);
  });

  it('is not drawn, at once, when a playing video has already failed', async () => {
    decodeImages();
    stub(HTMLVideoElement.prototype, 'readyState', { get: () => 0 });
    stub(HTMLVideoElement.prototype, 'error', { get: () => ({ code: 4, message: 'no supported source' }) });
    pane('chat', { x: 0, y: 40, width: 1280, height: 760 });
    const wrapper = await layer([video('chat', A)]);
    expect(await outcomeOf(whenDrawn(wrapper))).toBe(`Error: the wallpaper video ${A} did not load`);
  });

  it('is not drawn when the video it waits for is let go, which empties it with no error', async () => {
    decodeImages();
    stub(HTMLVideoElement.prototype, 'readyState', { get: () => 0 });
    pane('chat', { x: 0, y: 40, width: 1280, height: 760 });
    const wrapper = await layer([video('chat', A)]);
    const waiting = whenDrawn(wrapper);
    expect(await outcomeOf(waiting)).toBe('pending');
    await wrapper.setProps({ wallpapers: [image('chat')] });
    expect(await outcomeOf(waiting)).toBe(`Error: the wallpaper video ${A} did not load`);
  });

  it('lets go of its observer, its videos and the settle listener when it unmounts', async () => {
    pane('sidebar', { x: 0, y: 40, width: 240, height: 760 });
    const wrapper = await layer([video('sidebar', A)]);
    wrapper.unmount();
    mounted.length = 0;
    expect(FakeResizeObserver.instances[0]!.observed).toEqual([]);
    expect(document.querySelector('video')).toBeNull();
    const before = measures;
    window.dispatchEvent(new Event(LAYOUT_SETTLED_EVENT));
    expect(measures).toBe(before);
  });
});
