import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanJudge } from './decision-kit';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import type { DesignPreviewHost } from '../../../platform/design-preview';
import { createVsCodeFileConfinement } from '../../../vscode/platform/file-confinement';
import { DEFAULT_RENDER_MEDIA, DESIGN_RENDER_CLIENT_ABSENT, DESIGN_RENDER_PREDATES, DESIGN_RENDER_UPDATE_NEEDED, MAX_QUEUED_RUNS_PER_AUTHORITY } from '../../../shared/design-render';
import { DESIGN_DECISIONS_DETAIL_KEY, type DesignCheckSummary, type DesignProbeResult, type DesignProbeWidth, type DesignRender, type DesignRenderRequest, type DesignScreenshotDetails } from '../../../shared/types/design';
import { widthIssues, type CheckedWidth } from '../design-check';
import { checkedWidthsOf, designViewports } from '../design-preview';
import type { DesignDecisionRecord, DesignRole } from '../design-entries';
import { readManifest } from '../design-files';
import { designFolderOf, designStateDirOf } from '../design-paths';
import { readLatestVersion } from '../design-state';
import { updateInventory } from '../inventory';
import { recordJourneyCheck } from '../width-checks';
import { createDesignChatTools, type DesignChatToolDeps } from '../tools/design-chat-tools';
import { createDesignScreenshotTool } from '../tools/design-screenshot';
import { createFinishDesignTool } from '../tools/finish-design';
import { designRuleSetById } from '../rule-set';
import { clearDesigns } from './design-harness';

const DESIGN = 'contacts-abcd1234';
const FOLDER = designFolderOf(DESIGN);
const FIXTURES = path.join(__dirname, 'fixtures');
const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;
type Tool = { name: string; execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: { type: string; text?: string; data?: string }[]; details: unknown; isError?: boolean }> };

const role: DesignRole = { designId: DESIGN, folder: FOLDER, parentSessionId: 'parent-1', ruleSet: 'full', title: 'Contacts' };
const decision = (id: string, title: string, chosen: string): DesignDecisionRecord => ({ v: 1, id, title, chosen, rejected: [], source: { kind: 'question', ref: 'Which?' }, files: [] });
const BRANCH = [{ id: 'r1', type: 'message', message: { role: 'toolResult', toolName: 'AskUserQuestion', toolCallId: 'q1', content: [], details: { [DESIGN_DECISIONS_DETAIL_KEY]: [decision('D1', 'Fidelity', 'Static mockup'), decision('D2', 'Density', 'Compact')] } } }];
const WIDTHS: CheckedWidth[] = [{ width: 390, breakpoint: 'base' }, { width: 640, breakpoint: 'sm' }, { width: 768, breakpoint: 'md' }, { width: 1024, breakpoint: 'lg' }, { width: 1280, breakpoint: 'xl' }, { width: 1536, breakpoint: '2xl' }];

function measured(width: number, overrides: Partial<DesignProbeWidth> = {}): DesignProbeWidth {
  return { width, contentHeight: 1200, scrollWidth: width, clientWidth: width, overflow: false, overflowing: [], elements: [], ...overrides };
}

/** A render whose probe overflows below `overflowBelow` px; captures are PNG headers of the scaled frame, renders JPEG bytes. */
function fakeRender(overflowBelow = 0, answer: (request: DesignRenderRequest) => Partial<DesignRender> = () => ({})): DesignPreviewHost & { probes: unknown[][]; captures: unknown[][]; renders: [string, string, DesignRenderRequest][] } {
  const probes: unknown[][] = [];
  const captures: unknown[][] = [];
  const renders: [string, string, DesignRenderRequest][] = [];
  return {
    probes,
    captures,
    renders,
    render: async (designId, relPath, request) => {
      renders.push([designId, relPath, request]);
      const scale = Math.min(2, Math.floor((request.maxSide / Math.max(request.width, 900)) * 1000) / 1000);
      return { frames: [{ image: new Uint8Array([0xff, 0xd8]), mimeType: 'image/jpeg', cssWidth: request.width, cssHeight: 900, top: 0 }], contentHeight: 1200, scale, moving: false, ...answer(request) };
    },
    open: async () => true,
    changed: () => undefined,
    journey: () => Promise.reject(new Error('unused')),
    replayJourney: () => Promise.reject(new Error('unused')),
    probe: async (...args) => {
      probes.push(args);
      const [, , widths, , sweepTo] = args;
      const at = (width: number): DesignProbeWidth => (width < overflowBelow
        ? measured(width, { scrollWidth: 812, overflow: true, overflowing: [{ element: '<div data-ds-component="Table">', width: 812 }] })
        : measured(width));
      const result: DesignProbeResult = {
        widths: widths.map(at),
        consoleErrors: [],
        ...(sweepTo !== undefined ? { sweep: { from: 320, to: sweepTo, step: 8, overflowAt: [] } } : {}),
      };
      return result;
    },
    capture: async (...args) => {
      captures.push(args);
      const [, , width, , scale] = args;
      const cssHeight = 900;
      const s = Math.min(scale, Math.floor((1950 / Math.max(width, cssHeight)) * 1000) / 1000);
      return { png: new Uint8Array([1, 2, 3]), cssWidth: width, cssHeight, contentHeight: 1200, scale: s };
    },
  };
}

function deps(overrides: Partial<DesignChatToolDeps> = {}): DesignChatToolDeps {
  return {
    role: () => role,
    enabled: () => true,
    cwd: FOLDER,
    confinement: createVsCodeFileConfinement(),
    branch: () => BRANCH,
    decisions: () => undefined,
    conflictJudge: () => cleanJudge(),
    sessionId: () => 'design-1',
    readStanding: async () => ({ kind: 'current' as const }),
    standing: () => ({ kind: 'current' as const }),
    publish: () => undefined,
    offerResult: vi.fn(async () => 'live' as const),
    hasParent: async () => true,
    requestApproval: async () => ({ choice: 'approve' as const }),
    render: () => fakeRender(),
    imageBudget: () => 12,
    model: () => undefined,
    referenceWritten: async () => undefined,
    openPreview: async () => ({ opened: true as const }),
    webToolsEnabled: () => true,
    webHostFilter: async () => () => false,
    ...overrides,
  };
}

async function designReady(): Promise<void> {
  fs.mkdirSync(path.join(FOLDER, 'screens'), { recursive: true });
  fs.writeFileSync(path.join(FOLDER, 'design.md'), fs.readFileSync(path.join(FIXTURES, 'design.md'), 'utf8').replace('checked: [base, md, xl]', 'checked: [base, sm, md, lg, xl, 2xl]'));
  fs.copyFileSync(path.join(FIXTURES, 'pass.html'), path.join(FOLDER, 'screens', 'S1-contacts.html'));
  fs.writeFileSync(path.join(FOLDER, 'tokens.css'), ':root { --spacing: 0.25rem; --color-surface: #fff; --color-muted-foreground: #64748b; --color-border: #e2e8f0; --radius-sm: 0.25rem; --radius-md: 0.375rem; }');
  await updateInventory(FOLDER, (current) => ({
    ...current,
    stack: 'Vue',
    breakpoints: { source: 'Tailwind defaults', values: { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 } },
    components: [{ name: 'Button', path: 'a.vue', variants: ['primary'] }, { name: 'Input', path: 'a.vue' }, { name: 'Table', path: 'a.vue', variants: ['compact'] }],
    types: [{ name: 'Contact', path: 'a.ts:1', fields: ['name', 'email'] }],
  }));
}

const tool = (d: DesignChatToolDeps, name: string): Tool => [...createDesignChatTools(pi, d, designRuleSetById('full')), createFinishDesignTool(pi, d), createDesignScreenshotTool(pi, d)].find((candidate) => (candidate as unknown as Tool).name === name) as unknown as Tool;

beforeEach(clearDesigns);

describe('the width rules', () => {
  it('reports an element that overflows at 390 px with its width, the viewport and the preset (acceptance)', () => {
    const probe: DesignProbeResult = { widths: [measured(390, { scrollWidth: 812, overflow: true, overflowing: [{ element: '<div data-ds-component="Table">', width: 812 }] }), measured(640)], consoleErrors: [] };
    expect(widthIssues('S1', probe, WIDTHS)).toEqual([{
      rule: 'layout.overflow',
      severity: 'error',
      screen: 'S1',
      element: '<div data-ds-component="Table">',
      message: '<div data-ds-component="Table"> is 812 px wide and overflows the 390 px viewport, which scrolls sideways to 812 px.',
      width: 390,
      breakpoint: 'base',
    }]);
  });

  it('reports a sweep run no checked width falls in, once, with no preset', () => {
    const probe: DesignProbeResult = {
      widths: [measured(390), measured(640)],
      consoleErrors: [],
      sweep: { from: 320, to: 1536, step: 8, overflowAt: [{ width: 456, scrollWidth: 470 }, { width: 464, scrollWidth: 470 }, { width: 472, scrollWidth: 480 }, { width: 600, scrollWidth: 610 }] },
    };
    const issues = widthIssues('S1', probe, WIDTHS);
    expect(issues.map((issue) => [issue.rule, issue.width, issue.breakpoint])).toEqual([['layout.overflow', 456, undefined], ['layout.overflow', 600, undefined]]);
    expect(issues[0]!.message).toBe('The page scrolls sideways from 456 to 472 px (470 px wide at 456 px), between the checked widths.');
  });

  it('warns about a bound field hidden at one width but shown at another', () => {
    const element = (visible: boolean) => ({ tag: 'td', id: null, component: null, variant: null, bind: 'Contact.email', rect: { x: 0, y: 0, w: visible ? 100 : 0, h: visible ? 20 : 0 }, visible });
    const probe: DesignProbeResult = { widths: [measured(390, { elements: [element(false)] }), measured(640, { elements: [element(true)] })], consoleErrors: [] };
    expect(widthIssues('S1', probe, WIDTHS)).toEqual([expect.objectContaining({ rule: 'ds.hidden-required', severity: 'warning', width: 390, breakpoint: 'base', element: '<td data-ds-bind="Contact.email">' })]);
    const hiddenEverywhere: DesignProbeResult = { widths: [measured(390, { elements: [element(false)] }), measured(640, { elements: [element(false)] })], consoleErrors: [] };
    expect(widthIssues('S1', hiddenEverywhere, WIDTHS)).toEqual([]);
  });
});

describe('widths a design cannot render at', () => {
  it('are no preset: design.frontmatter names them, and neither the checked widths nor the primary take them', async () => {
    await designReady();
    fs.writeFileSync(path.join(FOLDER, 'design.md'), fs.readFileSync(path.join(FIXTURES, 'design.md'), 'utf8').replace('checked: [base, md, xl]', 'checked: [xs, md]').replace('primary: xl', 'primary: xs').replace('journey: [xl]', 'journey: []'));
    await updateInventory(FOLDER, (current) => ({ ...current, breakpoints: { source: 'declared', values: { xs: 200, md: 768 } } }));
    const result = await tool(deps({ render: () => fakeRender() }), 'DesignCheck').execute('call-1', {});
    const summary = result.details as DesignCheckSummary;
    expect(summary.errors.filter((issue) => issue.rule === 'design.frontmatter').map((issue) => issue.message)).toEqual([
      'viewports.primary must be a preset (base, md) or a width from 320 to 2560.',
      'viewports.checked: "xs" is not a preset (base, md) or a width from 320 to 2560.',
    ]);
    expect(summary.widths).toEqual([768]);
    expect(checkedWidthsOf(await designViewports(FOLDER))).toEqual([{ width: 768, breakpoint: 'md' }]);
    expect((await designViewports(FOLDER)).primary).toBe(1280);
  });
});

describe('DesignCheck at widths (FULL)', () => {
  it('probes each screen at base and every breakpoint plus the sweep, and records the check with the folder\'s content hash', async () => {
    await designReady();
    const render = fakeRender(400);
    const result = await tool(deps({ render: () => render }), 'DesignCheck').execute('call-1', {});
    const summary = result.details as DesignCheckSummary;
    expect(render.probes).toHaveLength(1);
    expect(render.probes[0]!.slice(0, 5)).toEqual([DESIGN, 'screens/S1-contacts.html', [390, 640, 768, 1024, 1280, 1536], null, 1536]);
    expect(summary.widths).toEqual([390, 640, 768, 1024, 1280, 1536]);
    expect(summary.errors.map((issue) => [issue.rule, issue.width, issue.breakpoint])).toEqual([['layout.overflow', 390, 'base']]);
    expect(result.content[0]!.text).toMatch(/at 390 px \(base\)/);
    const record = JSON.parse(fs.readFileSync(path.join(designStateDirOf(DESIGN), 'checks', 'S1-contacts.json'), 'utf8'));
    expect(record).toMatchObject({ schemaVersion: 1, screen: 'S1', file: 'screens/S1-contacts.html', sweepTo: 1536, issues: [{ rule: 'layout.overflow', width: 390 }] });
    const manifest = await readManifest(FOLDER, DESIGN);
    expect(manifest.screens[0]!.widthCheck).toEqual({ contentHash: record.contentHash, widths: [390, 640, 768, 1024, 1280, 1536], errors: 1, warnings: 0 });
  });

  it('keeps a journey PreviewJourney records while the probe runs, re-reading the record in the state folder\'s lane (D65)', async () => {
    await designReady();
    const render = fakeRender();
    const screen = { id: 'S1', file: 'screens/S1-contacts.html', contentHash: 'h' };
    const journey = { contentHash: 'h', widths: [1280], passed: true } as unknown as Parameters<typeof recordJourneyCheck>[2];
    const probing: DesignPreviewHost = {
      ...render,
      probe: async (...args) => {
        await recordJourneyCheck(DESIGN, screen, journey);
        return render.probe(...args);
      },
    };
    await tool(deps({ render: () => probing }), 'DesignCheck').execute('call-1', {});
    const record = JSON.parse(fs.readFileSync(path.join(designStateDirOf(DESIGN), 'checks', 'S1-contacts.json'), 'utf8'));
    expect(record).toMatchObject({ file: 'screens/S1-contacts.html', sweepTo: 1536, journey });
  });

  it('checks only statically, with a note, while no client renders designs', async () => {
    await designReady();
    const absent: DesignPreviewHost = { ...fakeRender(), probe: () => Promise.reject(new Error(DESIGN_RENDER_CLIENT_ABSENT)) };
    const result = await tool(deps({ render: () => absent }), 'DesignCheck').execute('call-1', {});
    expect((result.details as DesignCheckSummary).widths).toEqual([]);
    expect(result.content[0]!.text).toContain(`The width checks did not run: ${DESIGN_RENDER_CLIENT_ABSENT}`);
    // The card says so in the user's language, never as a static pass.
    expect((result.details as DesignCheckSummary).widthChecks).toEqual({ skipped: { message: 'The width checks did not run. They run once this chat is open in the Damocles app.' } });
  });
});

describe('FinishDesign on FULL', () => {
  it('is refused while any width fails (acceptance)', async () => {
    await designReady();
    const result = await tool(deps({ render: () => fakeRender(400) }), 'FinishDesign').execute('call-1', { summary: 'The list.' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^FinishDesign refused: DesignCheck reports 1 error/);
    expect((result.details as DesignCheckSummary).errors[0]).toMatchObject({ rule: 'layout.overflow', width: 390 });
    expect(await readLatestVersion(designStateDirOf(DESIGN))).toBeUndefined();
  });

  it('reuses width checks made at the current content hash and probes again after a change', async () => {
    await designReady();
    const render = fakeRender();
    await tool(deps({ render: () => render }), 'DesignCheck').execute('call-1', {});
    expect((await tool(deps({ render: () => render }), 'FinishDesign').execute('call-2', { summary: 'The list.' })).details).toMatchObject({ version: 1 });
    expect(render.probes).toHaveLength(1);
    fs.appendFileSync(path.join(FOLDER, 'screens', 'S1-contacts.html'), '\n');
    await tool(deps({ render: () => render }), 'FinishDesign').execute('call-3', { summary: 'The list.' });
    expect(render.probes).toHaveLength(2);
  });

  it('reuses a width check while the screen and the files it loads are unchanged, whatever else is written, and probes again after a token change (D86)', async () => {
    await designReady();
    const render = fakeRender();
    await tool(deps({ render: () => render }), 'DesignCheck').execute('call-1', {});
    fs.mkdirSync(path.join(FOLDER, 'feedback'), { recursive: true });
    fs.writeFileSync(path.join(FOLDER, 'feedback', 'F1.json'), '{}');
    fs.writeFileSync(path.join(FOLDER, 'screens', 'S1-contacts.journey.json'), '{}');
    expect((await tool(deps({ render: () => render }), 'FinishDesign').execute('call-2', { summary: 'The list.' })).details).toMatchObject({ version: 1 });
    expect(render.probes).toHaveLength(1);
    fs.appendFileSync(path.join(FOLDER, 'tokens.css'), '\n');
    await tool(deps({ render: () => render }), 'FinishDesign').execute('call-3', { summary: 'The list.' });
    expect(render.probes).toHaveLength(2);
    fs.mkdirSync(path.join(FOLDER, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(FOLDER, 'assets', 'logo.svg'), '<svg/>');
    fs.mkdirSync(path.join(FOLDER, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(FOLDER, 'shared', 'unlinked.css'), 'body { color: var(--color-surface); }');
    await tool(deps({ render: () => render }), 'FinishDesign').execute('call-4', { summary: 'The list.' });
    expect(render.probes).toHaveLength(2);
  });

  it('takes a check record that is not JSON as absent and probes again', async () => {
    await designReady();
    const render = fakeRender();
    await tool(deps({ render: () => render }), 'DesignCheck').execute('call-1', {});
    fs.writeFileSync(path.join(designStateDirOf(DESIGN), 'checks', 'S1-contacts.json'), '{"schemaVersion": 1, "iss');
    expect((await tool(deps({ render: () => render }), 'FinishDesign').execute('call-2', { summary: 'The list.' })).details).toMatchObject({ version: 1 });
    expect(render.probes).toHaveLength(2);
  });

  it('refuses with the app message while a remote chat has no client to render it', async () => {
    await designReady();
    const absent: DesignPreviewHost = { ...fakeRender(), probe: () => Promise.reject(new Error(DESIGN_RENDER_CLIENT_ABSENT)) };
    const result = await tool(deps({ render: () => absent }), 'FinishDesign').execute('call-1', { summary: 'The list.' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('FinishDesign refused: Open this chat in the Damocles app to run the width checks.');
    expect((result.details as DesignCheckSummary).widthChecks).toEqual({ skipped: { message: 'Open this chat in the Damocles app to run the width checks.' } });
    expect(await readLatestVersion(designStateDirOf(DESIGN))).toBeUndefined();
  });
});

describe('DesignScreenshot', () => {
  it('returns one PNG per checked width, base to 2xl, each under 1950 px, and records the screenshot (acceptance)', async () => {
    await designReady();
    const render = fakeRender();
    await tool(deps({ render: () => render }), 'DesignCheck').execute('call-0', {});
    const result = await tool(deps({ render: () => render }), 'DesignScreenshot').execute('call-1', {});
    expect(result.content.filter((block) => block.type === 'image')).toHaveLength(6);
    expect(render.renders.map(([, , request]) => [request.width, request.format, request.maxSide])).toEqual([390, 640, 768, 1024, 1280, 1536].map((width) => [width, 'jpeg', 1568]));
    expect(render.captures).toEqual([]);
    expect(result.content.filter((block) => block.type === 'image').every((block) => (block as { mimeType?: string }).mimeType === 'image/jpeg')).toBe(true);
    const details = result.details as DesignScreenshotDetails;
    expect(details.outline).toBe(false);
    expect(details.screens[0]!.widths.map((width) => width.breakpoint)).toEqual(['base', 'sm', 'md', 'lg', 'xl', '2xl']);
    const screen = (await readManifest(FOLDER, DESIGN)).screens[0]!;
    expect(screen.screenshot?.widths).toEqual([390, 640, 768, 1024, 1280, 1536]);
    expect(screen.widthCheck?.widths).toHaveLength(6);
  });

  it('gives a model that reads no images the probe outline instead', async () => {
    await designReady();
    const render = fakeRender();
    const result = await tool(deps({ render: () => render, imageBudget: () => 0 }), 'DesignScreenshot').execute('call-1', {});
    expect(result.content.every((block) => block.type === 'text')).toBe(true);
    expect((result.details as DesignScreenshotDetails).outline).toBe(true);
    expect(render.renders).toEqual([]);
    expect(render.probes[0]![4]).toBeUndefined();
  });

  it('returns no more images than the model keeps from one result, so none is pruned before the model reads it', async () => {
    await designReady();
    fs.copyFileSync(path.join(FOLDER, 'screens', 'S1-contacts.html'), path.join(FOLDER, 'screens', 'S2-detail.html'));
    fs.copyFileSync(path.join(FOLDER, 'screens', 'S1-contacts.html'), path.join(FOLDER, 'screens', 'S3-edit.html'));
    const render = fakeRender();
    await expect(tool(deps({ render: () => render }), 'DesignScreenshot').execute('call-1', {})).rejects.toThrow(/3 pages at 6 widths is 18 images, over the 12 one call returns; name at most 2 pages/);
    expect(render.renders).toEqual([]);
    const two = await tool(deps({ render: () => render }), 'DesignScreenshot').execute('call-2', { screens: ['screens/S1-contacts.html', 'screens/S2-detail.html'] });
    expect(two.content.filter((block) => block.type === 'image')).toHaveLength(12);
    await expect(tool(deps({ render: () => render, imageBudget: () => 4 }), 'DesignScreenshot').execute('call-3', { screens: ['screens/S1-contacts.html'] })).rejects.toThrow(/name fewer widths/);
  });

  it('ends the other renders of the call when one fails', async () => {
    await designReady();
    const signals: AbortSignal[] = [];
    const failing: DesignPreviewHost = {
      ...fakeRender(),
      render: (...args) => {
        signals.push(args[3]);
        return signals.length === 1 ? Promise.reject(new Error('page crashed')) : new Promise(() => undefined);
      },
    };
    await expect(tool(deps({ render: () => failing }), 'DesignScreenshot').execute('call-1', {})).rejects.toThrow('page crashed');
    expect(signals).toHaveLength(6);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('fails with the refusal while no client renders designs, and refuses a file that is not a screen', async () => {
    await designReady();
    const absent: DesignPreviewHost = { ...fakeRender(), render: () => Promise.reject(new Error(DESIGN_RENDER_CLIENT_ABSENT)), capture: () => Promise.reject(new Error(DESIGN_RENDER_CLIENT_ABSENT)) };
    await expect(tool(deps({ render: () => absent }), 'DesignScreenshot').execute('call-1', {})).rejects.toThrow(DESIGN_RENDER_CLIENT_ABSENT);
    await expect(tool(deps(), 'DesignScreenshot').execute('call-1', { screens: ['../outside.html'] })).rejects.toThrow(/Not a screen or variant of this design/);
  });
});

describe('DesignScreenshot options (D85)', () => {
  const model = (resize?: Record<string, number>) => ({ input: ['text', 'image'], ...(resize ? { inputLimits: { images: { resize } } } : {}) }) as unknown as ReturnType<DesignChatToolDeps['model']>;
  const variant = (states: string): void => {
    fs.mkdirSync(path.join(FOLDER, 'variants', 'accent'), { recursive: true });
    fs.writeFileSync(path.join(FOLDER, 'variants', 'accent', 'a.html'), `<html data-ds-screen="S1" data-ds-states="${states}"><body><p>Accent A</p></body></html>`);
  };

  it('captures a variant in a declared state at the widths asked for (acceptance)', async () => {
    await designReady();
    variant('default empty');
    const render = fakeRender();
    const result = await tool(deps({ render: () => render }), 'DesignScreenshot').execute('call-1', { screens: ['variants/accent/a.html'], state: 'empty', widths: [390] });
    expect(render.renders.map(([, relPath, request]) => [relPath, request.state, request.width])).toEqual([['variants/accent/a.html', 'empty', 390]]);
    expect(result.content.filter((block) => block.type === 'image')).toHaveLength(1);
    await expect(tool(deps({ render: () => render }), 'DesignScreenshot').execute('call-2', { screens: ['variants/accent/a.html'], state: 'error' })).rejects.toThrow('variants/accent/a.html declares the states default, empty; "error" is not one of them.');
  });

  it('sizes and encodes for the model\'s published limits, else the default target (acceptance)', async () => {
    await designReady();
    const render = fakeRender();
    await tool(deps({ render: () => render, model: () => model({ maxWidth: 1568, maxHeight: 1568, maxBytes: 3_000_000, jpegQuality: 70 }) }), 'DesignScreenshot').execute('call-1', { widths: [1440] });
    await tool(deps({ render: () => render, model: () => model({ maxWidth: 2000, maxHeight: 2000, jpegQuality: 80 }) }), 'DesignScreenshot').execute('call-2', { widths: [1440] });
    await tool(deps({ render: () => render, model: () => model() }), 'DesignScreenshot').execute('call-3', { widths: [1440] });
    expect(render.renders.map(([, , request]) => [request.format, request.maxSide, request.quality, request.maxBytes])).toEqual([['jpeg', 1568, 70, 3_000_000], ['jpeg', 1950, 80, undefined], ['jpeg', 1568, 80, undefined]]);
  });

  it('pins the media asked for and passes the region and steps; refuses fullPage with selector, and steps on more than one page', async () => {
    await designReady();
    const render = fakeRender();
    const run = (id: string, params: Record<string, unknown>) => tool(deps({ render: () => render }), 'DesignScreenshot').execute(id, params);
    await run('call-1', { screens: ['screens/S1-contacts.html'], widths: [390], media: { colorScheme: 'dark', forcedColors: 'active' }, selector: '#tasks' });
    await run('call-2', { screens: ['screens/S1-contacts.html'], widths: [390], steps: [{ action: 'click', target: { role: 'button', name: 'More' } }] });
    const [first, second] = render.renders.map(([, , request]) => request) as [DesignRenderRequest, DesignRenderRequest];
    expect(first.media).toEqual({ colorScheme: 'dark', reducedMotion: 'no-preference', forcedColors: 'active', contrast: 'no-preference', reducedTransparency: 'no-preference' });
    expect(first.region).toEqual({ selector: '#tasks' });
    expect(second.steps).toEqual([{ action: 'click', target: { role: 'button', name: 'More' } }]);
    expect(second.media).toEqual(DEFAULT_RENDER_MEDIA);
    await expect(run('call-3', { widths: [390], fullPage: true, selector: '#tasks' })).rejects.toThrow('Use fullPage or selector, not both.');
    fs.copyFileSync(path.join(FOLDER, 'screens', 'S1-contacts.html'), path.join(FOLDER, 'screens', 'S2-detail.html'));
    await expect(run('call-4', { widths: [390], steps: [{ action: 'click', target: { role: 'button', name: 'More' } }] })).rejects.toThrow('steps run in one page: name exactly one screen or variant.');
  });

  it('counts frames in the image budget, and names the frames, the height left out and a page that never held still (acceptance)', async () => {
    await designReady();
    await expect(tool(deps(), 'DesignScreenshot').execute('call-1', { fullPage: true })).rejects.toThrow(/1 pages at 6 widths and up to 4 frames each is 24 images, over the 12/);
    const frames = [0, 900, 1800, 2700].map((top) => ({ image: new Uint8Array([0xff, 0xd8]), mimeType: 'image/jpeg' as const, cssWidth: 390, cssHeight: 900, top }));
    const render = fakeRender(0, () => ({ frames, contentHeight: 5000, moving: true }));
    const result = await tool(deps({ render: () => render }), 'DesignScreenshot').execute('call-2', { widths: [390], fullPage: true });
    const text = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    expect(text).toContain('screens/S1-contacts.html at 390 px (base): 4 frames, CSS px 0 to 3600 of 5000.');
    expect(text).toContain('CSS px 3600 to 5000 are left out; capture them with a selector for an element there, which is scrolled into view.');
    expect(text).toContain('screens/S1-contacts.html at 390 px never became still within 5 s (an endless animation, a carousel or a timer); the image shows one moment of it.');
    expect(result.content.filter((block) => block.type === 'image')).toHaveLength(4);
    expect((result.details as DesignScreenshotDetails).screens[0]!.widths.map((width) => width.top ?? 0)).toEqual([0, 900, 1800, 2700]);
  });

  it('names where a selector capture is cut, and sizes its card entry by the element\'s own width', async () => {
    await designReady();
    const frames = [5200, 6100, 7000, 7900].map((top) => ({ image: new Uint8Array([0xff, 0xd8]), mimeType: 'image/jpeg' as const, cssWidth: 320, cssHeight: 900, top }));
    const render = fakeRender(0, () => ({ frames, contentHeight: 12_000, boxBottom: 10_200 }));
    const result = await tool(deps({ render: () => render }), 'DesignScreenshot').execute('call-1', { widths: [390], selector: '#feed' });
    const text = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    expect(text).toContain('the element "#feed" matches, CSS px 5200 to 8800 of the page.');
    expect(text).toContain('The element is cut at CSS px 8800; its box runs to 10200.');
    expect((result.details as DesignScreenshotDetails).screens[0]!.widths[0]).toEqual({ breakpoint: 'base', width: 390, cssWidth: 320, cssHeight: 900, top: 5200 });
  });

  it('asks at most one authority\'s queue of renders at once, so a call over it still succeeds', async () => {
    await designReady();
    for (let index = 2; index <= 20; index++) fs.copyFileSync(path.join(FOLDER, 'screens', 'S1-contacts.html'), path.join(FOLDER, 'screens', `S${index}-copy.html`));
    let running = 0;
    let most = 0;
    const counted = <T>(work: () => Promise<T>): Promise<T> => {
      most = Math.max(most, ++running);
      return new Promise<T>((resolve) => setTimeout(() => resolve(work().finally(() => running--)), 1));
    };
    const base = fakeRender();
    const render: DesignPreviewHost = { ...base, render: (...args) => counted(() => base.render(...args)), probe: (...args) => counted(() => base.probe(...args)) };
    const shots = await tool(deps({ render: () => render, imageBudget: () => 24 }), 'DesignScreenshot').execute('call-1', { widths: [390] });
    expect(shots.content.filter((block) => block.type === 'image')).toHaveLength(20);
    expect(most).toBe(MAX_QUEUED_RUNS_PER_AUTHORITY);
    most = 0;
    const outlines = await tool(deps({ render: () => render, imageBudget: () => 0 }), 'DesignScreenshot').execute('call-2', { widths: [390] });
    expect((outlines.details as DesignScreenshotDetails).screens).toHaveLength(20);
    expect(most).toBe(MAX_QUEUED_RUNS_PER_AUTHORITY);
  });

  it('takes the plain capture from an app without design.render, saying so, and names the update when a new option was asked (acceptance)', async () => {
    await designReady();
    const older: DesignPreviewHost & { captures: unknown[][] } = { ...fakeRender(), render: () => Promise.reject(new Error(DESIGN_RENDER_PREDATES)) };
    const result = await tool(deps({ render: () => older }), 'DesignScreenshot').execute('call-1', { widths: [390] });
    expect(result.content.find((block) => block.type === 'image')).toMatchObject({ mimeType: 'image/png' });
    expect(result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')).toContain('This image was rendered by an older Damocles app: PNG, media not pinned.');
    await expect(tool(deps({ render: () => older }), 'DesignScreenshot').execute('call-2', { widths: [390], media: { colorScheme: 'dark' } })).rejects.toThrow(DESIGN_RENDER_UPDATE_NEEDED);
  });

  it('refuses the new options for a model that reads no images, which gets the outline', async () => {
    await designReady();
    await expect(tool(deps({ imageBudget: () => 0 }), 'DesignScreenshot').execute('call-1', { media: { colorScheme: 'dark' } })).rejects.toThrow(/This model reads no images/);
  });
});
