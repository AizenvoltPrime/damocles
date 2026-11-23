import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_THEME } from '../../../../shared/themes/builtin';
import { checkAnalysis, checkAnswer, checkCapture, MAX_RENDER_PNG_BYTES, pngSize, ThemeRenderer, type RenderPage } from '../theme-renderer';
import { webpExtended, webpLossy } from '../../../../shared/themes/testing/image-fixtures';

// The theme renderer's jobs against a fake page: the answer's shape and the capture's size are checked, jobs run one at a time
// within their timeout, and a page that dies fails its job and is made again for the next one.

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
    capture: async (width, height) => png(width, height),
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

  it('refuses a capture of another size, one that is not a PNG, and one past the byte cap', () => {
    const job = { width: 1280, height: 800 };
    expect(checkCapture(png(1280, 800), job)).toHaveLength(24);
    expect(() => checkCapture(png(640, 400), job)).toThrow('640x400');
    expect(() => checkCapture(new Uint8Array(40), job)).toThrow('not a PNG');
    expect(() => checkCapture(png(1280, 800, MAX_RENDER_PNG_BYTES), job)).toThrow('bytes');
  });
});

describe('ThemeRenderer', () => {
  it('draws a preview job at 1280x800 with the theme, and serves its theme while the job runs', async () => {
    const page = fakePage();
    let seenTheme: unknown;
    const renderer = new ThemeRenderer({ openPage: async () => page, log: () => undefined });
    page.render = async (json) => {
      seenTheme = renderer.currentTheme();
      page.jobs.push(json);
      return JSON.stringify({ drawn: true, width: 1280, height: 800 });
    };
    const result = await renderer.preview(BUILTIN_THEME, 'split');
    expect(pngSize(result)).toEqual({ width: 1280, height: 800 });
    expect(JSON.parse(page.jobs[0]!)).toMatchObject({ kind: 'preview', mode: 'split', width: 1280, height: 800, theme: { id: 'damocles' } });
    expect(seenTheme).toBe(BUILTIN_THEME);
    expect(renderer.currentTheme()).toBeUndefined();
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
    const first = renderer.preview(BUILTIN_THEME, 'dark');
    const second = renderer.preview(BUILTIN_THEME, 'light');
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
    const first = renderer.preview(BUILTIN_THEME, 'dark', running.signal);
    const second = renderer.composite(png(1600, 1000), png(800, 900), { x: 400, y: 50, width: 800, height: 900 }, queued.signal);
    const third = renderer.preview(BUILTIN_THEME, 'light');
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
    expect(pages[1]!.jobs.map((job) => (JSON.parse(job) as { kind: string }).kind)).toEqual(['preview']);
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
    const stuck = renderer.preview(BUILTIN_THEME, 'dark');
    const failure = expect(stuck).rejects.toThrow('longer than 60 s');
    await vi.advanceTimersByTimeAsync(60_000);
    await failure;
    expect(pages[0]!.close).toHaveBeenCalled();
    vi.useRealTimers();
    await renderer.preview(BUILTIN_THEME, 'dark');
    expect(pages).toHaveLength(2);
  });

  it('leaves no page open between jobs, since a hidden window would keep the app from quitting', async () => {
    const pages: FakePage[] = [];
    const renderer = new ThemeRenderer({ openPage: async () => {
      const page = fakePage();
      pages.push(page);
      return page;
    }, log: () => undefined });
    await renderer.preview(BUILTIN_THEME, 'dark');
    await vi.waitFor(() => expect(pages[0]!.close).toHaveBeenCalled());
    await renderer.preview(BUILTIN_THEME, 'dark');
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
    const running = renderer.preview(BUILTIN_THEME, 'dark');
    await vi.waitFor(() => expect(pages[0]?.jobs).toHaveLength(1));
    renderer.closePage('The Damocles window closed.');
    await expect(running).rejects.toThrow('The Damocles window closed.');
    expect(pages[0]!.close).toHaveBeenCalled();
    await renderer.preview(BUILTIN_THEME, 'dark');
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
    await expect(renderer.preview(BUILTIN_THEME, 'dark')).rejects.toThrow('The theme renderer ended: crashed');
    expect(pages[0]!.close).toHaveBeenCalled();
    await renderer.preview(BUILTIN_THEME, 'dark');
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
    const running = renderer.preview(BUILTIN_THEME, 'dark');
    const queued = renderer.preview(BUILTIN_THEME, 'light');
    const runningEnd = expect(running).rejects.toThrow('The Damocles window closed.');
    const queuedEnd = expect(queued).rejects.toThrow('The Damocles window closed.');
    await vi.waitFor(() => expect(pages[0]?.jobs).toHaveLength(1));
    renderer.closePage('The Damocles window closed.');
    await runningEnd;
    await queuedEnd;
    expect(pages).toHaveLength(1);
    // a job asked for after the close belongs to no closed window
    await renderer.preview(BUILTIN_THEME, 'dark');
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
    await expect(renderer.preview(BUILTIN_THEME, 'dark')).rejects.toThrow('the page did not load');
    expect(pngSize(await renderer.preview(BUILTIN_THEME, 'dark'))).toEqual({ width: 1280, height: 800 });
    expect(opens).toBe(2);
  });

  it('dispose fails the running job at once and closes its page', async () => {
    const page = fakePage(() => new Promise(() => undefined));
    const renderer = new ThemeRenderer({ openPage: async () => page, log: () => undefined });
    const running = renderer.preview(BUILTIN_THEME, 'dark');
    const end = expect(running).rejects.toThrow('The theme renderer is closed');
    await vi.waitFor(() => expect(page.jobs).toHaveLength(1));
    renderer.dispose();
    await end;
    expect(page.close).toHaveBeenCalled();
    await expect(renderer.preview(BUILTIN_THEME, 'dark')).rejects.toThrow('The theme renderer is closed');
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
    expect(renderer.currentImage()).toEqual({ sha256: SHA, mime: 'image/gif', kind: 'animated' });
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
