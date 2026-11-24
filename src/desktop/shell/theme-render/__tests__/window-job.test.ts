// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'vue';
import type { RenderAppearance, ThemeRenderJob } from '@shared/themes/agent';
import type { CharacterView } from '@shared/themes/characters';
import type { Arrangement } from '@shared/themes/schema';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import { FakeResizeObserver } from '../../__tests__/fakes';
import { createRenderBridge } from '../render-bridge';
import { RENDER_HIGHLIGHTER } from '../render-highlighter';
import { drawWindow } from '../window-job';

// The window job's verdict: drawn only when every file the sample window shows loaded, so a file the render session refused
// fails the job even where a component shows something else in its place.

const ARRANGEMENT: Required<Arrangement> = {
  grid: { slots: { main: 'chat', side: 'editor', bottom: 'terminal' }, visible: { editor: true, terminal: false }, sideWidth: 420, bottomHeight: 200 },
  sidebarWidth: 280,
  sectionOrder: ['projects', 'chats', 'files', 'scm', 'graph', 'repos', 'search'],
  sections: {
    projects: { collapsed: false, size: 180 },
    chats: { collapsed: false },
    files: { collapsed: true, size: 200 },
    scm: { collapsed: true, size: 200 },
    graph: { collapsed: true, size: 200 },
    repos: { collapsed: true, size: 200 },
    search: { collapsed: true, size: 200 },
  },
};
const PIP: CharacterView = { name: 'Pip', states: { idle: { url: 'app://damocles/theme-blob/unserved', moves: false, playable: false } } };
const job = (overrides: Partial<RenderAppearance> = {}, view: 'window' | 'sidebar' = 'sidebar'): Extract<ThemeRenderJob, { kind: 'window' }> => ({
  kind: 'window', view, width: 1280, height: 800,
  appearance: { kind: 'dark', css: '', trustedCss: '', arrangement: ARRANGEMENT, platform: 'linux', ...overrides },
});

let fontFaces: Array<{ family: string; status: string }>;
let apps: readonly App[] = [];
const observers: MutationObserver[] = [];
beforeAll(() => {
  installPlatformBridge(createRenderBridge());
});
beforeEach(() => {
  fontFaces = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), [Symbol.iterator]: () => fontFaces[Symbol.iterator]() } });
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue(undefined);
});
afterEach(() => {
  for (const app of [...apps].reverse()) app.unmount();
  apps = [];
  for (const observer of observers.splice(0)) observer.disconnect();
  document.body.innerHTML = '';
  delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function host(): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
}

// The render session answers a refused file at once: the image fails as soon as it is in the page.
function failImagesNamed(part: string): void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const images = node instanceof HTMLElement ? [...(node instanceof HTMLImageElement ? [node] : []), ...node.querySelectorAll('img')] : [];
        for (const image of images) if (image.src.includes(part)) image.dispatchEvent(new Event('error'));
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  observers.push(observer);
}

// happy-dom lays nothing out: the sidebar takes `sidebar`, and every other element the whole drawing.
function layOut(sidebar: { left: number; top: number; right: number; bottom: number }): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const { left, top, right, bottom } = this.matches('[data-render-region="sidebar"]') ? sidebar : { left: 0, top: 0, right: 1280, bottom: 800 };
    return { left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => undefined };
  });
}

const rejection = (reason: unknown): Event => Object.assign(new Event('unhandledrejection'), { reason });

describe('the window job', () => {
  it('answers drawn, with the sidebar region in whole pixels inside the drawing', async () => {
    layOut({ left: 0.4, top: 39.6, right: 280.5, bottom: 799.2 });
    const answer = await drawWindow(job(), host(), (owned) => (apps = owned));
    expect(answer).toEqual({ drawn: true, width: 1280, height: 800, region: { x: 0, y: 39, width: 281, height: 761 } });
  });

  it('keeps a sidebar region that reaches past the drawing inside it', async () => {
    layOut({ left: -3.4, top: -0.5, right: 1290.2, bottom: 812.7 });
    const answer = await drawWindow(job(), host(), (owned) => (apps = owned));
    expect(answer.region).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });

  it('answers the whole window with no region', async () => {
    const answer = await drawWindow(job({}, 'window'), host(), (owned) => (apps = owned));
    expect(answer).toEqual({ drawn: true, width: 1280, height: 800 });
  });

  it("fails with a sample component's own error when one throws while rendering", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { search: _search, ...sections } = ARRANGEMENT.sections;
    const drawn = drawWindow(job({ arrangement: { ...ARRANGEMENT, sections } }), host(), (owned) => (apps = owned));
    await expect(drawn).rejects.toThrow("The render job's arrangement has no search section");
    await expect(drawn).rejects.toBeInstanceOf(AggregateError);
  });

  it("fails with the window's own error when it throws while rendering, which leaves no chat slot", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const grid = { ...ARRANGEMENT.grid, slots: { main: 'editor', side: 'editor', bottom: 'terminal' } as const };
    const drawn = drawWindow(job({ arrangement: { ...ARRANGEMENT, grid } }), host(), (owned) => (apps = owned));
    await expect(drawn).rejects.toThrow('grid layout has no slot for chat');
  });

  it('fails on an uncaught error and on an unhandled rejection during the job, and on neither after it', async () => {
    const thrown = drawWindow(job(), host(), (owned) => (apps = owned));
    window.dispatchEvent(Object.assign(new Event('error'), { error: new Error('a sample timer threw') }));
    await expect(thrown).rejects.toThrow('a sample timer threw');

    const rejected = drawWindow(job(), host(), (owned) => (apps = owned));
    window.dispatchEvent(rejection(new Error('a sample promise rejected')));
    await expect(rejected).rejects.toThrow('a sample promise rejected');

    // the next job is not failed by what happens between jobs
    window.dispatchEvent(rejection(new Error('between jobs')));
    await expect(drawWindow(job(), host(), (owned) => (apps = owned))).resolves.toMatchObject({ drawn: true });
  });

  it('collects an image that did not decode with every other failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fontFaces = [{ family: 'Theme Sans', status: 'error' }];
    vi.mocked(HTMLImageElement.prototype.decode).mockImplementation(function (this: HTMLImageElement) {
      return this.src.includes('unserved') ? Promise.reject(new Error('EncodingError')) : Promise.resolve();
    });
    const drawn = drawWindow(job({ characters: { characters: [PIP], pins: {}, motion: 'still', selection: 'outline' } }), host(), (owned) => (apps = owned));
    const failure = await drawn.then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(AggregateError);
    const messages = (failure as AggregateError).errors.map(String);
    expect(messages).toContain('Error: the font Theme Sans did not load');
    expect(messages).toContain("Error: the sample window's image app://damocles/theme-blob/unserved did not load");
  });

  it('fails when a wallpaper did not load', async () => {
    layOut({ left: 0, top: 40, right: 280, bottom: 800 });
    // happy-dom has no Web Animations, which the wallpaper layer reads of a pane it placed
    Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
    vi.mocked(HTMLImageElement.prototype.decode).mockImplementation(function (this: HTMLImageElement) {
      return this.src.includes('missing') ? Promise.reject(new Error('EncodingError')) : Promise.resolve();
    });
    const wallpapers = [{ panel: 'sidebar' as const, asset: 'd'.repeat(64), fit: 'fill' as const, dim: 0.4, blur: 0, url: 'app://damocles/theme-cache/missing.png', width: 1920, height: 1080 }];
    await expect(drawWindow(job({ wallpapers }), host(), (owned) => (apps = owned))).rejects.toThrow('the wallpaper image app://damocles/theme-cache/missing.png did not load');
  });

  it('fails when the sample code block did not highlight before the capture', async () => {
    // a grammar that is still loading when the page is painted
    vi.spyOn(RENDER_HIGHLIGHTER, 'isReady').mockReturnValue(false);
    vi.spyOn(RENDER_HIGHLIGHTER, 'get').mockReturnValue(new Promise(() => undefined));
    await expect(drawWindow(job(), host(), (owned) => (apps = owned))).rejects.toThrow('the sample code block did not highlight');
  });

  it('fails when a character image did not load, though its avatar fell back to the letter', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    failImagesNamed('unserved');
    const drawn = drawWindow(job({ characters: { characters: [PIP], pins: {}, motion: 'still', selection: 'outline' } }), host(), (owned) => (apps = owned));
    await expect(drawn).rejects.toThrow('app://damocles/theme-blob/unserved did not load');
    // the letter stood in for it, which the job must not pass as drawn
    expect(document.querySelector('[data-avatar="letter"]')).not.toBeNull();
  });

  it('fails when a font face did not load, though its text fell back to another face', async () => {
    fontFaces = [{ family: 'Theme Sans', status: 'error' }];
    await expect(drawWindow(job(), host(), (owned) => (apps = owned))).rejects.toThrow('the font Theme Sans did not load');
  });
});
