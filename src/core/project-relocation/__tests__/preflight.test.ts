import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { takeAgentFile } from '../../pi-session/agent-file-owner';
import { piSessionDir } from '../../pi-session/session-store/session-dir';
import { SESSION_LEASE_DIR, sessionLeasePath } from '../../pi-session/session-store/session-lease';
import { worktreeFolderFor } from '../../worktrees/records';
import type { ChatWorktreeRecord } from '../../worktrees/registry';
import type { PathPresence } from '../../workspace-folders/folder-presence-probe';
import { ProjectRelocations } from '../index';
import { chatWorktreeOwner, planWorktrees, runPreflight, type PreflightDeps } from '../preflight';
import { RELOCATION_STEPS, type PreflightRequest, type RelocationRecord } from '../types';

const root = path.resolve('/preflight');
const p = (...parts: string[]): string => path.join(root, ...parts);
const home = p('home', '.damocles');
const from = p('old', 'acme');
const to = p('new', 'acme');
const worktreesRoot = p('home', '.damocles', 'worktrees');
const commonDir = p('new', '.git');
const volume = p('old');

// A chat worktree of `from`, whose repository is from's parent, so the project is the repository's `acme` subfolder.
function chat(id: string, branch: string, extra: Partial<ChatWorktreeRecord> = {}): ChatWorktreeRecord {
  const worktreeRoot = worktreeFolderFor(worktreesRoot, from, id);
  return { id, kind: 'chat', repositoryRoot: p('old'), worktreeRoot, workingFolder: path.join(worktreeRoot, 'acme'), projectPath: from, branch, index: 1, baseCommit: 'a'.repeat(40), createdAt: 1, ...extra };
}

function deps(overrides: Partial<PreflightDeps> & { present?: Record<string, PathPresence> } = {}): PreflightDeps {
  const present: Record<string, PathPresence> = { [to]: 'directory', ...overrides.present };
  return {
    records: () => [],
    foreignPending: () => [],
    chatsOf: async () => ['s1', 's2'],
    titleOf: async (sessionId) => `title of ${sessionId}`,
    holderOf: async () => undefined,
    presence: async (target) => present[target] ?? 'missing',
    volumeOf: async () => volume,
    worktrees: () => ({ records: [], unreadable: false, known: true }),
    chatWorktreeOf: () => undefined,
    repositoryDirs: async (root) => (root === p('new') ? { gitDir: commonDir, commonDir, linked: false } : undefined),
    relinkable: async () => true,
    damoclesHome: home,
    ...overrides,
  };
}

const request = (extra: Partial<PreflightRequest> = {}): PreflightRequest => ({ from, to, listed: [from], ...extra });

function pending(folders: { from: string; to: string }): RelocationRecord {
  const steps = Object.fromEntries(RELOCATION_STEPS.map((name) => [name, { state: 'pending' }])) as RelocationRecord['steps'];
  return { id: 'r1', seq: 1, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', ...folders }], chats: 0, state: 'running', steps, startedAt: 1 };
}

describe('runPreflight', () => {
  it('answers locate with the chat count when every check passes', async () => {
    expect(await runPreflight(request(), deps())).toEqual({ ok: true, mode: 'locate', chats: 2, worktrees: 0, notices: [] });
  });

  it('refuses an old folder that still exists', async () => {
    expect(await runPreflight(request(), deps({ present: { [from]: 'directory' } }))).toEqual({ ok: false, refusal: { code: 'fromExists' } });
  });

  it('passes with an unreachable notice naming the volume when the old folder or its volume does not answer', async () => {
    const unreachable = await runPreflight(request(), deps({ present: { [from]: 'unreachable' } }));
    expect(unreachable).toMatchObject({ ok: true, notices: [{ code: 'unreachable', params: { root: volume } }] });
    const onSystemRoot = await runPreflight(request(), deps({ present: { [from]: 'unreachable' }, volumeOf: async () => undefined }));
    expect(onSystemRoot).toMatchObject({ ok: true, notices: [{ code: 'unreachable', params: { root: path.parse(from).root } }] });
  });

  it('refuses the same folder, a folder inside ~/.damocles, a missing target and a file', async () => {
    expect(await runPreflight(request({ to: from }), deps())).toEqual({ ok: false, refusal: { code: 'sameFolder' } });
    const inside = path.join(home, 'x');
    expect(await runPreflight(request({ to: inside }), deps({ present: { [inside]: 'directory' } }))).toEqual({ ok: false, refusal: { code: 'insideDamocles' } });
    expect(await runPreflight(request(), deps({ present: { [to]: 'missing' } }))).toEqual({ ok: false, refusal: { code: 'toMissing' } });
    expect(await runPreflight(request(), deps({ present: { [to]: 'other' } }))).toEqual({ ok: false, refusal: { code: 'toNotDirectory' } });
  });

  it('allows a target that holds ~/.damocles, such as the home folder', async () => {
    const holder = path.dirname(home);
    expect(await runPreflight(request({ to: holder }), deps({ present: { [holder]: 'directory' } }))).toMatchObject({ ok: true });
  });

  it('refuses while a relocation that is not coreDone names either folder', async () => {
    const answer = await runPreflight(request(), deps({ records: () => [pending({ from: p('other'), to })] }));
    expect(answer).toEqual({ ok: false, refusal: { code: 'pendingRelocation', params: { path: to } } });
  });

  it('names a chat another process holds, and one this process holds unless the host closes those itself', async () => {
    const other = await runPreflight(request(), deps({ holderOf: async (id) => (id === 's2' ? { holder: 'otherProcess', by: 'chat' } : undefined) }));
    expect(other).toEqual({ ok: false, refusal: { code: 'chatHeld', params: { sessionId: 's2', title: 'title of s2', holder: 'otherProcess' } } });
    const here = deps({ holderOf: async () => ({ holder: 'thisProcess', by: 'chat' }) });
    expect(await runPreflight(request(), here)).toMatchObject({ ok: false, refusal: { code: 'chatHeld', params: { holder: 'thisProcess' } } });
    expect(await runPreflight(request({ heldHere: 'ignore' }), here)).toMatchObject({ ok: true });
  });

  it('names the chat whose subagent or team run holds its agent data with agentRunHeld, which a closed chat does not end', async () => {
    const other = await runPreflight(request(), deps({ holderOf: async (id) => (id === 's2' ? { holder: 'otherProcess', by: 'agentRun' } : undefined) }));
    expect(other).toEqual({ ok: false, refusal: { code: 'agentRunHeld', params: { sessionId: 's2', title: 'title of s2', holder: 'otherProcess' } } });
    const here = deps({ holderOf: async () => ({ holder: 'thisProcess', by: 'agentRun' }) });
    expect(await runPreflight(request(), here)).toMatchObject({ ok: false, refusal: { code: 'agentRunHeld', params: { holder: 'thisProcess' } } });
    // the host closing its own chats ends no agent run
    expect(await runPreflight(request({ heldHere: 'ignore' }), here)).toMatchObject({ ok: false, refusal: { code: 'agentRunHeld', params: { holder: 'thisProcess' } } });
  });

  it('refuses an unreadable registry whose records are not known, as a host without a registry of its own reads it', async () => {
    expect(await runPreflight(request(), deps({ worktrees: () => ({ records: [], unreadable: true, known: false }) }))).toEqual({ ok: false, refusal: { code: 'registryUnreadable' } });
  });

  it('passes a project whose chat worktrees can follow it, and refuses an unreadable registry when it has records', async () => {
    const records = [chat('aaaa1111', 'b1'), chat('bbbb2222', 'b2', { deletedAt: 5 })];
    expect(await runPreflight(request(), deps({ worktrees: () => ({ records, unreadable: false, known: true }) }))).toEqual({ ok: true, mode: 'locate', chats: 2, worktrees: 2, notices: [] });
    expect(await runPreflight(request(), deps({ worktrees: () => ({ records: [chat('aaaa1111', 'b1')], unreadable: true, known: true }) }))).toEqual({ ok: false, refusal: { code: 'registryUnreadable' } });
    expect(await runPreflight(request(), deps({ worktrees: () => ({ records: [], unreadable: true, known: true }) }))).toMatchObject({ ok: true });
  });

  it('refuses a new folder that does not lie in its repository as the project did', async () => {
    const renamed = p('new', 'renamed');
    const answer = await runPreflight(request({ to: renamed }), deps({ present: { [renamed]: 'directory' }, worktrees: () => ({ records: [chat('aaaa1111', 'b1')], unreadable: false, known: true }) }));
    // the project was its repository's acme subfolder, so a new folder of another name has no repository root to strip to
    expect(answer).toEqual({ ok: false, refusal: { code: 'repositoryLayout', params: { path: p('old') } } });
    const repositoryIsProject = chat('aaaa1111', 'b1', { repositoryRoot: from, workingFolder: worktreeFolderFor(worktreesRoot, from, 'aaaa1111') });
    const disagreeing = await runPreflight(request(), deps({ worktrees: () => ({ records: [repositoryIsProject, chat('bbbb2222', 'b2')], unreadable: false, known: true }) }));
    expect(disagreeing).toEqual({ ok: false, refusal: { code: 'repositoryLayout', params: { path: p('old') } } });
  });

  it('refuses a new repository root holding no repository, unless every chat worktree was deleted', async () => {
    const none: Partial<PreflightDeps> = { repositoryDirs: async () => undefined };
    expect(await runPreflight(request(), deps({ ...none, worktrees: () => ({ records: [chat('aaaa1111', 'b1')], unreadable: false, known: true }) }))).toEqual({ ok: false, refusal: { code: 'noRepository', params: { path: p('new') } } });
    expect(await runPreflight(request(), deps({ ...none, worktrees: () => ({ records: [chat('aaaa1111', 'b1', { deletedAt: 2 })], unreadable: false, known: true }) }))).toMatchObject({ ok: true, worktrees: 1 });
  });

  it('names the live chat worktrees a fresh clone cannot link, reading each by its old .git', async () => {
    const asked: string[] = [];
    const records = [chat('aaaa1111', 'b1'), chat('bbbb2222', 'b2'), chat('cccc3333', 'b3', { deletedAt: 2 })];
    const answer = await runPreflight(request(), deps({
      worktrees: () => ({ records, unreadable: false, known: true }),
      relinkable: async (common, dotGit) => {
        asked.push(dotGit);
        return common === commonDir && dotGit === path.join(records[0]!.worktreeRoot, '.git');
      },
    }));
    expect(answer).toEqual({ ok: true, mode: 'locate', chats: 2, worktrees: 3, notices: [{ code: 'worktreesNotRelinkable', params: { count: 1, branches: 'b2' } }] });
    expect(asked).toEqual([path.join(records[0]!.worktreeRoot, '.git'), path.join(records[1]!.worktreeRoot, '.git')]);
  });

  it('refuses while a finish action holds a chat worktree or a hand-off moves a chat of one', async () => {
    const records = [chat('aaaa1111', 'b1'), chat('bbbb2222', 'b2')];
    const finishing = await runPreflight(request(), deps({ worktrees: () => ({ records, unreadable: false, known: true }), worktreeActivity: (ids) => (ids.includes('bbbb2222') ? { worktreeId: 'bbbb2222', kind: 'finishing' } : undefined) }));
    expect(finishing).toEqual({ ok: false, refusal: { code: 'worktreeFinishing', params: { branch: 'b2' } } });
    const handOff = await runPreflight(request(), deps({ worktrees: () => ({ records, unreadable: false, known: true }), worktreeActivity: () => ({ worktreeId: 'aaaa1111', kind: 'handOff' }) }));
    expect(handOff).toEqual({ ok: false, refusal: { code: 'worktreeHandOff', params: { branch: 'b1' } } });
  });

  it('plans one worktree folder per chat record, live or deleted, by its working folder, which stays where it is', () => {
    const records = [chat('aaaa1111', 'b1'), chat('bbbb2222', 'b2', { deletedAt: 5 })];
    expect(planWorktrees(records, to)).toEqual({
      repository: p('new'),
      folders: records.map((record) => ({ kind: 'worktree', worktreeId: record.id, from: record.workingFolder, to: record.workingFolder })),
    });
  });

  it('refuses a project folder that lies in a chat worktree before anything else is read, naming the worktree\'s project', async () => {
    let asked = 0;
    const main = p('repos', 'main');
    const counting = async (): Promise<string[]> => {
      asked++;
      return [];
    };
    const owned = deps({ chatWorktreeOf: (folder) => (folder === from ? { projectPath: main } : undefined), chatsOf: counting, present: { [from]: 'directory' } });
    expect(await runPreflight(request(), owned)).toEqual({ ok: false, refusal: { code: 'chatWorktree', params: { projectPath: main } } });
    expect(await runPreflight(request(), deps({ chatWorktreeOf: () => ({}), chatsOf: counting }))).toEqual({ ok: false, refusal: { code: 'chatWorktree' } });
    expect(asked).toBe(0);
  });

  it('merges into a listed target, and notes a target inside another listed project', async () => {
    expect(await runPreflight(request({ listed: [from, to] }), deps())).toMatchObject({ ok: true, mode: 'merge', notices: [{ code: 'merge', params: { projectPath: to } }] });
    const outer = p('new');
    expect(await runPreflight(request({ listed: [from, outer] }), deps())).toMatchObject({ ok: true, mode: 'locate', notices: [{ code: 'insideProject', params: { projectPath: outer } }] });
  });
});

describe('chatWorktreeOwner', () => {
  const main = p('repos', 'main');
  const record = (id: string, project: string, extra: Partial<ChatWorktreeRecord> = {}): ChatWorktreeRecord => {
    const worktreeRoot = worktreeFolderFor(worktreesRoot, project, id);
    return { id, kind: 'chat', repositoryRoot: project, worktreeRoot, workingFolder: worktreeRoot, projectPath: project, branch: id, index: 1, baseCommit: 'a'.repeat(40), createdAt: 1, ...extra };
  };

  it('names the project of the chat record, live or deleted, whose worktree holds the folder', () => {
    const live = record('aaaa1111', main);
    const deleted = record('bbbb2222', main, { deletedAt: 5 });
    for (const folder of [live.worktreeRoot, path.join(live.worktreeRoot, 'src', 'deep'), deleted.workingFolder]) {
      expect(chatWorktreeOwner(folder, [live, deleted], worktreesRoot, []), folder).toEqual({ projectPath: main });
    }
  });

  it('names no project for a folder in the worktrees folder that no record names, and nothing outside it or in an adopted worktree', () => {
    const adoptedRoot = p('adopted');
    const adopted = { id: 'cccc3333', kind: 'adopted' as const, repositoryRoot: main, worktreeRoot: adoptedRoot, workingFolder: adoptedRoot, createdAt: 1 };
    expect(chatWorktreeOwner(path.join(worktreesRoot, 'gone-123456', 'dddd4444'), [], worktreesRoot, [])).toEqual({});
    expect(chatWorktreeOwner(adoptedRoot, [adopted], worktreesRoot, [])).toBeUndefined();
    expect(chatWorktreeOwner(from, [record('aaaa1111', main)], worktreesRoot, [])).toBeUndefined();
  });

  it('names a relocated worktree\'s project where it is now, its folder still where its first name put it', () => {
    const moved = p('moved', 'main');
    const kept = { ...record('aaaa1111', main), projectPath: moved, namedFor: main };
    expect(chatWorktreeOwner(kept.worktreeRoot, [kept], worktreesRoot, [])).toEqual({ projectPath: moved });
    // a pending relocation's record still names the old path, which its folder pair leads to the new one
    expect(chatWorktreeOwner(kept.worktreeRoot, [record('aaaa1111', main)], worktreesRoot, [{ from: main, to: moved }])).toEqual({ projectPath: moved });
  });
});

// The sessions step moves a chat's agent data with it, and each agent file's run holds a lease of its own (agent-file-owner.ts).
describe('preflight of a chat whose agent files are held', () => {
  const CHAT = 'c7000000-0000-4000-8000-0000000000c7';
  const AGENT = 'c8000000-0000-4000-8000-0000000000c8';
  let tmp: string;
  let P: string;
  let P_NEW: string;
  let agentFile: string;
  let relocations: ProjectRelocations;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-held-')));
    P = path.join(tmp, 'repos', 'acme');
    P_NEW = path.join(tmp, 'moved', 'acme');
    fs.mkdirSync(P_NEW, { recursive: true });
    fs.mkdirSync(piSessionDir(P), { recursive: true });
    fs.writeFileSync(path.join(piSessionDir(P), `2026-01-01T10-00-00-000Z_${CHAT}.jsonl`), `${JSON.stringify({ type: 'session', version: 3, id: CHAT, timestamp: '2026-01-01T10:00:00.000Z', cwd: P })}\n`);
    agentFile = path.join(piSessionDir(P), CHAT, 'subagents', `2026-01-01T10-05-00-000Z_${AGENT}.jsonl`);
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, `${JSON.stringify({ type: 'session', version: 3, id: AGENT, timestamp: '2026-01-01T10:05:00.000Z', cwd: P })}\n`);
    relocations = new ProjectRelocations({
      requestedBy: 'desktop',
      watcherFactory: createFakePlatform().fileWatchers,
      metaIndex: { move: async () => undefined, meta: async () => null },
      memory: { relocateWorkspace: async () => ({}) },
      hostState: { mcp: { relocateFolders: async () => undefined } },
      trust: { isTrusted: () => false, onDidGrantTrust: () => ({ dispose: () => undefined }) },
      projectFolders: () => [P_NEW],
      log: () => undefined,
      file: path.join(tmp, 'project-relocations.json'),
      identitiesFile: path.join(tmp, 'folder-identities.json'),
      lockDir: path.join(tmp, 'locks'),
    });
  });

  afterEach(() => {
    relocations.dispose();
    fs.rmSync(piSessionDir(P), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const held = (holder: 'otherProcess' | 'thisProcess'): unknown => ({ ok: false, refusal: { code: 'agentRunHeld', params: { sessionId: CHAT, title: '', holder } } });

  it('names the chat whose subagent file another process holds as held by an agent run, even when the host closes its own chats', async () => {
    const lock = sessionLeasePath(AGENT);
    fs.mkdirSync(SESSION_LEASE_DIR, { recursive: true });
    const unlock = lockfile.lockSync(lock, { lockfilePath: lock, realpath: false, stale: 20_000, update: 2_000 });
    try {
      expect(await relocations.preflight({ from: P, to: P_NEW, listed: [P_NEW], heldHere: 'ignore' })).toEqual(held('otherProcess'));
    } finally {
      unlock();
    }
    expect(await relocations.preflight({ from: P, to: P_NEW, listed: [P_NEW] })).toMatchObject({ ok: true, chats: 1 });
  });

  it('names the chat whose subagent file a run here owns as held by an agent run, and passes once the run let go', async () => {
    const owner = takeAgentFile({ kind: 'reopen', path: agentFile, agentId: AGENT })!;
    try {
      expect(await relocations.preflight({ from: P, to: P_NEW, listed: [P_NEW] })).toEqual(held('thisProcess'));
      expect(await relocations.preflight({ from: P, to: P_NEW, listed: [P_NEW], heldHere: 'ignore' })).toEqual(held('thisProcess'));
    } finally {
      owner.release();
    }
    expect(await relocations.preflight({ from: P, to: P_NEW, listed: [P_NEW] })).toMatchObject({ ok: true, chats: 1 });
  });
});
