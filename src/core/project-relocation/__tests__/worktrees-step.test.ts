import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import { validRecord, worktreeFolderFor } from '../../worktrees/records';
import { parseRegistry, REGISTRY_FILE, WorktreeRegistry } from '../../worktrees/registry';
import type { StepOutcome } from '../steps/outcome';
import { defaultWorktreesStepDeps, runWorktreesStep, type WorktreesStepDeps } from '../steps/worktrees';
import type { RelocationFolder } from '../types';

const inert = { dispose: () => undefined };
const watchers: FileWatcherFactory = {
  watch: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  watchWorkspace: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  onDidRenameFiles: () => inert,
};

const BASE = '0123456789abcdef0123456789abcdef01234567';
const LIVE_A = 'aaaa1111';
const LIVE_B = 'bbbb2222';
const DELETED_C = 'cccc3333';
const ADOPTED = 'dddd4444';
const OTHERS = 'eeee5555';
const TARGETS = 'gggg7777';
const MOVED = [LIVE_A, LIVE_B, DELETED_C];

let tmp: string;
let ROOT: string;
// The project is the `app` subfolder of its repository, so the working folder is the same subfolder of each worktree.
let FROM_REPO: string;
let FROM: string;
let TO_REPO: string;
let TO: string;
let OTHER: string;
const registries: WorktreeRegistry[] = [];

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-step-')));
  ROOT = path.join(tmp, 'worktrees');
  FROM_REPO = path.join(tmp, 'repos', 'acme');
  FROM = path.join(FROM_REPO, 'app');
  TO_REPO = path.join(tmp, 'moved', 'acme');
  TO = path.join(TO_REPO, 'app');
  OTHER = path.join(tmp, 'repos', 'other');
});

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Variant {
  // the target is a project with a chat worktree of its own already (a merge)
  readonly present: boolean;
}

function chatRecord(id: string, project: string, repository: string, index: number, deletedAt?: number): Record<string, unknown> {
  const worktreeRoot = worktreeFolderFor(ROOT, project, id);
  return {
    id, kind: 'chat', projectPath: project, repositoryRoot: repository, worktreeRoot,
    workingFolder: path.join(worktreeRoot, path.relative(repository, project)),
    branch: `damocles/${id}`, index, baseCommit: BASE, createdAt: 1_700_000_000_000, usedAt: 1_700_000_000_001,
    ...(deletedAt !== undefined ? { deletedAt } : {}),
  };
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A worktree folder as git leaves it: the `.git` file and the project's files under the working folder.
function seedFolder(record: Record<string, unknown>): void {
  write(path.join(record['worktreeRoot'] as string, '.git'), `gitdir: ${path.join(record['repositoryRoot'] as string, '.git', 'worktrees', record['id'] as string)}\n`);
  write(path.join(record['workingFolder'] as string, 'a.ts'), `export const id = '${record['id'] as string}';\n`);
}

// Two live chat worktrees (one shared by two chats, which only their sessions tell), a deleted one whose folder is gone, an
// adopted worktree of the project, another project's chat worktree, and a record another app version wrote.
function seed(variant: Variant): void {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const a = chatRecord(LIVE_A, FROM, FROM_REPO, 1);
  const b = chatRecord(LIVE_B, FROM, FROM_REPO, 2);
  const c = chatRecord(DELETED_C, FROM, FROM_REPO, 3, 1_700_000_000_500);
  const adopted = { id: ADOPTED, kind: 'adopted', projectPath: FROM, repositoryRoot: FROM_REPO, worktreeRoot: path.join(tmp, 'adopted'), workingFolder: path.join(tmp, 'adopted', 'app'), createdAt: 1_700_000_000_000 };
  const others = chatRecord(OTHERS, OTHER, OTHER, 1);
  const foreign = { id: 'zzzz9999', kind: 'future', projectPath: FROM, worktreeRoot: path.join(tmp, 'future') };
  const records: unknown[] = [a, b, c, adopted, others, foreign];
  for (const record of [a, b, others]) seedFolder(record);
  if (variant.present) {
    const target = chatRecord(TARGETS, TO, TO_REPO, 1);
    seedFolder(target);
    records.push(target);
  }
  write(path.join(ROOT, REGISTRY_FILE), `${JSON.stringify({ version: 1, records }, null, 2)}\n`);
}

const folders = (): RelocationFolder[] => [
  { kind: 'project', from: FROM, to: TO },
  ...MOVED.map((id): RelocationFolder => {
    const workingFolder = path.join(worktreeFolderFor(ROOT, FROM, id), 'app');
    return { kind: 'worktree', worktreeId: id, from: workingFolder, to: workingFolder };
  }),
];

function registry(): WorktreeRegistry {
  const created = new WorktreeRegistry({ rootDir: ROOT, watcherFactory: watchers, log: () => undefined });
  registries.push(created);
  return created;
}

const injected = (at: number): NodeJS.ErrnoException => Object.assign(new Error(`injected failure at call ${at}`), { code: 'EIO' });

// Records every call, and makes call `inject.at` (1-based) fail before it reaches the disk or after it changed the disk.
function counted(base: WorktreesStepDeps, calls: string[], inject?: { readonly at: number; readonly when: 'before' | 'after' }): WorktreesStepDeps {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(base) as [string, (...args: unknown[]) => unknown][]) {
    wrapped[name] = (...args: unknown[]) => {
      calls.push(name);
      if (calls.length !== inject?.at) return fn(...args);
      if (inject.when === 'before') {
        if (name === 'registryUnreadable') throw injected(inject.at);
        return Promise.reject(injected(inject.at));
      }
      const result = fn(...args);
      if (result instanceof Promise) return result.then(() => Promise.reject(injected(inject.at)));
      throw injected(inject.at);
    };
  }
  return wrapped as unknown as WorktreesStepDeps;
}

const run = (deps: WorktreesStepDeps): Promise<StepOutcome> => runWorktreesStep({ folders: folders(), log: () => undefined }, deps);

/** Every file and folder under the worktrees root, registry.json included, by path relative to it; a folder maps to null. */
function snapshot(): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const entry of fs.readdirSync(ROOT, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    out.set(path.relative(ROOT, full), entry.isDirectory() ? null : fs.readFileSync(full, 'utf8'));
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

const withoutRegistry = (shot: Map<string, string | null>): Map<string, string | null> => new Map([...shot].filter(([key]) => key !== REGISTRY_FILE));
const rawRecords = (): Array<Record<string, unknown>> => (JSON.parse(fs.readFileSync(path.join(ROOT, REGISTRY_FILE), 'utf8')) as { records: Array<Record<string, unknown>> }).records;
const recordOf = (id: string): Record<string, unknown> => rawRecords().find((r) => r['id'] === id)!;

describe.each<Variant & { readonly name: string }>([
  { name: 'alone', present: false },
  { name: 'merging into a project with a chat worktree of its own', present: true },
])('worktrees step, $name', (variant) => {
  it('re-points every record of the project, each valid and named for the old path, and moves no folder', async () => {
    seed(variant);
    const seeded = snapshot();
    expect(await run(defaultWorktreesStepDeps(registry()))).toEqual({ kind: 'done' });

    expect(withoutRegistry(snapshot())).toEqual(withoutRegistry(seeded));
    for (const id of MOVED) {
      const record = recordOf(id);
      const worktreeRoot = worktreeFolderFor(ROOT, FROM, id);
      expect(record).toMatchObject({ projectPath: TO, repositoryRoot: TO_REPO, worktreeRoot, workingFolder: path.join(worktreeRoot, 'app'), namedFor: FROM });
      expect(validRecord(record, ROOT), id).toBeDefined();
    }
    expect(recordOf(DELETED_C)['deletedAt']).toBe(1_700_000_000_500);
    expect(recordOf(ADOPTED)).toMatchObject({ projectPath: TO, worktreeRoot: path.join(tmp, 'adopted'), repositoryRoot: FROM_REPO });
    expect(recordOf(OTHERS)).toEqual(chatRecord(OTHERS, OTHER, OTHER, 1));
    expect(recordOf('zzzz9999')).toEqual({ id: 'zzzz9999', kind: 'future', projectPath: FROM, worktreeRoot: path.join(tmp, 'future') });
    for (const raw of rawRecords().filter((r) => r['kind'] !== 'future')) expect(validRecord(raw, ROOT), String(raw['id'])).toBeDefined();

    // a merge renumbers only the moved live worktree whose index the target's own holds, to the smallest index no live one holds
    const live = rawRecords().filter((r) => r['kind'] === 'chat' && r['deletedAt'] === undefined && r['projectPath'] === TO);
    expect(new Set(live.map((r) => r['index'])).size).toBe(live.length);
    expect(recordOf(LIVE_A)['index']).toBe(variant.present ? 3 : 1);
    expect(recordOf(LIVE_B)['index']).toBe(2);
    if (variant.present) expect(recordOf(TARGETS)).toEqual(chatRecord(TARGETS, TO, TO_REPO, 1));

    // a rerun of a finished step changes nothing
    const finished = snapshot();
    expect(await run(defaultWorktreesStepDeps(registry()))).toEqual({ kind: 'done' });
    expect(snapshot()).toEqual(finished);
  });

  it('a failure injected before and after every call, then a rerun, ends exactly where an uninterrupted run ends', async () => {
    seed(variant);
    const calls: string[] = [];
    expect(await run(counted(defaultWorktreesStepDeps(registry()), calls))).toEqual({ kind: 'done' });
    const reference = snapshot();
    expect(calls).toEqual(['registryUnreadable', 'relocateProject']);

    for (let k = 1; k <= calls.length; k++) {
      for (const when of ['before', 'after'] as const) {
        const label = `call ${k} (${calls[k - 1]}) failing ${when} it ran`;
        seed(variant);
        expect(await run(counted(defaultWorktreesStepDeps(registry()), [], { at: k, when })), label).toMatchObject({ kind: 'paused', failure: { code: 'io' } });
        const parsed = parseRegistry(fs.readFileSync(path.join(ROOT, REGISTRY_FILE), 'utf8'), ROOT, () => undefined);
        expect(parsed.foreign.map((raw) => (raw as { id: string }).id), label).toEqual(['zzzz9999']);
        // a fresh registry, as the next core start has
        expect(await run(defaultWorktreesStepDeps(registry())), `rerun after ${label}`).toEqual({ kind: 'done' });
        expect(snapshot(), `end state after ${label}`).toEqual(reference);
      }
    }
  });
});

describe('worktrees step refusals', () => {
  it('an unreadable registry.json pauses before the write and leaves the file as it is', async () => {
    seed({ present: false });
    const reg = registry();
    write(path.join(ROOT, REGISTRY_FILE), '{ not json');
    reg.reload();
    expect(reg.unreadable()).toBeDefined();
    expect(await run(defaultWorktreesStepDeps(reg))).toEqual({ kind: 'paused', failure: { code: 'registryUnreadable' } });
    expect(fs.readFileSync(path.join(ROOT, REGISTRY_FILE), 'utf8')).toBe('{ not json');
  });
});
