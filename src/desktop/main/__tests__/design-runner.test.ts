import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

const windows = vi.hoisted(() => [] as { options: Record<string, unknown>; contents: Record<string, unknown> & { handlers: Map<string, (...args: unknown[]) => void> }; destroyed: boolean }[]);
const registered = vi.hoisted(() => [] as { contents: unknown; origin: string; loadedAlready: boolean }[]);
vi.mock('electron', () => ({
  BrowserWindow: class {
    readonly webContents: Record<string, unknown> & { handlers: Map<string, (...args: unknown[]) => void> };
    private destroyed = false;
    constructor(options: Record<string, unknown>) {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const entry = { options, contents: undefined as never, destroyed: false };
      this.webContents = {
        handlers,
        loaded: false,
        on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
        setWebRTCIPHandlingPolicy: vi.fn(),
        loadURL: vi.fn(async () => {
          this.webContents['loaded'] = true;
          handlers.get('did-navigate')?.({}, 'damocles-design://t/screens/S1.html', 200);
        }),
      };
      entry.contents = this.webContents as never;
      windows.push(entry);
      Object.defineProperty(entry, 'destroyed', { get: () => this.destroyed });
    }
    on(): void {}
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
    }
  },
}));
vi.mock('../security', () => ({
  registerDesignContents: (contents: { loaded?: boolean }, origin: string) => registered.push({ contents, origin, loadedAlready: contents.loaded === true }),
}));
vi.mock('../protocol', () => ({ DESIGN_SCHEME: 'damocles-design' }));

import { MAX_CONSOLE_ERRORS, MAX_OVERFLOWING, MAX_PROBE_ELEMENTS, MAX_PROBE_WIDTHS, pngSize } from '../../../shared/design-render';
import { MAX_JOURNEY_OUTLINE_CHARS } from '../../../shared/design-journey';
import { CORE_TO_MAIN } from '../../core-protocol/messages';
import { INVALID } from '../../core-protocol/schema';
import type { JourneyCdp } from '../design/design-journey';
import { DesignRunner, MAX_CONCURRENT_RUNS, MAX_PROBE_OUTPUT_CHARS, MAX_QUEUED_RUNS_PER_AUTHORITY, openOffscreenPage, parseOutline, parseProbeOutput, type RunnerPage, type RunnerPageEvents } from '../design/design-runner';
import type { JourneyStep } from '../../../shared/types/design';
import { contactsPage } from './fake-journey-page';
import contacts from '../../../../e2e/fixtures/design-app/static/contacts.preview-journey.json' with { type: 'json' };

const target = { authority: 'local', designId: 'contacts-1a2b3c4d' };
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  // the signature, then IHDR's length (13) and type, as every PNG starts
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

interface FakePage extends RunnerPage {
  readonly origin: string;
  readonly events: RunnerPageEvents;
  readonly sizes: [number, number][];
  readonly shots: [number, number, number][];
  closed: number;
  release(): void;
}

/** Pages whose load waits for `release` when `hold` is set; the content is `contentHeight` tall and `scrollWidth` wide per width. */
function harness(options: { hold?: boolean; contentHeight?: number; scrollWidth?: (width: number) => number; timeoutMs?: number; cdp?: (width: number) => JourneyCdp; outline?: unknown } = {}) {
  const pages: FakePage[] = [];
  const evaluated: string[] = [];
  const sheets: string[] = [];
  const runner = new DesignRunner({
    log: () => undefined,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    openPage: (origin, width, events) => {
      let release = (): void => undefined;
      const held = options.hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
      let size: [number, number] = [width, 900];
      let debuggee: JourneyCdp | undefined;
      const page: FakePage = {
        origin,
        events,
        sizes: [],
        shots: [],
        closed: 0,
        release: () => release(),
        load: () => held,
        resize: async (w, h) => {
          size = [w, h];
          page.sizes.push(size);
        },
        insertCss: async (css) => {
          sheets.push(css);
        },
        evaluate: async (code) => {
          evaluated.push(code);
          const scrollWidth = options.scrollWidth?.(size[0]) ?? size[0];
          if (code.startsWith('[')) return [options.contentHeight ?? 1500, scrollWidth, size[0]];
          if (code.includes('lines.push')) return options.outline ?? `body
  button "Add contact" at ${size[0]}`;
          return JSON.stringify({ h: options.contentHeight ?? 1500, sw: scrollWidth, cw: size[0], els: [['td', null, null, null, 'Contact.name', 0, 10, 100, 20, size[0] >= 640]], over: scrollWidth > size[0] ? [['div', null, 'wide', 'Table', 812]] : [] });
        },
        screenshot: async (w, h, scale) => {
          page.shots.push([w, h, scale]);
          return png(Math.round(w * scale), Math.round(h * scale));
        },
        cdp: (method, params) => {
          if (!options.cdp) return Promise.reject(new Error('No debugger in this test'));
          debuggee ??= options.cdp(size[0]);
          return debuggee.send(method, params);
        },
        close: () => {
          page.closed++;
        },
      };
      pages.push(page);
      return page;
    },
  });
  return { runner, pages, evaluated, sheets };
}

const capture = { relPath: 'screens/S1-contacts.html', width: 390, state: null, scale: 2 };

describe('DesignRunner', () => {
  it('captures the frame W × min(900, content) at the largest scale up to 2 within 1950 px, in a window as tall as the content', async () => {
    const { runner, pages } = harness({ contentHeight: 1500 });
    const shot = await runner.capture(target, capture, new AbortController().signal);
    expect(shot).toMatchObject({ cssWidth: 390, cssHeight: 900, contentHeight: 1500, scale: 2 });
    expect(pages[0]!.sizes.at(-1)).toEqual([390, 1500]);
    const wide = await runner.capture(target, { ...capture, width: 2560 }, new AbortController().signal);
    expect(wide.scale).toBeLessThanOrEqual(1950 / 2560);
    expect(pngSize(wide.png).width).toBeLessThanOrEqual(1950);
    const short = harness({ contentHeight: 300 });
    expect(await short.runner.capture(target, capture, new AbortController().signal)).toMatchObject({ cssHeight: 300, scale: 2 });
    const tall = harness({ contentHeight: 90_000 });
    await tall.runner.capture(target, capture, new AbortController().signal);
    expect(tall.pages[0]!.sizes.at(-1)).toEqual([390, 4000]);
  });

  it('takes a capture too large for one image block again at a smaller scale', async () => {
    const { runner, pages } = harness({ contentHeight: 900, hold: true });
    const shot = runner.capture(target, capture, new AbortController().signal);
    await flush();
    const page = pages[0]!;
    const small = page.screenshot.bind(page);
    page.screenshot = async (w, h, scale) => {
      if (scale < 1.5) return small(w, h, scale);
      page.shots.push([w, h, scale]);
      const big = new Uint8Array(4 * 1024 * 1024);
      big.set(png(Math.round(w * scale), Math.round(h * scale)));
      return big;
    };
    page.release();
    expect((await shot).scale).toBe(1.4);
    expect(page.shots.map(([, , scale]) => scale)).toEqual([2, 1.4]);
  });

  it('gives each run its own view-token origin, serves only while it runs, and closes its window in finally', async () => {
    const { runner, pages } = harness();
    await runner.capture(target, capture, new AbortController().signal);
    await runner.capture(target, capture, new AbortController().signal);
    expect(pages[0]!.origin).not.toBe(pages[1]!.origin);
    expect(pages[0]!.origin).toMatch(/^damocles-design:\/\/[0-9a-f]{32}$/);
    expect(pages.map((page) => page.closed)).toEqual([1, 1]);
    expect(runner.targetOf(pages[0]!.origin.slice('damocles-design://'.length))).toBeUndefined();
    expect(runner.size).toBe(0);
  });

  it('runs at most two at once and queues the rest in order; an abort while queued leaves the queue', async () => {
    const { runner, pages } = harness({ hold: true });
    const runs = [0, 1, 2, 3].map(() => new AbortController());
    const results = runs.map((run) => runner.capture(target, capture, run.signal).then(() => 'done', (err: unknown) => (err as Error).message));
    await flush();
    expect(pages).toHaveLength(MAX_CONCURRENT_RUNS);
    expect(runner.targetOf(pages[0]!.origin.slice('damocles-design://'.length))).toEqual(target);
    runs[2]!.abort(new Error('stopped'));
    pages[0]!.release();
    await flush();
    await flush();
    expect(pages).toHaveLength(3);
    pages[1]!.release();
    pages[2]!.release();
    expect(await Promise.all(results)).toEqual(['done', 'done', 'stopped', 'done']);
  });

  it('ends a running capture on its request\'s abort and closes the window at once', async () => {
    const { runner, pages } = harness({ hold: true });
    const stop = new AbortController();
    const result = runner.capture(target, capture, stop.signal);
    await flush();
    stop.abort(new Error('Stop'));
    await expect(result).rejects.toThrow('Stop');
    expect(pages[0]!.closed).toBe(1);
  });

  it('times a run out', async () => {
    const { runner, pages } = harness({ hold: true, timeoutMs: 20 });
    await expect(runner.capture(target, capture, new AbortController().signal)).rejects.toThrow(/took longer than/);
    expect(pages[0]!.closed).toBe(1);
  });

  it('ends every run and queued run and closes every window on closeAll, so no hidden window holds the app open', async () => {
    const { runner, pages } = harness({ hold: true });
    const results = [0, 1, 2].map(() => runner.capture(target, capture, new AbortController().signal).catch((err: unknown) => (err as Error).message));
    await flush();
    runner.closeAll('The Damocles window closed.');
    expect(pages.every((page) => page.closed >= 1)).toBe(true);
    expect(await Promise.all(results)).toEqual(['The Damocles window closed.', 'The Damocles window closed.', 'The Damocles window closed.']);
    expect(pages).toHaveLength(2);
    expect(runner.size).toBe(0);
  });

  it('ends the run when its page goes', async () => {
    const { runner, pages } = harness({ hold: true });
    const result = runner.capture(target, capture, new AbortController().signal);
    await flush();
    pages[0]!.events.gone('crashed');
    await expect(result).rejects.toThrow(/page ended: crashed/);
  });

  it('rejects a width out of range and a state outside the design alphabet, opening no page', async () => {
    const { runner, pages } = harness();
    await expect(runner.capture(target, { ...capture, width: 100 }, new AbortController().signal)).rejects.toThrow(/Not a design width/);
    await expect(runner.capture(target, { ...capture, state: '"] *{' }, new AbortController().signal)).rejects.toThrow(/Not a state name/);
    await expect(runner.probe(target, { relPath: capture.relPath, widths: [100], state: null }, new AbortController().signal)).rejects.toThrow(/Not design widths/);
    await expect(runner.probe(target, { relPath: capture.relPath, widths: [390], state: '"] *{' }, new AbortController().signal)).rejects.toThrow(/Not a state name/);
    expect(pages).toHaveLength(0);
  });

  it('renders a block in every state its data-ds-state-only lists, and default when no state is asked', async () => {
    const { runner, sheets } = harness();
    for (const state of ['no-results', 'empty', null]) await runner.capture(target, { ...capture, state }, new AbortController().signal);
    const hidden = sheets.map((sheet) => {
      const { document } = parseHTML('<html><body><p id="both" data-ds-state-only="default no-results"></p><p id="empty" data-ds-state-only="empty"></p><p id="always"></p></body></html>') as unknown as { document: { querySelectorAll(selector: string): ArrayLike<{ id: string }> } };
      const rule = sheet.split('\n').find((line) => line.includes('data-ds-state-only'))!;
      return Array.from(document.querySelectorAll(rule.slice(0, rule.indexOf(' {'))), (element) => element.id);
    });
    expect(hidden).toEqual([['empty'], ['both'], ['empty']]);
  });

  it('queues at most 16 runs of one authority and refuses the next, while another authority still queues', async () => {
    const { runner, pages } = harness({ hold: true });
    const remote = { authority: 'ssh:build-box', designId: target.designId };
    const settled = Array.from({ length: MAX_CONCURRENT_RUNS + MAX_QUEUED_RUNS_PER_AUTHORITY }, () => runner.capture(remote, capture, new AbortController().signal).catch(() => undefined));
    await flush();
    await expect(runner.capture(remote, capture, new AbortController().signal)).rejects.toThrow(`${MAX_QUEUED_RUNS_PER_AUTHORITY} design renders of this host are already waiting`);
    const local = runner.capture(target, capture, new AbortController().signal);
    await flush();
    runner.closeAll('The Damocles window closed.');
    await expect(local).rejects.toThrow('The Damocles window closed.');
    await Promise.all(settled);
    expect(pages).toHaveLength(MAX_CONCURRENT_RUNS);
  });

  it('probes each width with one window and sweeps from 320 px to the widest breakpoint in 8 px steps, capturing nothing', async () => {
    const { runner, pages } = harness({ scrollWidth: (width) => (width < 820 ? 830 : width) });
    const probe = await runner.probe(target, { relPath: capture.relPath, widths: [1536, 390, 640], state: null, sweepTo: 1536 }, new AbortController().signal);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.shots).toEqual([]);
    expect(probe.widths.map((measured) => [measured.width, measured.overflow])).toEqual([[390, true], [640, true], [1536, false]]);
    expect(probe.widths[0]!.overflowing).toEqual([{ element: '<div.wide data-ds-component="Table">', width: 812 }]);
    expect(probe.sweep).toMatchObject({ from: 320, to: 1536, step: 8 });
    expect(probe.sweep!.overflowAt[0]).toEqual({ width: 320, scrollWidth: 830 });
    expect(probe.sweep!.overflowAt.at(-1)!.width).toBe(816);
    const swept = pages[0]!.sizes.map(([width]) => width).filter((width, index, all) => all.indexOf(width) === index);
    expect(swept).toContain(1536);
    expect(swept.filter((width) => width < 1536).every((width) => (width - 320) % 8 === 0 || [390, 640].includes(width))).toBe(true);
    // each checked width fits the window to the content (two resizes); the sweep resizes once a width, at the frame's height
    const sweep = pages[0]!.sizes.slice(3 * 2);
    expect(sweep).toHaveLength((1536 - 320) / 8 + 1);
    expect(sweep.every(([width, height], index) => width === 320 + index * 8 && height === 900)).toBe(true);
  });

  it('reads content height without the viewport floor and splits class names on whitespace, in its own world', async () => {
    const { runner, evaluated } = harness();
    await runner.probe(target, { relPath: capture.relPath, widths: [390], state: null }, new AbortController().signal);
    const probeScript = evaluated.find((code) => code.startsWith('(() =>'))!;
    expect(probeScript).toContain('document.documentElement.getBoundingClientRect().height');
    expect(probeScript).toContain(String.raw`.split(/\s+/)`);
    expect(probeScript).not.toContain('root.scrollHeight');
  });

  it('reports the page\'s console errors, bounded', async () => {
    const { runner, pages } = harness({ hold: true });
    const result = runner.probe(target, { relPath: capture.relPath, widths: [390], state: null }, new AbortController().signal);
    await flush();
    for (let index = 0; index < 30; index++) pages[0]!.events.consoleError(`boom\u0007 ${'x'.repeat(1000)}`);
    pages[0]!.release();
    const { consoleErrors } = await result;
    expect(consoleErrors).toHaveLength(20);
    expect(consoleErrors[0]!.length).toBe(500);
    expect(consoleErrors[0]).not.toContain('\u0007');
  });
});

describe('DesignRunner.journey (PD-13, PD-45)', () => {
  const STEPS = contacts.steps as JourneyStep[];
  const request = { relPath: capture.relPath, widths: [1280, 390], state: null, steps: STEPS, outline: false };

  it('runs the journey in a fresh page per width, ascending, each W × 900 with the run sheet, and closes each page (acceptance)', async () => {
    const { runner, pages } = harness({ cdp: (width) => contactsPage(width) });
    const run = await runner.journey(target, request, new AbortController().signal);
    expect(run.widths.map((width) => [width.width, width.passed, width.steps.length])).toEqual([[390, true, 11], [1280, true, 11]]);
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.sizes)).toEqual([[[390, 900]], [[1280, 900]]]);
    expect(pages.every((page) => page.closed === 1)).toBe(true);
    expect(runner.size).toBe(0);
  });

  it('reports a target hidden at base at that width and still runs the other widths', async () => {
    const { runner } = harness({ cdp: (width) => contactsPage(width, { addHiddenBelow: 640 }) });
    const run = await runner.journey(target, { ...request, steps: STEPS.slice(0, 4) }, new AbortController().signal);
    expect(run.widths[0]).toMatchObject({ width: 390, passed: false, steps: [{ ok: true }, { ok: true }, { ok: false, failure: 'hidden', hiddenAt: 390 }] });
    expect(run.widths[1]).toMatchObject({ width: 1280, passed: true });
  }, 15_000);

  it('validates the steps again, as a core is another trust domain, and opens no page for bad ones', async () => {
    const { runner, pages } = harness({ cdp: (width) => contactsPage(width) });
    await expect(runner.journey(target, { ...request, steps: [...STEPS, ...STEPS] }, new AbortController().signal)).rejects.toThrow('Not journey steps');
    await expect(runner.journey(target, { ...request, steps: [{ action: 'click', target: { selector: '#x' } } as unknown as JourneyStep, STEPS[1]!] }, new AbortController().signal)).rejects.toThrow('Not journey steps');
    await expect(runner.journey(target, { ...request, widths: [100] }, new AbortController().signal)).rejects.toThrow('Not design widths');
    expect(pages).toEqual([]);
  });

  it('adds the bounded outline of each page when asked, parsed as hostile', async () => {
    const { runner, evaluated } = harness({ cdp: (width) => contactsPage(width) });
    const run = await runner.journey(target, { ...request, widths: [390], outline: true }, new AbortController().signal);
    const script = evaluated.find((code) => code.includes('lines.push'))!;
    expect(() => new Function(`return ${script}`)).not.toThrow();
    expect(script).toContain(String.raw`.replace(/\s+/g, ' ')`);
    expect(run.widths[0]!.outline).toBe('body\n  button "Add contact" at 390');
    const hostile = harness({ cdp: (width) => contactsPage(width), outline: 'x'.repeat(64 * 1024 + 1) });
    await expect(hostile.runner.journey(target, { ...request, widths: [390], outline: true }, new AbortController().signal)).rejects.toThrow('malformed outline');
    expect(parseOutline('a\u202eb\nc')).toBe('a\\u{202E}b\nc');
  });
});

describe('parseProbeOutput', () => {
  const valid = { h: 1200.4, sw: 390, cw: 390, els: [['td', 'n', 'Table', null, 'Contact.name', 1, 2, 3, 4, true]], over: [] };

  it('types, rounds and clamps every field', () => {
    expect(parseProbeOutput(JSON.stringify({ ...valid, h: 1e12 }), 390)).toMatchObject({ contentHeight: 1_000_000, overflow: false, elements: [{ tag: 'td', id: 'n', component: 'Table', variant: null, bind: 'Contact.name', rect: { x: 1, y: 2, w: 3, h: 4 }, visible: true }] });
  });

  it('refuses output over 64 KiB, more than 400 elements, a non-string, and a wrong type anywhere', () => {
    expect(() => parseProbeOutput('x'.repeat(MAX_PROBE_OUTPUT_CHARS + 1), 390)).toThrow(/malformed probe/);
    expect(() => parseProbeOutput(JSON.stringify({ ...valid, els: Array.from({ length: MAX_PROBE_ELEMENTS + 1 }, () => valid.els[0]) }), 390)).toThrow(/malformed probe/);
    expect(() => parseProbeOutput({ h: 1 }, 390)).toThrow(/malformed probe/);
    expect(() => parseProbeOutput('{not json', 390)).toThrow(/malformed probe/);
    expect(() => parseProbeOutput(JSON.stringify({ ...valid, sw: 'wide' }), 390)).toThrow(/malformed probe/);
    expect(() => parseProbeOutput(JSON.stringify({ ...valid, els: [['td', null, null, null, null, 0, 0, 0, 0, 'yes']] }), 390)).toThrow(/malformed probe/);
    expect(() => parseProbeOutput(JSON.stringify({ ...valid, els: [[7, null, null, null, null, 0, 0, 0, 0, true]] }), 390)).toThrow(/malformed probe/);
    expect(() => parseProbeOutput(JSON.stringify({ ...valid, els: [['td', null, null, null, null, Number.NaN, 0, 0, 0, true]] }), 390)).toThrow(/malformed probe/);
  });

  it('names a tag outside the alphabet by a placeholder instead of failing the probe', () => {
    const parsed = parseProbeOutput(JSON.stringify({ ...valid, els: [['o:p', null, null, null, null, 0, 0, 0, 0, true]], over: [['<script>', null, null, null, 812]] }), 390);
    expect(parsed.elements[0]!.tag).toBe('element');
    expect(parsed.overflowing[0]!.element).toBe('<element>');
  });

  it('cuts attribute text and takes out control characters', () => {
    const parsed = parseProbeOutput(JSON.stringify({ ...valid, els: [['td', null, `A\u202e${'b'.repeat(500)}`, null, null, 0, 0, 0, 0, true]] }), 390);
    expect(parsed.elements[0]!.component).toHaveLength(120);
    expect(parsed.elements[0]!.component).not.toContain('\u202e');
  });
});

describe('openOffscreenPage', () => {
  it('builds the window exactly as contained as a preview view, registered before its first load', async () => {
    windows.length = 0;
    registered.length = 0;
    const page = openOffscreenPage('damocles-design://abc', 390, { consoleError: () => undefined, gone: () => undefined });
    const [window] = windows;
    expect(window!.options).toMatchObject({
      show: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        partition: 'design-preview',
        offscreen: { deviceScaleFactor: 1 },
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        javascript: true,
        disableDialogs: true,
        devTools: false,
        webviewTag: false,
      },
    });
    expect((window!.options['webPreferences'] as Record<string, unknown>)['preload']).toBeUndefined();
    expect(registered).toEqual([{ contents: window!.contents, origin: 'damocles-design://abc', loadedAlready: false }]);
    expect(window!.contents['setWebRTCIPHandlingPolicy']).toHaveBeenCalledWith('disable_non_proxied_udp');
    const prevent = vi.fn();
    window!.contents.handlers.get('will-prevent-unload')!({ preventDefault: prevent });
    expect(prevent).toHaveBeenCalled();
    await page.load('damocles-design://abc/screens/S1.html');
    page.close();
    page.close();
    expect(window!.destroyed).toBe(true);
  });

  it('drives CDP through the debugger of its own window, attached once', async () => {
    windows.length = 0;
    const page = openOffscreenPage('damocles-design://abc', 390, { consoleError: () => undefined, gone: () => undefined });
    let attached = false;
    const sendCommand = vi.fn(async () => ({ nodes: [] }));
    windows[0]!.contents['debugger'] = { isAttached: () => attached, attach: vi.fn(() => { attached = true; }), sendCommand };
    await page.cdp('Accessibility.queryAXTree', { backendNodeId: 1, accessibleName: 'Save' });
    await page.cdp('DOM.getDocument', { depth: 0 });
    expect((windows[0]!.contents['debugger'] as { attach: ReturnType<typeof vi.fn> }).attach).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls).toEqual([['Accessibility.queryAXTree', { backendNodeId: 1, accessibleName: 'Save' }], ['DOM.getDocument', { depth: 0 }]]);
  });

  it('fails a load the design scheme refused', async () => {
    windows.length = 0;
    const page = openOffscreenPage('damocles-design://abc', 390, { consoleError: () => undefined, gone: () => undefined });
    const contents = windows[0]!.contents;
    (contents['loadURL'] as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => contents.handlers.get('did-navigate')?.({}, 'x', 404));
    await expect(page.load('damocles-design://abc/screens/S9.html')).rejects.toThrow(/could not be read/);
  });
});

// Main's answers to core's design requests are parsed again by core (CORE_TO_MAIN), whose endpoint fails the request on an
// answer outside the contract; these pin the producers' bounds to the contract's.
describe('the runner\'s answers at every producer bound', () => {
  const control = '\u0007';
  const attribute = control.repeat(200);
  // as the probe script's answer can be: every list at its bound, every attribute past its cut, every number past its clamp
  const MAXIMAL_PROBE = JSON.stringify({
    h: 1e12,
    sw: 1e12,
    cw: 390,
    els: Array.from({ length: MAX_PROBE_ELEMENTS }, () => ['o:p', null, null, null, 'x', -1e12, 1e12, 1e12, 1e12, true]),
    over: Array.from({ length: MAX_OVERFLOWING }, () => ['o:p', attribute, attribute, attribute, 1e12]),
  });

  function maximalRunner(contentHeight: number) {
    return new DesignRunner({
      log: () => undefined,
      openPage: (_origin, width, events) => {
        let size: [number, number] = [width, 900];
        const journeyPage = contactsPage(width);
        return {
          load: async () => {
            for (let index = 0; index < 2 * MAX_CONSOLE_ERRORS; index++) events.consoleError(control.repeat(10_000));
          },
          resize: async (w, h) => {
            size = [w, h];
          },
          insertCss: async () => undefined,
          evaluate: async (code) => {
            if (code.startsWith('[')) return [contentHeight, 1e12, size[0]];
            if (code.includes('lines.push')) return control.repeat(MAX_JOURNEY_OUTLINE_CHARS);
            return MAXIMAL_PROBE;
          },
          screenshot: async (w, h, scale) => png(Math.round(w * scale), Math.round(h * scale)),
          cdp: (method, params) => journeyPage.send(method, params),
          close: () => undefined,
        };
      },
    });
  }

  it('pass core\'s parsers of design.probe, design.capture and design.journey', async () => {
    expect(MAXIMAL_PROBE.length).toBeLessThanOrEqual(MAX_PROBE_OUTPUT_CHARS);
    const signal = new AbortController().signal;
    const widths = Array.from({ length: MAX_PROBE_WIDTHS }, (_, index) => 320 + index * 100);
    const probe = await maximalRunner(1e12).probe(target, { relPath: capture.relPath, widths, state: null, sweepTo: 2560 }, signal);
    expect(probe.consoleErrors).toHaveLength(MAX_CONSOLE_ERRORS);
    expect(probe.widths[0]!.overflowing).toHaveLength(MAX_OVERFLOWING);
    expect(CORE_TO_MAIN.requests['design.probe'].result(probe)).not.toBe(INVALID);
    // a page of fixed-position content alone measures 0 high
    for (const contentHeight of [0, 1e12]) {
      const captured = await maximalRunner(contentHeight).capture(target, capture, signal);
      expect(CORE_TO_MAIN.requests['design.capture'].result(captured), String(contentHeight)).not.toBe(INVALID);
    }
    const journey = await maximalRunner(900).journey(target, { relPath: capture.relPath, widths: [390], state: null, steps: contacts.steps as JourneyStep[], outline: true }, signal);
    expect(journey.consoleErrors).toHaveLength(MAX_CONSOLE_ERRORS);
    expect(CORE_TO_MAIN.requests['design.journey'].result(journey)).not.toBe(INVALID);
  }, 30_000);
});
