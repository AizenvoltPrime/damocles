// One connect of a container record (docs/invariants.md "Dev Containers"): a devcontainer whose container runs is joined as it
// is; one that is stopped or gone, when a user watches the attempt, and every Rebuild, passes the trust gate before
// `devcontainer up` runs. An attached container must be running. Then stage 0 runs under exec as the container's user.
import type { BuildLog } from '../../../preload/overlay-channels';
import type { ArtifactCache } from '../artifact-cache';
import type { ContainerFound, ContainerHostRecord } from '../host-store';
import type { ServerManifest } from '../server-manifest-format';
import { SshConnectError, type SshAttemptHooks } from '../ssh/ssh-transport';
import type { ContainerSide } from './container-side';
import { startContainerTransport, type ContainerTransportResult } from './container-transport';
import { DevcontainerTrustError, type DevcontainerTrustVerdict } from './devcontainer-trust';
import { CONTAINER_DATA_FOLDER, dataVolumeName } from '../../../daemon/container-commands';
import { devcontainerUp, giveDataFolder } from './devcontainer';
import { BuildLogBuffer, shownMessage } from './devcontainer-output';
import { parseInspect, parsePs, type InspectedContainer } from './docker-ps';

export interface ContainerConnectDeps {
  readonly side: ContainerSide;
  readonly install: () => Promise<{ readonly manifest: ServerManifest; readonly artifacts: ArtifactCache; readonly releasesUrl?: string }>;
  // folder trust, read-configuration and the confirmation (devcontainer-trust.ts), for a devcontainer record
  readonly gate: () => Promise<DevcontainerTrustVerdict>;
  readonly recordContainer: (found: ContainerFound) => Promise<void>;
  // up gave a container without the key's data volume, not yet told for this container id: its chats go with a rebuild
  readonly dataVolumeMissing: () => void;
  readonly hooks: Pick<SshAttemptHooks, 'step' | 'progress' | 'notice'> & { buildLog(log: BuildLog): void };
  readonly signal: AbortSignal;
  // a user watches the attempt now; an attempt nobody watches never runs the gate or up
  readonly watched: () => boolean;
  installFolderSettled(): Promise<void>;
  readonly log: (line: string) => void;
}

/** What the trust gate's refusals and errors are as a connect failure; nothing ran for any of them. */
export function gateFailure(err: unknown): SshConnectError | undefined {
  if (!(err instanceof DevcontainerTrustError)) return undefined;
  return err.code === 'composeUnsupported' ? new SshConnectError('composeUnsupported', {}, '') : new SshConnectError('devcontainerFailed', { message: shownMessage(err.message) }, '');
}

/** The gate's verdict as the attempt goes on: proceed, or the failure naming why nothing ran. */
export async function passGate(gate: () => Promise<DevcontainerTrustVerdict>, folder: string): Promise<void> {
  let verdict: DevcontainerTrustVerdict;
  try {
    verdict = await gate();
  } catch (err) {
    throw gateFailure(err) ?? err;
  }
  if (verdict === 'folderUntrusted') throw new SshConnectError('folderUntrusted', { folder }, '');
  if (verdict === 'configRefused') throw new SshConnectError('configRefused', {}, '');
  if (verdict === 'cancelled') throw new SshConnectError('cancelled', {}, '');
  if (verdict === 'needsUser') throw new SshConnectError('containerNeedsBuild', {}, '');
}

async function inspectOne(side: ContainerSide, record: ContainerHostRecord, containerId: string): Promise<InspectedContainer | undefined> {
  const ran = await side.inspect(record.engine, [containerId]);
  if (ran.result === 'engineMissing') throw new SshConnectError('containerEngineMissing', { engine: record.engine }, '');
  // inspect exits non-zero for a container that is gone
  return ran.code === 0 ? parseInspect(ran.stdout).find((container) => container.id === containerId) : undefined;
}

// The attached container by its name among the running ones.
async function runningByName(side: ContainerSide, record: ContainerHostRecord, name: string): Promise<InspectedContainer | undefined> {
  const listed = await side.list(record.engine);
  if (listed.result === 'engineMissing') throw new SshConnectError('containerEngineMissing', { engine: record.engine }, '');
  if (listed.code !== 0) throw new SshConnectError('devcontainerFailed', { message: shownMessage(listed.stderr) || `${record.engine} ps exited with ${String(listed.code)}` }, '');
  const row = parsePs(listed.stdout).find((container) => container.name === name && (container.state === 'running' || container.state === 'paused'));
  if (row?.state === 'paused') throw new SshConnectError('containerPaused', { container: name, engine: record.engine }, '');
  return row && inspectOne(side, record, row.id);
}

/**
 * Runs `devcontainer up` (removeExisting: Rebuild), records what it found, and resolves the container; the caller passed the
 * trust gate first. Every log line reaches onLog's snapshot. up mounts the key's data volume only on a container it creates,
 * so a container it reused (made by VS Code or the CLI) has none: its ~/.damocles stays in the container, and the user is told
 * once per container.
 */
export async function upContainer(deps: Pick<ContainerConnectDeps, 'side' | 'recordContainer' | 'dataVolumeMissing' | 'signal' | 'log'>, record: ContainerHostRecord, removeExisting: boolean, onLog: (log: BuildLog) => void): Promise<{ readonly containerId: string; readonly user: string; readonly dataFolder: boolean }> {
  if (record.origin !== 'devcontainer' || record.workspaceFolder === undefined || record.configPath === undefined) throw new Error('Only a devcontainer record runs devcontainer up');
  const log = new BuildLogBuffer();
  const up = await devcontainerUp(deps.side, { engine: record.engine, workspaceFolder: record.workspaceFolder, configPath: record.configPath }, record.key, removeExisting, log, () => onLog(log.snapshot()), deps.signal);
  const inspected = await inspectOne(deps.side, record, up.containerId);
  if (!inspected) throw new SshConnectError('devcontainerFailed', { message: `devcontainer up gave ${up.containerId.slice(0, 12)}, which ${record.engine} does not list` }, '');
  const dataFolder = inspected.volumes.some((volume) => volume.name === dataVolumeName(record.key) && volume.destination === CONTAINER_DATA_FOLDER);
  if (dataFolder) await giveDataFolder(deps.side, record.engine, up.containerId, up.remoteUser);
  const tell = !dataFolder && record.dataNoticeShown !== up.containerId;
  await deps.recordContainer({ ...up, image: inspected.image, ...(dataFolder ? {} : { withoutDataVolume: true }), ...(tell ? { dataNoticeShown: up.containerId } : {}) });
  deps.log(`[containers] ${record.id}: devcontainer up gave ${up.containerId.slice(0, 12)} as ${up.remoteUser}${dataFolder ? '' : ', without the data volume'}`);
  if (tell) deps.dataVolumeMissing();
  return { containerId: up.containerId, user: up.remoteUser, dataFolder };
}

// The container a connect execs into: the running one as recorded, else what up starts; an attached one must run.
// dataFolder: the container mounts the key's data volume, which stage 1 links ~/.damocles to
async function containerOf(deps: ContainerConnectDeps, record: ContainerHostRecord): Promise<{ readonly containerId: string; readonly user: string; readonly dataFolder: boolean }> {
  if (record.origin === 'attach') {
    const name = record.containerName!;
    const found = await runningByName(deps.side, record, name);
    if (!found) throw new SshConnectError('containerNotRunning', { name }, '');
    if (record.user === 'configured' && found.userRefused) throw new SshConnectError('devcontainerFailed', { message: `the configured user of ${name} is not a user name` }, '');
    await deps.recordContainer({ containerId: found.id, image: found.image });
    return { containerId: found.id, user: record.user === 'root' ? 'root' : (found.user ?? 'root'), dataFolder: false };
  }
  const running = record.containerId !== undefined && record.remoteUser !== undefined ? await inspectOne(deps.side, record, record.containerId) : undefined;
  // docker refuses an exec into a paused container, and the devcontainer CLI never unpauses one
  if (running?.paused) throw new SshConnectError('containerPaused', { container: running.name, engine: record.engine }, '');
  if (running?.running && record.remoteUser !== undefined) return { containerId: running.id, user: record.remoteUser, dataFolder: record.withoutDataVolume !== true };
  // up runs the consented initializeCommand and may build for minutes: only for a user who waits on it
  if (!deps.watched()) throw new SshConnectError('containerNeedsBuild', {}, '');
  deps.hooks.step('building');
  await passGate(deps.gate, record.workspaceFolder!);
  if (deps.signal.aborted) throw new SshConnectError('cancelled', {}, '');
  return upContainer(deps, record, false, (log) => deps.hooks.buildLog(log));
}

/** The container's transport: the container up or found, then stage 0 under exec, resolved once the bridge authenticated. */
export async function connectContainer(deps: ContainerConnectDeps, record: ContainerHostRecord): Promise<ContainerTransportResult> {
  const { containerId, user, dataFolder } = await containerOf(deps, record);
  if (deps.signal.aborted) throw new SshConnectError('cancelled', {}, '');
  const { manifest, artifacts, releasesUrl } = await deps.install();
  return startContainerTransport({
    side: deps.side,
    dataFolder,
    engine: record.engine,
    containerId,
    user,
    ...(record.settings.installFolder !== undefined ? { installFolder: record.settings.installFolder } : {}),
    ...(record.previousInstallFolder !== undefined ? { previousInstallFolder: record.previousInstallFolder } : {}),
    signal: deps.signal,
    hooks: deps.hooks,
    installFolderSettled: () => deps.installFolderSettled(),
    manifest,
    ...(releasesUrl !== undefined ? { releasesUrl } : {}),
    artifacts,
    log: deps.log,
  });
}
