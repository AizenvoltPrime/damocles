import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { DAMOCLES_WORKTREE_ENTRY } from '../../pi-session/session-store/constants';
import { piSessionDir } from '../../pi-session/session-store/session-dir';
import { acquireSessionLease, releaseSessionLease, type SessionLeaseHolder } from '../../pi-session/session-store/session-lease';
import { folderKey } from '../../workspace-folders/folder-key';
import { validRecord, worktreeFolderFor } from '../../worktrees/records';
import { REGISTRY_FILE, WorktreeRegistry } from '../../worktrees/registry';
import { ProjectRelocations } from '../index';
import { parseJournal } from '../store';
import type { RelocationRecord } from '../types';

// A project P with one chat worktree W, which a host also has open as a project, with W's `docs` folder open as another
// (docs/invariants.md "Project relocation", "Worktree chats" Ownership): P's relocation re-points W's record and leaves W where
// it is, so W's rows, its session dirs and the chats in them keep their paths.

const ID = 'aaaa1111';
const MAIN = 'a1000000-0000-4000-8000-0000000000a1';
const CLEAR = 'a2000000-0000-4000-8000-0000000000a2';
const OWN = 'a3000000-0000-4000-8000-0000000000a3';
const DOCS_CHAT = 'a4000000-0000-4000-8000-0000000000a4';

let tmp: string;
let ROOT: string;
let P: string;
let P_NEW: string;
let W: string;
let DOCS: string;
const opened: Array<{ dispose(): void }> = [];

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-relocation-')));
  ROOT = path.join(tmp, 'worktrees');
  P = path.join(tmp, 'repos', 'acme');
  P_NEW = path.join(tmp, 'moved', 'acme');
  W = worktreeFolderFor(ROOT, P, ID);
  DOCS = path.join(W, 'docs');
});

afterEach(() => {
  for (const item of opened.splice(0)) item.dispose();
  for (const dir of sessionDirs()) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sessionDirs = (): string[] => [P, P_NEW, W, DOCS].map((folder) => piSessionDir(folder));

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const fileName = (id: string): string => `2026-03-0${[MAIN, CLEAR, OWN, DOCS_CHAT].indexOf(id) + 1}T10-00-00-000Z_${id}.jsonl`;

function conversation(id: string, cwd: string, project?: string): string {
  const entries: unknown[] = [
    { type: 'session', version: 3, id, timestamp: '2026-03-01T10:00:00.000Z', cwd },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-03-01T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: `prompt of ${id}` }], timestamp: 1 } },
    ...(project !== undefined ? [{ type: 'custom', id: 'w1', parentId: 'u1', timestamp: '2026-03-01T10:00:02.000Z', customType: DAMOCLES_WORKTREE_ENTRY, data: { worktreeId: ID, projectPath: project, place: 'worktree' } }] : []),
  ];
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

// P's folder is gone (moved outside Damocles to P_NEW); W is where its record puts it, holding P's chat after a /clear and W's
// own chat; W's docs folder holds a chat of its own.
function seed(): void {
  for (const dir of sessionDirs()) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(tmp, 'moved'), { recursive: true, force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
  write(path.join(P_NEW, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(P_NEW, 'a.ts'), 'export const a = 1;\n');
  write(path.join(W, '.git'), `gitdir: ${path.join(P, '.git', 'worktrees', ID)}\n`);
  write(path.join(W, 'a.ts'), 'export const a = 1;\n');
  write(path.join(DOCS, 'readme.md'), '# docs\n');
  const record = { id: ID, kind: 'chat', projectPath: P, repositoryRoot: P, worktreeRoot: W, workingFolder: W, branch: 'damocles/a', index: 1, baseCommit: 'b'.repeat(40), createdAt: 1, usedAt: 2 };
  write(path.join(ROOT, REGISTRY_FILE), `${JSON.stringify({ version: 1, records: [record] }, null, 2)}\n`);
  write(path.join(piSessionDir(P), fileName(MAIN)), conversation(MAIN, P));
  write(path.join(piSessionDir(W), fileName(CLEAR)), conversation(CLEAR, W, P));
  write(path.join(piSessionDir(W), fileName(OWN)), conversation(OWN, W));
  write(path.join(piSessionDir(DOCS), fileName(DOCS_CHAT)), conversation(DOCS_CHAT, DOCS));
}

interface Harness {
  readonly relocations: ProjectRelocations;
  readonly registry: WorktreeRegistry;
  readonly memory: string[];
  readonly mcp: string[];
}

interface Faults {
  memory?: boolean;
  mcp?: boolean;
}

function harness(faults: Faults = {}): Harness {
  const log = (): void => undefined;
  const registry = new WorktreeRegistry({ rootDir: ROOT, watcherFactory: createFakePlatform().fileWatchers, log });
  const memory: string[] = [];
  const mcp: string[] = [];
  const injected = (): Error => Object.assign(new Error('injected failure'), { code: 'EIO' });
  const relocations = new ProjectRelocations({
    requestedBy: 'desktop',
    watcherFactory: createFakePlatform().fileWatchers,
    metaIndex: { move: async () => undefined, meta: async () => null },
    memory: {
      relocateWorkspace: async (from, to) => {
        if (faults.memory) throw injected();
        memory.push(`${from} -> ${to}`);
        return {};
      },
    },
    hostState: {
      mcp: {
        relocateFolders: async (pairs) => {
          if (faults.mcp) throw injected();
          mcp.push(...pairs.map((pair) => `${pair.from} -> ${pair.to}`));
        },
      },
    },
    worktrees: registry,
    trust: { isTrusted: () => false, onDidChangeTrust: () => ({ dispose: () => undefined }) },
    projectFolders: () => [P, W, DOCS],
    log,
    file: path.join(tmp, 'project-relocations.json'),
    identitiesFile: path.join(tmp, 'folder-identities.json'),
    lockDir: path.join(tmp, 'locks'),
  });
  opened.push(relocations, registry);
  return { relocations, registry, memory, mcp };
}

const close = (h: Harness): void => {
  for (const item of [h.relocations, h.registry]) {
    item.dispose();
    opened.splice(opened.indexOf(item), 1);
  }
};

const journal = (): RelocationRecord[] => parseJournal(fs.readFileSync(path.join(tmp, 'project-relocations.json'), 'utf8'), () => undefined).records;

/** Every file under the worktrees root and the session dirs, by its path; a folder maps to null. */
function snapshot(): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const dir of [ROOT, ...sessionDirs()]) {
    if (!fs.existsSync(dir)) continue;
    out.set(dir, null);
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      const full = path.join(entry.parentPath, entry.name);
      out.set(full, entry.isDirectory() ? null : fs.readFileSync(full, 'utf8'));
    }
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

async function relocate(h: Harness): Promise<string> {
  const started = await h.relocations.relocate({ from: P, to: P_NEW, listed: [P, W, DOCS] });
  if ('refusal' in started) throw new Error(`refused: ${started.refusal.code}`);
  await h.relocations.whenIdle();
  return started.id;
}

const at = (folder: string, id: string): boolean => fs.existsSync(path.join(piSessionDir(folder), fileName(id)));

describe('relocating a project whose chat worktree is open as a project', () => {
  it('re-points the worktree\'s record and leaves the worktree, its open folders and their chats where they are, while the worktree\'s own chat stays open', async () => {
    seed();
    const before = snapshot();
    const h = harness();
    // the worktree's own chat is open in its own project; it is no chat of P's, so it holds nothing up
    const writer: SessionLeaseHolder = { onSessionLeaseLost: () => undefined };
    expect(acquireSessionLease(OWN, writer, { writer: true })).toBe(true);
    try {
      expect(await h.relocations.preflight({ from: P, to: P_NEW, listed: [P, W, DOCS] })).toMatchObject({ ok: true, chats: 2, worktrees: 1 });
      const id = await relocate(h);

      const [record] = journal();
      expect(record!.folders).toEqual([
        { kind: 'project', from: P, to: P_NEW, checkpointRepo: expect.any(String) as string },
        { kind: 'worktree', worktreeId: ID, from: W, to: W },
      ]);
      expect(record!.state).toBe('coreDone');
      expect(at(P_NEW, MAIN) && !at(P, MAIN)).toBe(true);
      for (const chat of [CLEAR, OWN]) expect(at(W, chat), chat).toBe(true);
      expect(at(DOCS, DOCS_CHAT)).toBe(true);
      const moved = new Set([path.join(piSessionDir(P), fileName(MAIN)), piSessionDir(P), path.join(ROOT, REGISTRY_FILE)]);
      const rest = (shot: Map<string, string | null>): Array<[string, string | null]> => [...shot].filter(([key]) => !moved.has(key) && !key.startsWith(piSessionDir(P_NEW)));
      expect(rest(snapshot())).toEqual(rest(before));

      const found = h.registry.get(ID)!;
      expect(found).toMatchObject({ projectPath: P_NEW, repositoryRoot: P_NEW, worktreeRoot: W, workingFolder: W, namedFor: P });
      expect(validRecord(found, ROOT)).toEqual(found);
      expect(h.memory).toEqual([`${P} -> ${P_NEW}`]);
      expect(h.mcp).toEqual([`${P} -> ${P_NEW}`]);

      expect(h.relocations.views()).toMatchObject([{ id, from: P, to: P_NEW, worktrees: [{ worktreeId: ID, from: W, to: W }] }]);
      expect(h.relocations.relocationsFrom([folderKey(P)]).map((each) => each.id)).toEqual([id]);
      expect(h.relocations.relocationsFrom([folderKey(W), folderKey(DOCS)])).toEqual([]);
    } finally {
      releaseSessionLease(OWN, writer);
    }
  });

  it('a relocation stopped at any step resumes at the next core start and ends where an uninterrupted one ends', async () => {
    seed();
    await relocate(harness());
    const reference = snapshot();
    const stops: Array<{ readonly name: string; readonly faults?: Faults; readonly sessions?: number; readonly registry?: boolean }> = [
      { name: 'after the session', sessions: 1 },
      { name: 'worktrees step', registry: true },
      { name: 'memory step', faults: { memory: true } },
      { name: 'hostState step', faults: { mcp: true } },
    ];
    for (const stop of stops) {
      fs.rmSync(path.join(tmp, 'project-relocations.json'), { force: true });
      seed();
      const first = harness(stop.faults);
      if (stop.sessions !== undefined) first.relocations.setPauseAfter({ sessions: stop.sessions, mode: 'pause' });
      if (stop.registry) first.registry.relocateProject = async () => Promise.reject(Object.assign(new Error('injected failure'), { code: 'EIO' }));
      await relocate(first);
      expect(journal()[0]!.state, stop.name).toBe('paused');
      close(first);

      const next = harness();
      await next.relocations.resumeAtStart();
      await next.relocations.whenIdle();
      expect(journal()[0]!.state, stop.name).toBe('coreDone');
      expect.soft(snapshot(), stop.name).toEqual(reference);
      close(next);
    }
  }, 60_000);

  it('refuses to relocate the worktree or a folder inside it from every core entry point, writing nothing', async () => {
    seed();
    const h = harness();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.renameSync(W, path.join(elsewhere, ID));
    for (const from of [W, DOCS]) {
      const refusal = { code: 'chatWorktree', params: { projectPath: P } };
      expect(await h.relocations.preflight({ from, to: elsewhere, listed: [from] }), from).toEqual({ ok: false, refusal });
      expect(await h.relocations.preflight({ from, to: elsewhere, listed: [from], heldHere: 'ignore' }), from).toEqual({ ok: false, refusal });
      expect(await h.relocations.relocate({ from, to: elsewhere, listed: [from, elsewhere] }), from).toEqual({ refusal });
    }
    expect(fs.existsSync(path.join(tmp, 'project-relocations.json'))).toBe(false);
    for (const chat of [CLEAR, OWN]) expect(at(W, chat), chat).toBe(true);
  });
});
