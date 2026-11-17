import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHungGate } from '../../folder-probe';
import { createFolderPresenceProbe, mountPointOf, PRESENCE_TIMEOUT_MS, type FolderPresenceProbeOptions } from '../folder-presence-probe';

type Answer = { readonly dev: number; readonly directory?: boolean } | 'missing' | 'hung';

// A stat over fixed answers: 'hung' never settles until released, as a stat of a dead share or a hard NFS mount does.
function fakeStat(answers: Record<string, Answer>) {
  const releases = new Map<string, (dev: number) => void>();
  const stat = vi.fn((target: string) => {
    const answer = answers[target] ?? 'missing';
    if (answer === 'hung') return new Promise<{ isDirectory(): boolean; dev: number }>((resolve) => releases.set(target, (dev) => resolve({ isDirectory: () => true, dev })));
    if (answer === 'missing') return Promise.reject(Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' }));
    return Promise.resolve({ isDirectory: () => answer.directory ?? true, dev: answer.dev });
  });
  // the released stat answers, and so does every later one of the path
  const release = (target: string, dev = 1): void => {
    answers[target] = { dev };
    releases.get(target)!(dev);
  };
  return { stat, release };
}

function probeOf(answers: Record<string, Answer>, options: Partial<FolderPresenceProbeOptions> = {}) {
  const fake = fakeStat(answers);
  const probe = createFolderPresenceProbe({ stat: fake.stat, now: () => Date.now(), gate: createHungGate(2, () => Date.now()), ...options });
  return { probe, ...fake };
}

const stated = (stat: ReturnType<typeof fakeStat>['stat']): string[] => stat.mock.calls.map(([target]) => target);

describe('createFolderPresenceProbe', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues one stat for a folder whose stat never settles, however often it is asked', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { probe, stat } = probeOf({ '/srv/app': 'hung' }, { platform: 'linux' });
    const first = Array.from({ length: 5 }, () => probe.presence('/srv/app'));
    await vi.advanceTimersByTimeAsync(PRESENCE_TIMEOUT_MS);
    expect(await Promise.all(first)).toEqual(Array(5).fill('unavailable'));
    for (let i = 0; i < 5; i++) expect(await probe.presence('/srv/app')).toBe('unavailable');
    expect(stated(stat)).toEqual(['/srv/app']);
  });

  it('starts one root stat and no folder stat for projects on a share that does not answer', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { probe, stat } = probeOf({ '\\\\nas\\work\\': 'hung' }, { platform: 'win32' });
    const answers = ['a', 'b', 'c', 'd', 'e'].map((name) => probe.presence(`\\\\nas\\work\\${name}`));
    await vi.advanceTimersByTimeAsync(PRESENCE_TIMEOUT_MS);
    expect(await Promise.all(answers)).toEqual(Array(5).fill('unavailable'));
    expect(await probe.presence('\\\\nas\\work\\f')).toBe('unavailable');
    expect(stated(stat)).toEqual(['\\\\nas\\work\\']);
  });

  it('starts no stat of another root while two hang past the deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { probe, stat } = probeOf({ 'P:\\': 'hung', 'Q:\\': 'hung', 'R:\\': { dev: 1 }, 'R:\\app': { dev: 1 } }, { platform: 'win32' });
    const hung = [probe.presence('P:\\app'), probe.presence('Q:\\app')];
    await vi.advanceTimersByTimeAsync(PRESENCE_TIMEOUT_MS);
    await Promise.all(hung);
    expect(await probe.presence('R:\\app')).toBe('unavailable');
    expect(stated(stat)).toEqual(['P:\\', 'Q:\\']);
  });

  it('tells once, for each folder that gave up on it, that a hung stat answered after all', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const distro = '\\\\wsl.localhost\\Ubuntu\\';
    const folder = `${distro}home\\me\\app`;
    const { probe, stat, release } = probeOf({ [distro]: 'hung', [folder]: { dev: 1 } }, { platform: 'win32' });
    const told: string[] = [];
    probe.onDidAnswerLate((answered) => told.push(answered));
    const asked = [probe.presence(folder), probe.presence(folder)];
    await vi.advanceTimersByTimeAsync(PRESENCE_TIMEOUT_MS);
    expect(await Promise.all(asked)).toEqual(['unavailable', 'unavailable']);
    expect(told).toEqual([]);

    release(distro);
    await vi.advanceTimersByTimeAsync(0);
    expect(told).toEqual([folder]);
    expect(await probe.presence(folder)).toBe('present');
    expect(told).toEqual([folder]);
    expect(stated(stat)).toEqual([distro, distro, folder]);
  });

  it('reads a POSIX volume by the mount point recorded for the folder: there only while it is still a mount point', async () => {
    const recordedMount = async (folder: string): Promise<string | undefined> => (folder.startsWith('/mnt/nas/') ? '/mnt/nas' : undefined);
    // unplugged: the mount point is a plain folder of its parent's volume, and the project is not stated at all
    const unmounted = probeOf({ '/mnt': { dev: 1 }, '/mnt/nas': { dev: 1 } }, { platform: 'linux', recordedMount });
    expect(await unmounted.probe.presence('/mnt/nas/app')).toBe('unavailable');
    expect(await unmounted.probe.path('/mnt/nas/app')).toBe('unreachable');
    expect(stated(unmounted.stat)).not.toContain('/mnt/nas/app');

    const mounted = probeOf({ '/mnt': { dev: 1 }, '/mnt/nas': { dev: 2 }, '/mnt/nas/app': { dev: 2 } }, { platform: 'linux', recordedMount });
    expect(await mounted.probe.presence('/mnt/nas/app')).toBe('present');
    expect(await mounted.probe.presence('/mnt/nas/renamed')).toBe('missing');

    // nothing recorded: a conventional mount folder that is gone, else the system root, which always answers
    const conventional = probeOf({ '/home/me/app': { dev: 1 } }, { platform: 'darwin' });
    expect(await conventional.probe.presence('/Volumes/USB/app')).toBe('unavailable');
    expect(await conventional.probe.presence('/home/me/gone')).toBe('missing');
    expect(await conventional.probe.path('/home/me/app')).toBe('directory');
    expect(await conventional.probe.volumeOf('/Volumes/USB/app')).toBe('/Volumes/USB');
    expect(await unmounted.probe.volumeOf('/mnt/nas/app')).toBe('/mnt/nas');
  });

  it('names a drive, a share or a WSL distro as the volume on Windows', async () => {
    const { probe } = probeOf({}, { platform: 'win32' });
    expect(await probe.volumeOf('D:\\work\\app')).toBe('D:\\');
    expect(await probe.volumeOf('\\\\server\\share\\app')).toBe('\\\\server\\share\\');
    expect(await probe.volumeOf('\\\\wsl.localhost\\Ubuntu\\home\\me\\app')).toBe('\\\\wsl.localhost\\Ubuntu\\');
  });
});

describe('mountPointOf', () => {
  it('is the deepest folder above or at the path whose device differs from its parent\'s, else the system root', async () => {
    const { stat } = fakeStat({ '/': { dev: 1 }, '/mnt': { dev: 1 }, '/mnt/nas': { dev: 2 }, '/mnt/nas/work': { dev: 2 }, '/mnt/nas/work/app': { dev: 2 }, '/home': { dev: 1 }, '/home/app': { dev: 1 } });
    expect(await mountPointOf('/mnt/nas/work/app', stat)).toBe('/mnt/nas');
    expect(await mountPointOf('/home/app', stat)).toBe('/');
  });
});
