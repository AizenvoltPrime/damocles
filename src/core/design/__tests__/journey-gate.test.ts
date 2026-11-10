import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanJudge } from './decision-kit';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import type { DesignPreviewHost } from '../../../platform/design-preview';
import { createVsCodeFileConfinement } from '../../../vscode/platform/file-confinement';
import { DESIGN_RENDER_CLIENT_ABSENT } from '../../../shared/design-render';
import { DESIGN_DECISIONS_DETAIL_KEY, type DesignCheckSummary, type DesignJourneyRun, type DesignProbeResult, type FinishDesignDetails, type JourneyStep, type JourneyStepResult, type PreviewJourneyDetails } from '../../../shared/types/design';
import { isDesignerRelative, designFolderOf, designStateDirOf } from '../design-paths';
import type { DesignDecisionRecord, DesignRole } from '../design-entries';
import { readManifest } from '../design-files';
import { runWidthChecks } from '../width-checks';
import { readLatestVersion } from '../design-state';
import { designResultMessage } from '../delivery';
import { updateInventory } from '../inventory';
import { designRuleSetById, DESIGN_TOOLS_WITHOUT_FOLDER_WRITES } from '../rule-set';
import { createDesignChatTools, type DesignChatToolDeps } from '../tools/design-chat-tools';
import { createFinishDesignTool } from '../tools/finish-design';
import { createPreviewJourneyTool } from '../tools/preview-journey';
import { clearDesigns } from './design-harness';
import contacts from '../../../../e2e/fixtures/design-app/static/contacts.preview-journey.json' with { type: 'json' };

const renderInputsHook = vi.hoisted(() => ({ once: undefined as (() => Promise<void>) | undefined }));
vi.mock('../render-inputs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../render-inputs')>();
  return {
    ...actual,
    renderInputHashes: async (...args: Parameters<typeof actual.renderInputHashes>) => {
      const hook = renderInputsHook.once;
      renderInputsHook.once = undefined;
      await hook?.();
      return actual.renderInputHashes(...args);
    },
  };
});

const DESIGN = 'contacts-abcd1234';
const FOLDER = designFolderOf(DESIGN);
const FIXTURES = path.join(__dirname, 'fixtures');
const STEPS = contacts.steps as JourneyStep[];
const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;
type Tool = { name: string; execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: { type: string; text: string }[]; details: unknown; isError?: boolean }> };

const role = (ruleSet: 'full' | 'reduced' = 'full'): DesignRole => ({ designId: DESIGN, folder: FOLDER, parentSessionId: 'parent-1', ruleSet, title: 'Contacts' });
const decision = (id: string, title: string, chosen: string): DesignDecisionRecord => ({ v: 1, id, title, chosen, rejected: [], source: { kind: 'question', ref: 'Which?' }, files: [] });
const branchOf = (fidelity: string): unknown[] => [{ id: 'r1', type: 'message', message: { role: 'toolResult', toolName: 'AskUserQuestion', toolCallId: 'q1', content: [], details: { [DESIGN_DECISIONS_DETAIL_KEY]: [decision('D1', 'Fidelity', fidelity), decision('D2', 'Density', 'Compact')] } } }];

const HELP_SCREEN = '<!doctype html>\n<html lang="en" data-ds-screen="S2" data-ds-states="default">\n<head><meta charset="utf-8"><title>Help</title><link rel="stylesheet" href="../tokens.css"></head>\n<body><main><h1>Help</h1><p>Contacts sync every hour.</p></main></body>\n</html>\n';

const passing = (): JourneyStepResult[] => STEPS.map(() => ({ ok: true }));

/** A client whose probes find nothing wrong and whose journeys answer `outcome` per width; `calls` records each journey asked. */
function fakeRender(outcome: (width: number) => { passed: boolean; steps: JourneyStepResult[] } = () => ({ passed: true, steps: passing() })): DesignPreviewHost & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    open: async () => true,
    changed: () => undefined,
    capture: () => Promise.reject(new Error('unused')),
    render: () => Promise.reject(new Error('unused')),
    replayJourney: () => Promise.reject(new Error('unused')),
    probe: async (_designId, _relPath, widths, _state, sweepTo) => {
      const result: DesignProbeResult = {
        widths: widths.map((width) => ({ width, contentHeight: 900, scrollWidth: width, clientWidth: width, overflow: false, overflowing: [], elements: [] })),
        consoleErrors: [],
        ...(sweepTo !== undefined ? { sweep: { from: 320, to: sweepTo, step: 8, overflowAt: [] } } : {}),
      };
      return result;
    },
    journey: async (...args) => {
      calls.push(args);
      const [, , widths, , , outline] = args;
      const run: DesignJourneyRun = { widths: widths.map((width) => ({ width, ...outcome(width), ...(outline ? { outline: `body\n  button "Add contact"` } : {}) })), consoleErrors: [] };
      return run;
    },
  };
}

function deps(options: { ruleSet?: 'full' | 'reduced'; fidelity?: string; render?: DesignPreviewHost; imageBudget?: number } = {}): DesignChatToolDeps & { offerResult: ReturnType<typeof vi.fn> } {
  const branch = branchOf(options.fidelity ?? 'Interactive prototype');
  return {
    role: () => role(options.ruleSet),
    enabled: () => true,
    cwd: FOLDER,
    confinement: createVsCodeFileConfinement(),
    branch: () => branch,
    decisions: () => undefined,
    conflictJudge: () => cleanJudge(),
    sessionId: () => 'design-1',
    readStanding: async () => ({ kind: 'current' as const }),
    standing: () => ({ kind: 'current' as const }),
    publish: () => undefined,
    offerResult: vi.fn(async () => 'live' as const),
    hasParent: async () => true,
    requestApproval: async () => ({ choice: 'approve' as const }),
    render: () => options.render ?? fakeRender(),
    imageBudget: () => options.imageBudget ?? 12,
    model: () => undefined,
    referenceWritten: async () => undefined,
    openPreview: async () => ({ opened: true as const }),
    webToolsEnabled: () => true,
    webHostFilter: async () => () => false,
  } as DesignChatToolDeps & { offerResult: ReturnType<typeof vi.fn> };
}

const tools = (d: DesignChatToolDeps): Tool[] => [...createDesignChatTools(pi, d, designRuleSetById('full')), createFinishDesignTool(pi, d), createPreviewJourneyTool(pi, d)] as unknown as Tool[];
const tool = (d: DesignChatToolDeps, name: string): Tool => tools(d).find((candidate) => candidate.name === name)!;
const journey = (d: DesignChatToolDeps, steps: unknown = STEPS, screen = 'screens/S1-contacts.html') => tool(d, 'PreviewJourney').execute('journey-1', { screen, steps, untested: contacts.untested });
const finish = (d: DesignChatToolDeps) => tool(d, 'FinishDesign').execute('finish-1', { summary: 'The contacts list.' });
const check = async (d: DesignChatToolDeps): Promise<DesignCheckSummary> => (await tool(d, 'DesignCheck').execute('check-1', {})).details as DesignCheckSummary;

async function designReady(): Promise<void> {
  fs.mkdirSync(path.join(FOLDER, 'screens'), { recursive: true });
  fs.writeFileSync(path.join(FOLDER, 'design.md'), fs.readFileSync(path.join(FIXTURES, 'design.md'), 'utf8').replace('journey: [xl]', 'journey: [base, xl]'));
  fs.copyFileSync(path.join(FIXTURES, 'pass.html'), path.join(FOLDER, 'screens', 'S1-contacts.html'));
  fs.writeFileSync(path.join(FOLDER, 'screens', 'S2-help.html'), HELP_SCREEN);
  fs.writeFileSync(path.join(FOLDER, 'tokens.css'), ':root { --spacing: 0.25rem; --color-surface: #fff; --color-muted-foreground: #64748b; --color-border: #e2e8f0; --radius-sm: 0.25rem; --radius-md: 0.375rem; }');
  await updateInventory(FOLDER, (current) => ({
    ...current,
    stack: 'Vue',
    breakpoints: { source: 'Tailwind defaults', values: { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 } },
    components: [{ name: 'Button', path: 'a.vue', variants: ['primary'] }, { name: 'Input', path: 'a.vue' }, { name: 'Table', path: 'a.vue', variants: ['compact'] }],
    types: [{ name: 'Contact', path: 'a.ts:1', fields: ['name', 'email'] }],
  }));
}

beforeEach(clearDesigns);

describe('PreviewJourney (PD-13, PD-45)', () => {
  it('is FULL\'s only, waits for the checkpoint baseline, and its files are core-owned (PD-26, PD-42)', () => {
    expect(designRuleSetById('full').designTools).toContain('PreviewJourney');
    expect(designRuleSetById('reduced').designTools).not.toContain('PreviewJourney');
    expect(DESIGN_TOOLS_WITHOUT_FOLDER_WRITES.has('PreviewJourney')).toBe(false);
    expect(isDesignerRelative('screens/s1-contacts.journey.json')).toBe(false);
    expect(isDesignerRelative('screens/s1-contacts.journey.spec.ts')).toBe(false);
  });

  it('runs the 11-step journey at base and xl, and writes its JSON, its Playwright spec, the check record and the manifest (acceptance)', async () => {
    await designReady();
    const render = fakeRender();
    const result = await journey(deps({ render }));
    expect(render.calls.map((call) => call.slice(0, 6))).toEqual([[DESIGN, 'screens/S1-contacts.html', [390, 1280], null, STEPS, false]]);
    const details = result.details as PreviewJourneyDetails;
    expect(details).toMatchObject({ screen: 'S1', relPath: 'screens/S1-contacts.html', journeyFile: 'screens/S1-contacts.journey.json', specFile: 'screens/S1-contacts.journey.spec.ts', viewports: [{ breakpoint: 'base', width: 390 }, { breakpoint: 'xl', width: 1280 }], state: 'default', passed: true, untested: contacts.untested, outline: false });
    expect(details.results.map((width) => [width.width, width.passed, width.steps.length])).toEqual([[390, true, 11], [1280, true, 11]]);
    expect(result.content[0]!.text).toContain('The journey of S1 passed at 390 px and 1280 px: 11/11 steps.');
    const saved = JSON.parse(fs.readFileSync(path.join(FOLDER, 'screens', 'S1-contacts.journey.json'), 'utf8'));
    expect(saved).toMatchObject({ schemaVersion: 1, screen: 'S1', file: 'screens/S1-contacts.html', state: 'default', steps: STEPS, passed: true, untested: contacts.untested });
    expect(fs.readFileSync(path.join(FOLDER, 'screens', 'S1-contacts.journey.spec.ts'), 'utf8')).toContain('await page.getByLabel("Name", { exact: true }).press("Escape");');
    const record = JSON.parse(fs.readFileSync(path.join(designStateDirOf(DESIGN), 'checks', 'S1-contacts.json'), 'utf8'));
    expect(record.journey).toMatchObject({ passed: true, results: [{ width: 390, passed: true, failedStep: null }, { width: 1280, passed: true, failedStep: null }], untested: contacts.untested });
  });

  it('takes a screen only as the folder spells it, so its journey files, manifest entry and check record name one screen', async () => {
    await designReady();
    const render = fakeRender();
    for (const screen of ['Screens/S1-contacts.html', 'screens/s1-contacts.html']) {
      await expect(journey(deps({ render }), STEPS, screen)).rejects.toThrow(/is not a screen of this design|must be a screen file/);
    }
    expect(render.calls).toEqual([]);
  });

  it('refuses a 17-step call before anything renders (acceptance)', async () => {
    await designReady();
    const render = fakeRender();
    const seventeen = [...STEPS, ...STEPS.slice(0, 6)];
    await expect(journey(deps({ render }), seventeen)).rejects.toThrow(/A journey has at most 16 steps, asserts counted; this one has 17/);
    expect(render.calls).toEqual([]);
    expect(fs.existsSync(path.join(FOLDER, 'screens', 'S1-contacts.journey.json'))).toBe(false);
  });

  it('reports a target hidden at base with its width, and the run fails there (acceptance)', async () => {
    await designReady();
    const render = fakeRender((width) => (width === 390 ? { passed: false, steps: [{ ok: true }, { ok: true }, { ok: false, failure: 'hidden', hiddenAt: 390, message: 'No visible element matches button "Add contact" at 390 px.' }] } : { passed: true, steps: passing() }));
    const result = await journey(deps({ render }));
    const details = result.details as PreviewJourneyDetails;
    expect(details.passed).toBe(false);
    expect(details.results[0]!.steps[2]).toEqual({ ok: false, failure: 'hidden', hiddenAt: 390, message: 'No visible element matches button "Add contact" at 390 px.' });
    expect(result.content[0]!.text).toContain('- step 3, click button "Add contact": No visible element matches button "Add contact" at 390 px. (hidden at 390 px)');
    expect(result.content[0]!.text).toContain('- steps 4 to 11 did not run.');
  });

  it('gives a model that reads no images each width\'s DOM outline', async () => {
    await designReady();
    const render = fakeRender();
    const result = await journey(deps({ render, imageBudget: 0 }));
    expect(render.calls[0]![5]).toBe(true);
    expect((result.details as PreviewJourneyDetails).outline).toBe(true);
    expect(result.content[0]!.text).toContain('The page at 390 px where the run ended:\nbody\n  button "Add contact"');
  });

  it('refuses with the render refusal while no client renders designs', async () => {
    await designReady();
    const absent: DesignPreviewHost = { ...fakeRender(), journey: () => Promise.reject(new Error(DESIGN_RENDER_CLIENT_ABSENT)) };
    await expect(journey(deps({ render: absent }))).rejects.toThrow(DESIGN_RENDER_CLIENT_ABSENT);
  });

  it('keeps no more of the client\'s answer than one run per width with no more results than steps', async () => {
    await designReady();
    const render = fakeRender(() => ({ passed: true, steps: [...passing(), { ok: true }] }));
    await expect(journey(deps({ render }))).rejects.toThrow('The app answered the journey with a malformed run');
  });
});

describe('the journey gate (PD-21, PD-52)', () => {
  it('refuses an interactive design whose screen with controls has no journey, naming the screen (acceptance)', async () => {
    await designReady();
    const d = deps();
    const summary = await check(d);
    expect(summary.errors).toEqual([expect.objectContaining({ rule: 'journey.required', severity: 'error', screen: 'S1', element: 'screens/S1-contacts.html' })]);
    const result = await finish(d);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('- error journey.required in S1 at screens/S1-contacts.html: S1 has controls but no journey. Run PreviewJourney on screens/S1-contacts.html; it runs at the journey widths (390 and 1280 px).');
    expect(await readLatestVersion(designStateDirOf(DESIGN))).toBeUndefined();
  });

  it('keeps the manifest journey a PreviewJourney records after DesignCheck read the journey files (D65)', async () => {
    await designReady();
    const d = deps();
    await check(d);
    renderInputsHook.once = async () => {
      await journey(d);
    };
    await check(d);
    const manifest = await readManifest(FOLDER, DESIGN);
    expect(manifest.screens.map((screen) => screen.journey)).toEqual([
      { file: 'screens/S1-contacts.journey.json', spec: 'screens/S1-contacts.journey.spec.ts', widths: [390, 1280], passed: true, untested: contacts.untested },
      { waiver: true },
    ]);
  });

  it('waives a screen with no interactive control, and finishes once the other screen\'s journey passed (acceptance)', async () => {
    await designReady();
    const d = deps();
    await journey(d);
    const result = await finish(d);
    expect(result.isError).toBeUndefined();
    const journeys = [
      { screen: 'S1', file: 'screens/S1-contacts.journey.json', spec: 'screens/S1-contacts.journey.spec.ts', widths: [390, 1280], passed: true, untested: contacts.untested },
      { screen: 'S2', waiver: true },
    ];
    expect((result.details as FinishDesignDetails).journeys).toEqual(journeys);
    const record = await readLatestVersion(designStateDirOf(DESIGN));
    expect(record?.journeys).toEqual(journeys);
    const manifest = await readManifest(FOLDER, DESIGN);
    expect(manifest.screens.map((screen) => screen.journey)).toEqual([
      { file: 'screens/S1-contacts.journey.json', spec: 'screens/S1-contacts.journey.spec.ts', widths: [390, 1280], passed: true, untested: contacts.untested },
      { waiver: true },
    ]);
    const message = designResultMessage({ record: record!, changes: [] }, FOLDER);
    expect(message.details.journeys).toEqual(journeys);
    expect(message.content).toContain('- S1: screens/S1-contacts.journey.spec.ts (from screens/S1-contacts.journey.json), passed at 390 and 1280 px; untested: Saving a contact; Deleting a contact; Search with no results.');
    expect(message.content).toContain('- S2: no journey; DesignCheck found no interactive control on it.');
  });

  it('counts a widget role, a native control, a tabindex, a <details>, an inline handler or any script as a control, so no waiver hides one', async () => {
    await designReady();
    for (const control of [
      '<div role="switch" aria-label="Sync">x</div>', '<div tabindex="0">Card</div>', '<p onclick="go()">Tap</p>', '<details><summary>More</summary></details>', '<div contenteditable>Notes</div>',
      '<div role="textbox" aria-label="Notes">x</div>', '<div role="treegrid">Rows</div>', '<details><p>More</p></details>',
      '<script src="../assets/help.js"></script>', '<script>document.body.addEventListener(\'click\', () => undefined);</script>',
    ]) {
      fs.writeFileSync(path.join(FOLDER, 'screens', 'S2-help.html'), HELP_SCREEN.replace('<p>Contacts sync every hour.</p>', control));
      const summary = await check(deps());
      expect(summary.errors.filter((issue) => issue.rule === 'journey.required').map((issue) => issue.screen), control).toEqual(['S1', 'S2']);
    }
  });

  it('fails the gate after an edit of the screen until the journey runs again (acceptance)', async () => {
    await designReady();
    const d = deps();
    await journey(d);
    expect((await check(d)).errors).toEqual([]);
    const screen = path.join(FOLDER, 'screens', 'S1-contacts.html');
    fs.writeFileSync(screen, fs.readFileSync(screen, 'utf8').replace('<h1>Contacts</h1>', '<h1>People</h1>'));
    const stale = await check(d);
    expect(stale.errors).toEqual([expect.objectContaining({ rule: 'journey.required', screen: 'S1', message: 'S1 or a file it loads (tokens.css, shared/, assets/) changed after its journey ran, so the journey no longer vouches for it. Run PreviewJourney on screens/S1-contacts.html again.' })]);
    expect((await finish(d)).isError).toBe(true);
    await journey(d);
    expect((await finish(d)).isError).toBeUndefined();
  });

  it('fails a run whose Escape step fails, and FinishDesign with it (acceptance)', async () => {
    await designReady();
    const escapeFails = (): { passed: boolean; steps: JourneyStepResult[] } => ({ passed: false, steps: [...passing().slice(0, 9), { ok: false, failure: 'expectation', message: 'dialog "New contact" is still visible at 1280 px.' }] });
    const d = deps({ render: fakeRender(escapeFails) });
    const run = await journey(d);
    expect((run.details as PreviewJourneyDetails).passed).toBe(false);
    expect(run.content[0]!.text).toContain('- step 10, assert dialog "New contact" is hidden: dialog "New contact" is still visible at 1280 px.');
    const result = await finish(d);
    expect(result.isError).toBe(true);
    expect((result.details as DesignCheckSummary).errors).toEqual([expect.objectContaining({ rule: 'journey.required', screen: 'S1', message: 'The journey of S1 failed. Fix the screen or the journey and run PreviewJourney on screens/S1-contacts.html again.' })]);
  });

  it('needs no journey for a static design, and REDUCED gates on DesignCheck only', async () => {
    await designReady();
    fs.writeFileSync(path.join(FOLDER, 'screens', 'S2-help.html'), HELP_SCREEN);
    expect((await check(deps({ fidelity: 'Static mockup' }))).errors).toEqual([]);
    const reduced = await finish(deps({ ruleSet: 'reduced' }));
    expect(reduced.isError).toBeUndefined();
    expect((reduced.details as FinishDesignDetails).journeys).toEqual([]);
  });
});

describe('render inputs a journey and a width record vouch for (D86, D90)', () => {
  const REFRESH_SCREEN = HELP_SCREEN.replace('data-ds-screen="S2"', 'data-ds-screen="S3"').replace('<p>Contacts sync every hour.</p>', '<button type="button">Refresh</button>');

  async function sharedShell(): Promise<void> {
    await designReady();
    fs.mkdirSync(path.join(FOLDER, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(FOLDER, 'shared', 'app.js'), 'document.body.dataset.ready = "1";');
    const screen = path.join(FOLDER, 'screens', 'S1-contacts.html');
    fs.writeFileSync(screen, fs.readFileSync(screen, 'utf8').replace('</body>', '<script src="../shared/app.js"></script></body>'));
    fs.writeFileSync(path.join(FOLDER, 'screens', 'S3-refresh.html'), REFRESH_SCREEN);
  }

  it('makes only the journeys of the screens that link an edited shared/app.js stale', async () => {
    await sharedShell();
    const d = deps();
    await journey(d);
    await journey(d, STEPS, 'screens/S3-refresh.html');
    expect((await check(d)).errors).toEqual([]);
    fs.appendFileSync(path.join(FOLDER, 'shared', 'app.js'), ' document.body.dataset.ready = "2";');
    const stale = await check(d);
    expect(stale.errors.map((issue) => [issue.rule, issue.screen])).toEqual([['journey.required', 'S1']]);
    expect(stale.errors[0]!.message).toContain('changed after its journey ran');
  });

  it('reads a journey file without a renderHash as stale, so the screen runs PreviewJourney once', async () => {
    await sharedShell();
    const d = deps();
    await journey(d);
    const file = path.join(FOLDER, 'screens', 'S1-contacts.journey.json');
    const { renderHash: _dropped, ...older } = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify(older));
    expect((await check(d)).errors).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'journey.required', screen: 'S1', message: expect.stringContaining('changed after its journey ran') })]));
  });

  it('probes again only the screens that link an edited shared/app.js', async () => {
    await sharedShell();
    const probed: string[] = [];
    const render: DesignPreviewHost = { ...fakeRender(), probe: async (designId, relPath, widths, state, sweepTo, signal) => {
      probed.push(relPath);
      return fakeRender().probe(designId, relPath, widths, state, sweepTo, signal);
    } };
    const screens = ['screens/S1-contacts.html', 'screens/S2-help.html', 'screens/S3-refresh.html'].map((file) => ({ id: path.posix.basename(file, '.html'), file, contentHash: 'h' }));
    const widthCheck = () => runWidthChecks({ designId: DESIGN, folder: FOLDER, screens, render, reuse: true, signal: new AbortController().signal });
    await widthCheck();
    expect(probed.splice(0).sort()).toEqual(screens.map((screen) => screen.file));
    await widthCheck();
    expect(probed).toEqual([]);
    fs.appendFileSync(path.join(FOLDER, 'shared', 'app.js'), ' // edited');
    await widthCheck();
    expect(probed).toEqual(['screens/S1-contacts.html']);
  });
});
