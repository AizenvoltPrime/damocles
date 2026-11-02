// The devcontainer CLI for one container record (docs/invariants.md "Dev Containers"): `up` with its JSON log streamed into
// the build log and its result parsed, and `read-configuration` for the trust gate. Where it runs (this computer under the
// app's binary as Node, or an SSH host under the package's Node) is the side's.
import type { ContainerEngine } from '../../../daemon/container-values';
import { SshConnectError } from '../ssh/ssh-transport';
import type { CliTarget, ContainerSide } from './container-side';
import { BuildLogBuffer, parseReadConfiguration, parseUpResult, shownMessage, type DevcontainerUp } from './devcontainer-output';

/** `devcontainer up`, or with removeExisting Rebuild's; each log line reaches the buffer and onLog as it arrives. */
export async function devcontainerUp(side: ContainerSide, target: CliTarget, dataKey: string, removeExisting: boolean, log: BuildLogBuffer, onLog: () => void, signal: AbortSignal): Promise<DevcontainerUp> {
  const ran = await side.up(target, dataKey, removeExisting, (text) => {
    if (log.push(text)) onLog();
  }, signal);
  if (log.end()) onLog();
  if (ran.result === 'engineMissing') throw new SshConnectError('containerEngineMissing', { engine: target.engine }, '');
  const outcome = parseUpResult(ran.stdout, ran.code);
  if (!outcome.ok) throw new SshConnectError('devcontainerFailed', { message: outcome.message }, '');
  return outcome.up;
}

/** The data volume's folder given to the remote user, for a container that mounts the volume. */
export async function giveDataFolder(side: ContainerSide, engine: ContainerEngine, containerId: string, user: string): Promise<void> {
  const owned = await side.prepareData(engine, containerId, user);
  if (owned.result === 'engineMissing') throw new SshConnectError('containerEngineMissing', { engine }, '');
  if (owned.code !== 0) throw new SshConnectError('devcontainerFailed', { message: shownMessage(`giving ${user} the data folder failed: ${owned.stderr}`) }, '');
}

/** `devcontainer read-configuration`'s resolved configuration, untrusted, for the trust gate. */
export async function devcontainerReadConfiguration(side: ContainerSide, target: CliTarget, log: (line: string) => void, signal: AbortSignal): Promise<unknown> {
  const stderr = new BuildLogBuffer();
  const ran = await side.readConfiguration(target, (text) => stderr.push(text), signal);
  stderr.end();
  if (ran.result === 'engineMissing') throw new SshConnectError('containerEngineMissing', { engine: target.engine }, '');
  const outcome = parseReadConfiguration(ran.stdout, ran.code);
  if (!outcome.ok) {
    for (const line of stderr.snapshot().lines.slice(-20)) log(`[devcontainer] ${line}`);
    throw new SshConnectError('devcontainerFailed', { message: outcome.message }, '');
  }
  return outcome.resolved;
}
