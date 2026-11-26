import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachedClient, Run } from '../../../daemon/control-messages';
import type { HostUpdate } from '../../../../shared/host-update';
import { adoptCompatibleDaemon, belowFloorSwitch, followCompatibleDaemon, followOtherProtocolDaemon, otherDeviceCount, PendingSwitches, requiredDeadline, serverInUseNotice, shutDownNow, type CompatibleDaemon, type CompatibleSwitchDeps, type PendingSwitch, type SwitchListing, type SwitchResult } from '../app-update-flow';
import type { OtherProtocolDaemon } from '../connection';
import type { ServerManifest } from '../server-manifest-format';
import { createSwitchReminders } from '../switch-reminders';

const quiet = (): void => undefined;
const chat = (id: string, title: string): Run => ({ kind: 'chat', id, projectKey: '/srv/app', title, state: 'running', providers: [] });
const terminal = (id: string, title: string): Run => ({ kind: 'terminal', id, projectKey: '', title, state: 'running', providers: [] });

// others: 'unknown' for a daemon that has not listed this device
function compatible(serverVersion: string, runs: readonly Run[], others: number | 'unknown' = 0, waitsForOtherClients = true, handsOver = false, cliWaits: readonly string[] = []) {
  const calls: string[] = [];
  const daemon: CompatibleDaemon = {
    serverVersion,
    waitsForOtherClients,
    handsOver,
    handOver: async (when) => {
      calls.push(`handOver ${when}`);
    },
    listRuns: async () => runs,
    cliWaits: () => cliWaits,
    otherDevices: () => (others === 'unknown' ? undefined : others),
    shutdownWhenIdle: async () => {
      calls.push('shutdownWhenIdle');
    },
    shutdownNow: async () => {
      calls.push('shutdownNow');
    },
  };
  return { daemon, calls };
}

// this build's manifest: a server version per target, as each target's package hashes to its own
const BUILD = { linux: '3.7.0+0123456789ab', windows: '3.7.0+ba9876543210' };
const manifest: ServerManifest = {
  version: '3.7.0',
  protocolVersion: 1,
  published: false,
  packages: {
    'linux-x64': { file: 'damocles-server-3.7.0-linux-x64.tar.gz', sha256: 'a'.repeat(64), size: 10, serverVersion: BUILD.linux },
    'win32-x64': { file: 'damocles-server-3.7.0-win32-x64.zip', sha256: 'b'.repeat(64), size: 10, serverVersion: BUILD.windows },
  },
};

describe('a compatible daemon of another build', () => {
  it('is attached as is when it runs one of this build\'s server versions, whichever target', async () => {
    for (const serverVersion of [BUILD.linux, BUILD.windows]) {
      const { daemon, calls } = compatible(serverVersion, [chat('host-1', 'busy')]);
      expect((await adoptCompatibleDaemon(manifest, daemon, quiet)).outcome).toBe('current');
      expect(calls).toEqual([]);
    }
  });

  it('is replaced when it runs another build of this version, or the plain version an earlier build ran as', async () => {
    for (const serverVersion of ['3.7.0+fedcba987654', '3.7.0']) {
      const lines: string[] = [];
      const { daemon, calls } = compatible(serverVersion, [], 0);
      expect((await adoptCompatibleDaemon(manifest, daemon, (line) => lines.push(line))).outcome).toBe('replaceNow');
      expect(calls).toEqual(['shutdownNow']);
      expect(lines).toEqual([`[update] the daemon of ${serverVersion} is idle with no other device; stopping it for this build of 3.7.0`]);
    }
  });

  it('keeps its runs: attached, it is asked to exit once idle, never stopped', async () => {
    const lines: string[] = [];
    const { daemon, calls } = compatible('3.6.9', [chat('host-1', 'Fix the parser')]);
    // the flow starts from the runs listed here
    expect(await adoptCompatibleDaemon(manifest, daemon, (line) => lines.push(line))).toEqual({ outcome: 'switchWhenIdle', runs: [chat('host-1', 'Fix the parser')] });
    expect(calls).toEqual(['shutdownWhenIdle']);
    expect(lines).toEqual(['[update] the daemon of 3.6.9 has 1 runs and 0 other devices; it exits once idle, then this build of 3.7.0 starts']);
  });

  it('is kept alive by a terminal alone, which delays the switch until it closes', async () => {
    const { daemon, calls } = compatible('3.6.9', [terminal('term-1', 'bash')]);
    expect((await adoptCompatibleDaemon(manifest, daemon, quiet)).outcome).toBe('switchWhenIdle');
    expect(calls).toEqual(['shutdownWhenIdle']);
  });

  // a dist:local rebuild of the same version: this app's own terminal or Keep running chat only delays the switch
  it('busy with no other device, is asked to exit once idle whatever its build, a daemon of the plain version included', async () => {
    for (const serverVersion of ['3.7.0+fedcba987654', '3.6.9+fedcba987654', '3.7.0']) {
      const { daemon, calls } = compatible(serverVersion, [chat('host-1', 'busy')], 0, false);
      expect((await adoptCompatibleDaemon(manifest, daemon, quiet)).outcome).toBe('switchWhenIdle');
      expect(calls).toEqual(['shutdownWhenIdle']);
    }
  });

  it('serving another device, waits for idle though it runs nothing', async () => {
    const { daemon, calls } = compatible('3.6.9', [], 1);
    expect((await adoptCompatibleDaemon(manifest, daemon, quiet)).outcome).toBe('switchWhenIdle');
    expect(calls).toEqual(['shutdownWhenIdle']);
  });

  // two machines' builds of one version on one host: neither takes the daemon the other uses
  it('serving other devices or an unknown number of them, is used as it is when this app version is the same, whatever its build', async () => {
    for (const [serverVersion, runs, others] of [['3.7.0+fedcba987654', [], 1], ['3.7.0+fedcba987654', [chat('host-1', 'busy')], 'unknown']] as const) {
      const lines: string[] = [];
      const { daemon, calls } = compatible(serverVersion, runs, others);
      expect((await adoptCompatibleDaemon(manifest, daemon, (line) => lines.push(line))).outcome).toBe('useAsIs');
      expect(calls).toEqual([]);
      expect(lines).toEqual([`[update] the daemon of ${serverVersion} has ${runs.length} runs and ${others === 'unknown' ? 'an unknown number of' : others} other devices and is not older than this build of 3.7.0; using it as it is`]);
    }
  });

  // its shutdownWhenIdle would exit once idle and end the other devices' connections
  it('serving other devices without control.shutdownWhenIdle.clients, is used as it is though this app version is newer', async () => {
    const lines: string[] = [];
    const { daemon, calls } = compatible('3.6.9', [], 1, false);
    expect((await adoptCompatibleDaemon(manifest, daemon, (line) => lines.push(line))).outcome).toBe('useAsIs');
    expect(calls).toEqual([]);
    expect(lines).toEqual(['[update] the daemon of 3.6.9 has 0 runs and 1 other devices and would end their connections once idle; using it as it is']);
  });

  it('serving another device, is asked to exit once idle by a release of its prerelease, and when its version does not parse', async () => {
    for (const serverVersion of ['3.7.0-dev.1+fedcba987654', 'nightly+fedcba987654', '3.8.01+fedcba987654', '3.8.0-01+fedcba987654']) {
      const { daemon, calls } = compatible(serverVersion, [], 1);
      expect((await adoptCompatibleDaemon(manifest, daemon, quiet)).outcome).toBe('switchWhenIdle');
      expect(calls).toEqual(['shutdownWhenIdle']);
    }
  });

  it('serving another device, is used as it is when this app version does not parse', async () => {
    const { daemon, calls } = compatible('3.6.9', [], 1);
    expect((await adoptCompatibleDaemon({ ...manifest, version: '3.7.0-a..b' }, daemon, quiet)).outcome).toBe('useAsIs');
    expect(calls).toEqual([]);
  });

  it('idle and alone, is stopped now so this build starts', async () => {
    const { daemon, calls } = compatible('3.6.9', [], 0);
    expect((await adoptCompatibleDaemon(manifest, daemon, quiet)).outcome).toBe('replaceNow');
    expect(calls).toEqual(['shutdownNow']);
  });

  // versions never move backwards: an older app never takes the host from a newer daemon
  it('newer than this app, is used as it is, idle and alone or busy, never replaced or asked to switch', async () => {
    for (const runs of [[], [chat('host-1', 'busy')]]) {
      const lines: string[] = [];
      const { daemon, calls } = compatible('3.8.0+fedcba987654', runs, 0);
      expect((await adoptCompatibleDaemon(manifest, daemon, (line) => lines.push(line))).outcome).toBe('useAsIs');
      expect(calls).toEqual([]);
      expect(lines).toEqual(['[update] the daemon of 3.8.0+fedcba987654 is newer than this build of 3.7.0; using it as it is']);
    }
  });
});

describe('a compatible daemon of another build that hands its terminals over', () => {
  const handingOver = (serverVersion: string, runs: readonly Run[], others: number | 'unknown' = 0, waitsForOtherClients = true, cliWaits: readonly string[] = []) => compatible(serverVersion, runs, others, waitsForOtherClients, true, cliWaits);

  it('is replaced now through handOver while only terminals run and no other computer is connected', async () => {
    const lines: string[] = [];
    const { daemon, calls } = handingOver('3.6.9', [terminal('term-1', 'bash'), terminal('term-2', 'zsh')]);
    expect((await adoptCompatibleDaemon(manifest, daemon, (line) => lines.push(line))).outcome).toBe('replaceNow');
    expect(calls).toEqual(['handOver now']);
    expect(lines).toEqual(['[update] the daemon of 3.6.9 is idle with no other device; stopping it for this build of 3.7.0']);
  });

  it('is asked through handOver to exit once its agents end, whatever terminals run', async () => {
    const lines: string[] = [];
    const { daemon, calls } = handingOver('3.6.9', [chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')]);
    expect((await adoptCompatibleDaemon(manifest, daemon, (line) => lines.push(line))).outcome).toBe('switchWhenIdle');
    expect(calls).toEqual(['handOver idle']);
    expect(lines).toEqual(['[update] the daemon of 3.6.9 has 1 agent runs, 0 damocles --wait requests and 0 other devices; it exits once idle, then this build of 3.7.0 starts']);
  });

  // a git commit whose message tab is open would abort
  it('with only a pending damocles --wait, is asked through handOver to exit once idle, never handed over now, required or not', async () => {
    const lines: string[] = [];
    const { daemon, calls } = handingOver('3.6.9', [terminal('term-1', 'bash')], 0, true, ['COMMIT_EDITMSG']);
    expect((await adoptCompatibleDaemon(manifest, daemon, (line) => lines.push(line))).outcome).toBe('switchWhenIdle');
    expect(calls).toEqual(['handOver idle']);
    expect(lines).toEqual(['[update] the daemon of 3.6.9 has 0 agent runs, 1 damocles --wait requests and 0 other devices; it exits once idle, then this build of 3.7.0 starts']);
    const required = handingOver('3.6.9', [], 1, true, ['COMMIT_EDITMSG']);
    expect((await adoptCompatibleDaemon({ ...manifest, requirement: { minimumServerVersion: '3.7.0', graceHours: 24 } }, required.daemon, quiet)).outcome).toBe('switchWhenIdle');
    expect(required.calls).toEqual(['handOver idle']);
  });

  // the runs event this app read predates a damocles --wait or an agent run that started since
  it('that decides the hand-over on its own runs, is asked handOverIfIdle, and its answer, not this app\'s view, makes the outcome', async () => {
    for (const [answer, outcome] of [['now', 'replaceNow'], ['idle', 'switchWhenIdle']] as const) {
      const lines: string[] = [];
      const { daemon, calls } = handingOver('3.6.9', [terminal('term-1', 'bash')]);
      const deciding: CompatibleDaemon = { ...daemon, handOverIfIdle: async () => {
        calls.push('handOverIfIdle');
        return answer;
      } };
      const adopted = await adoptCompatibleDaemon(manifest, deciding, (line) => lines.push(line));
      expect(adopted).toEqual(outcome === 'replaceNow' ? { outcome } : { outcome, runs: [terminal('term-1', 'bash')] });
      expect(calls).toEqual(['handOverIfIdle']);
      expect(lines).toEqual([
        '[update] the daemon of 3.6.9 is idle with no other device; stopping it for this build of 3.7.0 if it is still idle',
        ...(answer === 'idle' ? ['[update] the daemon of 3.6.9 has an agent run or a damocles --wait after all; it exits once idle, then this build of 3.7.0 starts'] : []),
      ]);
    }
    const required = handingOver('3.6.9', [], 1);
    const lines: string[] = [];
    const deciding: CompatibleDaemon = { ...required.daemon, handOverIfIdle: async () => {
      required.calls.push('handOverIfIdle');
      return 'idle';
    } };
    expect((await adoptCompatibleDaemon({ ...manifest, requirement: { minimumServerVersion: '3.7.0', graceHours: 24 } }, deciding, (line) => lines.push(line))).outcome).toBe('switchWhenIdle');
    expect(required.calls).toEqual(['handOverIfIdle']);
    expect(lines[1]).toBe('[update] the daemon of 3.6.9 has an agent run or a damocles --wait after all; it exits once idle, or at its deadline');
  });

  it('serving another computer, is asked through handOver to exit once idle, though only terminals run', async () => {
    const { daemon, calls } = handingOver('3.6.9', [terminal('term-1', 'bash')], 1);
    expect((await adoptCompatibleDaemon(manifest, daemon, quiet)).outcome).toBe('switchWhenIdle');
    expect(calls).toEqual(['handOver idle']);
  });

  it('serving other computers, is used as it is by an app that is not newer, and is never handed over', async () => {
    const { daemon, calls } = handingOver('3.7.0+fedcba987654', [terminal('term-1', 'bash')], 1);
    expect((await adoptCompatibleDaemon(manifest, daemon, quiet)).outcome).toBe('useAsIs');
    expect(calls).toEqual([]);
  });

  // versions never move backwards, whatever the daemon can hand over
  it('newer than this app, is used as it is and never handed over, idle or busy', async () => {
    for (const runs of [[], [terminal('term-1', 'bash')], [chat('host-1', 'busy')]]) {
      const { daemon, calls } = handingOver('3.8.0+fedcba987654', runs, 0);
      expect((await adoptCompatibleDaemon(manifest, daemon, quiet)).outcome).toBe('useAsIs');
      expect(calls).toEqual([]);
    }
  });

  it('running this build, is attached as it is', async () => {
    const { daemon, calls } = handingOver(BUILD.linux, [terminal('term-1', 'bash')]);
    expect((await adoptCompatibleDaemon(manifest, daemon, quiet)).outcome).toBe('current');
    expect(calls).toEqual([]);
  });
});

// A frozen-commands-only daemon whose runs the test changes; its connection closes when the test says it exited.
// frozenFeatures: what its refusal named; none from a daemon that predates control.handOver
function otherProtocol(initial: readonly Run[], frozenFeatures: readonly string[] = []) {
  let runs = initial;
  const requests: string[] = [];
  const closeListeners = new Set<(reason: string) => void>();
  const daemon = {
    serverVersion: '3.6.9',
    protocolVersion: 2,
    frozenFeatures,
    control: {
      request: vi.fn(async (method: string, params: { when?: string }) => {
        requests.push(method === 'handOver' ? `handOver ${params.when}` : method);
        return method === 'listRuns' ? { runs } : undefined;
      }),
    },
    receiveStream: vi.fn(),
    onClose: (listener: (reason: string) => void) => {
      closeListeners.add(listener);
      return { dispose: () => { closeListeners.delete(listener); } };
    },
    close: vi.fn(),
  } as unknown as OtherProtocolDaemon;
  return {
    daemon,
    requests,
    setRuns: (next: readonly Run[]) => { runs = next; },
    exit: () => { for (const listener of [...closeListeners]) listener('the daemon exited'); },
  };
}

// what every update of a daemon of 3.6.9 seen at the fake clock's start carries
const OLD_UPDATE = { serverVersion: '3.6.9', targetVersion: '3.7.0', terminalsSurvive: false, waitingSince: 0 } as const;

describe('a busy daemon of another protocol', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  function follow(daemon: OtherProtocolDaemon, confirm: (listing: SwitchListing) => boolean = () => true) {
    const reconnect = vi.fn();
    const ended = vi.fn();
    const syncMirror = vi.fn(async () => undefined);
    const confirmed: SwitchListing[] = [];
    const host = followOtherProtocolDaemon({
      daemon,
      syncMirror,
      changed: quiet,
      reconnect,
      ended,
      confirm: async (listing) => {
        confirmed.push(listing);
        return confirm(listing);
      },
      targetVersion: '3.7.0',
      pollMs: 5000, waitingSince: 0,
      log: quiet,
    });
    return { host, reconnect, ended, syncMirror, confirmed };
  }

  it('shows its running agents and terminals read-only from the mirror, which the poll keeps live with the update', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser'), chat('host-2', 'Write docs'), terminal('term-1', 'bash')]);
    const { host, syncMirror } = follow(old.daemon);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.update()).toEqual({ ...OLD_UPDATE, source: 'otherProtocol', phase: 'offer', runningAgents: 2, runningTerminals: 1 });
    expect(host.following()).toBe(old.daemon);
    expect(syncMirror).toHaveBeenCalledOnce();
    old.setRuns([chat('host-2', 'Write docs')]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.update()).toEqual({ ...OLD_UPDATE, source: 'otherProtocol', phase: 'offer', runningAgents: 1, runningTerminals: 0 });
    expect(syncMirror).toHaveBeenCalledTimes(2);
    expect(old.requests).not.toContain('shutdownNow');
    host.dispose();
  });

  it('names the app version of a daemon whose server version carries a build', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser')]);
    const { host } = follow({ ...old.daemon, serverVersion: '3.6.9+0123456789ab' } as OtherProtocolDaemon);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.update()).toMatchObject({ serverVersion: '3.6.9', runningAgents: 1, phase: 'offer' });
    host.dispose();
  });

  it('newer than this app, is never stopped though it runs nothing: the host shows that this app must update', async () => {
    const newer = otherProtocol([]);
    const { host } = follow({ ...newer.daemon, serverVersion: '3.8.0+0123456789ab' } as OtherProtocolDaemon);
    await vi.advanceTimersByTimeAsync(0);
    expect(newer.requests).not.toContain('shutdownNow');
    expect(host.update()).toMatchObject({ source: 'otherProtocol', phase: 'appOutdated', outdated: 'runs', serverVersion: '3.8.0', targetVersion: '3.7.0' });
    host.dispose();
  });

  it('newer than this app, keeps its chats readable and its connection held, and refuses both switches', async () => {
    const newer = otherProtocol([chat('host-1', 'Fix the parser')]);
    const daemon = { ...newer.daemon, serverVersion: '3.8.0' } as OtherProtocolDaemon;
    const { host, syncMirror } = follow(daemon);
    await vi.advanceTimersByTimeAsync(5000);
    expect(syncMirror).toHaveBeenCalledTimes(2);
    expect(host.following()).toBe(daemon);
    await expect(host.switchWhenIdle()).rejects.toThrow('newer than this app');
    await expect(host.switchNow({ confirmed: true })).rejects.toThrow('newer than this app');
    expect(newer.requests.filter((method) => method !== 'listRuns')).toEqual([]);
    host.dispose();
  });

  it('stopped at once when it runs nothing, and this version connects once it is gone', async () => {
    const old = otherProtocol([]);
    const { host, reconnect, ended } = follow(old.daemon);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.requests).toEqual(['listRuns', 'shutdownNow']);
    expect(host.update()).toBeUndefined();
    old.exit();
    expect(reconnect).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
  });

  it('switches when they finish: asked to exit once idle, the update waits, and its exit switches until the next connect settles', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser')]);
    const { host, reconnect, ended } = follow(old.daemon);
    await vi.advanceTimersByTimeAsync(0);
    await host.switchWhenIdle();
    expect(old.requests).toContain('shutdownWhenIdle');
    expect(old.requests).not.toContain('shutdownNow');
    expect(host.update()?.phase).toBe('waiting');
    expect(reconnect).not.toHaveBeenCalled();
    old.exit();
    expect(host.update()?.phase).toBe('switching');
    expect(host.following()).toBeUndefined();
    expect(reconnect).toHaveBeenCalledOnce();
    // the state the close left, then the next connect, which fails
    host.stateChanged('failed');
    expect(ended).not.toHaveBeenCalled();
    host.stateChanged('connecting');
    host.stateChanged('failed');
    expect(ended).toHaveBeenCalledOnce();
    expect(host.update()).toBeUndefined();
  });

  it('switches now only after a confirmation that lists the agents that stop and the terminals that close', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')]);
    let accept = false;
    const { host, confirmed } = follow(old.daemon, () => accept);
    await vi.advanceTimersByTimeAsync(0);
    expect(await host.switchNow()).toBe(false);
    expect(old.requests).not.toContain('shutdownNow');
    expect(host.update()?.phase).toBe('offer');
    accept = true;
    expect(await host.switchNow()).toBe(true);
    const listing = { agents: ['Fix the parser'], terminals: ['bash'], cliWaits: [], otherDevices: 0, terminalsSurvive: false };
    expect(confirmed).toEqual([listing, listing]);
    expect(old.requests.filter((method) => method === 'shutdownNow')).toHaveLength(1);
    expect(host.update()?.phase).toBe('switching');
    // a caller that asked already is not asked again
    expect(await host.switchNow({ confirmed: true })).toBe(true);
    expect(confirmed).toHaveLength(2);
    host.dispose();
  });

  describe('whose refusal lists control.handOver', () => {
    const HANDS_OVER = ['control.handOver'];

    it('is handed over at once while only terminals run, which survive, and this version connects once it is gone', async () => {
      const old = otherProtocol([terminal('term-1', 'bash')], HANDS_OVER);
      const { host, reconnect, ended } = follow(old.daemon);
      await vi.advanceTimersByTimeAsync(0);
      expect(old.requests).toEqual(['listRuns', 'handOver now']);
      expect(host.update()).toBeUndefined();
      old.exit();
      expect(reconnect).toHaveBeenCalledOnce();
      expect(ended).toHaveBeenCalledOnce();
    });

    it('with an agent running, offers the switch with terminals that survive, and both actions hand over', async () => {
      const old = otherProtocol([chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')], HANDS_OVER);
      const { host, confirmed } = follow(old.daemon);
      await vi.advanceTimersByTimeAsync(0);
      expect(host.update()).toEqual({ ...OLD_UPDATE, source: 'otherProtocol', phase: 'offer', runningAgents: 1, runningTerminals: 1, terminalsSurvive: true });
      await host.switchWhenIdle();
      expect(host.update()?.phase).toBe('waiting');
      expect(await host.switchNow()).toBe(true);
      expect(confirmed).toEqual([{ agents: ['Fix the parser'], terminals: ['bash'], cliWaits: [], otherDevices: 0, terminalsSurvive: true }]);
      expect(old.requests.filter((method) => method !== 'listRuns')).toEqual(['handOver idle', 'handOver now']);
      host.dispose();
    });

    // versions never move backwards, whatever the daemon can hand over
    it('newer than this app, is never handed over though only terminals run, and refuses both switches', async () => {
      const newer = otherProtocol([terminal('term-1', 'bash')], HANDS_OVER);
      const { host } = follow({ ...newer.daemon, serverVersion: '3.8.0+0123456789ab' } as OtherProtocolDaemon);
      await vi.advanceTimersByTimeAsync(0);
      expect(host.update()).toMatchObject({ phase: 'appOutdated', outdated: 'runs', terminalsSurvive: true });
      await expect(host.switchWhenIdle()).rejects.toThrow('newer than this app');
      await expect(host.switchNow({ confirmed: true })).rejects.toThrow('newer than this app');
      expect(newer.requests.filter((method) => method !== 'listRuns')).toEqual([]);
      host.dispose();
    });
  });

  // a refusal that names other frozen features, or none, is a legacy daemon's: its terminals end with it
  it('whose refusal does not list control.handOver keeps the legacy path: a terminal alone keeps the offer, and the actions shut down', async () => {
    const old = otherProtocol([terminal('term-1', 'bash')], ['control.somethingElse']);
    const { host } = follow(old.daemon);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.update()).toMatchObject({ phase: 'offer', runningTerminals: 1, terminalsSurvive: false });
    await host.switchWhenIdle();
    expect(await host.switchNow({ confirmed: true })).toBe(true);
    expect(old.requests.filter((method) => method !== 'listRuns')).toEqual(['shutdownWhenIdle', 'shutdownNow']);
    host.dispose();
  });
});

// A compatible daemon's connection whose runs, devices and connection the test drives.
function compatibleConnection(features: readonly string[], initial: readonly Run[], initialWaits: readonly string[] = []) {
  let runs = initial;
  let cliWaits = initialWaits;
  let devices: readonly AttachedClient[] = [{ deviceName: 'laptop', self: true }];
  let lost = false;
  // what the daemon's own registry decides for handOverIfIdle
  let ifIdle: 'now' | 'idle' = 'now';
  const requests: string[] = [];
  const listeners = { runs: new Set<(runs: readonly Run[]) => void>(), devices: new Set<() => void>(), lost: new Set<() => void>(), close: new Set<() => void>() };
  const add = <L>(set: Set<L>) => (listener: L) => {
    set.add(listener);
    return { dispose: () => { set.delete(listener); } };
  };
  const connection = {
    serverVersion: '3.6.9+fedcba987654',
    features,
    control: {
      request: vi.fn(async (method: string, params: { when?: string }) => {
        requests.push(method === 'handOver' ? `handOver ${params.when}` : method);
        if (method === 'handOverIfIdle') return { when: ifIdle };
        return method === 'listRuns' ? { runs } : undefined;
      }),
    },
    devices: () => devices,
    onDevices: add(listeners.devices),
    onRuns: (listener: (runs: readonly Run[]) => void) => {
      listeners.runs.add(listener);
      listener(runs);
      return { dispose: () => { listeners.runs.delete(listener); } };
    },
    cliWaits: () => cliWaits,
    onLost: add(listeners.lost),
    onClose: add(listeners.close),
    lost: () => lost,
  };
  return {
    connection: connection as unknown as CompatibleSwitchDeps['connection'],
    requests,
    listeners,
    // a daemon that pushes runs tells every watcher, with its pending CLI waits; one that does not answers the next listRuns
    setRuns: (next: readonly Run[], nextWaits: readonly string[] = cliWaits) => {
      runs = next;
      cliWaits = nextWaits;
      if (features.includes('control.runs')) for (const listener of [...listeners.runs]) listener(next);
    },
    setDevices: (next: readonly AttachedClient[]) => {
      devices = next;
      for (const listener of [...listeners.devices]) listener();
    },
    lose: () => {
      lost = true;
      for (const listener of [...listeners.lost]) listener();
    },
    resume: () => { lost = false; },
    answerIfIdle: (when: 'now' | 'idle') => { ifIdle = when; },
    close: () => { for (const listener of [...listeners.close]) listener(); },
    // what the daemon lists now, as adoptCompatibleDaemon read it
    listed: () => runs,
  };
}

type CompatibleFixture = ReturnType<typeof compatibleConnection>;

describe('a compatible daemon asked to switch once idle', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  function follow(old: CompatibleFixture, confirm: (listing: SwitchListing) => boolean = () => true) {
    const changed = vi.fn();
    const ended = vi.fn();
    const confirmed: SwitchListing[] = [];
    const host = followCompatibleDaemon({
      connection: old.connection,
      runs: old.listed(),
      targetVersion: '3.7.0',
      changed,
      ended,
      confirm: async (listing) => {
        confirmed.push(listing);
        return confirm(listing);
      },
      pollMs: 5000, waitingSince: 0,
      log: quiet,
    });
    return { host, changed, ended, confirmed };
  }

  it('waits at once, following the runs the daemon pushes and the other computers it lists, and polls nothing', async () => {
    const old = compatibleConnection(['control.runs', 'clients'], [chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')]);
    const { host, changed } = follow(old);
    expect(host.update()).toEqual({ ...OLD_UPDATE, source: 'compatible', phase: 'waiting', runningAgents: 1, runningTerminals: 1, otherDevices: 0 });
    expect(host.following()).toBeUndefined();
    old.setRuns([terminal('term-1', 'bash')]);
    old.setDevices([{ deviceName: 'laptop', self: true }, { deviceName: 'desktop', self: false }]);
    expect(host.update()).toMatchObject({ runningAgents: 0, runningTerminals: 1, otherDevices: 1 });
    const published = changed.mock.calls.length;
    old.setRuns([terminal('term-1', 'bash')]);
    expect(changed).toHaveBeenCalledTimes(published);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(old.requests).toEqual([]);
    host.dispose();
    expect(old.listeners.runs.size + old.listeners.devices.size + old.listeners.lost.size + old.listeners.close.size).toBe(0);
  });

  it('polls the runs of a daemon that does not push them, and leaves the other computers out while it does not list them', async () => {
    const old = compatibleConnection([], [chat('host-1', 'Fix the parser')]);
    old.setDevices([]);
    const { host } = follow(old);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.update()).toEqual({ ...OLD_UPDATE, source: 'compatible', phase: 'waiting', runningAgents: 1, runningTerminals: 0 });
    old.setRuns([]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(host.update()?.runningAgents).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.update()?.runningAgents).toBe(0);
    expect(old.requests).toEqual(['listRuns', 'listRuns']);
    host.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(old.requests).toHaveLength(2);
  });

  it('switches while its connection is lost, waits again once it resumes, and ends when the connect after its close fails', async () => {
    const old = compatibleConnection(['control.runs', 'clients'], [terminal('term-1', 'bash')]);
    const { host, ended } = follow(old);
    old.lose();
    host.stateChanged('failed');
    expect(host.update()?.phase).toBe('switching');
    host.stateChanged('connecting');
    old.resume();
    host.stateChanged('connected');
    expect(host.update()?.phase).toBe('waiting');
    old.lose();
    host.stateChanged('connecting');
    old.close();
    expect(host.update()?.phase).toBe('switching');
    expect(ended).not.toHaveBeenCalled();
    host.stateChanged('failed');
    expect(ended).toHaveBeenCalledOnce();
  });

  it('switches now after a confirmation listing the agents, the terminals that close and the other computers, over the live connection', async () => {
    const old = compatibleConnection(['control.runs', 'clients'], [chat('host-1', ''), terminal('term-1', 'bash')]);
    old.setDevices([{ deviceName: 'laptop', self: true }, { deviceName: 'desktop', self: false }]);
    let accept = false;
    const { host, confirmed } = follow(old, () => accept);
    expect(await host.switchNow()).toBe(false);
    expect(host.update()?.phase).toBe('waiting');
    accept = true;
    const switching = host.switchNow();
    await vi.waitFor(() => expect(old.requests).toContain('shutdownNow'));
    expect(host.update()?.phase).toBe('switching');
    old.lose();
    expect(await switching).toBe(true);
    const listing = { agents: [''], terminals: ['bash'], cliWaits: [], otherDevices: 1, terminalsSurvive: false };
    expect(confirmed).toEqual([listing, listing]);
    expect(old.requests.filter((method) => method === 'shutdownNow')).toHaveLength(1);
  });

  it('that lists control.handOver shows terminals that survive, and both actions hand over instead of shutting down', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')]);
    const { host, confirmed } = follow(old);
    expect(host.update()).toEqual({ ...OLD_UPDATE, source: 'compatible', phase: 'waiting', runningAgents: 1, runningTerminals: 1, otherDevices: 0, terminalsSurvive: true });
    await host.switchWhenIdle();
    const switching = host.switchNow();
    await vi.waitFor(() => expect(old.requests).toContain('handOver now'));
    expect(host.update()?.phase).toBe('switching');
    old.lose();
    expect(await switching).toBe(true);
    expect(confirmed).toEqual([{ agents: ['Fix the parser'], terminals: ['bash'], cliWaits: [], otherDevices: 0, terminalsSurvive: true }]);
    expect(old.requests.filter((method) => method !== 'listRuns')).toEqual(['handOver idle', 'handOver now']);
  });

  it('counts the pending damocles --wait requests, which Switch now lists and its result names', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver', 'runs.cliWaits'], [terminal('term-1', 'bash')], ['COMMIT_EDITMSG']);
    const { host, switched, confirm, lines } = followed(old);
    expect(host.update()).toEqual({ ...OLD_UPDATE, source: 'compatible', phase: 'waiting', runningAgents: 0, runningTerminals: 1, cliWaits: 1, otherDevices: 0, terminalsSurvive: true });
    old.setRuns([terminal('term-1', 'bash')], []);
    expect(host.update()).not.toHaveProperty('cliWaits');
    old.setRuns([terminal('term-1', 'bash')], ['COMMIT_EDITMSG', 'old.txt, new.txt']);
    const switching = host.switchNow();
    await vi.waitFor(() => expect(old.requests).toContain('handOver now'));
    old.lose();
    await switching;
    expect(confirm).toHaveBeenCalledWith({ agents: [], terminals: ['bash'], cliWaits: ['COMMIT_EDITMSG', 'old.txt, new.txt'], otherDevices: 0, terminalsSurvive: true });
    expect(switched).toEqual([{ agentsStopped: 0, terminalsClosed: 0, cliWaitsEnded: 2, chosen: true }]);
    expect(lines).toContain('[update] switching from the daemon of 3.6.9+fedcba987654 now: 0 runs and 2 damocles --wait requests stop');
    host.dispose();
  });

  it('that does not list control.handOver is asked the legacy way once idle', async () => {
    const old = compatibleConnection(['control.runs', 'clients'], [terminal('term-1', 'bash')]);
    const { host } = follow(old);
    await host.switchWhenIdle();
    expect(old.requests).toEqual(['shutdownWhenIdle']);
    expect(host.update()?.terminalsSurvive).toBe(false);
    host.dispose();
  });
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OTHER_COMPUTER: readonly AttachedClient[] = [{ deviceName: 'laptop', self: true }, { deviceName: 'desktop', self: false }];

function followed(old: CompatibleFixture, extra: Partial<CompatibleSwitchDeps> = {}) {
  const lines: string[] = [];
  const switched: Array<SwitchResult | undefined> = [];
  const confirm = vi.fn(async () => true);
  const host = followCompatibleDaemon({ connection: old.connection, runs: old.listed(), targetVersion: '3.7.0', changed: quiet, ended: quiet, confirm, pollMs: 5000, waitingSince: 0, log: (line) => lines.push(line), switched: (result) => switched.push(result), ...extra });
  return { host, lines, switched, confirm };
}

describe('an unasked switch of a daemon that decides the hand-over on its own runs', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());
  const DECIDES = ['control.runs', 'clients', 'control.handOver', 'runs.cliWaits', 'control.handOverIfIdle'];

  // the runs event this app read predates a damocles --wait that started since
  it('of a required daemon that runs nothing more, keeps waiting while the daemon answers idle, and switches once it answers now', async () => {
    const old = compatibleConnection(DECIDES, [terminal('term-1', 'bash')]);
    old.answerIfIdle('idle');
    const { host, switched, lines } = followed(old, { required: { deadline: 24 * HOUR } });
    await vi.advanceTimersByTimeAsync(0);
    const switches = (): string[] => old.requests.filter((method) => method !== 'listRuns');
    expect(switches()).toEqual(['handOverIfIdle']);
    expect(host.update()?.phase).toBe('waiting');
    expect(switched).toEqual([]);
    expect(lines).toContain('[update] not switching the daemon of 3.6.9+fedcba987654: it has an agent run or a damocles --wait after all');
    old.answerIfIdle('now');
    old.setRuns([terminal('term-1', 'bash')], []);
    await vi.advanceTimersByTimeAsync(0);
    expect(switches()).toEqual(['handOverIfIdle', 'handOverIfIdle']);
    expect(host.update()?.phase).toBe('switching');
    expect(switched).toEqual([{ agentsStopped: 0, terminalsClosed: 0 }]);
    host.dispose();
  });

  it('asks handOverIfIdle at the drain\'s end, and keeps waiting while the daemon answers idle', async () => {
    const old = compatibleConnection(DECIDES, [terminal('term-1', 'bash')]);
    old.setDevices(OTHER_COMPUTER);
    old.answerIfIdle('idle');
    const { host, switched } = followed(old, { drainMs: 2500 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(old.requests).toEqual(['listRuns', 'handOverIfIdle']);
    expect(host.update()?.phase).toBe('waiting');
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    expect(switched).toEqual([]);
    host.dispose();
  });

  it('hands over now at the deadline and on Switch now, which stop what runs', async () => {
    const old = compatibleConnection(DECIDES, [chat('host-1', 'Fix the parser')]);
    const { host } = followed(old, { required: { deadline: HOUR } });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    host.dispose();
    const chosen = compatibleConnection(DECIDES, [terminal('term-1', 'bash')], ['COMMIT_EDITMSG']);
    const { host: other } = followed(chosen);
    const switching = other.switchNow();
    await vi.waitFor(() => expect(chosen.requests).toContain('handOver now'));
    chosen.lose();
    await switching;
    expect(chosen.requests).toEqual(['listRuns', 'handOver now']);
    other.dispose();
  });

  it('runs a Switch now asked while an unasked one waits for the daemon\'s answer, once the daemon answered idle', async () => {
    const old = compatibleConnection(DECIDES, [terminal('term-1', 'bash')]);
    old.answerIfIdle('idle');
    const request = vi.mocked(old.connection.control.request);
    const answer = request.getMockImplementation()!;
    let answerIfIdle!: () => void;
    request.mockImplementation(async (method, params) => {
      if (method === 'handOverIfIdle') await new Promise<void>((resolve) => { answerIfIdle = resolve; });
      return answer(method, params);
    });
    const { host, switched } = followed(old, { required: { deadline: 24 * HOUR } });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledWith('handOverIfIdle', {});
    const switching = host.switchNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(old.requests).not.toContain('handOver now');
    answerIfIdle();
    await vi.waitFor(() => expect(old.requests).toContain('handOver now'));
    old.lose();
    expect(await switching).toBe(true);
    expect(old.requests.filter((method) => method !== 'listRuns')).toEqual(['handOverIfIdle', 'handOver now']);
    expect(switched).toEqual([{ agentsStopped: 0, terminalsClosed: 0, chosen: true }]);
    host.dispose();
  });
});

describe('the bounded drain of a daemon that hands over', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it('starts once no agent runs while another computer is connected, and hands over now at its end, stopping nothing', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')]);
    old.setDevices(OTHER_COMPUTER);
    const { host, switched, confirm } = followed(old);
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    old.setRuns([terminal('term-1', 'bash')]);
    expect(host.update()).toMatchObject({ phase: 'waiting', runningAgents: 0, otherDevices: 1, drainEndsAt: 20 * MINUTE });
    await vi.advanceTimersByTimeAsync(15 * MINUTE - 1);
    expect(old.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    expect(host.update()).toMatchObject({ phase: 'switching' });
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    expect(switched).toEqual([{ agentsStopped: 0, terminalsClosed: 0 }]);
    expect(confirm).not.toHaveBeenCalled();
    host.dispose();
  });

  // a git commit whose message tab is open would abort at the drain's end
  it('never starts while a damocles --wait is pending, and starts once it ended', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver', 'runs.cliWaits'], [terminal('term-1', 'bash')], ['COMMIT_EDITMSG']);
    old.setDevices(OTHER_COMPUTER);
    const { host } = followed(old);
    expect(host.update()).toMatchObject({ phase: 'waiting', cliWaits: 1 });
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(old.requests).toEqual([]);
    old.setRuns([terminal('term-1', 'bash')], []);
    expect(host.update()?.drainEndsAt).toBe(45 * MINUTE);
    old.setRuns([terminal('term-1', 'bash')], ['COMMIT_EDITMSG']);
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    host.dispose();
  });

  it('does not hand over at its end when a damocles --wait started while the daemon listed its runs', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver', 'runs.cliWaits'], [terminal('term-1', 'bash')]);
    old.setDevices(OTHER_COMPUTER);
    const request = old.connection.control.request as unknown as ReturnType<typeof vi.fn>;
    const answer = request.getMockImplementation() as (method: string, params: object) => Promise<unknown>;
    request.mockImplementationOnce(async (method: string, params: object) => {
      old.setRuns([terminal('term-1', 'bash')], ['COMMIT_EDITMSG']);
      return answer(method, params);
    });
    const { host, switched, lines } = followed(old);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(old.requests).toEqual(['listRuns']);
    expect(switched).toEqual([]);
    expect(lines).toContain('[update] not switching the daemon of 3.6.9+fedcba987654: it lists a run or a damocles --wait again');
    expect(host.update()).toMatchObject({ phase: 'waiting', cliWaits: 1 });
    host.dispose();
  });

  it('is cancelled by a new agent run and starts over once the runs end again', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], []);
    old.setDevices(OTHER_COMPUTER);
    const { host } = followed(old);
    expect(host.update()?.drainEndsAt).toBe(15 * MINUTE);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    old.setRuns([chat('host-2', 'Another turn')]);
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(old.requests).toEqual([]);
    old.setRuns([]);
    expect(host.update()?.drainEndsAt).toBe(55 * MINUTE);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    host.dispose();
  });

  it('ends when the other computers disconnect, and never starts while their number is unknown or the connection is lost', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], []);
    old.setDevices(OTHER_COMPUTER);
    const { host } = followed(old);
    old.setDevices([{ deviceName: 'laptop', self: true }]);
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    old.setDevices([]);
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    old.setDevices(OTHER_COMPUTER);
    expect(host.update()?.drainEndsAt).toBe(15 * MINUTE);
    old.lose();
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(old.requests).toEqual([]);
    host.dispose();
  });

  it('takes the e2e hook\'s length', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], []);
    old.setDevices(OTHER_COMPUTER);
    const { host } = followed(old, { drainMs: 4000 });
    expect(host.update()?.drainEndsAt).toBe(4000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    host.dispose();
  });

  it('never drains a legacy daemon, whose terminals would end', async () => {
    const old = compatibleConnection(['control.runs', 'clients'], []);
    old.setDevices(OTHER_COMPUTER);
    const { host } = followed(old);
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(old.requests).toEqual([]);
    host.dispose();
  });

  it('lists the runs again after the poll interval when the listing at its end failed, and hands over then', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], []);
    old.setDevices(OTHER_COMPUTER);
    vi.mocked(old.connection.control.request).mockRejectedValueOnce(new Error('The daemon did not answer'));
    const { host } = followed(old);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(old.requests).toEqual([]);
    expect(host.update()).toMatchObject({ phase: 'waiting', drainEndsAt: 15 * MINUTE });
    await vi.advanceTimersByTimeAsync(5000);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    expect(host.update()?.phase).toBe('switching');
    host.dispose();
  });

  it('waits for the first listing of a daemon that does not push its runs', async () => {
    const old = compatibleConnection(['clients', 'control.handOver'], [chat('host-1', 'Fix the parser')]);
    old.setDevices(OTHER_COMPUTER);
    const { host } = followed(old);
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    old.setRuns([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.update()?.drainEndsAt).toBe(5000 + 15 * MINUTE);
    host.dispose();
  });
});

describe('a required update\'s deadline', () => {
  it('counts from the first detection, and is kept for the same server version', () => {
    expect(requiredDeadline(undefined, '3.6.9+a', 24, 1000)).toEqual({ record: { serverVersion: '3.6.9+a', detectedAt: 1000, deadline: 1000 + 24 * HOUR }, deadline: 1000 + 24 * HOUR });
    const stored = { serverVersion: '3.6.9+a', detectedAt: 1000, deadline: 1000 + 24 * HOUR };
    expect(requiredDeadline(stored, '3.6.9+a', 24, 5 * HOUR)).toEqual({ record: stored, deadline: stored.deadline });
  });

  it('is only brought closer by a later requirement with a shorter grace, and starts over for another server version', () => {
    const stored = { serverVersion: '3.6.9+a', detectedAt: 0, deadline: 24 * HOUR };
    expect(requiredDeadline(stored, '3.6.9+a', 2, 5 * HOUR)).toEqual({ record: { ...stored, deadline: 7 * HOUR }, deadline: 7 * HOUR });
    expect(requiredDeadline(stored, '3.6.9+a', 72, 5 * HOUR).record).toEqual(stored);
    expect(requiredDeadline(stored, '3.6.8+b', 24, 5 * HOUR).record).toEqual({ serverVersion: '3.6.8+b', detectedAt: 5 * HOUR, deadline: 29 * HOUR });
  });

  it('missed while no app was connected, counts down 15 minutes from the connect, and the stored one does not move', () => {
    const stored = { serverVersion: '3.6.9+a', detectedAt: 0, deadline: 24 * HOUR };
    expect(requiredDeadline(stored, '3.6.9+a', 24, 30 * HOUR)).toEqual({ record: stored, deadline: 30 * HOUR + 15 * MINUTE });
    expect(requiredDeadline(stored, '3.6.9+a', 24, 24 * HOUR).deadline).toBe(24 * HOUR + 15 * MINUTE);
  });
});

describe('a compatible daemon that must switch', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());
  const required: ServerManifest = { ...manifest, requirement: { minimumServerVersion: '3.7.0', graceHours: 24 } };

  it('is stopped at once when the switch stops nothing, whatever other computers do', async () => {
    for (const others of [1, 'unknown'] as const) {
      const lines: string[] = [];
      const { daemon, calls } = compatible('3.6.9', [terminal('term-1', 'bash')], others, true, true);
      expect((await adoptCompatibleDaemon(required, daemon, (line) => lines.push(line))).outcome).toBe('replaceNow');
      expect(calls).toEqual(['handOver now']);
      expect(lines).toEqual([`[update] the daemon of 3.6.9 is idle and must switch, with ${others === 'unknown' ? 'an unknown number of' : others} other devices; stopping it for this build of 3.7.0`]);
    }
    const legacy = compatible('3.6.9', [], 2, false);
    expect((await adoptCompatibleDaemon(required, legacy.daemon, quiet)).outcome).toBe('replaceNow');
    expect(legacy.calls).toEqual(['shutdownNow']);
  });

  it('is never used as it is while it runs something: asked to exit once idle, though it does not wait for the other computers', async () => {
    const { daemon, calls } = compatible('3.6.9', [chat('host-1', 'busy')], 1, false);
    expect((await adoptCompatibleDaemon(required, daemon, quiet)).outcome).toBe('switchWhenIdle');
    expect(calls).toEqual(['shutdownWhenIdle']);
  });

  it('is required of nothing at the minimum, another build of it included, and never when it is newer than this app', async () => {
    const same = compatible('3.7.0+fedcba987654', [], 1);
    expect((await adoptCompatibleDaemon(required, same.daemon, quiet)).outcome).toBe('useAsIs');
    const newer = compatible('3.8.0+fedcba987654', [], 1);
    expect((await adoptCompatibleDaemon({ ...manifest, requirement: { minimumServerVersion: '3.7.0', graceHours: 24 } }, newer.daemon, quiet)).outcome).toBe('useAsIs');
    expect([...same.calls, ...newer.calls]).toEqual([]);
  });

  it('shows its deadline, counts down in the last 15 minutes, and is never drained', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [chat('host-1', 'Fix the parser')]);
    old.setDevices(OTHER_COMPUTER);
    const { host } = followed(old, { required: { deadline: 24 * HOUR } });
    expect(host.update()).toMatchObject({ phase: 'waiting', required: { deadline: 24 * HOUR, countdown: false } });
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    await vi.advanceTimersByTimeAsync(24 * HOUR - 15 * MINUTE - 1);
    expect(host.update()?.required).toEqual({ deadline: 24 * HOUR, countdown: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(host.update()?.required).toEqual({ deadline: 24 * HOUR, countdown: true });
    expect(old.requests).toEqual([]);
    host.dispose();
  });

  it('is switched at the deadline with no confirmation through handOver now, which stops its agents', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')]);
    const { host, switched, confirm, lines } = followed(old, { required: { deadline: 2 * HOUR } });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    expect(confirm).not.toHaveBeenCalled();
    expect(host.update()?.phase).toBe('switching');
    expect(switched).toEqual([{ agentsStopped: 1, terminalsClosed: 0, forcedAt: 2 * HOUR }]);
    expect(lines).toContain('[update] switching from the daemon of 3.6.9+fedcba987654 at its deadline: 1 runs and 0 damocles --wait requests stop');
    host.dispose();
  });

  it('waits for a pending damocles --wait as for an agent, and its deadline ends the wait', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver', 'runs.cliWaits'], [terminal('term-1', 'bash')], ['COMMIT_EDITMSG']);
    const { host, switched } = followed(old, { required: { deadline: 2 * HOUR } });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(old.requests).toEqual([]);
    expect(host.update()).toMatchObject({ phase: 'waiting', cliWaits: 1 });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    expect(switched).toEqual([{ agentsStopped: 0, terminalsClosed: 0, cliWaitsEnded: 1, forcedAt: 2 * HOUR }]);
    host.dispose();
  });

  it('is switched the moment its last damocles --wait ends', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver', 'runs.cliWaits'], [], ['COMMIT_EDITMSG']);
    const { host, switched } = followed(old, { required: { deadline: 24 * HOUR } });
    await vi.advanceTimersByTimeAsync(0);
    expect(old.requests).toEqual([]);
    old.setRuns([], []);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    expect(switched).toEqual([{ agentsStopped: 0, terminalsClosed: 0 }]);
    host.dispose();
  });

  it('that is legacy is switched at the deadline through shutdownNow, which closes its terminals too', async () => {
    const old = compatibleConnection(['control.runs', 'clients'], [chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')]);
    const { host, switched } = followed(old, { required: { deadline: 2 * HOUR } });
    expect(host.update()).toMatchObject({ terminalsSurvive: false, runningTerminals: 1, required: { deadline: 2 * HOUR, countdown: false } });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(old.requests).toEqual(['listRuns', 'shutdownNow']);
    expect(switched).toEqual([{ agentsStopped: 1, terminalsClosed: 1, forcedAt: 2 * HOUR }]);
    host.dispose();
  });

  it('is switched the moment its last agent ends, other computers connected or not, and that is not forced', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')]);
    old.setDevices(OTHER_COMPUTER);
    const { host, switched } = followed(old, { required: { deadline: 24 * HOUR } });
    old.setRuns([terminal('term-1', 'bash')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    expect(switched).toEqual([{ agentsStopped: 0, terminalsClosed: 0 }]);
    host.dispose();
  });

  it('hands over at the drain\'s end only when the daemon then lists no agent run, else follows the run it lists', async () => {
    const old = compatibleConnection(['clients', 'control.handOver'], [terminal('term-1', 'bash')]);
    old.setDevices(OTHER_COMPUTER);
    const { host, switched } = followed(old, { drainMs: 2500 });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.update()?.drainEndsAt).toBe(2500);
    // an agent starts between two polls, before the drain ends
    await vi.advanceTimersByTimeAsync(1000);
    old.setRuns([chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(old.requests).not.toContain('handOver now');
    expect(switched).toEqual([]);
    expect(host.update()).toMatchObject({ phase: 'waiting', runningAgents: 1 });
    expect(host.update()).not.toHaveProperty('drainEndsAt');
    host.dispose();
  });

  it('waits since the time the authority kept, an earlier run\'s included, which its reminders count from', () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [chat('host-1', 'Fix the parser')]);
    const { host } = followed(old, { waitingSince: -3 * HOUR });
    expect(host.update()?.waitingSince).toBe(-3 * HOUR);
    host.dispose();
  });

  it('marks a switch the user confirmed as chosen, so its result is told even when it stopped nothing', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [terminal('term-1', 'bash')]);
    old.setDevices(OTHER_COMPUTER);
    const { host, switched } = followed(old);
    const switching = host.switchNow();
    await vi.waitFor(() => expect(old.requests).toContain('handOver now'));
    old.lose();
    await switching;
    expect(switched).toEqual([{ agentsStopped: 0, terminalsClosed: 0, chosen: true }]);
    host.dispose();
  });

  it('counts down at once when its grace is shorter than the countdown, and after a missed deadline', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [chat('host-1', 'Fix the parser')]);
    const { host } = followed(old, { required: { deadline: 36_000 } });
    expect(host.update()?.required).toEqual({ deadline: 36_000, countdown: true });
    await vi.advanceTimersByTimeAsync(35_999);
    expect(old.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    host.dispose();

    vi.setSystemTime(30 * HOUR);
    const missed = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [chat('host-1', 'Fix the parser')]);
    const { deadline } = requiredDeadline({ serverVersion: '3.6.9+fedcba987654', detectedAt: 0, deadline: 24 * HOUR }, '3.6.9+fedcba987654', 24, Date.now());
    const late = followed(missed, { required: { deadline } });
    expect(late.host.update()?.required).toEqual({ deadline: 30 * HOUR + 15 * MINUTE, countdown: true });
    await vi.advanceTimersByTimeAsync(15 * MINUTE - 1);
    expect(missed.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(missed.requests).toEqual(['listRuns', 'handOver now']);
    late.host.dispose();
  });

  it('arms a deadline further away than a timer can wait', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [chat('host-1', 'Fix the parser')]);
    const deadline = 2 ** 31 + HOUR;
    const { host } = followed(old, { required: { deadline } });
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
    expect(old.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(HOUR + 1);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    host.dispose();
  });

  it('sends the deadline\'s switch again when the daemon refused it, after publishing its phase and withdrawing its result', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [chat('host-1', 'Fix the parser')]);
    const request = old.connection.control.request as unknown as ReturnType<typeof vi.fn>;
    const answer = request.getMockImplementation() as (method: string, params: { when?: string }) => Promise<unknown>;
    let refusals = 1;
    request.mockImplementation(async (method: string, params: { when?: string }) => {
      if (method === 'handOver' && refusals-- > 0) throw new Error('The daemon refused');
      return answer(method, params);
    });
    const { host, switched } = followed(old, { required: { deadline: HOUR } });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(host.update()?.phase).toBe('waiting');
    expect(switched).toEqual([{ agentsStopped: 1, terminalsClosed: 0, forcedAt: HOUR }, undefined]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(old.requests).toEqual(['listRuns', 'listRuns', 'handOver now']);
    expect(host.update()?.phase).toBe('switching');
    expect(switched).toEqual([{ agentsStopped: 1, terminalsClosed: 0, forcedAt: HOUR }, undefined, { agentsStopped: 1, terminalsClosed: 0, forcedAt: HOUR + 5000 }]);
    host.dispose();
  });

  // macOS and Linux stop a timer's clock during sleep, as fake timers keep it across setSystemTime
  it('switches on a resume after the wall clock passed its deadline while the computer slept', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [chat('host-1', 'Fix the parser')]);
    const { host } = followed(old, { required: { deadline: 2 * HOUR } });
    vi.setSystemTime(3 * HOUR);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.requests).toEqual([]);
    host.resumed();
    await vi.advanceTimersByTimeAsync(0);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    expect(host.update()).toMatchObject({ phase: 'switching', required: { deadline: 2 * HOUR, countdown: true } });
    host.dispose();
  });

  it('sends the switch again when the deadline passed while its connection did not answer', async () => {
    const old = compatibleConnection(['control.runs', 'clients', 'control.handOver'], [chat('host-1', 'Fix the parser')]);
    const { host } = followed(old, { required: { deadline: HOUR } });
    const request = vi.mocked(old.connection.control.request);
    request.mockRejectedValueOnce(new Error('The connection is lost'));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(old.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(old.requests).toEqual(['listRuns', 'handOver now']);
    host.dispose();
  });
});

describe('a daemon of another protocol that must switch', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  function follow(daemon: OtherProtocolDaemon, deadline: number) {
    const switched: Array<SwitchResult | undefined> = [];
    const confirm = vi.fn(async () => true);
    const host = followOtherProtocolDaemon({ daemon, syncMirror: async () => undefined, changed: quiet, reconnect: quiet, ended: quiet, confirm, targetVersion: '3.7.0', pollMs: 5000, waitingSince: 0, log: quiet, required: Promise.resolve({ deadline }), switched: (result) => switched.push(result) });
    return { host, switched, confirm };
  }

  it('offers the switch with its deadline, counts down, and is switched at the deadline with no confirmation', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')], ['control.handOver']);
    const { host, switched, confirm } = follow(old.daemon, HOUR);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.update()).toMatchObject({ source: 'otherProtocol', phase: 'offer', required: { deadline: HOUR, countdown: false } });
    await vi.advanceTimersByTimeAsync(45 * MINUTE);
    expect(host.update()?.required).toEqual({ deadline: HOUR, countdown: true });
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(old.requests.filter((method) => method !== 'listRuns')).toEqual(['handOver now']);
    expect(host.update()?.phase).toBe('switching');
    expect(switched).toEqual([{ agentsStopped: 1, terminalsClosed: 0, forcedAt: HOUR }]);
    expect(confirm).not.toHaveBeenCalled();
    host.dispose();
  });

  it('that is legacy is switched at the deadline through shutdownNow, and at once when its last run ends', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')]);
    const { host, switched } = follow(old.daemon, HOUR);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(old.requests.filter((method) => method !== 'listRuns')).toEqual(['shutdownNow']);
    expect(switched).toEqual([{ agentsStopped: 1, terminalsClosed: 1, forcedAt: HOUR }]);
    host.dispose();

    const idle = otherProtocol([chat('host-1', 'Fix the parser')]);
    const next = follow(idle.daemon, 24 * HOUR);
    await vi.advanceTimersByTimeAsync(0);
    idle.setRuns([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(idle.requests.filter((method) => method !== 'listRuns')).toEqual(['shutdownNow']);
    expect(next.switched).toEqual([]);
    next.host.dispose();
  });

  it('publishes its first update with its requirement, though that is read after its runs', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser')], ['control.handOver']);
    let settle!: (found: { readonly deadline: number }) => void;
    const changes: Array<HostUpdate | undefined> = [];
    const host: PendingSwitch = followOtherProtocolDaemon({ daemon: old.daemon, syncMirror: async () => undefined, changed: () => changes.push(host.update()), reconnect: quiet, ended: quiet, confirm: async () => true, targetVersion: '3.7.0', pollMs: 5000, waitingSince: 0, log: quiet, required: new Promise((resolve) => (settle = resolve)) });
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([]);
    settle({ deadline: 10 * HOUR });
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toMatchObject([{ phase: 'offer', runningAgents: 1, required: { deadline: 10 * HOUR, countdown: false } }]);
    host.dispose();
  });

  it('offers the switch again when the daemon refused the deadline\'s switch, withdraws its result, and sends it again', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser')], ['control.handOver']);
    const request = old.daemon.control.request as unknown as ReturnType<typeof vi.fn>;
    const answer = request.getMockImplementation() as (method: string, params: { when?: string }) => Promise<unknown>;
    let refusals = 1;
    request.mockImplementation(async (method: string, params: { when?: string }) => {
      if (method === 'handOver' && refusals-- > 0) throw new Error('The daemon refused');
      return answer(method, params);
    });
    const { host, switched } = follow(old.daemon, HOUR);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(host.update()?.phase).toBe('offer');
    expect(switched).toEqual([{ agentsStopped: 1, terminalsClosed: 0, forcedAt: HOUR }, undefined]);
    expect(old.requests).not.toContain('handOver now');
    await vi.advanceTimersByTimeAsync(5000);
    expect(old.requests).toContain('handOver now');
    expect(host.update()?.phase).toBe('switching');
    expect(switched).toHaveLength(3);
    host.dispose();
  });

  it('switches on a resume after the wall clock passed its deadline while the computer slept', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser')], ['control.handOver']);
    const { host } = follow(old.daemon, 2 * HOUR);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(3 * HOUR);
    host.resumed();
    await vi.advanceTimersByTimeAsync(0);
    expect(old.requests).toContain('handOver now');
    expect(host.update()).toMatchObject({ phase: 'switching', required: { deadline: 2 * HOUR, countdown: true } });
    host.dispose();
  });

  it('newer than this app, is never required to switch', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser')]);
    const host = followOtherProtocolDaemon({ daemon: { ...old.daemon, serverVersion: '3.8.0' }, syncMirror: async () => undefined, changed: quiet, reconnect: quiet, ended: quiet, confirm: async () => true, targetVersion: '3.7.0', pollMs: 5000, waitingSince: 0, log: quiet, required: Promise.resolve({ deadline: HOUR }) });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(host.update()).toMatchObject({ phase: 'appOutdated' });
    expect(host.update()).not.toHaveProperty('required');
    expect(old.requests.filter((method) => method !== 'listRuns')).toEqual([]);
    host.dispose();
  });
});

describe('a host whose security floor is above this app', () => {
  it('shows that this app must update, with the floor as the version the host needs, and refuses both switches', async () => {
    vi.useFakeTimers({ now: 5000 });
    const host = belowFloorSwitch('3.9.0', '3.7.0');
    vi.useRealTimers();
    expect(host.update()).toEqual({ source: 'otherProtocol', phase: 'appOutdated', outdated: 'floor', serverVersion: '3.9.0', targetVersion: '3.7.0', runningAgents: 0, runningTerminals: 0, terminalsSurvive: true, waitingSince: 5000 });
    expect(host.following()).toBeUndefined();
    await expect(host.switchNow()).rejects.toThrow('needs Damocles 3.9.0 or later');
    await expect(host.switchWhenIdle()).rejects.toThrow('needs Damocles 3.9.0 or later');
    host.stateChanged('failed');
    expect(host.update()?.phase).toBe('appOutdated');
  });
});

describe('the pending switches of every authority', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function start(pending: PendingSwitches, authorityKey: string, daemon: OtherProtocolDaemon) {
    const reconnect = vi.fn();
    pending.follow(authorityKey, (ended) => followOtherProtocolDaemon({
      daemon,
      syncMirror: async () => undefined,
      changed: quiet,
      reconnect,
      ended,
      confirm: async () => true,
      targetVersion: '3.7.0',
      pollMs: 5000, waitingSince: 0,
      log: quiet,
    }));
    return reconnect;
  }

  it('lets go of every flow at the quit, so the old daemons closing with the connections connect nothing', async () => {
    const pending = new PendingSwitches();
    const first = otherProtocol([chat('host-1', 'Fix the parser')]);
    const second = otherProtocol([terminal('term-1', 'bash')]);
    const reconnects = [start(pending, 'ssh+h1', first.daemon), start(pending, 'ssh+h2', second.daemon)];
    await vi.advanceTimersByTimeAsync(0);
    pending.dispose();
    first.exit();
    second.exit();
    expect(reconnects.map((reconnect) => reconnect.mock.calls.length)).toEqual([0, 0]);
    expect(first.daemon.close).toHaveBeenCalled();
    expect(pending.has('ssh+h1') || pending.has('ssh+h2')).toBe(false);
  });

  it('Forget host lets go of that host\'s flow alone', async () => {
    const pending = new PendingSwitches();
    const forgotten = otherProtocol([chat('host-1', 'Fix the parser')]);
    const kept = otherProtocol([chat('host-2', 'Write docs')]);
    const reconnects = [start(pending, 'ssh+h1', forgotten.daemon), start(pending, 'ssh+h2', kept.daemon)];
    await vi.advanceTimersByTimeAsync(0);
    pending.forget('ssh+h1');
    forgotten.exit();
    kept.exit();
    expect(reconnects.map((reconnect) => reconnect.mock.calls.length)).toEqual([0, 1]);
    expect(pending.has('ssh+h1')).toBe(false);
    // the kept host's offer ended with its daemon's exit
    expect(pending.has('ssh+h2')).toBe(false);
  });

  it('keeps a switch past its daemon\'s exit until the next connect of that authority settles, and hands it the authority\'s states', async () => {
    const pending = new PendingSwitches();
    const old = otherProtocol([chat('host-1', 'Fix the parser')]);
    start(pending, 'ssh+h1', old.daemon);
    await vi.advanceTimersByTimeAsync(0);
    await pending.get('ssh+h1')!.switchWhenIdle();
    old.exit();
    expect(pending.get('ssh+h1')?.update()?.phase).toBe('switching');
    pending.stateChanged('ssh+h2', 'connecting');
    pending.stateChanged('ssh+h2', 'failed');
    expect(pending.has('ssh+h1')).toBe(true);
    pending.stateChanged('ssh+h1', 'connecting');
    pending.stateChanged('ssh+h1', 'failed');
    expect(pending.has('ssh+h1')).toBe(false);
  });

  it('replaces an authority\'s flow, and keeps none whose daemon closed before it started', async () => {
    const pending = new PendingSwitches();
    const before = otherProtocol([chat('host-1', 'Fix the parser')]);
    const after = otherProtocol([chat('host-1', 'Fix the parser')]);
    const reconnects = [start(pending, 'ssh+h1', before.daemon), start(pending, 'ssh+h1', after.daemon)];
    before.exit();
    expect(reconnects[0]).not.toHaveBeenCalled();
    expect(pending.get('ssh+h1')?.following()).toBe(after.daemon);
    after.exit();
    expect(pending.has('ssh+h1')).toBe(false);
    const closed = otherProtocol([]);
    const closedDaemon = { ...closed.daemon, onClose: (listener: (reason: string) => void) => {
      listener('already closed');
      return { dispose: () => undefined };
    } } as OtherProtocolDaemon;
    start(pending, 'ssh+h1', closedDaemon);
    expect(pending.has('ssh+h1')).toBe(false);
  });
});

describe('the reminders of a switch the app follows', () => {
  beforeEach(() => vi.useFakeTimers({ now: 10 * HOUR }));
  afterEach(() => vi.useRealTimers());
  const english = (message: string, ...args: string[]): string => message.replace(/\{(\d)\}/g, (_match, index: string) => args[Number(index)]!);

  // a relaunch the morning after the switch started waiting: its first reminder is due at once
  it('name the runs the daemon listed when it was asked, though it pushes none and its poll has not answered', async () => {
    const old = compatibleConnection(['clients'], [chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')]);
    (old.connection.control.request as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => undefined));
    const reminded: string[] = [];
    const reminders = createSwitchReminders({
      wording: () => ({ t: english, hostName: 'prod-1', time: () => '', now: Date.now() }),
      remind: (_authority, notice) => reminded.push(notice.message),
      countDown: () => ({ withdraw: quiet }),
      switched: quiet,
      log: quiet,
    });
    const host: PendingSwitch = followCompatibleDaemon({ connection: old.connection, runs: old.listed(), targetVersion: '3.7.0', changed: () => reminders.changed('ssh+prod-1', host.update()), ended: quiet, confirm: async () => true, pollMs: 5000, waitingSince: 8 * HOUR, log: quiet });
    reminders.changed('ssh+prod-1', host.update());
    reminders.connected('ssh+prod-1', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(reminded).toEqual(['Damocles 3.7.0 waits for 1 agent to finish. Its terminal closes too.']);
    host.dispose();
    reminders.dispose();
  });
});

describe('the server in use notice', () => {
  it('names the daemon\'s app version and the other computers using it, and is absent while none or an unknown number do', () => {
    const daemon = (devices: readonly AttachedClient[]) => ({ serverVersion: '3.6.9+fedcba987654', devices: () => devices });
    expect(serverInUseNotice(daemon([{ deviceName: 'laptop', self: true }, { deviceName: 'desktop', self: false }]))).toEqual({ code: 'serverInUse', params: { version: '3.6.9', devices: 1 } });
    expect(serverInUseNotice(daemon([{ deviceName: 'laptop', self: true }]))).toBeUndefined();
    expect(serverInUseNotice(daemon([]))).toBeUndefined();
  });
});

describe('the other devices of a daemon', () => {
  it('are unknown until the daemon listed this device, as one without the clients feature never does', () => {
    expect(otherDeviceCount([])).toBeUndefined();
    expect(otherDeviceCount([{ deviceName: 'laptop', self: true }])).toBe(0);
    expect(otherDeviceCount([{ deviceName: 'laptop', self: true }, { deviceName: 'desktop', self: false }])).toBe(1);
  });

  it('when unknown, an idle daemon is asked to exit once idle, never stopped at once', async () => {
    const { daemon, calls } = compatible('3.6.9', []);
    expect((await adoptCompatibleDaemon(manifest, { ...daemon, otherDevices: () => otherDeviceCount([]) }, quiet)).outcome).toBe('switchWhenIdle');
    expect(calls).toEqual(['shutdownWhenIdle']);
  });
});

describe('shutting a daemon down now', () => {
  function connection() {
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    };
    const value = { control: { request: vi.fn(async () => undefined) }, onClose: subscribe, onLost: subscribe };
    return { value: value as unknown as Parameters<typeof shutDownNow>[0], listeners, end: () => { for (const listener of [...listeners]) listener(); } };
  }

  it('settles once the daemon ended the connection, and keeps no listener on it', async () => {
    const { value, listeners, end } = connection();
    let done = false;
    const shutting = shutDownNow(value, () => undefined).then(() => { done = true; });
    await vi.waitFor(() => expect(value.control.request).toHaveBeenCalledWith('shutdownNow', {}));
    expect(done).toBe(false);
    end();
    await shutting;
    expect(listeners.size).toBe(0);
  });

  it('stops waiting for a daemon that answered but never ended the connection', async () => {
    vi.useFakeTimers();
    try {
      const { value, listeners } = connection();
      const lines: string[] = [];
      let done = false;
      void shutDownNow(value, (line) => lines.push(line), 500).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(500);
      expect(done).toBe(true);
      expect(listeners.size).toBe(0);
      expect(lines).toEqual(['[update] the daemon answered shutdownNow but did not end the connection within 500 ms']);
    } finally {
      vi.useRealTimers();
    }
  });
});
