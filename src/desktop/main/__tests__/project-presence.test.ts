import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHungGate } from '../../../core/folder-probe';
import { createFolderPresenceProbe, folderPresenceOf, PRESENCE_TIMEOUT_MS } from '../../../core/workspace-folders/folder-presence-probe';
import { ProjectPresences, remotePathPresence, type ProjectPresence } from '../project-presence';

afterEach(() => {
  vi.useRealTimers();
});

describe('remotePathPresence', () => {
  it('reads a host request that does not answer by the deadline as unreachable, and cancels it', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const answer = remotePathPresence((given) => {
      signal = given;
      return new Promise<boolean>(() => {});
    });
    await vi.advanceTimersByTimeAsync(PRESENCE_TIMEOUT_MS);
    expect(await answer).toBe('unreachable');
    expect(folderPresenceOf(await answer)).toBe('unavailable');
    expect(signal?.aborted).toBe(true);
  });

  it('reads the host\'s answer as a directory or a missing folder, cancelling nothing', async () => {
    const signals: AbortSignal[] = [];
    expect(await remotePathPresence(async (signal) => (signals.push(signal), true))).toBe('directory');
    expect(await remotePathPresence(async (signal) => (signals.push(signal), false))).toBe('missing');
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
  });
});

describe('ProjectPresences', () => {
  const tracker = (answers: Map<string, ProjectPresence | Promise<ProjectPresence>>) => {
    const changes: string[] = [];
    const asked: string[] = [];
    const presences = new ProjectPresences({
      presence: async ({ fsPath }) => {
        asked.push(fsPath);
        return answers.get(fsPath) ?? 'present';
      },
      changed: (key, presence, previous) => changes.push(`${key}:${previous}->${presence}`),
    });
    return { presences, changes, asked };
  };

  it('reports each change once, and the projects that came back present', async () => {
    const answers = new Map<string, ProjectPresence>([['/a', 'missing']]);
    const { presences, changes } = tracker(answers);
    expect(await presences.sync([{ key: 'a', fsPath: '/a' }, { key: 'b', fsPath: '/b' }])).toEqual([]);
    expect([presences.of('a'), presences.of('b'), presences.absent('a')]).toEqual(['missing', 'present', true]);
    expect(await presences.check([{ key: 'a', fsPath: '/a' }])).toEqual([]);
    answers.delete('/a');
    expect(await presences.check([{ key: 'a', fsPath: '/a' }])).toEqual(['a']);
    expect(changes).toEqual(['a:present->missing', 'a:missing->present']);
  });

  it('forgets a project the list no longer holds, and drops an answer a later check overtook', async () => {
    let settle!: (presence: ProjectPresence) => void;
    const slow = new Promise<ProjectPresence>((resolve) => { settle = resolve; });
    const answers = new Map<string, ProjectPresence | Promise<ProjectPresence>>([['/a', slow]]);
    const { presences, changes } = tracker(answers);
    const first = presences.check([{ key: 'a', fsPath: '/a' }]);
    answers.set('/a', 'unavailable');
    await presences.check([{ key: 'a', fsPath: '/a' }]);
    settle('present');
    await first;
    expect(presences.of('a')).toBe('unavailable');
    await presences.sync([]);
    expect(presences.of('a')).toBe('present');
    expect(changes).toEqual(['a:present->unavailable']);
  });

  it('checks at a list change only the projects new to it and those it is told to check again', async () => {
    const { presences, asked } = tracker(new Map());
    const wsl = { key: 'w', fsPath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app' };
    const drive = { key: 'd', fsPath: 'D:\\app' };
    await presences.sync([wsl, drive]);
    asked.length = 0;
    const added = { key: 'n', fsPath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\new' };
    await presences.sync([wsl, drive, added], (project) => !project.fsPath.startsWith('\\\\wsl.localhost\\'));
    expect(asked).toEqual([drive.fsPath, added.fsPath]);
  });

  it('checks an unavailable project once per late answer until another check of it runs', async () => {
    const { presences, asked } = tracker(new Map([['/nas/app', 'unavailable']]));
    const project = { key: 'a', fsPath: '/nas/app' };
    await presences.check([project]);
    await presences.answeredLate(project);
    await presences.answeredLate(project);
    expect(asked).toEqual(['/nas/app', '/nas/app']);
    await presences.check([project]);
    await presences.answeredLate(project);
    expect(asked).toHaveLength(4);
  });

  it('checks a project once more when the stat its check gave up on answers late, as a WSL distro that starts slowly does', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const distro = '\\\\wsl.localhost\\Ubuntu\\';
    const project = { key: 'w', fsPath: `${distro}home\\me\\app` };
    let release!: () => void;
    let started = false;
    const stat = vi.fn((target: string) => {
      if (target === distro && !started) {
        started = true;
        return new Promise<{ isDirectory(): boolean; dev: number }>((resolve) => { release = () => resolve({ isDirectory: () => true, dev: 1 }); });
      }
      return Promise.resolve({ isDirectory: () => true, dev: 1 });
    });
    const probe = createFolderPresenceProbe({ stat, platform: 'win32', now: () => Date.now(), gate: createHungGate(2, () => Date.now()) });
    const changes: string[] = [];
    const presences = new ProjectPresences({ presence: ({ fsPath }) => probe.presence(fsPath), changed: (key, presence, previous) => changes.push(`${key}:${previous}->${presence}`) });
    const rechecks: Promise<readonly string[]>[] = [];
    probe.onDidAnswerLate((folder) => {
      if (folder === project.fsPath) rechecks.push(presences.answeredLate(project));
    });

    const launched = presences.sync([project]);
    await vi.advanceTimersByTimeAsync(PRESENCE_TIMEOUT_MS);
    await launched;
    expect(presences.of('w')).toBe('unavailable');

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(rechecks).toHaveLength(1);
    expect(await rechecks[0]).toEqual(['w']);
    expect(changes).toEqual(['w:present->unavailable', 'w:unavailable->present']);
    // a project that is not unavailable is not checked again
    expect(await presences.answeredLate(project)).toEqual([]);
  });
});
