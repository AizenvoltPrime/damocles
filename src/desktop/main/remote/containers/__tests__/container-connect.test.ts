import { describe, expect, it, vi } from 'vitest';
import type { ContainerCliResult, ContainerEngineResult } from '../../../../daemon/control-messages';
import type { ContainerFound, ContainerHostRecord } from '../../host-store';
import { SshConnectError } from '../../ssh/ssh-transport';
import { connectContainer, passGate, type ContainerConnectDeps } from '../container-connect';
import type { ContainerSide } from '../container-side';
import type { ContainerTransportOptions } from '../container-transport';
import { DevcontainerTrustError, type DevcontainerTrustVerdict } from '../devcontainer-trust';

// the transport is the real one; each start's options are kept, so a test sees whether stage 1 links the data folder
const transports = vi.hoisted(() => [] as { dataFolder: boolean }[]);
vi.mock('../container-transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../container-transport')>();
  return {
    ...actual,
    startContainerTransport: (options: ContainerTransportOptions) => {
      transports.push({ dataFolder: options.dataFolder });
      return actual.startContainerTransport(options);
    },
  };
});
const OLD = 'aa'.repeat(32);
const NEW = 'bb'.repeat(32);
const KEY = 'c'.repeat(32);

const devcontainer: ContainerHostRecord = {
  id: 'h1', kind: 'container', key: KEY, engine: 'docker', origin: 'devcontainer', workspaceFolder: 'C:\\work\\app', configPath: 'C:\\work\\app\\.devcontainer\\devcontainer.json',
  containerId: OLD, remoteUser: 'node', name: 'app', recentFolders: [], settings: {},
};
const attached: ContainerHostRecord = { id: 'h2', kind: 'container', key: KEY, engine: 'docker', origin: 'attach', containerName: 'web', user: 'configured', name: 'web', recentFolders: [], settings: {} };

const DATA_MOUNT = { Type: 'volume', Name: `damocles-data-${KEY}`, Source: '/var/lib/docker/volumes/x/_data', Destination: '/var/lib/damocles-data' };
const inspected = (id: string, running: boolean, config: Record<string, unknown> = {}, mounts: readonly unknown[] = [DATA_MOUNT], state: Record<string, unknown> = {}): string => JSON.stringify([{ Id: id, Name: '/web', State: { Running: running, ...state }, Config: { Image: 'node:24', User: '', Labels: {}, ...config }, Mounts: mounts }]);
const ran = (stdout: string, code = 0): ContainerEngineResult => ({ result: 'ran', code, stdout, stderr: '' });

interface Script {
  inspect?: (ids: readonly string[]) => ContainerEngineResult;
  list?: () => ContainerEngineResult;
  up?: () => ContainerCliResult;
  chown?: () => ContainerEngineResult;
  verdict?: DevcontainerTrustVerdict | Error;
  watched?: boolean;
  signal?: AbortSignal;
  // runs while the gate runs, before its verdict
  duringGate?: () => void;
}

// Every engine and CLI call in order; exec ends the connect, since the transport itself has its own tests.
function harness(script: Script): { deps: ContainerConnectDeps; calls: string[]; found: ContainerFound[] } {
  const calls: string[] = [];
  const found: ContainerFound[] = [];
  const side: ContainerSide = {
    via: undefined,
    config: async () => null,
    up: async (_target, dataKey, removeExisting) => {
      calls.push(`up ${dataKey} ${removeExisting}`);
      return script.up?.() ?? { result: 'ran', code: 0, stdout: JSON.stringify({ outcome: 'success', containerId: NEW, remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/app' }) };
    },
    prepareData: async (_engine, id, user) => {
      calls.push(`chown ${id.slice(0, 2)} ${user}`);
      return script.chown?.() ?? ran('');
    },
    readConfiguration: async () => ({ result: 'ran', code: 0, stdout: '{}' }),
    list: async () => {
      calls.push('list');
      return script.list?.() ?? ran('');
    },
    inspect: async (_engine, ids) => {
      calls.push(`inspect ${ids.map((id) => id.slice(0, 2)).join(',')}`);
      return script.inspect?.(ids) ?? ran(inspected(ids[0]!, true));
    },
    exec: async (_engine, id, user) => {
      calls.push(`exec ${id.slice(0, 2)} ${user}`);
      return 'engineMissing';
    },
    copyPackage: async () => 'copied',
  };
  const deps: ContainerConnectDeps = {
    side,
    install: async () => ({ manifest: { version: '3.7.0', packages: {} } as never, artifacts: { packageFolder: () => '', packagePath: async () => '' }, releasesUrl: 'https://example.invalid' }),
    gate: async () => {
      calls.push('gate');
      script.duringGate?.();
      if (script.verdict instanceof Error) throw script.verdict;
      return script.verdict ?? 'proceed';
    },
    recordContainer: async (value) => {
      found.push(value);
    },
    dataVolumeMissing: () => calls.push('notice'),
    hooks: { step: (step) => calls.push(`step ${step}`), progress: () => undefined, notice: () => undefined, buildLog: () => undefined },
    signal: script.signal ?? new AbortController().signal,
    watched: () => script.watched ?? true,
    installFolderSettled: async () => undefined,
    log: () => undefined,
  };
  return { deps, calls, found };
}

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  const err = await promise.then(() => undefined, (error: unknown) => error);
  return err instanceof SshConnectError ? err.code : String(err);
};

describe('a container connect', () => {
  it('joins a recorded devcontainer that runs as it is, with no gate and no up', async () => {
    const { deps, calls } = harness({});
    expect(await codeOf(connectContainer(deps, devcontainer))).toBe('containerEngineMissing');
    expect(calls).toEqual(['inspect aa', 'step connecting', 'exec aa node']);
  });

  it('builds a stopped or missing devcontainer after the gate, with the key\'s data volume, and records the new container', async () => {
    for (const inspect of [() => ran(inspected(OLD, false)), () => ran('', 1)]) {
      const { deps, calls, found } = harness({ inspect: (ids) => (ids[0] === OLD ? inspect() : ran(inspected(ids[0]!, true))) });
      await codeOf(connectContainer(deps, devcontainer));
      expect(calls).toEqual(['inspect aa', 'step building', 'gate', `up ${KEY} false`, 'inspect bb', 'chown bb node', 'step connecting', 'exec bb node']);
      expect(found).toEqual([{ containerId: NEW, remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/app', image: 'node:24' }]);
    }
  });

  it('runs nothing past a gate that refuses, and names why', async () => {
    const stopped = { inspect: () => ran(inspected(OLD, false)) };
    for (const [verdict, code] of [['folderUntrusted', 'folderUntrusted'], ['configRefused', 'configRefused'], [new DevcontainerTrustError('composeUnsupported', 'compose'), 'composeUnsupported'], [new DevcontainerTrustError('tooLarge', 'too large'), 'devcontainerFailed']] as const) {
      const { deps, calls } = harness({ ...stopped, verdict });
      expect(await codeOf(connectContainer(deps, devcontainer))).toBe(code);
      expect(calls).toEqual(['inspect aa', 'step building', 'gate']);
    }
    await expect(passGate(async () => 'proceed', '/f')).resolves.toBeUndefined();
  });

  it('never runs the gate or up for a stopped devcontainer nobody watches, and names what it needs', async () => {
    const { deps, calls } = harness({ inspect: () => ran(inspected(OLD, false)), watched: false });
    expect(await codeOf(connectContainer(deps, devcontainer))).toBe('containerNeedsBuild');
    expect(calls).toEqual(['inspect aa']);
    // a running one is joined whoever waits
    const running = harness({ watched: false });
    await codeOf(connectContainer(running.deps, devcontainer));
    expect(running.calls).toEqual(['inspect aa', 'step connecting', 'exec aa node']);
  });

  it('runs no up once the attempt was cancelled during the gate, and maps the gate\'s own cancel and unwatched verdicts', async () => {
    const controller = new AbortController();
    const { deps, calls } = harness({ inspect: () => ran(inspected(OLD, false)), signal: controller.signal, duringGate: () => controller.abort() });
    expect(await codeOf(connectContainer(deps, devcontainer))).toBe('cancelled');
    expect(calls).toEqual(['inspect aa', 'step building', 'gate']);
    expect(await codeOf(passGate(async () => 'cancelled', '/f'))).toBe('cancelled');
    expect(await codeOf(passGate(async () => 'needsUser', '/f'))).toBe('containerNeedsBuild');
  });

  it('fails with the CLI\'s message when up fails, before any exec', async () => {
    const { deps, calls } = harness({ inspect: () => ran('', 1), up: () => ({ result: 'ran', code: 1, stdout: JSON.stringify({ outcome: 'error', message: 'build failed' }) }) });
    const err = await connectContainer(deps, devcontainer).catch((error: unknown) => error);
    expect(err).toMatchObject({ code: 'devcontainerFailed', params: { message: 'build failed' } });
    expect(calls).not.toContain('step connecting');
  });

  it('connects to a container up reused without the data volume: no chown, no data link, and the notice once per container', async () => {
    const stoppedOld = (ids: readonly string[]): ContainerEngineResult => (ids[0] === OLD ? ran(inspected(OLD, false)) : ran(inspected(ids[0]!, true, {}, [])));
    transports.length = 0;
    const first = harness({ inspect: stoppedOld });
    await codeOf(connectContainer(first.deps, devcontainer));
    expect(first.calls).toEqual(['inspect aa', 'step building', 'gate', `up ${KEY} false`, 'inspect bb', 'notice', 'step connecting', 'exec bb node']);
    expect(first.found).toEqual([{ containerId: NEW, remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/app', image: 'node:24', withoutDataVolume: true, dataNoticeShown: NEW }]);
    expect(transports).toEqual([{ dataFolder: false }]);
    // the same container stopped and started again by up: told already
    const recorded: ContainerHostRecord = { ...devcontainer, ...first.found[0] };
    const again = harness({ inspect: (ids) => (ids[0] === NEW && again.calls.filter((call) => call === 'inspect bb').length === 1 ? ran(inspected(NEW, false, {}, [])) : ran(inspected(ids[0]!, true, {}, []))) });
    await codeOf(connectContainer(again.deps, recorded));
    expect(again.calls).toEqual(['inspect bb', 'step building', 'gate', `up ${KEY} false`, 'inspect bb', 'step connecting', 'exec bb node']);
    expect(again.found).toEqual([{ containerId: NEW, remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/app', image: 'node:24', withoutDataVolume: true }]);
    // joined as it runs: still no data link
    const joined = harness({ inspect: (ids) => ran(inspected(ids[0]!, true, {}, [])) });
    await codeOf(connectContainer(joined.deps, recorded));
    expect(joined.calls).toEqual(['inspect bb', 'step connecting', 'exec bb node']);
    expect(transports.at(-1)).toEqual({ dataFolder: false });
    // a new container without the volume (VS Code rebuilt it) is told once more
    const OTHER = 'dd'.repeat(32);
    const rebuilt = harness({ inspect: (ids) => (ids[0] === NEW ? ran('', 1) : ran(inspected(ids[0]!, true, {}, []))), up: () => ({ result: 'ran', code: 0, stdout: JSON.stringify({ outcome: 'success', containerId: OTHER, remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/app' }) }) });
    await codeOf(connectContainer(rebuilt.deps, recorded));
    expect(rebuilt.calls).toContain('notice');
    expect(rebuilt.found.at(-1)).toMatchObject({ containerId: OTHER, dataNoticeShown: OTHER });
  });

  it('links the data folder only for a container that mounts the key\'s volume at its folder, and never tells about it', async () => {
    const elsewhere = { ...DATA_MOUNT, Destination: '/data' };
    const otherVolume = { ...DATA_MOUNT, Name: 'damocles-data-'.concat('e'.repeat(32)) };
    const bind = { ...DATA_MOUNT, Type: 'bind' };
    for (const mounts of [[elsewhere], [otherVolume], [bind]]) {
      const { deps, calls } = harness({ inspect: (ids) => (ids[0] === OLD ? ran('', 1) : ran(inspected(ids[0]!, true, {}, mounts))) });
      await codeOf(connectContainer(deps, devcontainer));
      expect(calls).not.toContain('chown bb node');
      expect(calls).toContain('notice');
    }
    transports.length = 0;
    const { deps, calls, found } = harness({ inspect: (ids) => (ids[0] === OLD ? ran('', 1) : ran(inspected(ids[0]!, true))) });
    await codeOf(connectContainer(deps, devcontainer));
    expect(calls).toContain('chown bb node');
    expect(calls).not.toContain('notice');
    expect(found).toEqual([{ containerId: NEW, remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/app', image: 'node:24' }]);
    expect(transports).toEqual([{ dataFolder: true }]);
  });

  it('names a paused container, recorded or attached, and runs nothing in it', async () => {
    const recorded = harness({ inspect: () => ran(inspected(OLD, true, {}, [DATA_MOUNT], { Paused: true })) });
    expect(await connectContainer(recorded.deps, devcontainer).catch((err: unknown) => err)).toMatchObject({ code: 'containerPaused', params: { container: 'web', engine: 'docker' } });
    expect(recorded.calls).toEqual(['inspect aa']);
    const row = JSON.stringify({ ID: NEW, Names: 'web', Image: 'node:24', Status: 'Up (Paused)', State: 'paused' });
    const attachedPaused = harness({ list: () => ran(row) });
    expect(await connectContainer(attachedPaused.deps, attached).catch((err: unknown) => err)).toMatchObject({ code: 'containerPaused', params: { container: 'web', engine: 'docker' } });
    expect(attachedPaused.calls).toEqual(['list']);
  });

  it('shows engine stderr and trust messages without bidi or control characters', async () => {
    const hostile = 'evil\u202Etxt.exe\u0007\u001b[31m red\nnext';
    const gate = harness({ inspect: () => ran(inspected(OLD, false)), verdict: new DevcontainerTrustError('malformed', `features["${hostile}"] is not a string`) });
    expect(await connectContainer(gate.deps, devcontainer).catch((err: unknown) => err)).toMatchObject({ code: 'devcontainerFailed', params: { message: 'features["eviltxt.exe red next"] is not a string' } });
    const listed = harness({ list: () => ({ result: 'ran', code: 1, stdout: '', stderr: hostile }) });
    expect(await connectContainer(listed.deps, attached).catch((err: unknown) => err)).toMatchObject({ code: 'devcontainerFailed', params: { message: 'eviltxt.exe red next' } });
    const chown = harness({ inspect: (ids) => (ids[0] === OLD ? ran('', 1) : ran(inspected(ids[0]!, true))), chown: () => ({ result: 'ran', code: 1, stdout: '', stderr: hostile }) });
    expect(await connectContainer(chown.deps, devcontainer).catch((err: unknown) => err)).toMatchObject({ code: 'devcontainerFailed', params: { message: 'giving node the data folder failed: eviltxt.exe red next' } });
  });

  it('attaches a running container by its name as its configured user or root, and refuses a stopped one or a user no exec takes', async () => {
    const row = (state: string): string => JSON.stringify({ ID: NEW, Names: 'web', Image: 'node:24', Status: 'Up', State: state });
    const run = harness({ list: () => ran(row('running')), inspect: () => ran(inspected(NEW, true, { User: 'app' })) });
    await codeOf(connectContainer(run.deps, attached));
    expect(run.calls).toEqual(['list', 'inspect bb', 'step connecting', 'exec bb app']);
    expect(run.found).toEqual([{ containerId: NEW, image: 'node:24' }]);
    const root = harness({ list: () => ran(row('running')), inspect: () => ran(inspected(NEW, true, { User: 'app' })) });
    await codeOf(connectContainer(root.deps, { ...attached, user: 'root' }));
    expect(root.calls.at(-1)).toBe('exec bb root');
    const stopped = harness({ list: () => ran(row('exited')) });
    expect(await codeOf(connectContainer(stopped.deps, attached))).toBe('containerNotRunning');
    const refused = harness({ list: () => ran(row('running')), inspect: () => ran(inspected(NEW, true, { User: '-u root' })) });
    expect(await codeOf(connectContainer(refused.deps, attached))).toBe('devcontainerFailed');
    expect(refused.calls).not.toContain('exec bb root');
  });
});
