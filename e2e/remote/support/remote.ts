import type { ElectronApplication, TestInfo } from '@playwright/test';
import { authorityKeyOfProject } from '../../../src/shared/project-location';
import { expect, test as desktopTest } from '../../desktop/support/fixtures';
import { shellState } from '../../desktop/support/shell';
import { startReleaseMirror, type ReleaseMirror } from './release-mirror';
import { runProgram, sshClientHome, startSshd, type SshClientHome, type SshdFixture, type SshdOptions } from './sshd';

export { expect };

// The default suite: SSH to the Docker fixtures, which every pull request runs.
export const SSH_TAG = '@ssh';
// Run only when --grep names them (scripts/test-remote.mjs), against the runner's own sshd in the nightly workflow.
export const WINDOWS_TARGET_TAG = '@windows-target';
export const DARWIN_TARGET_TAG = '@darwin-target';
// Runs against DAMOCLES_E2E_PACKAGED_APP, with no main-process access.
export const PACKAGED_TAG = '@packaged';

export type ConnectStep = 'connecting' | 'authenticating' | 'checking' | 'installing' | 'starting';

export interface RemoteHost {
  readonly hostId: string;
  readonly name: string;
  readonly alias?: string;
  readonly host?: string;
  readonly user?: string;
  readonly port?: number;
  readonly authorityKey: string;
  readonly connection: string;
}

export interface ConnectStepEvent {
  readonly step: ConnectStep | 'connected' | 'failed';
  /** The steps the attempt entered, in order, which the timeline's rows show. */
  readonly visited: readonly ConnectStep[];
  readonly progress?: number;
  readonly failure?: { readonly code: string; readonly params: Record<string, string | number> };
}

// main's e2e hooks for SSH hosts (globalThis.__damoclesE2e.remote, DAMOCLES_E2E_HOOKS=1 in an unpackaged app only)
interface RemoteHooks {
  hosts(): RemoteHost[];
  state(hostId: string): string;
  control(hostId: string, command: string, params: Record<string, unknown>): Promise<unknown>;
  dropConnection(hostId: string): void;
  cutTransport(hostId: string, options: { hold: boolean }): void;
  releaseTransport(hostId: string): void;
  exitControlMaster(hostId: string): Promise<void>;
  addHost(target: { alias: string; name: string } | { input: string; name: string }): Promise<string>;
  openFolder(hostId: string, folder: string, trust: boolean): Promise<string>;
  setInstallFolder(hostId: string, folder: string | null): Promise<unknown>;
  connectStep(hostId: string): ConnectStepEvent | undefined;
  logs(hostId: string): Promise<{ daemon: string; bridgeStderr: string }>;
  writeBytes(projectKey: string, relativePath: string, base64: string): Promise<void>;
  readBytes(projectKey: string, relativePath: string): Promise<string>;
  pick(authorityKey: string, kind: 'file' | 'folder', options: PickOptions): Promise<string | undefined>;
}

export interface PickOptions {
  readonly title?: string;
  readonly defaultPath?: string;
  readonly buttonLabel?: string;
}

type Hooked = { __damoclesE2e?: { remote?: Record<string, (...args: unknown[]) => unknown> } };

const hooked = new WeakSet<ElectronApplication>();

/** Calls main's hook `method` once main has installed its e2e hooks, which it does during startup. */
async function remote<M extends keyof RemoteHooks>(app: ElectronApplication, method: M, ...args: Parameters<RemoteHooks[M]>): Promise<Awaited<ReturnType<RemoteHooks[M]>>> {
  if (!hooked.has(app)) {
    await expect.poll(() => app.evaluate(() => typeof (globalThis as unknown as Hooked).__damoclesE2e?.remote), { timeout: 60_000 }).toBe('object');
    hooked.add(app);
  }
  return app.evaluate((_electron, [name, values]) => (globalThis as unknown as Hooked).__damoclesE2e!.remote![name]!(...values), [method, args] as const) as Promise<Awaited<ReturnType<RemoteHooks[M]>>>;
}

export const remoteHosts = (app: ElectronApplication): Promise<RemoteHost[]> => remote(app, 'hosts');
export const hostState = (app: ElectronApplication, hostId: string): Promise<string> => remote(app, 'state', hostId);
export const control = (app: ElectronApplication, hostId: string, command: string, params: Record<string, unknown> = {}): Promise<unknown> => remote(app, 'control', hostId, command, params);
export const dropConnection = (app: ElectronApplication, hostId: string): Promise<void> => remote(app, 'dropConnection', hostId);
/** Ends the host's transport as a network drop does; with hold, every attempt's transport fails until releaseTransport. */
export const cutTransport = (app: ElectronApplication, hostId: string, options: { hold: boolean }): Promise<void> => remote(app, 'cutTransport', hostId, options);
export const releaseTransport = (app: ElectronApplication, hostId: string): Promise<void> => remote(app, 'releaseTransport', hostId);
/** `ssh -O exit` on Damocles' master connection to the host; nothing on a Windows client, which uses none. */
export const exitControlMaster = (app: ElectronApplication, hostId: string): Promise<void> => remote(app, 'exitControlMaster', hostId);
/** Saves a host record through main, as the Connect dialog's new-host form does, without connecting. */
export const addHost = (app: ElectronApplication, target: { alias: string; name: string } | { input: string; name: string }): Promise<string> => remote(app, 'addHost', target);
/** Connects the host with no prompt to answer and adds `folder` as its project, selected; resolves with its key. */
export async function openRemoteFolder(app: ElectronApplication, hostId: string, folder: string, trust = true): Promise<string> {
  try {
    return await remote(app, 'openFolder', hostId, folder, trust);
  } catch (error) {
    // the failure's code and parameters and the bridge's stderr, which the rejection's text leaves out
    const step = await remote(app, 'connectStep', hostId);
    const logs = await remote(app, 'logs', hostId);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nlast step: ${JSON.stringify(step)}\nbridge stderr:\n${logs.bridgeStderr}`, { cause: error });
  }
}
export const setInstallFolder = (app: ElectronApplication, hostId: string, folder: string | null): Promise<unknown> => remote(app, 'setInstallFolder', hostId, folder);
export const lastConnectStep = (app: ElectronApplication, hostId: string): Promise<ConnectStepEvent | undefined> => remote(app, 'connectStep', hostId);
export const hostLogs = (app: ElectronApplication, hostId: string): Promise<{ daemon: string; bridgeStderr: string }> => remote(app, 'logs', hostId);
/** Bytes written to and read from a remote project's files through its workspace, over the wire. */
export const writeRemoteBytes = (app: ElectronApplication, projectKey: string, relativePath: string, bytes: Buffer): Promise<void> => remote(app, 'writeBytes', projectKey, relativePath, bytes.toString('base64'));
export const readRemoteBytes = async (app: ElectronApplication, projectKey: string, relativePath: string): Promise<Buffer> => Buffer.from(await remote(app, 'readBytes', projectKey, relativePath), 'base64');

/** Asks the authority's picker as its core's dialogs.pickFile or dialogs.pickFolder does; settles once the user answers. */
export const pickOnHost = (app: ElectronApplication, authorityKey: string, kind: 'file' | 'folder', options: PickOptions = {}): Promise<string | undefined> =>
  remote(app, 'pick', authorityKey, kind, options);

/** The one host the store holds under `name`. */
export async function hostNamed(app: ElectronApplication, name: string): Promise<RemoteHost> {
  let found: RemoteHost | undefined;
  await expect.poll(async () => (found = (await remoteHosts(app)).find((host) => host.name === name))).toBeDefined();
  return found!;
}

/** The project on `host` at `folder` once main lists it connected; resolves with its key. */
export async function remoteProjectKey(app: ElectronApplication, host: Pick<RemoteHost, 'authorityKey'>, folder: string): Promise<string> {
  let key = '';
  await expect.poll(async () => {
    const project = (await shellState(app)).projects.find((candidate) => authorityKeyOfProject(candidate.key) === host.authorityKey && candidate.fsPath === folder);
    key = project?.key ?? '';
    return project?.connection;
  }, { timeout: 60_000 }).toBe('connected');
  return key;
}

/** The environment a launch needs to reach the fixtures: the e2e hooks, the remote gate, the temp ssh config and the mirror. */
export function remoteEnv(ssh: Pick<SshClientHome, 'config'>, mirror: Pick<ReleaseMirror, 'url'>): Record<string, string> {
  return { ...WINDOWS_SSH_ENV, DAMOCLES_E2E_HOOKS: '1', DAMOCLES_REMOTE: '1', DAMOCLES_E2E_SSH_CONFIG: ssh.config, DAMOCLES_E2E_RELEASE_URL: mirror.url };
}

// Win32-OpenSSH's ssh.exe exits 255 without a word when ProgramData is missing, which the hermetic environment leaves out.
export const WINDOWS_SSH_ENV: Record<string, string> = process.platform === 'win32' && process.env['ProgramData'] !== undefined ? { ProgramData: process.env['ProgramData'] } : {};

/** A fixture with this computer's key authorized (unless agentOnly) and, unless `trusted` is false, its host key in the temp known_hosts. */
export interface RemoteFixtures {
  mirror: ReleaseMirror;
  ssh: SshClientHome;
  /** Starts a container under `alias` in the temp ssh config; every one started is removed after the test. */
  sshd: (alias: string, options?: SshdOptions & { trusted?: boolean; config?: readonly string[]; agentOnly?: boolean }) => Promise<SshdFixture>;
}

export const test = desktopTest.extend<RemoteFixtures>({
  // eslint-disable-next-line no-empty-pattern
  mirror: async ({}, use) => {
    const mirror = await startReleaseMirror();
    await use(mirror);
    await mirror.close();
  },
  ssh: async ({ home }, use) => {
    await use(await sshClientHome(home));
  },
  sshd: async ({ ssh }, use, testInfo) => {
    const started: SshdFixture[] = [];
    await use(async (alias, options = {}) => {
      const fixture = await startSshd(options);
      started.push(fixture);
      if (options.agentOnly) ssh.addAgentHost(alias, fixture);
      else {
        await fixture.authorize(ssh.publicKey);
        ssh.addHost(alias, fixture, options.config);
      }
      if (options.trusted !== false) await ssh.trust(fixture);
      return fixture;
    });
    await disposeEach(started, async (fixture) => {
      try {
        await attachTargetState(testInfo, fixture);
      } finally {
        await fixture.dispose();
      }
    });
  },
});

/** Runs `dispose` on every item even when one throws, then throws what failed. */
export async function disposeEach<T>(items: readonly T[], dispose: (item: T) => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  for (const item of items) {
    try {
      await dispose(item);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${failures.length} of ${items.length} disposals failed`);
}

// What a failed test needs from the target: its processes and the install folder's listing.
async function attachTargetState(testInfo: TestInfo, fixture: SshdFixture): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  const script = 'ps -A -o user= -o pid= -o args=; ls -laR /home/*/.damocles/server /opt/damocles | head -n 300; for f in /home/*/.damocles/server/run-*/logs/*.log; do echo "== $f"; tail -n 200 "$f"; done';
  const state = await runProgram('docker', ['exec', fixture.container, 'sh', '-c', script]);
  await testInfo.attach(`target-${fixture.container}.txt`, { body: `exit ${state.code}\n${state.stdout}\n${state.stderr}`, contentType: 'text/plain' });
}
