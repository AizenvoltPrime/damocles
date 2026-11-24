import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderAppearance, ThemeRenderJob } from '../../../../shared/themes/agent';
import { checkAnalysis, checkAnswer, checkCapture, MAX_RENDER_PNG_BYTES, pngSize, ThemeRenderer, type RenderPage, type RenderServed } from '../theme-renderer';
import { webpExtended, webpLossy } from '../../../../shared/themes/testing/image-fixtures';
import { characterSheetLayout, SIDEBAR_AVATAR_PX } from '../../../../shared/themes/character-sheet';
import type { CharacterView } from '../../../../shared/themes/characters';

// The theme renderer's jobs against a fake page: the answer's shape and the capture's size are checked, jobs run one at a time
// within their timeout, and a page that dies fails its job and is made again for the next one.

const ARRANGEMENT: RenderAppearance['arrangement'] = {
  grid: { slots: { main: 'chat', side: 'editor', bottom: 'terminal' }, visible: { editor: true, terminal: false }, sideWidth: 520, bottomHeight: 240 },
  sidebarWidth: 280,
  sectionOrder: ['projects', 'chats'],
  sections: { projects: { collapsed: false, size: 200 }, chats: { collapsed: false } },
};
const APPEARANCE: RenderAppearance = { kind: 'dark', css: '', trustedCss: '', arrangement: ARRANGEMENT, platform: 'linux' };
const windowJob = (view: 'window' | 'sidebar' = 'window'): Extract<ThemeRenderJob, { kind: 'window' }> => ({ kind: 'window', view, appearance: APPEARANCE, width: 1280, height: 800 });
const SPRITE = 'b'.repeat(64);
const VIDEO = 'c'.repeat(64);
const SERVED: RenderServed = { blobs: new Map([[SPRITE, { kind: 'sprite', mime: 'image/png' }]]), stills: new Set([VIDEO]) };
const SIDEBAR = { x: 0, y: 40, width: 280, height: 760 };

function png(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(24 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

interface FakePage extends RenderPage {
  readonly jobs: string[];
  gone?: (reason: string) => void;
}

function fakePage(answer: (job: Record<string, unknown>) => Promise<unknown> | unknown = (job) => JSON.stringify({ drawn: true, width: job['width'], height: job['height'] })): FakePage {
  const page: FakePage = {
    jobs: [],
    render: async (json) => {
      page.jobs.push(json);
      return answer(JSON.parse(json) as Record<string, unknown>);
    },
    resize: async () => undefined,
    capture: async (width, height, crop) => png(crop?.width ?? width, crop?.height ?? height),
    close: vi.fn(),
  };
  return page;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('checks', () => {
  it('reads a PNG size and refuses anything else', () => {
    expect(pngSize(png(1280, 800))).toEqual({ width: 1280, height: 800 });
    expect(pngSize(new Uint8Array(30))).toBeUndefined();
  });

  it("refuses an answer that is not the job's drawn size, not JSON or not drawn", () => {
    const job = { width: 1280, height: 800 };
    expect(checkAnswer('{"drawn":true,"width":1280,"height":800}', job)).toEqual({ drawn: true, width: 1280, height: 800 });
    expect(() => checkAnswer('{"drawn":true,"width":1279,"height":800}', job)).toThrow('drew 1279x800');
    expect(() => checkAnswer('nope', job)).toThrow('not JSON');
    expect(() => checkAnswer('{"drawn":false}', job)).toThrow('did not say it drew');
    expect(() => checkAnswer({ drawn: true, width: 1280, height: 800 }, job)).toThrow('did not say it drew');
  });

  it("takes a sidebar view's region only as whole pixels inside the drawing, and leaves a window view's without one", () => {
    const answer = (region: unknown): string => JSON.stringify({ drawn: true, width: 1280, height: 800, region });
    expect(checkAnswer(answer(SIDEBAR), windowJob('sidebar'))).toEqual({ drawn: true, width: 1280, height: 800, region: SIDEBAR });
    expect(checkAnswer(answer(SIDEBAR), windowJob('window'))).toEqual({ drawn: true, width: 1280, height: 800 });
    expect(() => checkAnswer(answer(undefined), windowJob('sidebar'))).toThrow('no sidebar region');
    expect(() => checkAnswer(answer({ ...SIDEBAR, width: 280.5 }), windowJob('sidebar'))).toThrow('not whole pixels');
    expect(() => checkAnswer(answer({ ...SIDEBAR, x: '0' }), windowJob('sidebar'))).toThrow('not whole pixels');
    expect(() => checkAnswer(answer({ ...SIDEBAR, x: -1 }), windowJob('sidebar'))).toThrow('not inside 1280x800');
    expect(() => checkAnswer(answer({ ...SIDEBAR, height: 761 }), windowJob('sidebar'))).toThrow('not inside 1280x800');
    expect(() => checkAnswer(answer({ ...SIDEBAR, width: 0 }), windowJob('sidebar'))).toThrow('not inside 1280x800');
  });

  it('refuses a capture of another size, one that is not a PNG, and one past the byte cap', () => {
    const job = { width: 1280, height: 800 };
    expect(checkCapture(png(1280, 800), job)).toHaveLength(24);
    expect(() => checkCapture(png(640, 400), job)).toThrow('640x400');
    expect(() => checkCapture(new Uint8Array(40), job)).toThrow('not a PNG');
    expect(() => checkCapture(png(1280, 800, MAX_RENDER_PNG_BYTES), job)).toThrow('bytes');
  });

  it("holds a cropped capture to the crop's size", () => {
    const job = { width: 1280, height: 800 };
    expect(checkCapture(png(280, 760), job, SIDEBAR)).toHaveLength(24);
    expect(() => checkCapture(png(1280, 800), job, SIDEBAR)).toThrow('not 280x760');
  });
});

describe('ThemeRenderer', () => {
  it('draws a window job at 1280x800 with its appearance, and serves what it draws only while it runs', async () => {
    const page = fakePage();
    const seen: unknown[] = [];
    const renderer = new ThemeRenderer({ openPage: async () => page, log: () => undefined });
    page.render = async (json) => {
      seen.push(renderer.currentJobBlob(SPRITE), renderer.currentJobBlob(VIDEO), renderer.currentJobStill(VIDEO), renderer.currentJobStill(SPRITE));
      page.jobs.push(json);
      return JSON.stringify({ drawn: true, width: 1280, height: 800 });
    };
    const result = await renderer.window(windowJob(), SERVED);
    expect(pngSize(result)).toEqual({ width: 1280, height: 800 });
    expect(JSON.parse(page.jobs[0]!)).toEqual({ kind: 'window', view: 'window', appearance: APPEARANCE, width: 1280, height: 800 });
    expect(seen).toEqual([{ kind: 'sprite', mime: 'image/png' }, undefined, true, false]);
    expect(renderer.currentJobBlob(SPRITE)).toBeUndefined();
    expect(renderer.currentJobStill(VIDEO)).toBe(false);
  });

  it("draws a character sheet one page at a time, each job and its capture at the size the layout gives that page", async () => {
    const PIP: CharacterView = { name: 'Pip', states: { idle: { url: `app://damocles/theme-blob/${SPRITE}`, moves: false, playable: false } } };
    const views = new Map(Array.from({ length: 4 }, (_, index) => [index, { ...PIP, name: `Pip ${index}` }] as const));
    const tall = (index: number) => ({ index, states: [{ state: 'idle' as const, frameWidth: 32, frameHeight: 32, frames: 12 }, { state: 'running' as const, frameWidth: 32, frameHeight: 32, frames: 12 }] });
    const layout = characterSheetLayout([tall(0), tall(1), tall(2), { index: 3, states: [{ state: 'idle', frameWidth: 8, frameHeight: 8, frames: 1 }] }], { wallpaper: true, sidebarAvatar: SIDEBAR_AVATAR_PX });
    expect(layout.sheets.length).toBeGreaterThan(1);
    // a page with a second, smaller row is taller than one with a row alone
    expect(new Set(layout.sheets.map((sheet) => `${sheet.width}x${sheet.height}`)).size).toBeGreaterThan(1);
    const pages: FakePage[] = [];
    const sizes: string[] = [];
    const served: unknown[] = [];
    const renderer = new ThemeRenderer({
      openPage: async () => {
        const page = fakePage();
        const render = page.render;
        page.resize = async (width, height) => void sizes.push(`${width}x${height}`);
        page.render = async (json) => {
          served.push(renderer.currentJobBlob(SPRITE), renderer.currentJobStill(VIDEO));
          return render(json);
        };
        pages.push(page);
        return page;
      },
      log: () => undefined,
    });
    const pngs = await renderer.characterSheets(APPEARANCE, layout, views, SERVED);
    expect(pngs.map((png) => pngSize(png))).toEqual(layout.sheets.map((sheet) => ({ width: sheet.width, height: sheet.height })));
    expect(sizes).toEqual(layout.sheets.map((sheet) => `${sheet.width}x${sheet.height}`));
    // each page a job of its own, on a page of its own, which closes after it
    expect(pages).toHaveLength(layout.sheets.length);
    expect(pages.every((page) => page.jobs.length === 1 && vi.mocked(page.close).mock.calls.length === 1)).toBe(true);
    const jobs = pages.map((page) => JSON.parse(page.jobs[0]!) as Extract<ThemeRenderJob, { kind: 'characters' }>);
    expect(jobs.map((job) => job.sheet)).toEqual(layout.sheets);
    expect(jobs.map((job) => job.characters.map((character) => character.index))).toEqual(layout.sheets.map((sheet) => sheet.rows.map((row) => row.character)));
    expect(jobs[0]!.characters[0]!.view).toEqual(views.get(0));
    expect(served).toEqual(layout.sheets.flatMap(() => [{ kind: 'sprite', mime: 'image/png' }, true]));
    expect(renderer.currentJobBlob(SPRITE)).toBeUndefined();
  });

  it('refuses a sheet page past 1280x768, a page of another size and one naming a character it has no view of', async () => {
    const renderer = new ThemeRenderer({ openPage: async () => fakePage((job) => JSON.stringify({ drawn: true, width: (job['width'] as number) - 1, height: job['height'] })), log: () => undefined });
    const layout = characterSheetLayout([{ index: 0, states: [{ state: 'idle', frameWidth: 16, frameHeight: 16, frames: 1 }] }], { wallpaper: false, sidebarAvatar: SIDEBAR_AVATAR_PX });
    const view: CharacterView = { name: 'Pip', states: { idle: { url: 'app://damocles/theme-blob/x', moves: false, playable: false } } };
    await expect(renderer.characterSheets(APPEARANCE, layout, new Map([[0, view]]), SERVED)).rejects.toThrow(/drew \d+x\d+, not/);
    await expect(renderer.characterSheets(APPEARANCE, layout, new Map(), SERVED)).rejects.toThrow('no view of');
    const huge = { ...layout, sheets: [{ ...layout.sheets[0]!, width: 1281 }] };
    await expect(renderer.characterSheets(APPEARANCE, huge, new Map([[0, view]]), SERVED)).rejects.toThrow('larger than 1280x768');
  });

  it("crops a sidebar view to the region the page reports, at the frame's own pixels", async () => {
    const page = fakePage((job) => JSON.stringify({ drawn: true, width: job['width'], height: job['height'], region: SIDEBAR }));
    const crops: unknown[] = [];
    const capture = page.capture;
    page.capture = async (width, height, crop) => {
      crops.push(crop);
      return capture(width, height, crop);
    };
    const renderer = new ThemeRenderer({ openPage: async () => page, log: () => undefined });
    expect(pngSize(await renderer.window(windowJob('sidebar'), SERVED))).toEqual({ width: 280, height: 760 });
    expect(pngSize(await renderer.window(windowJob('window'), SERVED))).toEqual({ width: 1280, height: 800 });
    expect(crops).toEqual([SIDEBAR, undefined]);
  });

  it('closes the page after every window job, pass or fail, so the next job gets a page of its own', async () => {
    const pages: FakePage[] = [];
    const renderer = new ThemeRenderer({
      openPage: async () => {
        const page = pages.length === 1 ? fakePage(() => 'nope') : fakePage();
        pages.push(page);
        return page;
      },
      log: () => undefined,
    });
    const first = renderer.window(windowJob(), SERVED);
    const second = renderer.window(windowJob(), SERVED);
    const third = renderer.window(windowJob(), SERVED);
    await first;
    await expect(second).rejects.toThrow('not JSON');
    await third;
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      expect(page.close).toHaveBeenCalled();
      expect(page.jobs).toHaveLength(1);
    }
  });

  it("serves the next job's files only after the previous page is destroyed, since a closing page still shares the session", async () => {
    const pages: FakePage[] = [];
    const destroyed: Array<() => void> = [];
    const renderer = new ThemeRenderer({
      openPage: async () => {
        const page = fakePage();
        page.close = vi.fn(() => new Promise<void>((resolve) => {
          destroyed.push(resolve);
        }));
        const render = page.render;
        page.render = async (json) => {
          expect(renderer.currentJobBlob(SPRITE)).toBeDefined();
          return render(json);
        };
        pages.push(page);
        return page;
      },
      log: () => undefined,
    });
    const first = renderer.window(windowJob(), SERVED);
    const second = renderer.window(windowJob(), SERVED);
    await first;
    await vi.waitFor(() => expect(pages[0]!.close).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    // the first page is closing, not yet gone: the second job names no file and has no page
    expect(renderer.currentJobBlob(SPRITE)).toBeUndefined();
    expect(renderer.currentJobStill(VIDEO)).toBe(false);
    expect(pages).toHaveLength(1);
    destroyed[0]!();
    await vi.waitFor(() => expect(destroyed).toHaveLength(2));
    destroyed[1]!();
    expect(pngSize(await second)).toEqual({ width: 1280, height: 800 });
    expect(pages).toHaveLength(2);
  });

  it('fails a job whose previous page is never destroyed, at its timeout, without serving it anything', async () => {
    vi.useFakeTimers();
    const pages: FakePage[] = [];
    const renderer = new ThemeRenderer({
      openPage: async () => {
        const page = fakePage();
        page.close = vi.fn(() => new Promise<void>(() => undefined));
        pages.push(page);
        return page;
      },
      timeoutMs: 60_000,
      log: () => undefined,
    });
    await renderer.window(windowJob(), SERVED);
    const stuck = renderer.window(windowJob(), SERVED);
    const failure = expect(stuck).rejects.toThrow('longer than 60 s');
    await vi.advanceTimersByTimeAsync(60_000);
    await failure;
    expect(pages).toHaveLength(1);
  });

  it('never runs a composite on a page that loaded theme files, nor theme files on a page that holds window captures', async () => {
    const pages: FakePage[] = [];
    const renderer = new ThemeRenderer({
      openPage: async () => {
        const page = fakePage((job) => {
          if (job['kind'] === 'sprite') return JSON.stringify({ width: 8, height: 8, flash: { flagged: false } });
          return JSON.stringify({ drawn: true, width: job['width'], height: job['height'] });
        });
        pages.push(page);
        return page;
      },
      log: () => undefined,
    });
    const composite = (): Promise<Uint8Array> => renderer.composite(png(1600, 1000), png(800, 900), { x: 400, y: 50, width: 800, height: 900 });
    await Promise.all([
      renderer.window(windowJob(), SERVED), composite(),
      renderer.analyzeSprite(SPRITE, { mime: 'image/png', width: 8, height: 8, animated: false }), composite(), composite(),
    ]);
    const kinds = pages.map((page) => page.jobs.map((job) => (JSON.parse(job) as { kind: string }).kind));
    // two composites in a row may share a page; nothing else ever does
    expect(kinds).toEqual([['window'], ['composite'], ['sprite'], ['composite', 'composite']]);
  });

  it('composites at the shell capture size with both images as data URLs', async () => {
    const page = fakePage();
    const renderer = new ThemeRenderer({ openPage: async () => page, log: () => undefined });
    await renderer.composite(png(1600, 1000), png(800, 900), { x: 400, y: 50, width: 800, height: 900 });
    const job = JSON.parse(page.jobs[0]!) as Record<string, unknown>;
    expect(job).toMatchObject({ kind: 'composite', width: 1600, height: 1000, bounds: { x: 400, y: 50, width: 800, height: 900 } });
    expect(String(job['shell'])).toMatch(/^data:image\/png;base64,/);
    await expect(renderer.composite(new Uint8Array(10), png(1, 1), { x: 0, y: 0, width: 1, height: 1 })).rejects.toThrow('not a PNG');
  });

  it('runs one job at a time', async () => {
    let release: () => void = () => undefined;
    let running = 0;
    let most = 0;
    const page = fakePage(async (job) => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      running--;
      return JSON.stringify({ drawn: true, width: job['width'], height: job['height'] });
    });
    const renderer = new ThemeRenderer({ openPage: async () => page, log: () => undefined });
    const first = renderer.window(windowJob(), SERVED);
    const second = renderer.window(windowJob(), SERVED);
    await vi.waitFor(() => expect(page.jobs).toHaveLength(1));
    release();
    await first;
    await vi.waitFor(() => expect(page.jobs).toHaveLength(2));
    release();
    await second;
    expect(most).toBe(1);
  });

  it('ends a running analysis when its caller cancels, frees the page for the next job, and never starts one cancelled while it waited', async () => {
    const pages: FakePage[] = [];
    const renderer = new ThemeRenderer({
      openPage: async () => {
        const page = fakePage(() => new Promise(() => undefined));
        pages.push(page);
        return page;
      },
      log: () => undefined,
    });
    const running = new AbortController();
    const queued = new AbortController();
    const first = renderer.analyze('a'.repeat(64), 'image/png', { width: 8, height: 8 }, 'image', undefined, running.signal);
    const second = renderer.analyzeSprite('b'.repeat(64), { mime: 'image/png', width: 8, height: 8, animated: false }, queued.signal);
    const firstEnd = expect(first).rejects.toThrow('The theme render was cancelled');
    const secondEnd = expect(second).rejects.toThrow('The theme render was cancelled');
    await vi.waitFor(() => expect(pages[0]?.jobs).toHaveLength(1));
    queued.abort();
    running.abort();
    await firstEnd;
    await secondEnd;
    // the page that was busy is closed, and the job cancelled in the queue reached no page
    expect(pages[0]!.close).toHaveBeenCalled();
    expect(pages.flatMap((page) => page.jobs)).toHaveLength(1);
  });

  it('ends a drawn preview and a composite their caller cancels, so neither holds the queue for the job behind it', async () => {
    const pages: FakePage[] = [];
    const renderer = new ThemeRenderer({
      openPage: async () => {
        // the first page never answers; every later one draws
        const page = pages.length === 0 ? fakePage(() => new Promise(() => undefined)) : fakePage();
        pages.push(page);
        return page;
      },
      log: () => undefined,
    });
    const running = new AbortController();
    const queued = new AbortController();
    const first = renderer.window(windowJob(), SERVED, running.signal);
    const second = renderer.composite(png(1600, 1000), png(800, 900), { x: 400, y: 50, width: 800, height: 900 }, queued.signal);
    const third = renderer.window(windowJob(), SERVED);
    const firstEnd = expect(first).rejects.toThrow('The theme render was cancelled');
    const secondEnd = expect(second).rejects.toThrow('The theme render was cancelled');
    await vi.waitFor(() => expect(pages[0]?.jobs).toHaveLength(1));
    queued.abort();
    running.abort();
    await firstEnd;
    await secondEnd;
    expect(pngSize(await third)).toEqual({ width: 1280, height: 800 });
    expect(pages[0]!.close).toHaveBeenCalled();
    expect(pages).toHaveLength(2);
    expect(pages[1]!.jobs.map((job) => (JSON.parse(job) as { kind: string }).kind)).toEqual(['window']);
  });

  it('fails a job past its timeout and opens a fresh page for the next', async () => {
    vi.useFakeTimers();
    const pages: FakePage[] = [];
    const renderer = new ThemeRenderer({
      openPage: async () => {
        const page = pages.length === 0 ? fakePage(() => new Promise(() => undefined)) : fakePage();
        pages.push(page);
        return page;
      },
      timeoutMs: 60_000,
      log: () => undefined,
    });
    const stuck = renderer.window(windowJob(), SERVED);
    const failure = expect(stuck).rejects.toThrow('longer than 60 s');
    await vi.advanceTimersByTimeAsync(60_000);
    await failure;
    expect(pages[0]!.close).toHaveBeenCalled();
    vi.useRealTimers();
    await renderer.window(windowJob(), SERVED);
    expect(pages).toHaveLength(2);
  });

  it('leaves no page open between jobs, since a hidden window would keep the app from quitting', async () => {
    const pages: FakePage[] = [];
    const renderer = new ThemeRenderer({ openPage: async () => {
      const page = fakePage();
      pages.push(page);
      return page;
    }, log: () => undefined });
    await renderer.window(windowJob(), SERVED);
    await vi.waitFor(() => expect(pages[0]!.close).toHaveBeenCalled());
    await renderer.window(windowJob(), SERVED);
    expect(pages).toHaveLength(2);
  });

  it('closing the window closes the page and fails the job running on it; the next job opens a fresh page', async () => {
    const pages: FakePage[] = [];
    const renderer = new ThemeRenderer({
      openPage: async () => {
        const page = pages.length === 0 ? fakePage(() => new Promise(() => undefined)) : fakePage();
        pages.push(page);
        return page;
      },
      log: () => undefined,
    });
    const running = renderer.window(windowJob(), SERVED);
    await vi.waitFor(() => expect(pages[0]?.jobs).toHaveLength(1));
    renderer.closePage('The Damocles window closed.');
    await expect(running).rejects.toThrow('The Damocles window closed.');
    expect(pages[0]!.close).toHaveBeenCalled();
    await renderer.window(windowJob(), SERVED);
    expect(pages).toHaveLength(2);
  });

  it('a renderer that dies fails its job with the reason, and the next job gets a new page', async () => {
    const pages: FakePage[] = [];
    const renderer = new ThemeRenderer({
      openPage: async (gone) => {
        const page = fakePage(pages.length === 0 ? () => {
          gone('crashed');
          return new Promise(() => undefined);
        } : undefined);
        pages.push(page);
        return page;
      },
      log: () => undefined,
    });
    await expect(renderer.window(windowJob(), SERVED)).rejects.toThrow('The theme renderer ended: crashed');
    expect(pages[0]!.close).toHaveBeenCalled();
    await renderer.window(windowJob(), SERVED);
    expect(pages).toHaveLength(2);
  });

  it('closing the window fails the jobs queued behind the running one too, and opens no page for them', async () => {
    const pages: FakePage[] = [];
    const renderer = new ThemeRenderer({
      openPage: async () => {
        const page = pages.length === 0 ? fakePage(() => new Promise(() => undefined)) : fakePage();
        pages.push(page);
        return page;
      },
      log: () => undefined,
    });
    const running = renderer.window(windowJob(), SERVED);
    const queued = renderer.window(windowJob(), SERVED);
    const runningEnd = expect(running).rejects.toThrow('The Damocles window closed.');
    const queuedEnd = expect(queued).rejects.toThrow('The Damocles window closed.');
    await vi.waitFor(() => expect(pages[0]?.jobs).toHaveLength(1));
    renderer.closePage('The Damocles window closed.');
    await runningEnd;
    await queuedEnd;
    expect(pages).toHaveLength(1);
    // a job asked for after the close belongs to no closed window
    await renderer.window(windowJob(), SERVED);
    expect(pages).toHaveLength(2);
  });

  it('a page that cannot open fails its job, and the next job opens one again', async () => {
    let opens = 0;
    const page = fakePage();
    const renderer = new ThemeRenderer({
      openPage: async () => {
        if (opens++ === 0) throw new Error('the page did not load');
        return page;
      },
      log: () => undefined,
    });
    await expect(renderer.window(windowJob(), SERVED)).rejects.toThrow('the page did not load');
    expect(pngSize(await renderer.window(windowJob(), SERVED))).toEqual({ width: 1280, height: 800 });
    expect(opens).toBe(2);
  });

  it('dispose fails the running job at once and closes its page', async () => {
    const page = fakePage(() => new Promise(() => undefined));
    const renderer = new ThemeRenderer({ openPage: async () => page, log: () => undefined });
    const running = renderer.window(windowJob(), SERVED);
    const end = expect(running).rejects.toThrow('The theme renderer is closed');
    await vi.waitFor(() => expect(page.jobs).toHaveLength(1));
    renderer.dispose();
    await end;
    expect(page.close).toHaveBeenCalled();
    await expect(renderer.window(windowJob(), SERVED)).rejects.toThrow('The theme renderer is closed');
  });

  it('gives a drawing queued behind an analysis a page of its own: one that decoded a file is never handed a capture', async () => {
    const pages: FakePage[] = [];
    const renderer = new ThemeRenderer({
      openPage: async () => {
        const page = fakePage((job) => (job['kind'] === 'sprite' ? JSON.stringify({ width: 8, height: 8, flash: { flagged: false } }) : JSON.stringify({ drawn: true, width: job['width'], height: job['height'] })));
        pages.push(page);
        return page;
      },
      log: () => undefined,
    });
    const analysis = renderer.analyzeSprite('b'.repeat(64), { mime: 'image/png', width: 8, height: 8, animated: false });
    const drawing = renderer.composite(png(1600, 1000), png(800, 900), { x: 400, y: 50, width: 800, height: 900 });
    await analysis;
    await drawing;
    expect(pages).toHaveLength(2);
    expect(pages[0]!.close).toHaveBeenCalled();
    expect(pages[0]!.jobs.map((job) => (JSON.parse(job) as { kind: string }).kind)).toEqual(['sprite']);
    expect(pages[1]!.jobs.map((job) => (JSON.parse(job) as { kind: string }).kind)).toEqual(['composite']);
  });
});

describe('moving wallpaper analysis', () => {
  const SHA = 'a'.repeat(64);
  const palette = Object.fromEntries((['dark', 'light'] as const).map((kind) => [kind, { background: '#000000', panel: '#111111', text: '#eeeeee', accent: '#3366ff', success: '#22aa55', warning: '#ddaa00', danger: '#dd3333', info: '#3399ff' }]));
  const answer = (extra: Record<string, unknown> = {}): string => JSON.stringify({
    thumb: `data:image/webp;base64,${Buffer.from(webpLossy(480, 270)).toString('base64')}`,
    stats: { p10: 0.1, p90: 0.6, mean: 0.3 },
    palette,
    width: 1920,
    height: 1080,
    still: `data:image/png;base64,${Buffer.from(png(1920, 1080)).toString('base64')}`,
    flash: { flagged: true, atMs: 250, kind: 'general' },
    ...extra,
  });
  const image = { width: 1920, height: 1080 };

  it('takes a moving wallpaper\'s still frame and flash check, and refuses an answer that carries an allowance or lacks either', () => {
    expect(checkAnalysis(answer(), image, true)).toMatchObject({ still: png(1920, 1080), flash: { flagged: true, atMs: 250, kind: 'general' } });
    expect(() => checkAnalysis(answer({ flash: { flagged: true, allowed: true } }), image, true)).toThrow('no flash check');
    expect(() => checkAnalysis(answer({ flash: undefined }), image, true)).toThrow('no flash check');
    expect(() => checkAnalysis(answer({ still: undefined }), image, true)).toThrow('no still frame');
    expect(() => checkAnalysis(answer({ still: `data:image/png;base64,${Buffer.from(png(4000, 2000)).toString('base64')}` }), image, true)).toThrow('side cap');
    // a still image's answer needs neither
    expect(checkAnalysis(answer({ still: undefined, flash: undefined }), image).still).toBeUndefined();
  });

  it('takes a flash check that names a time past a video\'s longest length, as a long animation\'s does', () => {
    expect(checkAnalysis(answer({ flash: { flagged: true, atMs: 90_000, kind: 'general' } }), image, true).flash).toEqual({ flagged: true, atMs: 90_000, kind: 'general' });
  });

  it('builds the stats and the palette again from their own fields, and refuses an animated thumbnail and an image of no size', () => {
    const extra = answer({ stats: { p10: 0.1, p90: 0.6, mean: 0.3, more: 'x' }, palette: { dark: { ...palette['dark'], more: 'x' }, light: palette['light'], more: 'x' } });
    const checked = checkAnalysis(extra, image, true);
    expect(checked.stats).toEqual({ p10: 0.1, p90: 0.6, mean: 0.3 });
    expect(checked.palette).toEqual(palette);
    const thumb = (bytes: Uint8Array): string => `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`;
    expect(() => checkAnalysis(answer({ thumb: thumb(webpExtended(480, 270, true)) }), image, true)).toThrow('not a still WebP');
    expect(() => checkAnalysis(answer({ thumb: thumb(webpLossy(0, 270)) }), image, true)).toThrow(/thumbnail/);
    expect(() => checkAnalysis(answer({ still: `data:image/png;base64,${Buffer.from(png(0, 1080)).toString('base64')}` }), image, true)).toThrow('empty or larger');
  });

  it('feeds a moving image\'s bytes to the page before its job, gives a video 90 s, and reports progress while it runs', async () => {
    vi.useFakeTimers();
    const fed: string[] = [];
    const reported: Array<readonly [string, number]> = [];
    let release: (value: string) => void = () => undefined;
    const page: FakePage = { ...fakePage(() => new Promise<string>((resolve) => { release = resolve; })), feed: async (chunk) => { fed.push(chunk); }, progress: async () => 0.5 };
    const renderer = new ThemeRenderer({ openPage: async () => page, readBlob: async () => new Uint8Array([1, 2, 3]), progress: (sha256, fraction) => reported.push([sha256, fraction]), log: () => undefined });
    const animated = renderer.analyze(SHA, 'image/gif', image, 'animated');
    await vi.waitFor(() => expect(page.jobs).toHaveLength(1));
    expect(fed.join('')).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(JSON.parse(page.jobs[0]!)).toMatchObject({ kind: 'analyze', moving: { kind: 'animated', mime: 'image/gif' } });
    fed.length = 0;
    expect(renderer.currentJobBlob(SHA)).toEqual({ kind: 'animated', mime: 'image/gif' });
    expect(renderer.currentJobStill(SHA)).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    // each report names the wallpaper the job checks, so the install card waiting on it shows it
    expect(reported).toContainEqual([SHA, 0.5]);
    release(answer());
    await expect(animated).resolves.toMatchObject({ flash: { flagged: true } });

    const video = renderer.analyze(SHA, 'video/mp4', image, 'video', 30_000);
    await vi.waitFor(() => expect(page.jobs).toHaveLength(2));
    // a video's bytes are fed too: the page decodes every frame itself and plays nothing
    expect(fed.join('')).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    await vi.advanceTimersByTimeAsync(61_000);
    release(answer({ flash: { flagged: false } }));
    await expect(video).resolves.toMatchObject({ flash: { flagged: false } });
    const late = renderer.analyze(SHA, 'video/mp4', image, 'video', 30_000);
    const failed = expect(late).rejects.toThrow('longer than 90 s');
    await vi.advanceTimersByTimeAsync(91_000);
    await failed;
  });
});
