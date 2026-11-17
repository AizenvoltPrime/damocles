import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { afterEach, describe, expect, it } from 'vitest';
import { DAMOCLES_HOME_DIR } from '../../paths';
import { takeAgentFile, type AgentFileStore } from '../../pi-session/agent-file-owner';
import { getCheckpointsBaseDir, getRepoDir } from '../../pi-session/checkpoints/resolver';
import { DAMOCLES_CHECKPOINT_ENTRY, DAMOCLES_WORKTREE_ENTRY } from '../../pi-session/session-store/constants';
import { legacySubagentTranscriptDir } from '../../pi-session/session-store/mutations';
import { piSessionDir, piSessionsRoot } from '../../pi-session/session-store/session-dir';
import { piSessionIdFromFile } from '../../pi-session/session-store/meta-index/protocol';
import { acquireSessionLease, releaseSessionLease, SESSION_LEASE_DIR, sessionLeaseBlocker, sessionLeasePath, type SessionLeaseHolder } from '../../pi-session/session-store/session-lease';
import { currentPathOf, foldAliases } from '../aliases';
import { RelocationPause, type StepOutcome } from '../steps/outcome';
import { defaultSessionsStepDeps } from '../steps/session-fs';
import { runSessionsStep, type SessionsStepDeps } from '../steps/sessions';

// The step never touches these folders, so they need not exist; C:\a-b\c and C:\a\b-c share one encoded session dir.
const FROM = path.resolve('/a-b/c');
const COLLIDER = path.resolve('/a/b-c');
const TO = path.resolve('/moved/c');
const WORKTREE = path.resolve('/wt/abcd1234');

const OLD_DIR = piSessionDir(FROM);
const NEW_DIR = piSessionDir(TO);
const SUBAGENTS_ROOT = path.join(DAMOCLES_HOME_DIR, 'pi', 'subagents');
const ROOTS = [piSessionsRoot(), SUBAGENTS_ROOT, getCheckpointsBaseDir()];

const AGENTS = 'a0000000-0000-4000-8000-00000000000a';
const FORK = 'b0000000-0000-4000-8000-00000000000b';
const LEGACY = 'c0000000-0000-4000-8000-00000000000c';
const IN_WORKTREE = 'd0000000-0000-4000-8000-00000000000d';
const TARGET = 'e0000000-0000-4000-8000-00000000000e';
const COLLIDING = 'f0000000-0000-4000-8000-00000000000f';
const COLLIDING_WORKTREE = 'f1000000-0000-4000-8000-0000000000f1';
const MOVED = [AGENTS, FORK, LEGACY, IN_WORKTREE];

const fileName = (id: string, day: number): string => `2026-01-0${day}T10-00-00-000Z_${id}.jsonl`;
const fileOf = (dir: string, id: string): string => path.join(dir, fileName(id, [...MOVED, TARGET, COLLIDING, COLLIDING_WORKTREE].indexOf(id) + 1));

const SUB = '2026-01-01T10-05-00-000Z_5ub00000-0000-4000-8000-000000000001.jsonl';
const MEMBER = '2026-01-01T10-06-00-000Z_3e3be700-0000-4000-8000-000000000001.jsonl';
const LEGACY_SUB = '2026-01-03T10-05-00-000Z_5ub00000-0000-4000-8000-000000000003.jsonl';

const json = (entries: readonly unknown[]): string => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
const header = (id: string, cwd: string, extra: Record<string, unknown> = {}): unknown => ({ type: 'session', version: 3, id, timestamp: '2026-01-01T10:00:00.000Z', cwd, ...extra });
const message = (id: string, parentId: string | null, role: 'user' | 'assistant', text: string): unknown => ({
  type: 'message', id, parentId, timestamp: '2026-01-01T10:00:01.000Z',
  message: { role, content: [{ type: 'text', text }], timestamp: 1767261601000 },
});
const custom = (id: string, parentId: string, customType: string, data: unknown): unknown => ({ type: 'custom', id, parentId, timestamp: '2026-01-01T10:00:02.000Z', customType, data });
const conversation = (id: string, cwd: string, ...more: unknown[]): string =>
  json([header(id, cwd), message('u1', null, 'user', `prompt of ${id}`), message('a1', 'u1', 'assistant', `reply of ${id}`), ...more]);

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

interface Variant {
  // a second folder whose sessions share the old encoded dir and must stay
  readonly colliding: boolean;
  // every rename from the old folder's stores to the new one's fails with EXDEV, so folders and files take the copy path
  readonly exdev: boolean;
}

// One project with three chats (subagents and a team, a fork with checkpoints, a legacy v2 repo and subagent dir) and a
// chat whose worktree entry names the project; the target's own chat; optionally a colliding folder's chats.
function seed(variant: Variant): void {
  for (const root of [...ROOTS, SESSION_LEASE_DIR]) fs.rmSync(root, { recursive: true, force: true });
  const agentsFile = fileOf(OLD_DIR, AGENTS);
  write(agentsFile, conversation(AGENTS, FROM));
  write(path.join(OLD_DIR, AGENTS, 'subagents', SUB), conversation('5ub00000-0000-4000-8000-000000000001', FROM));
  write(path.join(OLD_DIR, AGENTS, 'teams', 'team1.jsonl'), json([{ type: 'team_created', teamId: 'team1' }]));
  write(path.join(OLD_DIR, AGENTS, 'teams', 'team1', 'members', MEMBER), conversation('3e3be700-0000-4000-8000-000000000001', FROM));
  write(fileOf(OLD_DIR, FORK), json([
    header(FORK, FROM, { parentSession: agentsFile }),
    message('u1', null, 'user', 'forked prompt'),
    custom('c1', 'u1', DAMOCLES_CHECKPOINT_ENTRY, { commit: '0123456789abcdef0123456789abcdef01234567', folderId: '0123456789abcdef' }),
    message('a1', 'c1', 'assistant', 'forked reply'),
  ]));
  const legacyFile = fileOf(OLD_DIR, LEGACY);
  write(legacyFile, conversation(LEGACY, FROM));
  const legacyRepo = getRepoDir(legacyFile);
  write(path.join(legacyRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(legacyRepo, '.git', 'objects', 'ab', 'cdef0123'), 'blob');
  write(path.join(legacyRepo, 'index'), 'index bytes');
  write(path.join(legacySubagentTranscriptDir(FROM, LEGACY), LEGACY_SUB), conversation('5ub00000-0000-4000-8000-000000000003', FROM));
  write(fileOf(OLD_DIR, IN_WORKTREE), conversation(IN_WORKTREE, WORKTREE, custom('w1', 'a1', DAMOCLES_WORKTREE_ENTRY, { worktreeId: 'abcd1234', projectPath: FROM, place: 'worktree' })));
  write(fileOf(NEW_DIR, TARGET), conversation(TARGET, TO));
  if (variant.colliding) {
    const collidingFile = fileOf(OLD_DIR, COLLIDING);
    write(collidingFile, conversation(COLLIDING, COLLIDER));
    write(path.join(OLD_DIR, COLLIDING, 'subagents', SUB), conversation('5ub00000-0000-4000-8000-000000000001', COLLIDER));
    write(path.join(getRepoDir(collidingFile), '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(path.join(legacySubagentTranscriptDir(COLLIDER, COLLIDING), LEGACY_SUB), conversation('5ub00000-0000-4000-8000-000000000003', COLLIDER));
    write(fileOf(OLD_DIR, COLLIDING_WORKTREE), conversation(COLLIDING_WORKTREE, WORKTREE, custom('w1', 'a1', DAMOCLES_WORKTREE_ENTRY, { worktreeId: 'abcd1234', projectPath: COLLIDER, place: 'worktree' })));
  }
}

// The meta index as a map of session file to row; a move carries the row and is a no-op once carried.
function metaRows(variant: Variant): Map<string, string> {
  const ids = [...MOVED, ...(variant.colliding ? [COLLIDING, COLLIDING_WORKTREE] : [])];
  return new Map([...ids.map((id) => [fileOf(OLD_DIR, id), `row of ${id}`] as const), [fileOf(NEW_DIR, TARGET), `row of ${TARGET}`]]);
}

function baseDeps(variant: Variant, rows: Map<string, string>): SessionsStepDeps {
  const real = defaultSessionsStepDeps({
    move: (fromFile: string, toFile: string) => {
      const row = rows.get(fromFile);
      if (row === undefined) return;
      rows.set(toFile, row);
      rows.delete(fromFile);
    },
  });
  if (!variant.exdev) return real;
  const crossesDevices = (from: string, to: string): boolean => {
    const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + path.sep);
    const oldLegacy = path.dirname(legacySubagentTranscriptDir(FROM, LEGACY));
    const newLegacy = path.dirname(legacySubagentTranscriptDir(TO, LEGACY));
    return (within(from, OLD_DIR) && within(to, NEW_DIR)) || (within(from, oldLegacy) && within(to, newLegacy));
  };
  return {
    ...real,
    rename: (from, to) => (crossesDevices(from, to)
      ? Promise.reject(Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }))
      : real.rename(from, to)),
  };
}

// Records every call by name and first argument, and fails call `throwAt` (1-based) before it reaches the filesystem.
function counted(base: SessionsStepDeps, calls: string[], throwAt?: number): SessionsStepDeps {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(base) as [string, (...args: unknown[]) => Promise<unknown>][]) {
    wrapped[name] = (...args: unknown[]) => {
      calls.push(`${name} ${String(args[0])}`);
      if (calls.length === throwAt) return Promise.reject(Object.assign(new Error(`injected failure at call ${throwAt}`), { code: 'EIO' }));
      return fn(...args);
    };
  }
  return wrapped as unknown as SessionsStepDeps;
}

const run = (deps: SessionsStepDeps, from = FROM, to = TO, onCommitted?: (moved: number, total: number) => void, owners: readonly string[] = [from]): Promise<StepOutcome> =>
  runSessionsStep({ from, to, owners, currentPathOf: (folder) => folder, log: () => undefined, ...(onCommitted ? { onCommitted } : {}) }, deps);

/** Every file and folder under the stores the step touches, relative to the Damocles home; a folder maps to null. */
function snapshot(): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const root of ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      const full = path.join(entry.parentPath, entry.name);
      out.set(path.relative(DAMOCLES_HOME_DIR, full), entry.isDirectory() ? null : fs.readFileSync(full, 'latin1'));
    }
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

const filesOf = (shot: Map<string, string | null>): Map<string, string> =>
  new Map([...shot].filter((entry): entry is [string, string] => entry[1] !== null));

const rel = (p: string): string => path.relative(DAMOCLES_HOME_DIR, p);

// Where each moved item of `FROM` lands under `TO`, as paths relative to the Damocles home.
const MOVES: ReadonlyArray<readonly [string, string]> = [
  ...MOVED.map((id) => [rel(fileOf(OLD_DIR, id)), rel(fileOf(NEW_DIR, id))] as const),
  ...MOVED.map((id) => [rel(path.join(OLD_DIR, id)), rel(path.join(NEW_DIR, id))] as const),
  [rel(legacySubagentTranscriptDir(FROM, LEGACY)), rel(legacySubagentTranscriptDir(TO, LEGACY))],
  [rel(getRepoDir(fileOf(OLD_DIR, LEGACY))), rel(getRepoDir(fileOf(NEW_DIR, LEGACY)))],
];

function movedPath(relative: string): string | undefined {
  for (const [from, to] of MOVES) if (relative === from || relative.startsWith(from + path.sep)) return to + relative.slice(from.length);
  return undefined;
}

function expectedFiles(seeded: Map<string, string>): Map<string, string> {
  return new Map([...seeded].map(([key, bytes]) => [movedPath(key) ?? key, bytes] as const).sort(([a], [b]) => a.localeCompare(b)));
}

// After any interruption every seeded file is whole at its old or its new place.
function expectNothingLost(seeded: Map<string, string>, label: string): void {
  for (const [key, bytes] of seeded) {
    const places = [key, movedPath(key)].filter((p): p is string => p !== undefined).map((p) => path.join(DAMOCLES_HOME_DIR, p));
    expect(places.some((p) => fs.existsSync(p) && fs.readFileSync(p, 'latin1') === bytes), `${label}: ${key} lost`).toBe(true);
  }
}

const relocating = (shot: Map<string, string | null>): string[] => [...shot.keys()].filter((key) => key.endsWith('.relocating'));
const sortedRows = (rows: Map<string, string>): [string, string][] => [...rows].map(([file, row]) => [rel(file), row] as [string, string]).sort(([a], [b]) => a.localeCompare(b));

const MUTATIONS = ['mkdir', 'rename', 'copyFile', 'fsync', 'rm', 'rmdir', 'moveLegacyRepo', 'moveMetaRow'];

afterEach(() => {
  for (const root of [...ROOTS, SESSION_LEASE_DIR]) fs.rmSync(root, { recursive: true, force: true });
});

describe.each<Variant & { readonly name: string }>([
  { name: 'beside a colliding folder', colliding: true, exdev: false },
  { name: 'alone in its session dir', colliding: false, exdev: false },
  { name: 'across devices (EXDEV)', colliding: false, exdev: true },
])('sessions step, $name', (variant) => {
  it('a failure injected at every fs call, then a rerun, ends exactly where an uninterrupted run ends', async () => {
    seed(variant);
    const seeded = filesOf(snapshot());
    const rows = metaRows(variant);
    const calls: string[] = [];
    expect(await run(counted(baseDeps(variant, rows), calls))).toEqual({ kind: 'done' });
    const reference = snapshot();
    const referenceRows = sortedRows(rows);

    expect(filesOf(reference)).toEqual(expectedFiles(seeded));
    expect(relocating(reference)).toEqual([]);
    expect(referenceRows).toEqual(sortedRows(new Map([...metaRows(variant)].map(([file, row]) => [movedPath(rel(file)) !== undefined ? path.join(DAMOCLES_HOME_DIR, movedPath(rel(file))!) : file, row]))));
    expect(reference.has(rel(OLD_DIR))).toBe(variant.colliding);
    // the legacy v2 repo moves through its own helper; every other moved file is copied once
    const copied = [...seeded.keys()].filter((key) => movedPath(key) !== undefined && !key.startsWith(rel(getCheckpointsBaseDir()) + path.sep));
    expect(calls.filter((call) => call.startsWith('copyFile ')).length).toBe(variant.exdev ? copied.length : 0);
    const n = calls.length;
    expect(n).toBeGreaterThan(MOVED.length * 4);

    for (let k = 1; k <= n; k++) {
      seed(variant);
      const kRows = metaRows(variant);
      const failed = await run(counted(baseDeps(variant, kRows), [], k));
      expect(failed, `call ${k} (${calls[k - 1]})`).toMatchObject({ kind: 'paused', failure: { code: 'io' } });
      expectNothingLost(seeded, `call ${k} (${calls[k - 1]})`);
      expect(await run(counted(baseDeps(variant, kRows), [])), `rerun after call ${k}`).toEqual({ kind: 'done' });
      expect.soft(snapshot(), `end state after a failure at call ${k} (${calls[k - 1]})`).toEqual(reference);
      expect.soft(sortedRows(kRows), `meta rows after a failure at call ${k} (${calls[k - 1]})`).toEqual(referenceRows);
    }
  }, 180_000);

  it('a pause after each committed session, then a rerun, ends where an uninterrupted run ends', async () => {
    seed(variant);
    const seeded = filesOf(snapshot());
    expect(await run(baseDeps(variant, metaRows(variant)))).toEqual({ kind: 'done' });
    const reference = snapshot();
    for (let after = 1; after <= MOVED.length; after++) {
      seed(variant);
      const rows = metaRows(variant);
      const committed: string[] = [];
      const outcome = await run(baseDeps(variant, rows), FROM, TO, (moved, total) => {
        committed.push(`${moved} of ${total}`);
        if (moved === after) throw new RelocationPause({ code: 'stopped' });
      });
      expect(outcome).toEqual({ kind: 'paused', failure: { code: 'stopped' } });
      expect(committed).toEqual(Array.from({ length: after }, (_, i) => `${i + 1} of ${MOVED.length}`));
      expectNothingLost(seeded, `paused after ${after}`);
      expect(await run(baseDeps(variant, rows))).toEqual({ kind: 'done' });
      expect(snapshot()).toEqual(reference);
    }
  }, 60_000);
});

describe('sessions step ownership', () => {
  const colliding: Variant = { colliding: true, exdev: false };

  it('locating the other folder of a colliding pair moves only that folder\'s sessions, worktree-entry owners included', async () => {
    seed(colliding);
    const before = filesOf(snapshot());
    const rows = metaRows(colliding);
    expect(await run(baseDeps(colliding, rows), COLLIDER, TO)).toEqual({ kind: 'done' });
    const after = filesOf(snapshot());
    for (const id of [COLLIDING, COLLIDING_WORKTREE]) {
      expect(after.get(rel(fileOf(NEW_DIR, id)))).toBe(before.get(rel(fileOf(OLD_DIR, id))));
      expect(after.has(rel(fileOf(OLD_DIR, id)))).toBe(false);
      expect(rows.get(fileOf(NEW_DIR, id))).toBe(`row of ${id}`);
    }
    expect(after.get(rel(path.join(NEW_DIR, COLLIDING, 'subagents', SUB)))).toBe(before.get(rel(path.join(OLD_DIR, COLLIDING, 'subagents', SUB))));
    expect(after.has(rel(path.join(legacySubagentTranscriptDir(TO, COLLIDING), LEGACY_SUB)))).toBe(true);
    // FROM's sessions share the encoded dir and stay where they are, byte for byte
    for (const [key, bytes] of before) {
      if (key.includes(COLLIDING) || key.includes(COLLIDING_WORKTREE)) continue;
      expect(after.get(key), key).toBe(bytes);
    }
    for (const id of MOVED) expect(rows.get(fileOf(OLD_DIR, id))).toBe(`row of ${id}`);
  });

  it('a folder whose session dir encodes like the old one moves nothing and changes nothing', async () => {
    seed(colliding);
    const before = snapshot();
    const rows = metaRows(colliding);
    const calls: string[] = [];
    expect(await run(counted(baseDeps(colliding, rows), calls), FROM, COLLIDER)).toEqual({ kind: 'done' });
    expect(calls.filter((call) => MUTATIONS.includes(call.split(' ')[0]!))).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(sortedRows(rows)).toEqual(sortedRows(metaRows(colliding)));
  });
});

// A project P at A located to B keeps its chats' header cwd A; another project Q located from C into a re-created A does not
// take them over, so P's next move takes them along (docs/invariants.md "Project relocation", the alias rule).
describe('sessions step ownership after a reused folder', () => {
  const A = path.resolve('/reused/a');
  const B = path.resolve('/reused/b');
  const C = path.resolve('/reused/c');
  const D = path.resolve('/reused/d');
  const P_CHAT = 'a2000000-0000-4000-8000-0000000000a2';
  const P_LATER = 'b2000000-0000-4000-8000-0000000000b2';
  const aliases = foldAliases([
    { seq: 1, startedAt: Date.parse('2026-02-01T00:00:00.000Z'), folders: [{ from: A, to: B }] },
    { seq: 2, startedAt: Date.parse('2026-03-01T00:00:00.000Z'), folders: [{ from: C, to: A }] },
  ]);

  it('B→D moves a chat whose header names A from before A→B, after C→A, and one B recorded since', async () => {
    for (const root of [...ROOTS, SESSION_LEASE_DIR]) fs.rmSync(root, { recursive: true, force: true });
    const pChat = path.join(piSessionDir(B), fileName(P_CHAT, 1));
    const pLater = path.join(piSessionDir(B), `2026-02-15T10-00-00-000Z_${P_LATER}.jsonl`);
    write(pChat, conversation(P_CHAT, A));
    write(pLater, json([{ type: 'session', version: 3, id: P_LATER, timestamp: '2026-02-15T10:00:00.000Z', cwd: B }]));
    const outcome = await runSessionsStep({ from: B, to: D, owners: [B], currentPathOf: (folder: string, recordedAt?: number) => currentPathOf(aliases, folder, recordedAt), log: () => undefined }, baseDeps({ colliding: false, exdev: false }, new Map()));
    expect(outcome).toEqual({ kind: 'done' });
    expect(fs.existsSync(path.join(piSessionDir(D), path.basename(pChat)))).toBe(true);
    expect(fs.existsSync(path.join(piSessionDir(D), path.basename(pLater)))).toBe(true);
    expect(fs.existsSync(pChat)).toBe(false);
  });
});

// Ownership (docs/invariants.md "Worktree chats"): a folder W that is MAIN's chat worktree and open as a project holds MAIN's chat
// (its latest entry names MAIN) beside W's own (no entry). Preflight refuses to relocate W; were a relocation of W run anyway, it
// would move W's own chats alone, and another project's chat in a moved dir never moves.
describe('sessions step ownership in a chat worktree\'s session dir', () => {
  const alone: Variant = { colliding: false, exdev: false };
  const MAIN = path.resolve('/main/p');
  const OTHER = path.resolve('/other/q');
  const W = path.resolve('/wt/p-111111/abcd1234');
  const W_TO = path.resolve('/elsewhere/abcd1234');
  const W_DIR = piSessionDir(W);
  const W_NEW_DIR = piSessionDir(W_TO);
  const MAINS = 'a1000000-0000-4000-8000-0000000000a1';
  const OWN = 'a2000000-0000-4000-8000-0000000000a2';
  const OTHERS = 'a3000000-0000-4000-8000-0000000000a3';
  const name = (id: string): string => `2026-02-0${[MAINS, OWN, OTHERS].indexOf(id) + 1}T10-00-00-000Z_${id}.jsonl`;
  const entry = (project: string): unknown => custom('w1', 'a1', DAMOCLES_WORKTREE_ENTRY, { worktreeId: 'abcd1234', projectPath: project, place: 'worktree' });

  function seedWorktree(): void {
    for (const root of [...ROOTS, SESSION_LEASE_DIR]) fs.rmSync(root, { recursive: true, force: true });
    write(path.join(W_DIR, name(MAINS)), conversation(MAINS, W, entry(MAIN)));
    write(path.join(W_DIR, name(OWN)), conversation(OWN, W));
    write(path.join(W_DIR, OWN, 'subagents', SUB), conversation('5ub00000-0000-4000-8000-000000000001', W));
    write(path.join(W_DIR, name(OTHERS)), conversation(OTHERS, W, entry(OTHER)));
  }

  const where = (id: string): string[] => [W_DIR, W_NEW_DIR].filter((dir) => fs.existsSync(path.join(dir, name(id))));

  it('moves only the chats the moved folder owns, never one whose latest entry names another project though its header names the folder', async () => {
    seedWorktree();
    expect(await run(baseDeps(alone, new Map()), W, W_TO)).toEqual({ kind: 'done' });
    expect(where(OWN)).toEqual([W_NEW_DIR]);
    expect(fs.existsSync(path.join(W_NEW_DIR, OWN, 'subagents', SUB))).toBe(true);
    expect(where(MAINS)).toEqual([W_DIR]);
    expect(where(OTHERS)).toEqual([W_DIR]);
  });

  it('a failure injected at every fs call, then a rerun, ends where an uninterrupted run ends, the other projects\' chats untouched', async () => {
    seedWorktree();
    const kept = [MAINS, OTHERS].map((id) => fs.readFileSync(path.join(W_DIR, name(id)), 'latin1'));
    const calls: string[] = [];
    expect(await run(counted(baseDeps(alone, new Map()), calls), W, W_TO)).toEqual({ kind: 'done' });
    const reference = snapshot();
    for (let k = 1; k <= calls.length; k++) {
      seedWorktree();
      expect(await run(counted(baseDeps(alone, new Map()), [], k), W, W_TO), `call ${k} (${calls[k - 1]})`).toMatchObject({ kind: 'paused' });
      expect([MAINS, OTHERS].map((id) => fs.readFileSync(path.join(W_DIR, name(id)), 'latin1')), `call ${k}`).toEqual(kept);
      expect(await run(counted(baseDeps(alone, new Map()), []), W, W_TO), `rerun after call ${k}`).toEqual({ kind: 'done' });
      expect.soft(snapshot(), `end state after a failure at call ${k} (${calls[k - 1]})`).toEqual(reference);
    }
  }, 60_000);
});

describe('sessions step session files', () => {
  const alone: Variant = { colliding: false, exdev: false };

  it('a differing session file already at the destination pauses with conflict, keeps both and leaves the meta row', async () => {
    seed(alone);
    const source = fs.readFileSync(fileOf(OLD_DIR, FORK), 'latin1');
    write(fileOf(NEW_DIR, FORK), conversation(FORK, TO));
    const rows = metaRows(alone);
    expect(await run(baseDeps(alone, rows))).toEqual({ kind: 'paused', failure: { code: 'conflict', params: { path: fileOf(NEW_DIR, FORK) } } });
    expect(fs.readFileSync(fileOf(OLD_DIR, FORK), 'latin1')).toBe(source);
    expect(fs.readFileSync(fileOf(NEW_DIR, FORK), 'latin1')).toBe(conversation(FORK, TO));
    expect(rows.get(fileOf(OLD_DIR, FORK))).toBe(`row of ${FORK}`);
    expect(rows.has(fileOf(NEW_DIR, FORK))).toBe(false);
  });

  // '-p' and 'p' get different session dirs but one legacy subagent folder (mutations.ts strips leading dashes).
  it('a legacy subagent folder both paths share keeps its transcripts byte for byte', async () => {
    const from = path.resolve('/-p');
    const to = path.resolve('/p');
    expect(piSessionDir(from)).not.toBe(piSessionDir(to));
    expect(legacySubagentTranscriptDir(from, LEGACY)).toBe(legacySubagentTranscriptDir(to, LEGACY));
    for (const root of ROOTS) fs.rmSync(root, { recursive: true, force: true });
    const file = path.join(piSessionDir(from), fileName(LEGACY, 3));
    write(file, conversation(LEGACY, from));
    const transcript = path.join(legacySubagentTranscriptDir(from, LEGACY), LEGACY_SUB);
    write(transcript, conversation('5ub00000-0000-4000-8000-000000000003', from));
    const bytes = fs.readFileSync(transcript, 'latin1');
    expect(await run(baseDeps(alone, new Map()), from, to)).toEqual({ kind: 'done' });
    expect(fs.existsSync(path.join(piSessionDir(to), fileName(LEGACY, 3)))).toBe(true);
    expect(fs.existsSync(transcript) && fs.readFileSync(transcript, 'latin1')).toBe(bytes);
  });
});

describe('sessions step agent data', () => {
  const alone: Variant = { colliding: false, exdev: false };
  const destinationSub = path.join(NEW_DIR, AGENTS, 'subagents', SUB);
  const sourceSub = path.join(OLD_DIR, AGENTS, 'subagents', SUB);

  async function reference(): Promise<Map<string, string | null>> {
    seed(alone);
    expect(await run(baseDeps(alone, metaRows(alone)))).toEqual({ kind: 'done' });
    return snapshot();
  }

  it('a differing agent file at the destination pauses with conflict, keeps both files and the session file, and a retry once it is gone completes', async () => {
    const expected = await reference();
    seed(alone);
    write(destinationSub, 'a different transcript\n');
    const sourceBytes = fs.readFileSync(sourceSub, 'latin1');
    const rows = metaRows(alone);
    const outcome = await run(baseDeps(alone, rows));
    expect(outcome).toMatchObject({ kind: 'paused', failure: { code: 'conflict' } });
    expect(fs.readFileSync(sourceSub, 'latin1')).toBe(sourceBytes);
    expect(fs.readFileSync(destinationSub, 'latin1')).toBe('a different transcript\n');
    // agent data moves before the session file, which is the commit point
    expect(fs.existsSync(fileOf(OLD_DIR, AGENTS))).toBe(true);
    expect(fs.existsSync(fileOf(NEW_DIR, AGENTS))).toBe(false);
    expect(rows.get(fileOf(OLD_DIR, AGENTS))).toBe(`row of ${AGENTS}`);

    fs.rmSync(destinationSub);
    expect(await run(baseDeps(alone, rows))).toEqual({ kind: 'done' });
    expect(snapshot()).toEqual(expected);
  });

  it('an identical agent file already at the destination is dropped from the source, leaving one copy', async () => {
    const expected = await reference();
    seed(alone);
    write(destinationSub, fs.readFileSync(sourceSub, 'latin1'));
    expect(await run(baseDeps(alone, metaRows(alone)))).toEqual({ kind: 'done' });
    expect(snapshot()).toEqual(expected);
  });

  it('a session whose lease another writer holds pauses with locked and is left whole, and a retry once released completes', async () => {
    const expected = await reference();
    seed(alone);
    const seeded = filesOf(snapshot());
    const writer: SessionLeaseHolder = { onSessionLeaseLost: () => undefined };
    expect(acquireSessionLease(AGENTS, writer, { writer: true })).toBe(true);
    try {
      expect(await run(baseDeps(alone, metaRows(alone)))).toMatchObject({ kind: 'paused', failure: { code: 'locked' } });
      expect(fs.readFileSync(fileOf(OLD_DIR, AGENTS), 'latin1')).toBe(seeded.get(rel(fileOf(OLD_DIR, AGENTS))));
      expect(fs.existsSync(sourceSub)).toBe(true);
      expect(fs.existsSync(fileOf(NEW_DIR, AGENTS))).toBe(false);
    } finally {
      releaseSessionLease(AGENTS, writer);
    }
    expect(await run(baseDeps(alone, metaRows(alone)))).toEqual({ kind: 'done' });
    expect(snapshot()).toEqual(expected);
  });

  // An agent file has a lease of its own (agent-file-owner.ts), which a stopped run keeps after its panel let go of the chat.
  it.each([['subagent', SUB], ['team member', MEMBER]])('a %s file whose lease another process holds pauses the chat with agentRunning and moves nothing, and a retry once released completes', async (_kind, name) => {
    const expected = await reference();
    seed(alone);
    const before = snapshot();
    const lock = sessionLeasePath(piSessionIdFromFile(name));
    fs.mkdirSync(SESSION_LEASE_DIR, { recursive: true });
    const unlock = lockfile.lockSync(lock, { lockfilePath: lock, realpath: false, stale: 20_000, update: 2_000 });
    try {
      expect(await run(baseDeps(alone, metaRows(alone)))).toEqual({ kind: 'paused', failure: { code: 'agentRunning', params: { sessionId: AGENTS } } });
      expect(snapshot()).toEqual(before);
    } finally {
      unlock();
    }
    expect(await run(baseDeps(alone, metaRows(alone)))).toEqual({ kind: 'done' });
    expect(snapshot()).toEqual(expected);
  });

  it('an agent file a run of this process owns pauses the chat with agentRunning, one not written yet included, and moves once the run let go', async () => {
    const expected = await reference();
    const stores: AgentFileStore[] = [
      { kind: 'reopen', path: sourceSub, agentId: piSessionIdFromFile(SUB) },
      { kind: 'file', dir: path.join(OLD_DIR, AGENTS, 'subagents'), id: 'a9000000-0000-4000-8000-0000000000a9' },
    ];
    for (const store of stores) {
      seed(alone);
      const before = snapshot();
      const owner = takeAgentFile(store);
      expect(owner).not.toBeNull();
      try {
        expect(await run(baseDeps(alone, metaRows(alone))), store.kind).toEqual({ kind: 'paused', failure: { code: 'agentRunning', params: { sessionId: AGENTS } } });
        expect(snapshot(), store.kind).toEqual(before);
      } finally {
        owner!.release();
      }
    }
    expect(await run(baseDeps(alone, metaRows(alone)))).toEqual({ kind: 'done' });
    expect(snapshot()).toEqual(expected);
  });

  it('holds every agent file\'s lease while the tree moves, so no run opens one meanwhile, and lets go of them after', async () => {
    seed(alone);
    const agentIds = [SUB, MEMBER].map(piSessionIdFromFile);
    const seen: string[] = [];
    const real = baseDeps(alone, metaRows(alone));
    const deps: SessionsStepDeps = {
      ...real,
      rename: async (from, to) => {
        if (from === path.join(OLD_DIR, AGENTS)) for (const id of agentIds) seen.push(`${id}:${sessionLeaseBlocker(id)?.kind ?? 'free'}`);
        await real.rename(from, to);
      },
    };
    expect(await run(deps)).toEqual({ kind: 'done' });
    expect(seen).toEqual(agentIds.map((id) => `${id}:writing`));
    for (const id of agentIds) expect(sessionLeaseBlocker(id)).toBeUndefined();
    expect(fs.existsSync(path.join(NEW_DIR, AGENTS, 'teams', 'team1', 'members', MEMBER))).toBe(true);
  });
});
