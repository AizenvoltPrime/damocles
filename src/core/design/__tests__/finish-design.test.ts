import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    pendingDecisions: () => [],
    sessionId: () => 'design-1',
    readStanding: async () => ({ kind: 'current' as const }),
    standing: () => ({ kind: 'current' as const }),
    decisionsChanged: async () => undefined,
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
  it('marks FinishDesign, DesignCheck, RecordDecision, MapReference, ExtractTokens, ImportAsset and DesignScreenshot sequential', async () => {
    const { createDesignChatTools } = await import('../tools/design-chat-tools');
    const { createMapReferenceTool } = await import('../tools/map-reference');
    const { createDeclareTweaksTool } = await import('../tools/declare-tweaks');
    const { createDesignScreenshotTool } = await import('../tools/design-screenshot');
    const tools = [createFinishDesignTool(pi, deps()), ...createDesignChatTools(pi, deps(), designRuleSetById('reduced')), createMapReferenceTool(pi, deps()), createDeclareTweaksTool(pi, deps()), createDesignScreenshotTool(pi, deps())] as unknown as { name: string; executionMode?: string }[];
    expect(tools.filter((t) => t.executionMode === 'sequential').map((t) => t.name).sort()).toEqual(['DesignCheck', 'DesignScreenshot', 'ExtractTokens', 'FinishDesign', 'ImportAsset', 'MapReference', 'RecordDecision']);
  });
});
