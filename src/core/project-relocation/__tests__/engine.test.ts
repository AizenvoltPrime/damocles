import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { SESSION_LEASE_STALE_MS, SESSION_LEASE_UPDATE_MS } from '../../pi-session/session-store/session-lease';
import { currentPathOf, foldAliases } from '../aliases';
import { RelocationEngine, type RelocationInput, type StepContext, type StepRunner } from '../engine';
import { RelocationPause, STEP_DONE, type StepOutcome } from '../steps/outcome';
import { parseJournal, RelocationStore } from '../store';
import { RELOCATION_STEPS, type RelocationRecord, type RelocationStepName, type RelocationStepState } from '../types';

const FROM = path.resolve('/old/p');
const TO = path.resolve('/new/p');

let dir: string;
let journalFile: string;
let lockDir: string;
const opened: Array<{ dispose(): void }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relocation-engine-'));
  journalFile = path.join(dir, 'project-relocations.json');
  lockDir = path.join(dir, 'locks', 'relocations');
});

afterEach(() => {
  vi.useRealTimers();
  for (const item of opened.splice(0)) item.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function openStore(): RelocationStore {
  const store = new RelocationStore({ file: journalFile, watcherFactory: createFakePlatform().fileWatchers, log: () => undefined });
  opened.push(store);
  return store;
}

// Each step records its name, then runs its override or finishes.
function stepTable(calls: RelocationStepName[], overrides: Partial<Record<RelocationStepName, StepRunner>> = {}): Record<RelocationStepName, StepRunner> {
  return Object.fromEntries(RELOCATION_STEPS.map((name) => [name, async (context: StepContext): Promise<StepOutcome> => {
    calls.push(name);
    return overrides[name] ? overrides[name](context) : STEP_DONE;
  }])) as Record<RelocationStepName, StepRunner>;
}

function openEngine(store: RelocationStore, steps: Record<RelocationStepName, StepRunner>): RelocationEngine {
  const engine = new RelocationEngine({ store, steps, lockDir, log: () => undefined });
  opened.push(engine);
  return engine;
}

const input = (id: string): RelocationInput => ({ id, requestedBy: 'desktop', mode: 'locate', folders: [{ kind: 'project', from: FROM, to: TO }], chats: 3 });

const onDisk = (): RelocationRecord[] => (fs.existsSync(journalFile) ? parseJournal(fs.readFileSync(journalFile, 'utf8'), () => undefined).records : []);
const lockPath = (id: string): string => path.join(lockDir, `${id}.lock`);

function steps(states: Partial<Record<RelocationStepName, RelocationStepState>>): Record<RelocationStepName, RelocationStepState> {
  return Object.fromEntries(RELOCATION_STEPS.map((name) => [name, states[name] ?? { state: 'pending' }])) as Record<RelocationStepName, RelocationStepState>;
}

// A record as an earlier core left it in the journal.
async function journaled(store: RelocationStore, id: string, state: RelocationRecord['state'], stepStates: Partial<Record<RelocationStepName, RelocationStepState>>): Promise<RelocationRecord> {
  const written = await store.add((seq) => ({ ...input(id), seq, state, steps: steps(stepStates), startedAt: 1 }));
  if ('refusal' in written) throw new Error(`refused: ${written.refusal.code}`);
  return written;
}

const allDone = steps(Object.fromEntries(RELOCATION_STEPS.map((name) => [name, { state: 'done' }])));

function written(record: RelocationRecord | { readonly refusal: unknown }): RelocationRecord {
  if ('refusal' in record) throw new Error('begin was refused');
  return record;
}

describe('RelocationEngine', () => {
  it('writes the record before any step runs, then runs every step in order to coreDone and lets go of its lock', async () => {
    const calls: RelocationStepName[] = [];
    const seenByFirstStep: RelocationRecord[][] = [];
    const engine = openEngine(openStore(), stepTable(calls, {
      checkpoints: async () => {
        seenByFirstStep.push(onDisk());
        return STEP_DONE;
      },
    }));
    const record = written(await engine.begin(input('r1')));
    await engine.whenIdle();

    expect(seenByFirstStep).toEqual([[{ ...input('r1'), seq: 1, state: 'running', steps: steps({}), startedAt: record.startedAt }]]);
    expect(calls).toEqual([...RELOCATION_STEPS]);
    expect(onDisk()).toEqual([{ ...record, state: 'coreDone', steps: allDone, finishedAt: expect.any(Number) as number }]);
    expect(fs.existsSync(lockPath('r1'))).toBe(false);
  });

  it('a journal that does not parse refuses begin, and no step runs', async () => {
    fs.writeFileSync(journalFile, '{ not json');
    const calls: RelocationStepName[] = [];
    const engine = openEngine(openStore(), stepTable(calls));
    await expect(engine.begin(input('r1'))).rejects.toThrow();
    await engine.whenIdle();
    expect(calls).toEqual([]);
    expect(fs.readFileSync(journalFile, 'utf8')).toBe('{ not json');
  });

  it('a relocation naming a folder of one that is not coreDone is refused before anything is written', async () => {
    const store = openStore();
    await journaled(store, 'r1', 'paused', { checkpoints: { state: 'done' } });
    const calls: RelocationStepName[] = [];
    const engine = openEngine(store, stepTable(calls));
    expect(await engine.begin({ ...input('r2'), folders: [{ kind: 'project', from: TO, to: path.resolve('/third/p') }] })).toEqual({ refusal: { code: 'pendingRelocation', params: { path: TO } } });
    await engine.whenIdle();
    expect(calls).toEqual([]);
    expect(onDisk().map((r) => r.id)).toEqual(['r1']);
  });

  it('while one runner holds the lock a second runner, another process\'s engine on the same journal, runs no step', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callsA: RelocationStepName[] = [];
    const a = openEngine(openStore(), stepTable(callsA, {
      sessions: async () => {
        await gate;
        return STEP_DONE;
      },
    }));
    const record = written(await a.begin(input('r1')));
    await vi.waitFor(() => expect(callsA).toContain('sessions'));

    const callsB: RelocationStepName[] = [];
    const b = openEngine(openStore(), stepTable(callsB));
    await b.run(record.id);
    await b.resumeAtStart();
    expect(callsB).toEqual([]);
    expect(b.isRunning(record.id)).toBe(false);

    release();
    await a.whenIdle();
    expect(callsA).toEqual([...RELOCATION_STEPS]);
    expect(onDisk()[0]!.state).toBe('coreDone');
  });

  it('resumes at start a running and a paused record from their first step not done, and clears the pause', async () => {
    const store = openStore();
    await journaled(store, 'running', 'running', { checkpoints: { state: 'done' } });
    await journaled(store, 'paused', 'paused', { checkpoints: { state: 'done' }, sessions: { state: 'pending', failure: { code: 'conflict', params: { path: TO } } } });
    const calls: RelocationStepName[] = [];
    const engine = openEngine(openStore(), stepTable(calls));
    await engine.resumeAtStart();
    await engine.whenIdle();

    const rest = RELOCATION_STEPS.filter((name) => name !== 'checkpoints');
    expect([...calls].sort()).toEqual([...rest, ...rest].sort());
    for (const record of onDisk()) expect(record).toMatchObject({ state: 'coreDone', steps: allDone });
  });

  it('a step\'s coded pause stops the run at that step with the lock released, and a retry finishes from it', async () => {
    let attempt = 0;
    const calls: RelocationStepName[] = [];
    const engine = openEngine(openStore(), stepTable(calls, {
      sessions: async () => (++attempt === 1 ? { kind: 'paused', failure: { code: 'conflict', params: { path: TO } } } : STEP_DONE),
    }));
    const record = written(await engine.begin(input('r1')));
    await engine.whenIdle();

    expect(calls).toEqual(['checkpoints', 'sessions']);
    expect(onDisk()[0]).toMatchObject({ state: 'paused', steps: steps({ checkpoints: { state: 'done' }, sessions: { state: 'pending', failure: { code: 'conflict', params: { path: TO } } } }) });
    expect(fs.existsSync(lockPath(record.id))).toBe(false);

    await engine.retry(record.id);
    await engine.whenIdle();
    expect(calls).toEqual(['checkpoints', 'sessions', ...RELOCATION_STEPS.filter((name) => name !== 'checkpoints')]);
    expect(onDisk()[0]).toMatchObject({ state: 'coreDone', steps: allDone });
  });

  it('a step that throws pauses the run as io and a RelocationPause thrown inside a step pauses with its own code', async () => {
    const calls: RelocationStepName[] = [];
    const engine = openEngine(openStore(), stepTable(calls, {
      checkpoints: async () => {
        if (calls.length === 1) throw Object.assign(new Error('disk gone'), { code: 'EIO', path: FROM });
        return STEP_DONE;
      },
      memory: () => Promise.reject(new RelocationPause({ code: 'stopped' })),
    }));
    const record = written(await engine.begin(input('r1')));
    await engine.whenIdle();
    expect(onDisk()[0]!.steps.checkpoints).toEqual({ state: 'pending', failure: { code: 'io', params: { path: FROM, errno: 'EIO' } } });
    expect(onDisk()[0]!.state).toBe('paused');

    await engine.retry(record.id);
    await engine.whenIdle();
    expect(onDisk()[0]!.steps.memory).toEqual({ state: 'pending', failure: { code: 'stopped' } });
    expect(calls).toEqual(['checkpoints', 'checkpoints', 'sessions', 'worktrees', 'repair', 'memory']);
  });

  it('a waiting memory step lets the run reach coreDone and is retried at the next start alone', async () => {
    const store = openStore();
    const calls: RelocationStepName[] = [];
    const engine = openEngine(store, stepTable(calls, { memory: async () => ({ kind: 'waiting', failure: { code: 'memoryReadOnly', params: { reason: 'readOnly' } } }) }));
    written(await engine.begin(input('r1')));
    await engine.whenIdle();
    expect(calls).toEqual([...RELOCATION_STEPS]);
    expect(onDisk()[0]).toMatchObject({ state: 'coreDone', steps: { memory: { state: 'waiting', failure: { code: 'memoryReadOnly', params: { reason: 'readOnly' } } } } });
    const finishedAt = onDisk()[0]!.finishedAt;

    const nextCalls: RelocationStepName[] = [];
    const next = openEngine(openStore(), stepTable(nextCalls));
    await next.resumeAtStart();
    await next.whenIdle();
    expect(nextCalls).toEqual(['memory']);
    expect(onDisk()[0]).toMatchObject({ state: 'coreDone', steps: allDone, finishedAt });
  });

  it('a waiting repair journals the worktrees it left unlinked, and a run that links them clears the list', async () => {
    const failures = [{ worktreeId: 'aaaa1111', failure: { code: 'notRelinked' } }];
    let linked = false;
    const calls: RelocationStepName[] = [];
    const engine = openEngine(openStore(), stepTable(calls, {
      repair: async () => (linked ? STEP_DONE : { kind: 'waiting', failure: { code: 'repairFailed', params: { count: 1 } }, repairFailures: failures }),
    }));
    const record = written(await engine.begin(input('r1')));
    await engine.whenIdle();
    expect(onDisk()[0]).toMatchObject({ state: 'coreDone', repairFailures: failures, steps: { repair: { state: 'waiting', failure: { code: 'repairFailed', params: { count: 1 } } } } });

    linked = true;
    await engine.retry(record.id);
    await engine.whenIdle();
    expect(onDisk()[0]).toMatchObject({ state: 'coreDone', steps: allDone });
    expect(onDisk()[0]!.repairFailures).toBeUndefined();
    expect(calls.filter((name) => name === 'repair')).toHaveLength(2);
  });

  it('a coreDone record with every step done is not resumed', async () => {
    const store = openStore();
    await store.add((seq) => ({ ...input('r1'), seq, state: 'coreDone', steps: allDone, startedAt: 1, finishedAt: 2 }));
    const before = fs.readFileSync(journalFile, 'utf8');
    const calls: RelocationStepName[] = [];
    const engine = openEngine(openStore(), stepTable(calls));
    await engine.resumeAtStart();
    await engine.whenIdle();
    expect(calls).toEqual([]);
    expect(fs.readFileSync(journalFile, 'utf8')).toBe(before);
    expect(fs.existsSync(lockPath('r1'))).toBe(false);
  });

  it('after coreDone the alias fold maps the old folder to the new one, in another process\'s store too', async () => {
    const engine = openEngine(openStore(), stepTable([]));
    written(await engine.begin(input('r1')));
    await engine.whenIdle();
    const other = openStore();
    expect(other.records()[0]!.state).toBe('coreDone');
    const aliases = foldAliases(other.aliasSources());
    expect(currentPathOf(aliases, FROM)).toBe(TO);
    expect(currentPathOf(aliases, path.resolve('/unrelated'))).toBe(path.resolve('/unrelated'));
  });

  it('the e2e pause-after stops the sessions step after N commits as stopped, once, and a retry completes', async () => {
    const commits: number[] = [];
    let attempt = 0;
    const calls: RelocationStepName[] = [];
    const engine = openEngine(openStore(), stepTable(calls, {
      sessions: async (context) => {
        attempt++;
        for (let i = 1; i <= 3; i++) {
          await context.sessionCommitted();
          commits.push(attempt * 10 + i);
        }
        return STEP_DONE;
      },
    }));
    engine.setPauseAfter({ sessions: 2, mode: 'pause' });
    const record = written(await engine.begin(input('r1')));
    await engine.whenIdle();
    expect(commits).toEqual([11]);
    expect(onDisk()[0]).toMatchObject({ state: 'paused', steps: { sessions: { state: 'pending', failure: { code: 'stopped' } } } });

    await engine.retry(record.id);
    await engine.whenIdle();
    expect(commits).toEqual([11, 21, 22, 23]);
    expect(onDisk()[0]!.state).toBe('coreDone');
  });

  it('a run reads its record from disk once it holds the lock, so a record another process paused meanwhile runs no step', async () => {
    const other = openStore();
    await journaled(other, 'r1', 'running', { checkpoints: { state: 'done' } });
    // this store's watcher reports nothing, so its cache still holds the record running
    const store = openStore();
    await other.update('r1', (r) => ({ ...r, state: 'paused', steps: { ...r.steps, sessions: { state: 'pending', failure: { code: 'conflict', params: { path: TO } } } } }));
    expect(store.get('r1')!.state).toBe('running');

    const calls: RelocationStepName[] = [];
    const engine = openEngine(store, stepTable(calls));
    await engine.run('r1');
    expect(calls).toEqual([]);
    expect(onDisk()[0]!.state).toBe('paused');
  });

  it('a retry that arrives while its relocation runs, as a trust grant does, runs the relocation once more after that run', async () => {
    let trusted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: RelocationStepName[] = [];
    const engine = openEngine(openStore(), stepTable(calls, {
      repair: async () => (trusted ? STEP_DONE : { kind: 'waiting', failure: { code: 'untrusted', params: { count: 1 } } }),
      memory: async () => {
        await gate;
        return STEP_DONE;
      },
    }));
    const record = written(await engine.begin(input('r1')));
    await vi.waitFor(() => expect(calls).toContain('memory'));
    expect(onDisk()[0]!.steps.repair.state).toBe('waiting');

    trusted = true;
    void engine.retry(record.id);
    release();
    await engine.whenIdle();
    expect(calls.filter((name) => name === 'repair')).toHaveLength(2);
    expect(onDisk()[0]).toMatchObject({ state: 'coreDone', steps: allDone });
  });

  it('abandons a paused relocation under its lock: it is finished, never resumed, and no longer refuses a relocation of its folders', async () => {
    const store = openStore();
    await journaled(store, 'r1', 'paused', { checkpoints: { state: 'done' }, sessions: { state: 'pending', failure: { code: 'conflict', params: { path: TO } } } });
    const calls: RelocationStepName[] = [];
    const engine = openEngine(store, stepTable(calls));
    expect(await engine.abandon('r1')).toBeUndefined();
    expect(onDisk()[0]).toMatchObject({ state: 'abandoned', finishedAt: expect.any(Number) as number, steps: { sessions: { state: 'pending' } } });
    expect(fs.existsSync(lockPath('r1'))).toBe(false);

    await engine.resumeAtStart();
    await engine.retry('r1');
    await engine.whenIdle();
    expect(calls).toEqual([]);
    expect(written(await engine.begin({ ...input('r2'), folders: [{ kind: 'project', from: TO, to: path.resolve('/third/p') }] })).seq).toBe(2);
  });

  it('refuses to abandon a relocation that is not paused or that a runner holds', async () => {
    const store = openStore();
    await journaled(store, 'running', 'running', { checkpoints: { state: 'done' } });
    await store.add((seq) => ({ ...input('done'), folders: [{ kind: 'project', from: path.resolve('/d/old'), to: path.resolve('/d/new') }], seq, state: 'coreDone', steps: allDone, startedAt: 1, finishedAt: 2 }));
    await store.add((seq) => ({ ...input('held'), folders: [{ kind: 'project', from: path.resolve('/h/old'), to: path.resolve('/h/new') }], seq, state: 'paused', steps: steps({}), startedAt: 1 }));
    const engine = openEngine(store, stepTable([]));
    expect(await engine.abandon('running')).toEqual({ code: 'notPaused' });
    expect(await engine.abandon('done')).toEqual({ code: 'notPaused' });
    expect(await engine.abandon('missing')).toEqual({ code: 'notPaused' });
    // another process's runner holds the lock it took for a retry
    fs.mkdirSync(lockPath('held'), { recursive: true });
    expect(await engine.abandon('held')).toEqual({ code: 'relocationRunning' });
    expect(onDisk().map((record) => record.state)).toEqual(['running', 'coreDone', 'paused']);
  });

  it('a retry from a process that has not seen the abandon yet leaves the relocation abandoned and runs no step', async () => {
    const stale = openStore();
    await journaled(stale, 'r1', 'paused', { checkpoints: { state: 'done' } });
    expect(await openEngine(openStore(), stepTable([])).abandon('r1')).toBeUndefined();
    expect(stale.get('r1')!.state).toBe('paused');

    const calls: RelocationStepName[] = [];
    const engine = openEngine(stale, stepTable(calls));
    await engine.retry('r1');
    await engine.whenIdle();
    expect(calls).toEqual([]);
    expect(onDisk()[0]!.state).toBe('abandoned');
  });

  it('a relocation another app version left running refuses a relocation naming its folders; its coreDone and abandoned ones do not', async () => {
    const foreign = (id: string, seq: number, state: string, from: string, to: string): unknown => ({ id, seq, state, futureField: true, folders: [{ kind: 'project', from, to }] });
    fs.writeFileSync(journalFile, JSON.stringify({ version: 1, hostAliases: [], relocations: [
      foreign('f1', 1, 'running', path.resolve('/f/old'), FROM),
      foreign('f2', 2, 'coreDone', path.resolve('/g/old'), path.resolve('/g/new')),
      foreign('f3', 3, 'abandoned', path.resolve('/h/old'), path.resolve('/h/new')),
      foreign('f4', 4, 'someNewState', path.resolve('/i/old'), path.resolve('/i/new')),
    ] }));
    const engine = openEngine(openStore(), stepTable([]));
    expect(await engine.begin(input('r1'))).toEqual({ refusal: { code: 'pendingRelocation', params: { path: FROM } } });
    expect(await engine.begin({ ...input('r2'), folders: [{ kind: 'project', from: path.resolve('/i/new'), to: path.resolve('/i/next') }] })).toEqual({ refusal: { code: 'pendingRelocation', params: { path: path.resolve('/i/new') } } });
    expect(written(await engine.begin({ ...input('r3'), folders: [{ kind: 'project', from: path.resolve('/g/new'), to: path.resolve('/h/new') }] })).seq).toBe(5);
  });

  // A killed core leaves its lock behind; the next core's resume tries again once the lock can have turned stale.
  it('a lock a dead runner left is taken over by the retry that resume at start schedules', async () => {
    const store = openStore();
    await journaled(store, 'r1', 'running', { checkpoints: { state: 'done' } });
    fs.mkdirSync(lockPath('r1'), { recursive: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls: RelocationStepName[] = [];
    const engine = openEngine(openStore(), stepTable(calls));
    await engine.resumeAtStart();
    expect(calls).toEqual([]);
    expect(engine.isRunning('r1')).toBe(false);

    const stale = new Date(Date.now() - 2 * SESSION_LEASE_STALE_MS);
    fs.utimesSync(lockPath('r1'), stale, stale);
    await vi.advanceTimersByTimeAsync(SESSION_LEASE_STALE_MS + 3 * SESSION_LEASE_UPDATE_MS);
    vi.useRealTimers();
    await engine.whenIdle();
    expect(calls).toEqual(RELOCATION_STEPS.filter((name) => name !== 'checkpoints'));
    expect(onDisk()[0]!.state).toBe('coreDone');
  });
});
