import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import type { StructuredCompletionRequest, StructuredCompletionResult } from '../../pi-session/structured-completion';
import type { DesignPreviewHost } from '../../../platform/design-preview';
import { DESIGN_PARITY_CHECK_IDS, type DesignParityDetails, type DesignParityRefusal } from '../../../shared/design-parity';
import { DESIGN_RENDER_CLIENT_ABSENT } from '../../../shared/design-render';
import type { BrowserToolAnswer } from '../../../shared/remote-user';
import { DAMOCLES_DESIGN_RESULT } from '../../pi-session/session-store/constants';
import { renderInputHashes, updateManifest } from '../design-files';
import { designFolderOf, designStateDirOf } from '../design-paths';
import { writeJsonAtomic, type DesignVersionRecord } from '../design-state';
import { PARITY_CHECKS, PARITY_OUTPUT_TOOL, PARITY_SCHEMA, PARITY_SYSTEM_PROMPT, parityStatus, parityWidth, parseParityVerdicts } from '../parity';
import { captureAppFrame, parseAppFrame } from '../parity-capture';
import type { BrowserAgentScope } from '../../browser';
import { createDesignParityTool, type DesignParityDeps } from '../tools/design-parity';
import { clearDesigns } from './design-harness';

const DESIGN = 'contacts-abcd1234';
const PARENT = 'parent-1';
const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;

// A PNG header whose IHDR names `width` × `height`.
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const allPass = (): Record<string, { pass: boolean; reason: string }> => Object.fromEntries(DESIGN_PARITY_CHECK_IDS.map((id) => [id, { pass: true, reason: `${id} matches` }]));

const link = { id: 'link', type: 'custom', customType: 'damocles.design-link', data: { v: 1, designId: DESIGN, folder: designFolderOf(DESIGN), parentSessionId: PARENT, title: 'Contacts' } };
const card = { id: 'card-1', type: 'custom_message', customType: DAMOCLES_DESIGN_RESULT, details: { designId: DESIGN, version: 1 } };

function appAnswer(width: number): BrowserToolAnswer {
  return { content: [{ type: 'text', text: JSON.stringify({ cssWidth: width, cssHeight: 900, contentHeight: 1400, status: 200 }) }, { type: 'image', data: png(Math.min(width * 2, 1950), 900).toString('base64'), mimeType: 'image/png' }] };
}

interface Setup {
  deps: DesignParityDeps;
  judged: StructuredCompletionRequest[];
  released: string[];
  captured: Array<{ scope: string; url: string; width: number }>;
}

function setup(overrides: Partial<DesignParityDeps> = {}, answers: unknown[] = []): Setup {
  const judged: StructuredCompletionRequest[] = [];
  const released: string[] = [];
  const captured: Array<{ scope: string; url: string; width: number }> = [];
  const render = {
    capture: vi.fn(async (_designId: string, _relPath: string, width: number) => ({ png: new Uint8Array(png(width * 2, 1800)), cssWidth: width, cssHeight: 900, contentHeight: 1200, scale: 2 })),
  } as unknown as DesignPreviewHost;
  const deps: DesignParityDeps = {
    enabled: () => true,
    designChat: () => false,
    sessionId: () => PARENT,
    branch: () => [link, card],
    cwd: '/ws',
    render: () => render,
    imageBudget: () => 12,
    browserEnabled: () => true,
    appCapture: () => ({
      remote: false,
      capture: async (scope, url, width) => {
        captured.push({ scope, url, width });
        return appAnswer(width);
      },
      release: async (scope) => void released.push(scope),
    }),
    judgeReadsImages: () => true,
    judge: async <T,>(req: StructuredCompletionRequest): Promise<StructuredCompletionResult<T>> => {
      judged.push(req);
      const value = answers.length > 0 ? answers.shift() : { checks: allPass() };
      return { kind: 'answered', value: value as T };
    },
    ...overrides,
  };
  return { deps, judged, released, captured };
}

type ParityResult = { content: Array<{ type: string; text?: string; data?: string }>; details: DesignParityDetails | DesignParityRefusal; isError?: boolean };

async function run(deps: DesignParityDeps, params: Record<string, unknown> = { screen: 'S1-contacts', url: 'http://127.0.0.1:5173/contacts.html', widths: [768, 390] }): Promise<ParityResult> {
  const tool = createDesignParityTool(pi, deps);
  return (await tool.execute('call-1', params as never, new AbortController().signal, undefined, undefined as never)) as unknown as ParityResult;
}

function refusalOf(result: ParityResult): string {
  expect(result.isError).toBe(true);
  return (result.details as DesignParityRefusal).refusal.message;
}

beforeEach(async () => {
  clearDesigns();
  const folder = designFolderOf(DESIGN);
  fs.mkdirSync(path.join(folder, 'screens'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'inventory.json'), JSON.stringify({ schemaVersion: 1, stack: 'Vue', tokens: null, breakpoints: { source: 'tailwind', values: { md: 768, xl: 1280 } }, components: [], screens: [], types: [], stores: [], actions: [] }));
  await updateManifest(folder, DESIGN, (current) => ({ ...current, screens: [{ id: 'S1-contacts', file: 'screens/S1-contacts.html', contentHash: 'h', check: { errors: 0, warnings: [] } }] }));
  fs.writeFileSync(path.join(folder, 'screens', 'S1-contacts.html'), '<html data-ds-screen="S1-contacts"></html>');
  await writeVersion(await renderInputHashes(folder, ['screens/S1-contacts.html']));
});

function writeVersion(renderHashes: Record<string, string> | undefined): Promise<void> {
  const record: DesignVersionRecord = {
    schemaVersion: 1, version: 1, designId: DESIGN, title: 'Contacts', sessionId: 'design-1', toolCallId: 'finish-1', contentHash: 'c',
    decisions: [], screens: ['S1-contacts'], ...(renderHashes ? { renderHashes } : {}), check: { errors: 0, warnings: [] }, journeys: [],
    summary: 'The list.', changedSinceLast: [], finishedAt: '2026-01-01T00:00:00.000Z',
  };
  return writeJsonAtomic(path.join(designStateDirOf(DESIGN), 'versions', 'v1.json'), record);
}

describe('the parity checks', () => {
  it('are open-codesign\'s 12, each asked in the judge\'s prompt and required by its schema', () => {
    expect(Object.keys(PARITY_CHECKS)).toEqual([...DESIGN_PARITY_CHECK_IDS]);
    for (const id of DESIGN_PARITY_CHECK_IDS) expect(PARITY_SYSTEM_PROMPT).toContain(`- ${id}: ${PARITY_CHECKS[id].question}`);
    expect((PARITY_SCHEMA['properties'] as { checks: { required: string[] } }).checks.required).toEqual([...DESIGN_PARITY_CHECK_IDS]);
  });

  it('take open-codesign\'s status thresholds over passes ÷ 12', () => {
    expect(parityStatus(12, 12)).toBe('verified');
    expect(parityStatus(11, 12)).toBe('needs_review');
    expect(parityStatus(10, 12)).toBe('needs_iteration');
    expect(parityStatus(8, 12)).toBe('needs_iteration');
    expect(parityStatus(7, 12)).toBe('failed');
    expect(parityStatus(0, 0)).toBe('failed');
  });

  it('take exactly the 12 ids with a boolean each, and nothing else of the answer', () => {
    expect(parseParityVerdicts({ checks: allPass() })?.size).toBe(12);
    expect(parseParityVerdicts({ checks: { ...allPass(), 'layout.extra': { pass: true, reason: '' } } })).toBeUndefined();
    const missing = allPass();
    delete missing['color.accent_color_match'];
    expect(parseParityVerdicts({ checks: missing })).toBeUndefined();
    expect(parseParityVerdicts({ checks: { ...allPass(), 'color.accent_color_match': { pass: 'true', reason: '' } } })).toBeUndefined();
    expect(parseParityVerdicts({ checks: DESIGN_PARITY_CHECK_IDS.map((id) => ({ id, pass: true })) })).toBeUndefined();
    expect(parseParityVerdicts(null)).toBeUndefined();
  });

  it('compute the score from the booleans alone; a model score or status is never read', () => {
    const checks = { ...allPass(), 'layout.column_count_match': { pass: false, reason: 'One\ncolumn,   not two.' }, 'content.all_sections_present': { pass: false, reason: 'x'.repeat(1000) } };
    const verdicts = parseParityVerdicts({ checks, score: 1, status: 'verified', passes: 12 })!;
    const width = parityWidth(768, 'md', verdicts);
    expect(width).toMatchObject({ width: 768, breakpoint: 'md', passes: 10, score: 10 / 12, status: 'needs_iteration' });
    expect(width.failed.map((check) => [check.id, check.label])).toEqual([['layout.column_count_match', 'Column count'], ['content.all_sections_present', 'Sections']]);
    expect(width.failed[0]!.reason).toBe('One column, not two.');
    expect([...width.failed[1]!.reason]).toHaveLength(300);
  });
});

describe('the app capture answer', () => {
  it('takes a frame of the asked width and refuses anything else', () => {
    expect(parseAppFrame(appAnswer(768), 768)).toMatchObject({ cssWidth: 768, cssHeight: 900, contentHeight: 1400, status: 200 });
    expect(parseAppFrame(appAnswer(768), 390)).toEqual({ failure: 'error', detail: expect.any(String) });
    expect(parseAppFrame({ content: [{ type: 'text', text: '{"failure":"load","detail":"net::ERR_CONNECTION_REFUSED"}' }], isError: true }, 768)).toEqual({ failure: 'load', detail: 'net::ERR_CONNECTION_REFUSED' });
    // a relay's or the guard's own refusal is no capture failure, and is kept as written
    expect(parseAppFrame({ content: [{ type: 'text', text: '10.0.0.5 is on this computer or its local network.' }], isError: true }, 768)).toEqual({ failure: undefined, detail: '10.0.0.5 is on this computer or its local network.' });
    expect(parseAppFrame({ content: [{ type: 'text', text: '{"failure":"rm -rf"}' }], isError: true }, 768)).toEqual({ failure: undefined, detail: '{"failure":"rm -rf"}' });
    const big = appAnswer(768);
    expect(parseAppFrame({ content: [big.content[0]!, { type: 'image', data: png(2000, 900).toString('base64'), mimeType: 'image/png' }] }, 768)).toEqual({ failure: 'tooLarge', detail: '' });
    expect(parseAppFrame({ content: [big.content[0]!, { type: 'image', data: 'bm90IGEgcG5n', mimeType: 'image/png' }] }, 768)).toEqual({ failure: 'error', detail: expect.any(String) });
  });
});

describe('the app capture', () => {
  function fakeScope(height: unknown, pngs: string[] = []) {
    const calls: string[] = [];
    const clips: Array<{ width: number; height: number; scale: number }> = [];
    let controller: unknown = null;
    const page = {
      waitForLoadState: async () => void calls.push('load'),
      evaluate: async () => height,
    };
    const made = {
      getPage: () => page,
      setViewport: async (width: number, viewHeight: number, dpr: number) => void calls.push(`viewport ${width}x${viewHeight}@${dpr}`),
      captureScreenshot: async (options: { clip: { width: number; height: number; scale: number } }) => {
        clips.push(options.clip);
        return pngs.shift() ?? png(Math.round(options.clip.width * options.clip.scale), Math.round(options.clip.height * options.clip.scale)).toString('base64');
      },
    };
    const scope = {
      getController: () => controller,
      open: async (url: string) => {
        calls.push(`open ${url}`);
        controller = made;
        return url === 'about:blank' ? undefined : 200;
      },
      waitForController: async () => true,
    } as unknown as BrowserAgentScope;
    return { scope, calls, clips };
  }

  it('sets the viewport before the load and captures W × min(900, content height) at the largest scale up to 2 within 1950 px', async () => {
    const { scope, calls, clips } = fakeScope(1500.4);
    const answer = await captureAppFrame(scope, 'http://127.0.0.1:5173/', 1280);
    expect(calls).toEqual(['open about:blank', 'viewport 1280x900@1', 'open http://127.0.0.1:5173/', 'load']);
    expect(clips).toEqual([{ x: 0, y: 0, width: 1280, height: 900, scale: 1.523 }]);
    expect(parseAppFrame(answer, 1280)).toMatchObject({ cssWidth: 1280, cssHeight: 900, contentHeight: 1500, status: 200 });
    const short = fakeScope(400);
    await captureAppFrame(short.scope, 'http://127.0.0.1:5173/', 390);
    expect(short.clips).toEqual([{ x: 0, y: 0, width: 390, height: 400, scale: 2 }]);
  });

  it('reports a load failure by its net code and an HTTP error status, and captures neither', async () => {
    const refused = fakeScope(900);
    (refused.scope as unknown as { open: (url: string) => Promise<number | undefined> }).open = async (url) => {
      if (url === 'about:blank') {
        (refused.scope as unknown as { getController: () => unknown }).getController = () => ({ setViewport: async () => undefined });
        return undefined;
      }
      throw new Error('Navigation to http://127.0.0.1:5173 failed: net::ERR_CONNECTION_REFUSED');
    };
    expect(await captureAppFrame(refused.scope, 'http://127.0.0.1:5173/', 390)).toEqual({ content: [{ type: 'text', text: '{"failure":"load","detail":"net::ERR_CONNECTION_REFUSED"}' }], isError: true });
    const missing = fakeScope(900);
    const open = (missing.scope as unknown as { open: (url: string) => Promise<number | undefined> }).open;
    (missing.scope as unknown as { open: (url: string) => Promise<number | undefined> }).open = async (url) => ((await open(url)) === undefined ? undefined : 404);
    expect(await captureAppFrame(missing.scope, 'http://127.0.0.1:5173/nope', 390)).toEqual({ content: [{ type: 'text', text: '{"failure":"status","detail":"404"}' }], isError: true });
    expect(missing.clips).toEqual([]);
    expect(await captureAppFrame(missing.scope, 'ftp://127.0.0.1/', 390)).toEqual({ content: [{ type: 'text', text: '{"failure":"scheme"}' }], isError: true });
  });

  it('takes a capture past one image block again, smaller, and refuses a page whose height it cannot read', async () => {
    const huge = `${png(780, 1800).toString('base64')}${'A'.repeat(4_000_000)}`;
    const { scope, clips } = fakeScope(2000, [huge]);
    expect((await captureAppFrame(scope, 'http://127.0.0.1:5173/', 390)).isError).toBeUndefined();
    expect(clips.map((clip) => clip.scale)).toEqual([2, 1.4]);
    expect(await captureAppFrame(fakeScope('tall').scope, 'http://127.0.0.1:5173/', 390)).toEqual({ content: [{ type: 'text', text: '{"failure":"height"}' }], isError: true });
  });
});

describe('DesignParity', () => {
  it('scores each width ascending from the judge\'s booleans and returns the design then the app image per width', async () => {
    const failing = { ...allPass(), 'color.accent_color_match': { pass: false, reason: 'Blue, not teal.' }, 'color.palette_consistency_match': { pass: false, reason: 'Warmer.' }, 'components.icon_motif_match': { pass: false, reason: 'Filled icons.' } };
    const { deps, judged, released, captured } = setup({}, [{ checks: allPass(), score: 0.1 }, { checks: failing, score: 1, status: 'verified' }]);
    const result = await run(deps);
    expect(result.isError).toBeUndefined();
    const details = result.details as DesignParityDetails;
    expect(details).toMatchObject({ screen: 'S1-contacts', file: 'screens/S1-contacts.html', url: 'http://127.0.0.1:5173/contacts.html' });
    expect(details.widths.map(({ width, breakpoint, passes, score, status }) => ({ width, breakpoint, passes, score, status }))).toEqual([
      { width: 390, breakpoint: 'base', passes: 12, score: 1, status: 'verified' },
      { width: 768, breakpoint: 'md', passes: 9, score: 0.75, status: 'needs_iteration' },
    ]);
    expect(details.widths[1]!.failed.map((check) => check.id)).toEqual(['color.accent_color_match', 'color.palette_consistency_match', 'components.icon_motif_match']);
    expect(details.images.map(({ width, kind }) => ({ width, kind }))).toEqual([{ width: 390, kind: 'design' }, { width: 390, kind: 'app' }, { width: 768, kind: 'design' }, { width: 768, kind: 'app' }]);
    // Each image's frame height, which the card's thumbnail box takes its aspect ratio from.
    expect(details.images.every((image) => typeof image.cssHeight === 'number' && image.cssHeight > 0)).toBe(true);
    expect(result.content.filter((block) => block.type === 'image')).toHaveLength(4);
    expect(captured).toEqual([{ scope: 'design-parity-call-1', url: 'http://127.0.0.1:5173/contacts.html', width: 390 }, { scope: 'design-parity-call-1', url: 'http://127.0.0.1:5173/contacts.html', width: 768 }]);
    expect(released).toEqual(['design-parity-call-1']);
    expect(judged.map((req) => [req.purpose, req.outputToolName, req.userImages?.length])).toEqual([['design-parity', PARITY_OUTPUT_TOOL, 2], ['design-parity', PARITY_OUTPUT_TOOL, 2]]);
    expect(judged[0]!.userImages![0]!.data).toBe(png(780, 1800).toString('base64'));
    expect(judged[0]!.attribution).toEqual({ cwd: '/ws', sessionId: PARENT });
  });

  it('takes the design\'s checked widths by default and a screen by its file', async () => {
    const { deps } = setup();
    const result = await run(deps, { screen: 'screens/S1-contacts.html', url: 'https://app.example/contacts' });
    expect((result.details as DesignParityDetails).widths.map((width) => width.width)).toEqual([390, 768, 1280]);
  });

  it('carries no images for a chat model that reads none, and still scores every width', async () => {
    const { deps } = setup({ imageBudget: () => 0 });
    const result = await run(deps);
    expect((result.details as DesignParityDetails).images).toEqual([]);
    expect((result.details as DesignParityDetails).widths).toHaveLength(2);
    expect(result.content.some((block) => block.type === 'image')).toBe(false);
  });

  it('refuses more images than the chat\'s model keeps from one result', async () => {
    const { deps, captured } = setup({ imageBudget: () => 2 });
    expect(refusalOf(await run(deps))).toBe('{0} widths need {1} images, over the {2} one result keeps. Name at most {3} widths.');
    expect(refusalOf(await run(setup({ imageBudget: () => 1 }).deps))).toBe("The chat's model keeps too few images from one result to show the design beside the app.");
    expect(captured).toEqual([]);
  });

  it('refuses while the design\'s render inputs differ from the delivered version\'s, or the version records none', async () => {
    const folder = designFolderOf(DESIGN);
    fs.mkdirSync(path.join(folder, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'assets', 'logo.svg'), '<svg/>');
    const { deps, captured } = setup();
    expect(refusalOf(await run(deps))).toBe('The design changed since v{0}; compare after its next version.');
    await writeVersion(await renderInputHashes(folder, ['screens/S1-contacts.html']));
    fs.writeFileSync(path.join(folder, 'decisions.md'), '# Decisions');
    fs.mkdirSync(path.join(folder, 'feedback'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'feedback', 'F1.json'), '{}');
    expect((await run(deps)).isError).toBeUndefined();
    fs.appendFileSync(path.join(folder, 'screens', 'S1-contacts.html'), '\n');
    expect(refusalOf(await run(deps))).toBe('The design changed since v{0}; compare after its next version.');
    await writeVersion(undefined);
    expect(refusalOf(await run(deps))).toBe('v{0} of the design predates the render hashes DesignParity compares. Finish the design again in its design chat, then compare.');
    expect(captured).toHaveLength(2);
  });

  it('refuses with the browser setting off, naming it, and captures nothing', async () => {
    const { deps, captured, judged } = setup({ browserEnabled: () => false });
    const result = await run(deps);
    expect(refusalOf(result)).toBe('DesignParity captures the app with the Damocles browser, which is off. Turn on the browser in Settings, then call DesignParity again.');
    expect(result.content[0]!.text).toContain('Turn on the browser in Settings');
    expect([captured, judged]).toEqual([[], []]);
  });

  it('refuses a background model that reads no images, with no fallback', async () => {
    const { deps, captured, judged } = setup({ judgeReadsImages: () => false });
    expect(refusalOf(await run(deps))).toBe('The background model cannot read images. Choose one that can in Settings, Background.');
    expect([captured, judged]).toEqual([[], []]);
    expect(refusalOf(await run(setup({ judgeReadsImages: () => null }).deps))).toBe('No model could be reached. Check the Background model in Settings.');
  });

  it('refuses with the render refusal when no client renders designs, and releases the scope', async () => {
    expect(refusalOf(await run(setup({ render: () => undefined }).deps))).toBe(DESIGN_RENDER_CLIENT_ABSENT);
    const absent = { capture: async () => { throw new Error(DESIGN_RENDER_CLIENT_ABSENT); } } as unknown as DesignPreviewHost;
    const { deps, released, judged } = setup({ render: () => absent });
    expect(refusalOf(await run(deps))).toBe(DESIGN_RENDER_CLIENT_ABSENT);
    expect(released).toEqual(['design-parity-call-1']);
    expect(judged).toEqual([]);
  });

  it('refuses an address that is not http or https', async () => {
    const { deps, captured } = setup();
    expect(refusalOf(await run(deps, { screen: 'S1-contacts', url: 'file:///C:/app/index.html' }))).toBe('DesignParity opens only http and https addresses.');
    expect(captured).toEqual([]);
  });

  it('says the app did not load, naming the net error, or for a remote chat that its port may not be forwarded', async () => {
    const failing = (remote: boolean, text: string): DesignParityDeps['appCapture'] => () => ({
      remote,
      capture: async () => ({ content: [{ type: 'text', text }], isError: true }),
      release: async () => undefined,
    });
    const load = '{"failure":"load","detail":"net::ERR_CONNECTION_REFUSED"}';
    const local = await run(setup({ appCapture: failing(false, load) }).deps);
    expect((local.details as DesignParityRefusal).refusal).toEqual({
      message: 'The app at {0} did not load ({1}). Start the app or check the address, then call DesignParity again.',
      args: ['http://127.0.0.1:5173', { message: '{0}', args: ['net::ERR_CONNECTION_REFUSED'] }],
    });
    expect(local.content[0]!.text).toBe('DesignParity refused: The app at http://127.0.0.1:5173 did not load (net::ERR_CONNECTION_REFUSED). Start the app or check the address, then call DesignParity again.');
    expect(refusalOf(await run(setup({ appCapture: failing(true, load) }).deps))).toBe('The app at {0} did not load ({1}). Start it on the remote host and check that its port is forwarded in the Ports section, then call DesignParity again.');
    expect(refusalOf(await run(setup({ appCapture: failing(true, 'Port 5173 could not be forwarded.') }).deps))).toBe('The browser on the computer that shows this chat could not capture {0}: {1} For an app on the remote host, check that its port is forwarded in the Ports section.');
    expect(refusalOf(await run(setup({ appCapture: failing(false, '{"failure":"status","detail":"404"}') }).deps))).toBe('The app at {0} answered HTTP {1}. Check the address and the app, then call DesignParity again.');
  });

  it('ends a width whose app capture does not answer within 60 s with the app refusal, and releases the scope', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const released: string[] = [];
      let seen: AbortSignal | undefined;
      const { deps, judged } = setup({
        appCapture: () => ({ remote: false, capture: (_scope, _url, _width, signal) => { seen = signal; return new Promise<BrowserToolAnswer>(() => undefined); }, release: async (scope) => void released.push(scope) }),
      });
      const pending = run(deps);
      await vi.waitFor(() => expect(seen).toBeDefined());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refusalOf(await pending)).toBe('The app at {0} did not answer within {1} s. Check that it is running, then call DesignParity again.');
      expect(seen?.aborted).toBe(true);
      expect(released).toEqual(['design-parity-call-1']);
      expect(judged).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses without a finished design of its own, in a design chat and with design mode off', async () => {
    expect(refusalOf(await run(setup({ branch: () => [link] }).deps))).toBe('DesignParity runs in a chat that has a finished design. Start one with StartDesign and wait for its result.');
    expect(refusalOf(await run(setup({ sessionId: () => 'fork-1' }).deps))).toBe('DesignParity runs in a chat that has a finished design. Start one with StartDesign and wait for its result.');
    expect(refusalOf(await run(setup({ designChat: () => true }).deps))).toBe('DesignParity runs in the chat that started the design, not in a design chat.');
    expect(refusalOf(await run(setup({ enabled: () => false }).deps))).toBe('Design mode is off. The user turns it on in Settings.');
    expect(refusalOf(await run(setup().deps, { screen: 'S9', url: 'http://127.0.0.1:5173/' }))).toBe('Not a screen of this design: {0}. The screens are {1}.');
  });

  it('fails a width whose judge answer does not hold exactly the 12 checks, and releases the scope', async () => {
    const { deps, released } = setup({}, [{ checks: { ...allPass(), extra: { pass: true, reason: '' } } }]);
    expect(refusalOf(await run(deps))).toBe('The judge did not return the 12 checks at {0} px. Call DesignParity again.');
    expect(released).toEqual(['design-parity-call-1']);
  });

  it('names the background model\'s refusal or sign-in', async () => {
    const answering = (result: StructuredCompletionResult<never>): Partial<DesignParityDeps> => ({ judge: async () => result });
    expect(refusalOf(await run(setup(answering({ kind: 'rejected' })).deps))).toBe('The background model refused the images at {0} px.');
    expect(refusalOf(await run(setup(answering({ kind: 'unreachable', cause: 'credential' })).deps))).toBe("The Background model's provider refused the sign-in. Sign in again in Settings › Models & accounts.");
    expect(refusalOf(await run(setup(answering({ kind: 'unanswered' })).deps))).toBe('The judge did not return the 12 checks at {0} px. Call DesignParity again.');
  });
});
