import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createWorkspaceHandlers, isPlanFileCandidate } from '../workspace-handlers';
import { createFakePlatform, type FakePlatform } from '../../../../../__mocks__/fake-platform';
import type { FileResult } from '../../../ripgrep';
import type { ExtensionToWebviewMessage } from '../../../../../shared/types/messages';

const H = vi.hoisted(() => ({ listed: [] as FileResult[], logged: [] as unknown[][] }));

vi.mock('../../../ripgrep', () => ({ listWorkspaceFiles: vi.fn(async () => H.listed) }));
vi.mock('../../../../logger', () => ({ log: (...args: unknown[]) => void H.logged.push(args) }));

type Candidates = Extract<ExtensionToWebviewMessage, { type: 'planFileCandidates' }>;

let root: string;
let folder: string;
let activePlan: string | null;
let platform: FakePlatform;

/** Writes a workspace file whose mtime is `minutesAgo` minutes in the past and lists it. */
function workspaceFile(relativePath: string, minutesAgo: number, content = `# ${relativePath}`): void {
  const full = path.join(folder, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  const when = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(full, when, when);
  H.listed.push({ relativePath, isDirectory: false });
}

function fakeSession(sessionId: string | null) {
  return {
    persistenceSessionId: sessionId,
    getActivePlanFilePath: async () => activePlan,
    getPlanFilePath: () => path.join(root, 'plans', 'fresh-s1.md'),
  };
}

function harness(sessionId: string | null = 's1') {
  const posted: ExtensionToWebviewMessage[] = [];
  const disposables: { dispose(): void }[] = [];
  const panelFolder = { key: folder, fsPath: folder, name: 'ws', label: 'ws', projectScope: true };
  const instance = { folder: panelFolder, session: fakeSession(sessionId), disposables };
  const panels = new Map([['p1', instance]]);
  const deps = {
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message),
    getPanels: () => panels,
    platform,
  } as unknown as Parameters<typeof createWorkspaceHandlers>[0];
  // As the router builds it: a snapshot of the panel at dispatch time.
  const ctx = () => ({ host: {}, panelId: 'p1', folder: instance.folder, session: instance.session }) as never;
  const handlers = createWorkspaceHandlers(deps);
  const lastCandidates = (): Candidates => posted.filter((m): m is Candidates => m.type === 'planFileCandidates').at(-1)!;
  const list = async (): Promise<Candidates> => {
    await handlers.requestPlanFileCandidates!({ type: 'requestPlanFileCandidates' }, ctx());
    return lastCandidates();
  };
  /** Starts a listing and runs `meanwhile` while it is still in flight. */
  const listWhile = async (meanwhile: () => void): Promise<Candidates> => {
    const listing = handlers.requestPlanFileCandidates!({ type: 'requestPlanFileCandidates' }, ctx());
    meanwhile();
    await listing;
    return lastCandidates();
  };
  /** A folder switch, which gives the panel a new session object. */
  const switchFolder = () => {
    instance.folder = { ...panelFolder, key: `${folder}-other` };
    instance.session = fakeSession(sessionId);
  };
  const bind = (candidateId?: string) =>
    handlers.bindPlanToSession!(candidateId === undefined ? { type: 'bindPlanToSession' } : { type: 'bindPlanToSession', candidateId }, ctx());
  return { list, listWhile, switchFolder, bind, posted, disposables, panels };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-plan-'));
  folder = path.join(root, 'ws');
  fs.mkdirSync(folder);
  activePlan = null;
  H.listed = [];
  H.logged = [];
  platform = createFakePlatform();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isPlanFileCandidate', () => {
  it.each([
    ['plans/rollout.md', true],
    ['docs/deep/Plans/notes.md', true],
    ['PLAN.md', true],
    ['docs/release-plan.md', true],
    ['docs/migration_plan_v2.md', true],
    ['docs/rolloutPlan.md', true],
    ['plan2.MD', true],
    ['docs/release-planning.md', false],
    ['src/MyPlanner.MD', false],
    ['docs/explanation.md', false],
    ['airplane.md', false],
    ['plans/rollout.txt', false],
    ['docs/readme.md', false],
    ['planning/readme.md', false],
    ['plan.md/readme.txt', false],
  ])('%s is %s', (relativePath, expected) => {
    expect(isPlanFileCandidate(relativePath)).toBe(expected);
  });
});

describe('requestPlanFileCandidates', () => {
  it('answers a listing that throws with an empty failed list, so the overlay stops loading and an earlier id no longer binds', async () => {
    workspaceFile('plans/a.md', 1);
    const { list, bind } = harness();
    const first = await list();
    const staleId = first.files[0]!.id;

    const { listWorkspaceFiles } = await import('../../../ripgrep');
    vi.mocked(listWorkspaceFiles).mockRejectedValueOnce(new Error('rg crashed'));
    const failed = await list();

    expect(failed).toEqual({ type: 'planFileCandidates', files: [], hasPlan: false, listFailed: true });
    await bind(staleId);
    expect(fs.existsSync(path.join(root, 'plans', 'fresh-s1.md'))).toBe(false);
  });

  it('answers a listing that outlived a folder switch with an empty list and issues nothing', async () => {
    workspaceFile('plans/a.md', 1);
    const h = harness();

    const answer = await h.listWhile(h.switchFolder);

    expect(answer).toEqual({ type: 'planFileCandidates', files: [], hasPlan: false });
    expect(h.disposables).toHaveLength(0);
  });

  it('answers a listing that outlived its panel', async () => {
    workspaceFile('plans/a.md', 1);
    const h = harness();

    const answer = await h.listWhile(() => h.panels.clear());

    expect(answer).toEqual({ type: 'planFileCandidates', files: [], hasPlan: false });
  });

  it('registers one dispose hook per panel however often a listing fails', async () => {
    workspaceFile('plans/a.md', 1);
    const h = harness();
    const { listWorkspaceFiles } = await import('../../../ripgrep');

    for (let i = 0; i < 3; i++) {
      await h.list();
      vi.mocked(listWorkspaceFiles).mockRejectedValueOnce(new Error('rg crashed'));
      await h.list();
    }
    await h.list();

    expect(h.disposables).toHaveLength(1);
  });

  it('lists plan files newest first with paths relative to the folder', async () => {
    workspaceFile('docs/plan-old.md', 30);
    workspaceFile('README.md', 1);
    workspaceFile('.damocles/plans/new.md', 2);
    workspaceFile('src/plans/mid.md', 10);
    workspaceFile('plans/data.json', 0);

    const message = await harness().list();

    expect(message.files.map((f) => f.relativePath)).toEqual(['.damocles/plans/new.md', 'src/plans/mid.md', 'docs/plan-old.md']);
    expect(message.files[0]!.modifiedAt).toBe(fs.statSync(path.join(folder, '.damocles/plans/new.md')).mtimeMs);
    expect(message.hasPlan).toBe(false);
  });

  it('caps the list at the eight newest', async () => {
    for (let i = 0; i < 11; i++) workspaceFile(`plans/p${i}.md`, i);

    const message = await harness().list();

    expect(message.files.map((f) => f.relativePath)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `plans/p${i}.md`));
  });

  it('reports a bound plan and issues a fresh id for every list', async () => {
    workspaceFile('plans/a.md', 1);
    activePlan = path.join(root, 'plans', 'bound-s1.md');
    const h = harness();

    const first = await h.list();
    const second = await h.list();

    expect(first.hasPlan).toBe(true);
    expect(second.files[0]!.id).not.toBe(first.files[0]!.id);
    expect(h.disposables).toHaveLength(1);
  });
});

describe('bindPlanToSession', () => {
  it('binds the file behind an issued id to the session plan path', async () => {
    workspaceFile('plans/a.md', 1, '# Plan A');
    const h = harness();
    const { files } = await h.list();

    await h.bind(files[0]!.id);

    expect(fs.readFileSync(path.join(root, 'plans', 'fresh-s1.md'), 'utf8')).toBe('# Plan A');
    expect(platform.dialogs.pickFileCalls).toEqual([]);
  });

  it('overwrites the bound plan in place without asking', async () => {
    workspaceFile('plans/a.md', 1, '# Plan A');
    activePlan = path.join(root, 'plans', 'bound-s1.md');
    fs.mkdirSync(path.dirname(activePlan), { recursive: true });
    fs.writeFileSync(activePlan, '# Old');
    const h = harness();
    const { files } = await h.list();

    await h.bind(files[0]!.id);

    expect(fs.readFileSync(activePlan, 'utf8')).toBe('# Plan A');
    expect(platform.notifications.calls.filter((c) => c.level === 'warn')).toEqual([]);
  });

  it('binds nothing for an id it did not issue, or one a newer list replaced, and logs it', async () => {
    workspaceFile('plans/a.md', 1);
    const h = harness();
    const stale = (await h.list()).files[0]!.id;
    await h.list();

    await h.bind('not-issued');
    await h.bind(stale);

    expect(fs.existsSync(path.join(root, 'plans'))).toBe(false);
    expect(platform.dialogs.pickFileCalls).toEqual([]);
    expect(H.logged.map((args) => args[1])).toEqual(['not-issued', stale]);
  });

  it('binds nothing for an id listed before a folder switch', async () => {
    workspaceFile('plans/a.md', 1);
    const h = harness();
    const before = (await h.list()).files[0]!.id;
    h.switchFolder();

    await h.bind(before);

    expect(fs.existsSync(path.join(root, 'plans'))).toBe(false);
    expect(H.logged.map((args) => args[1])).toEqual([before]);
  });

  it('opens the OS file dialog when no id is given and binds its answer', async () => {
    const outside = path.join(root, 'elsewhere.md');
    fs.writeFileSync(outside, '# Picked');
    platform.dialogs.answerPickFile(() => outside);

    await harness().bind();

    expect(platform.dialogs.pickFileCalls).toHaveLength(1);
    expect(platform.dialogs.pickFileCalls[0]!.defaultPath).toBe(folder);
    expect(fs.readFileSync(path.join(root, 'plans', 'fresh-s1.md'), 'utf8')).toBe('# Picked');
  });

  it('keeps the no-active-session guard', async () => {
    workspaceFile('plans/a.md', 1);
    const h = harness(null);
    const { files } = await h.list();

    await h.bind(files[0]!.id);

    expect(platform.notifications.calls).toEqual([{ level: 'info', message: 'No active session', actions: [] }]);
    expect(fs.existsSync(path.join(root, 'plans'))).toBe(false);
  });
});
