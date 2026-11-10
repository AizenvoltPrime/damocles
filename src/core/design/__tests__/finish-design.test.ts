import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanJudge, decisionEntry, flaggingJudge, judgeOf, memoryLedger, noModelJudge, record } from './decision-kit';
import type { DecisionConflictJudge } from '../decision-conflicts';
import { decisionsOnBranch } from '../design-entries';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import { createVsCodeFileConfinement } from '../../../vscode/platform/file-confinement';
import { DESIGN_DECISIONS_DETAIL_KEY, type DesignCheckSummary, type FinishDesignDetails } from '../../../shared/types/design';
import type { DesignDecisionRecord, DesignRole } from '../design-entries';
import { designFolderOf, designStateDirOf } from '../design-paths';
import { readManifest } from '../design-files';
import { readLatestVersion, updateDesignLink } from '../design-state';
import { updateInventory } from '../inventory';
import type { DesignChatToolDeps } from '../tools/design-chat-tools';
import { createFinishDesignTool } from '../tools/finish-design';
import { designRuleSetById } from '../rule-set';
import { clearDesigns } from './design-harness';
import { PermissionHandler } from '../../permission-handler';
import type { DesignApprovalAnswer } from '../../permission-handler/types';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { designTurnEnds } from '../../pi-session/finish-turn';

const DESIGN = 'contacts-abcd1234';
const FOLDER = designFolderOf(DESIGN);
const FIXTURES = path.join(__dirname, 'fixtures');
const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;
type Tool = { execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: { text: string }[]; details: unknown; isError?: boolean }> };
type Deps = DesignChatToolDeps & { offerResult: ReturnType<typeof vi.fn>; requestApproval: ReturnType<typeof vi.fn> };

const role: DesignRole = { designId: DESIGN, folder: FOLDER, parentSessionId: 'parent-1', ruleSet: 'reduced', title: 'Contacts' };
const decision = (id: string, title: string, chosen: string): DesignDecisionRecord => ({ v: 1, id, title, chosen, rejected: [], source: { kind: 'question', ref: 'Which?' }, files: [] });
const BRANCH = [{ id: 'r1', type: 'message', message: { role: 'toolResult', toolName: 'AskUserQuestion', toolCallId: 'q1', content: [], details: { [DESIGN_DECISIONS_DETAIL_KEY]: [decision('D1', 'Fidelity', 'Static mockup'), decision('D2', 'Density', 'Compact')] } } }];

function deps(overrides: Partial<DesignChatToolDeps> = {}): Deps {
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
    requestApproval: vi.fn(async (): Promise<DesignApprovalAnswer | undefined> => ({ choice: 'approve' })),
    render: () => undefined,
    imageBudget: () => 12,
    ...overrides,
  } as Deps;
}
const finish = (d: DesignChatToolDeps, id = 'call-1', signal?: AbortSignal) => (createFinishDesignTool(pi, d) as unknown as Tool).execute(id, { summary: 'The contacts list.' }, signal);
const answering = (answer: DesignApprovalAnswer | undefined) => ({ requestApproval: vi.fn(async () => answer) });
const versionFiles = (): string[] => (fs.existsSync(path.join(designStateDirOf(DESIGN), 'versions')) ? fs.readdirSync(path.join(designStateDirOf(DESIGN), 'versions')) : []);

/** FinishDesign with its approval raised on a real PermissionHandler, as a session wires it. */
function onHandler(overrides: Partial<DesignChatToolDeps> = {}) {
  const handler = new PermissionHandler(createFakePlatform());
  const posted: ExtensionToWebviewMessage[] = [];
  handler.setPostMessage((m) => posted.push(m));
  const d = deps({ requestApproval: (ask, signal) => handler.requestDesignApproval(ask, signal), ...overrides });
  const raised = async (): Promise<Extract<ExtensionToWebviewMessage, { type: 'requestDesignApproval' }>> => {
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'requestDesignApproval')).toBe(true), { timeout: 10_000 });
    return posted.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'requestDesignApproval' }> => m.type === 'requestDesignApproval')!;
  };
  return { handler, posted, d, raised };
}

async function designReady(screen = 'pass.html'): Promise<void> {
  fs.mkdirSync(path.join(FOLDER, 'screens'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'design.md'), path.join(FOLDER, 'design.md'));
  fs.copyFileSync(path.join(FIXTURES, screen), path.join(FOLDER, 'screens', 'S1-contacts.html'));
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

describe('FinishDesign', () => {
  it('refuses while DesignCheck reports an error, with the check as its details', async () => {
    await designReady('fail-tokens.color.html');
    const result = await finish(deps());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^FinishDesign refused: DesignCheck reports 1 error/);
    expect((result.details as DesignCheckSummary).errors.map((e) => e.rule)).toEqual(['tokens.color']);
    expect(await readLatestVersion(designStateDirOf(DESIGN))).toBeUndefined();
  });

  it('stamps v1, writes its outbox record and the manifest, and hands it to the parent', async () => {
    await designReady();
    const d = deps();
    const result = await finish(d);
    expect(result.isError).toBeUndefined();
    expect(result.details as FinishDesignDetails).toEqual({ designId: DESIGN, version: 1, reused: false, delivery: 'live', check: { errors: 0, warnings: [] }, journeys: [] });
    const record = await readLatestVersion(designStateDirOf(DESIGN));
    expect(record).toMatchObject({ version: 1, sessionId: 'design-1', toolCallId: 'call-1', screens: ['S1'], decisions: [{ id: 'D1', title: 'Fidelity', chosen: 'Static mockup' }, { id: 'D2', title: 'Density', chosen: 'Compact' }] });
    expect(d.offerResult).toHaveBeenCalledWith(record, role, true);
    expect(await readManifest(FOLDER, DESIGN)).toMatchObject({ status: 'finished', version: 1, screens: [{ id: 'S1', file: 'screens/S1-contacts.html', check: { errors: 0, warnings: [] } }] });
  });

  it('asks the user before the version, with the summary, the decisions and each screen by its folder-relative file', async () => {
    await designReady();
    const d = deps();
    await finish(d);
    expect(d.requestApproval).toHaveBeenCalledTimes(1);
    expect(d.requestApproval.mock.calls[0]![0]).toEqual({
      designId: DESIGN,
      summary: 'The contacts list.',
      previousVersion: null,
      changes: [],
      warnings: [],
      decisions: [{ id: 'D1', title: 'Fidelity', chosen: 'Static mockup' }, { id: 'D2', title: 'Density', chosen: 'Compact' }],
      screens: [{ id: 'S1', file: 'screens/S1-contacts.html' }],
      hasParent: true,
    });
    expect(d.requestApproval.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
  });

  it('returns the same version when nothing changed without asking, and asks for v2 with what changed when a screen did', async () => {
    await designReady();
    await finish(deps());
    const reused = deps();
    expect((await finish(reused, 'call-2')).details).toMatchObject({ version: 1, reused: true });
    expect(reused.requestApproval).not.toHaveBeenCalled();
    expect(reused.offerResult.mock.calls[0]![2]).toBe(false);
    fs.appendFileSync(path.join(FOLDER, 'screens', 'S1-contacts.html'), '\n');
    const changed = deps();
    expect((await finish(changed, 'call-3')).details).toMatchObject({ version: 2, reused: false });
    expect(changed.requestApproval.mock.calls[0]![0]).toMatchObject({ previousVersion: 1, changes: [{ kind: 'screenChanged', screen: 'S1' }] });
    expect((await readLatestVersion(designStateDirOf(DESIGN)))?.changedSinceLast).toEqual(['S1 changed']);
  });

  it('says a design with no main chat gets no send in its ask', async () => {
    await designReady();
    const d = deps({ hasParent: async () => false, offerResult: vi.fn(async () => 'no-parent' as const) });
    await finish(d);
    expect(d.requestApproval.mock.calls[0]![0]).toMatchObject({ hasParent: false });
  });

  it('records the version and says no parent will receive it when the parent is gone', async () => {
    await designReady();
    const result = await finish(deps({ offerResult: vi.fn(async () => 'no-parent' as const) }));
    expect(result.content[0]?.text).toMatch(/No parent chat will receive it/);
    expect((await readLatestVersion(designStateDirOf(DESIGN)))?.version).toBe(1);
  });

  it('in a design fork, which has no parent, records the version and says no parent will receive it (PD-43, PD-36)', async () => {
    await designReady();
    const forkRole: DesignRole = { ...role, parentSessionId: null };
    const d = deps({ role: () => forkRole, offerResult: vi.fn(async () => 'no-parent' as const) });
    const result = await finish(d);
    expect(result.content[0]?.text).toMatch(/No parent chat will receive it: this design was forked from another design chat and has no main chat\./);
    expect(result.details).toMatchObject({ version: 1, delivery: 'no-parent' });
    expect((await readLatestVersion(designStateDirOf(DESIGN)))?.version).toBe(1);
  });

  it('refuses in a superseded design chat, outside a design chat and with design mode off', async () => {
    await designReady();
    await expect(finish(deps({ readStanding: async () => ({ kind: 'superseded', by: 'newer-chat' }) }))).rejects.toThrow(/continues in another design chat/);
    // Under the version lock: link.json names another chat, or this chat's own takeover began after the first check.
    await expect(finish(deps({ standing: () => ({ kind: 'handing-over' }) }))).rejects.toThrow(/continues in another design chat/);
    await updateDesignLink(designStateDirOf(DESIGN), () => ({ schemaVersion: 1, designId: DESIGN, folder: FOLDER, title: 'Contacts', parentSessionId: 'parent-1', designSessionId: 'newer-chat', superseded: ['design-1'] }));
    await expect(finish(deps())).rejects.toThrow(/continues in another design chat/);
    expect(await readLatestVersion(designStateDirOf(DESIGN))).toBeUndefined();
    await expect(finish(deps({ role: () => undefined }))).rejects.toThrow(/runs only in a design chat/);
    await expect(finish(deps({ enabled: () => false }))).rejects.toThrow(/Design mode is off/);
  });
});

describe('FinishDesign asks the user to approve a new version', () => {
  const manifestBefore = async () => readManifest(FOLDER, DESIGN);

  it('does not ask while DesignCheck reports an error', async () => {
    await designReady('fail-tokens.color.html');
    const d = deps();
    expect((await finish(d)).isError).toBe(true);
    expect(d.requestApproval).not.toHaveBeenCalled();
  });

  it('on a request for changes makes no version, writes nothing for one, quotes the note, and the turn goes on', async () => {
    await designReady();
    const before = await manifestBefore();
    const d = deps(answering({ choice: 'changes', feedback: 'Make the header sticky.' }));
    const result = await finish(d);
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ designId: DESIGN, approval: 'changesRequested', feedback: 'Make the header sticky.' });
    expect(result.content[0]?.text).toContain('Make the header sticky.');
    expect(result.content[0]?.text).toMatch(/Keep working on it now, then call FinishDesign again/);
    expect(versionFiles()).toEqual([]);
    expect(await readManifest(FOLDER, DESIGN)).toMatchObject({ status: before.status, version: before.version });
    expect(d.offerResult).not.toHaveBeenCalled();
    expect(designTurnEnds(turnWith(result))).toBe(false);
  });

  it('on Stop makes no version and ends the turn', async () => {
    await designReady();
    const d = deps(answering({ choice: 'stop' }));
    const result = await finish(d);
    expect([result.isError, result.details]).toEqual([true, { designId: DESIGN, approval: 'stopped' }]);
    expect(versionFiles()).toEqual([]);
    expect(d.offerResult).not.toHaveBeenCalled();
    expect(designTurnEnds(turnWith(result))).toBe(true);
  });

  it('on approval makes and delivers the version, and the turn ends', async () => {
    await designReady();
    const d = deps();
    const result = await finish(d);
    expect(versionFiles()).toEqual(['v1.json']);
    expect(d.offerResult).toHaveBeenCalledTimes(1);
    expect(designTurnEnds(turnWith(result))).toBe(true);
  });

  it('when the run is stopped while it asks, makes no version and closes the prompt on every view', async () => {
    await designReady();
    const { handler, posted, d, raised } = onHandler();
    const run = new AbortController();
    const result = finish(d, 'call-1', run.signal);
    const { promptId } = await raised();
    expect(handler.pendingPrompts().map((p) => p.kind)).toEqual(['designApproval']);
    run.abort();
    expect((await result).details).toEqual({ designId: DESIGN, approval: 'cancelled' });
    expect(posted.at(-1)).toEqual({ type: 'designApprovalClosed', promptId });
    expect(handler.pendingPrompts()).toEqual([]);
    expect(versionFiles()).toEqual([]);
    expect(d.offerResult).not.toHaveBeenCalled();
  });

  it('when the chat closes while it asks, makes no version and closes the prompt', async () => {
    await designReady();
    const { handler, posted, d, raised } = onHandler();
    const result = finish(d, 'call-1', new AbortController().signal);
    const { promptId } = await raised();
    await handler.dispose();
    expect((await result).details).toEqual({ designId: DESIGN, approval: 'cancelled' });
    expect(posted.at(-1)).toEqual({ type: 'designApprovalClosed', promptId });
    expect(versionFiles()).toEqual([]);
  });

  it('asks with YOLO on, and a mode or YOLO change while it asks answers nothing', async () => {
    await designReady();
    const { handler, d, raised } = onHandler();
    handler.setDangerouslySkipPermissions(true);
    const result = finish(d, 'call-1', new AbortController().signal);
    const { promptId } = await raised();
    handler.setPermissionMode('acceptEdits');
    handler.setDangerouslySkipPermissions(false);
    handler.setDangerouslySkipPermissions(true);
    expect(handler.pendingPrompts().map((p) => p.kind)).toEqual(['designApproval']);
    expect(versionFiles()).toEqual([]);
    handler.resolveDesignApproval(promptId, 'approve', undefined);
    expect((await result).details).toMatchObject({ version: 1, reused: false });
  });

  it('refuses an approval, making no version, after a takeover or an edit while it asked', async () => {
    await designReady();
    let standing: 'current' | 'handing-over' = 'current';
    const takenOver = deps({
      standing: () => ({ kind: standing }) as ReturnType<DesignChatToolDeps['standing']>,
      requestApproval: vi.fn(async () => { standing = 'handing-over'; return { choice: 'approve' as const }; }),
    });
    await expect(finish(takenOver)).rejects.toThrow(/continues in another design chat/);
    const edited = deps({
      requestApproval: vi.fn(async () => { fs.appendFileSync(path.join(FOLDER, 'screens', 'S1-contacts.html'), '\n'); return { choice: 'approve' as const }; }),
    });
    await expect(finish(edited)).rejects.toThrow(/changed while it waited for approval/);
    expect(versionFiles()).toEqual([]);
    expect(takenOver.offerResult).not.toHaveBeenCalled();
    expect(edited.offerResult).not.toHaveBeenCalled();
  });
});

/** The turn FinishDesign's result completes, as the design chat's turn decider reads it. */
function turnWith(result: { content: { text: string }[]; details: unknown; isError?: boolean }) {
  return {
    message: { content: [{ type: 'toolCall', id: 'call-1', name: 'FinishDesign', arguments: {} }] },
    toolResults: [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'FinishDesign', content: result.content, details: result.details, isError: result.isError === true, timestamp: 0 }],
  } as unknown as Parameters<typeof designTurnEnds>[0];
}

describe('design tools that read the folder or number decisions run alone in their batch (F3)', () => {
  it('marks FinishDesign, DesignCheck, RecordDecision, MapReference, ExtractTokens, ImportAsset, DesignScreenshot, RemoveDesignFile and OpenPreview sequential', async () => {
    const { createDesignChatTools } = await import('../tools/design-chat-tools');
    const { createMapReferenceTool } = await import('../tools/map-reference');
    const { createDeclareTweaksTool } = await import('../tools/declare-tweaks');
    const { createDesignScreenshotTool } = await import('../tools/design-screenshot');
    const { createDesignFileTools } = await import('../tools/design-file-tools');
    const tools = [createFinishDesignTool(pi, deps()), ...createDesignChatTools(pi, deps(), designRuleSetById('reduced')), createMapReferenceTool(pi, deps()), createDeclareTweaksTool(pi, deps()), createDesignScreenshotTool(pi, deps()), ...createDesignFileTools(pi, deps(), designRuleSetById('full'))] as unknown as { name: string; executionMode?: string }[];
    expect(tools.filter((t) => t.executionMode === 'sequential').map((t) => t.name).sort()).toEqual(['DesignCheck', 'DesignScreenshot', 'ExtractTokens', 'FinishDesign', 'ImportAsset', 'MapReference', 'OpenPreview', 'RecordDecision', 'RemoveDesignFile']);
  });
});

describe('FinishDesign and the decisions recorded unchecked (D99)', () => {
  const unchecked = (id: string, title: string, chosen: string) => decisionEntry(record(id, title, chosen, { kind: 'chat', source: { kind: 'chat', ref: chosen }, conflictCheck: 'unchecked', uncheckedReason: 'noModel' }));
  const withLedger = (entries: Record<string, unknown>[], judge: DecisionConflictJudge, overrides: Partial<DesignChatToolDeps> = {}) => {
    const ledger = memoryLedger(FOLDER, entries);
    return { ledger, d: deps({ branch: () => entries, decisions: () => ledger, conflictJudge: () => judge, ...overrides }) };
  };

  it('checks them again with the model back: a contradiction refuses, naming the call that resolves it (acceptance)', async () => {
    await designReady();
    const { d } = withLedger([decisionEntry(record('D1', 'Fidelity', 'Static mockup')), decisionEntry(record('D2', 'Density', 'Compact')), decisionEntry(record('D8', 'Page shell', 'White cards')), unchecked('D23', 'Surfaces', 'No white')], flaggingJudge([{ id: 'D8', kind: 'contradicts', reason: 'white vs no white' }]));
    const result = await finish(d);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^FinishDesign refused: the conflict check found current decisions that conflict\.\n- D23 Surfaces conflicts with D8 Page shell \(contradicts: white vs no white\)\. Record it again with RecordDecision, replaces: \["D23", "D8"\]/);
    expect(d.requestApproval).not.toHaveBeenCalled();
    expect(await readLatestVersion(designStateDirOf(DESIGN))).toBeUndefined();
  });

  it('checks them again with the model back: a clean result clears the warning before the user is asked (acceptance)', async () => {
    await designReady();
    const entries = [decisionEntry(record('D1', 'Fidelity', 'Static mockup')), unchecked('D2', 'Density', 'Compact')];
    const { d } = withLedger(entries, cleanJudge());
    const result = await finish(d);
    expect(result.isError).toBeUndefined();
    expect(decisionsOnBranch(entries).find((decision) => decision.id === 'D2')).toMatchObject({ conflictCheck: 'checked' });
    expect(d.requestApproval.mock.calls[0]![0]).not.toHaveProperty('unchecked');
    const version = await readLatestVersion(designStateDirOf(DESIGN));
    expect(version!.check.warnings.map((issue) => issue.rule)).not.toContain('decisions.unchecked');
    expect(version).not.toHaveProperty('uncheckedDecisions');
  });

  it('with the model still missing, names the unchecked decisions in the prompt and records them in the version (acceptance)', async () => {
    await designReady();
    const entries = [decisionEntry(record('D1', 'Fidelity', 'Static mockup')), decisionEntry(record('D2', 'Density', 'Compact')), unchecked('D23', 'Accent', 'taupe'), unchecked('D24', 'Surfaces', 'warm')];
    const { d: base } = withLedger(entries, noModelJudge());
    const { d, raised, handler } = onHandler({ branch: base.branch, decisions: base.decisions, conflictJudge: base.conflictJudge });
    const finished = finish(d);
    const prompt = await raised();
    expect(prompt.uncheckedDecisions).toEqual([{ ids: ['D23', 'D24'], cause: 'noModel' }]);
    handler.resolveDesignApproval(prompt.promptId, 'approve', undefined);
    expect((await finished).isError).toBeUndefined();
    const version = await readLatestVersion(designStateDirOf(DESIGN));
    expect(version).toMatchObject({ uncheckedDecisions: ['D23', 'D24'], decisions: [{ id: 'D1' }, { id: 'D2' }, { id: 'D23' }, { id: 'D24' }] });
    expect(version!.check.warnings.filter((issue) => issue.rule === 'decisions.unchecked').map((issue) => issue.element)).toEqual(['D23', 'D24']);
  });

  it('carries each unchecked decision\'s own cause to the prompt, grouped by cause (G1-N9)', async () => {
    await designReady();
    const entries = [decisionEntry(record('D1', 'Fidelity', 'Static mockup')), decisionEntry(record('D2', 'Density', 'Compact')), unchecked('D23', 'Accent', 'taupe'), unchecked('D24', 'Surfaces', 'warm'), unchecked('D25', 'Rows', 'Striped')];
    const judge = judgeOf((request) => (request.userMessage.split('\n')[1]!.includes('"title":"Surfaces"') ? { kind: 'rejected' as const } : { kind: 'unreachable' as const }));
    const { d: base } = withLedger(entries, judge);
    const { d, raised, handler } = onHandler({ branch: base.branch, decisions: base.decisions, conflictJudge: base.conflictJudge });
    const finished = finish(d);
    const prompt = await raised();
    expect(prompt.uncheckedDecisions).toEqual([{ ids: ['D23', 'D25'], cause: 'unreachable' }, { ids: ['D24'], cause: 'rejected' }]);
    handler.resolveDesignApproval(prompt.promptId, 'approve', undefined);
    expect((await finished).isError).toBeUndefined();
  });

  it('records only the current decisions in the version, with what each replaced', async () => {
    await designReady();
    const entries = [decisionEntry(record('D1', 'Fidelity', 'Static mockup')), decisionEntry(record('D2', 'Density', 'Compact')), decisionEntry(record('D18', 'Accent colour', 'graphite')), decisionEntry(record('D19', 'Accent', 'taupe', { replaces: ['D18'] }))];
    const { d } = withLedger(entries, cleanJudge());
    await finish(d);
    expect((await readLatestVersion(designStateDirOf(DESIGN)))!.decisions).toEqual([{ id: 'D1', title: 'Fidelity', chosen: 'Static mockup' }, { id: 'D2', title: 'Density', chosen: 'Compact' }, { id: 'D19', title: 'Accent', chosen: 'taupe', replaces: ['D18'] }]);
  });
});
