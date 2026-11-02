// Rebuild Container, after the user confirmed the agents and terminals that stop: the trust gate first, so a refusal stops
// nothing; then the container's daemon shuts down, `devcontainer up --remove-existing-container` runs with its log shown as it
// comes, and the container connects again under the same key, so its trust, layout and mirrored chats stay.
import type { BuildLog, ContainerRebuildRun, ContainerRebuildStep, PasswordlessStepState } from '../../../preload/overlay-channels';
import { BUILD_LOG_PUSH_MS } from '../connections';
import { SshConnectError } from '../ssh/ssh-transport';
import { shownMessage } from './devcontainer-output';

export interface RebuildDeps {
  // the trust gate; rejects with the failure naming why nothing ran
  readonly passGate: () => Promise<void>;
  // control.shutdownNow when connected, settled once the daemon ended its connection; the host stays disconnected afterwards
  readonly shutDown: () => Promise<void>;
  // devcontainer up --remove-existing-container, its log lines as they come; records the new container id
  readonly up: (onLog: (log: BuildLog) => void) => Promise<void>;
  // after a failed up: whether the engine still lists the container the record named before it
  readonly oldContainerKept: () => Promise<boolean>;
  // resolves once the container connected again, rejecting with the attempt's failure
  readonly reconnect: () => Promise<void>;
  readonly log: (line: string) => void;
}

export type RebuildResult = NonNullable<ContainerRebuildRun['result']>;

const pending: PasswordlessStepState = 'pending';
export const INITIAL_REBUILD: ContainerRebuildRun = { steps: { stopping: pending, building: pending, reconnecting: pending }, log: { lines: [], total: 0 } };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
// a connect failure's message param was already made shown text; any other error's text is made so here
const failureMessage = (err: unknown): string => (err instanceof SshConnectError && typeof err.params['message'] === 'string' ? err.params['message'] : shownMessage(messageOf(err)));

/**
 * The rebuild run: each step's state reaches progress as it changes, and the build log, which the repository's build decides,
 * at most once per BUILD_LOG_PUSH_MS, since each progress sends the whole run to the overlay.
 */
export async function rebuildContainer(deps: RebuildDeps, progress: (run: ContainerRebuildRun) => void): Promise<RebuildResult> {
  let run = INITIAL_REBUILD;
  let logTimer: NodeJS.Timeout | undefined;
  // a step's change carries the newest log too
  const step = (name: ContainerRebuildStep, state: PasswordlessStepState): void => {
    clearTimeout(logTimer);
    logTimer = undefined;
    run = { ...run, steps: { ...run.steps, [name]: state } };
    progress(run);
  };
  // a line that arrives once the build step ended starts no push
  const logChanged = (log: BuildLog): void => {
    if (run.steps.building !== 'running') return;
    run = { ...run, log };
    logTimer ??= setTimeout(() => {
      logTimer = undefined;
      progress(run);
    }, BUILD_LOG_PUSH_MS);
  };
  try {
    await deps.passGate();
  } catch (err) {
    if (err instanceof SshConnectError && (err.code === 'configRefused' || err.code === 'folderUntrusted' || err.code === 'composeUnsupported' || err.code === 'containerEngineMissing')) return { ok: false, code: err.code };
    deps.log(`[containers] the trust gate before the rebuild failed: ${messageOf(err)}`);
    return { ok: false, code: 'configFailed', message: failureMessage(err) };
  }
  step('stopping', 'running');
  try {
    await deps.shutDown();
  } catch (err) {
    deps.log(`[containers] stopping the container's daemon for the rebuild failed: ${messageOf(err)}`);
    step('stopping', 'failed');
    return { ok: false, code: 'stopFailed', message: failureMessage(err) };
  }
  step('stopping', 'done');
  step('building', 'running');
  try {
    await deps.up(logChanged);
  } catch (err) {
    step('building', 'failed');
    deps.log(`[containers] devcontainer up --remove-existing-container failed: ${messageOf(err)}`);
    // with no engine the CLI removed nothing; otherwise it may have failed before or after it removed the old container
    const kept = err instanceof SshConnectError && err.code === 'containerEngineMissing' ? true : await deps.oldContainerKept();
    return { ok: false, code: kept ? 'buildFailedKept' : 'buildFailed', message: failureMessage(err) };
  }
  step('building', 'done');
  step('reconnecting', 'running');
  try {
    await deps.reconnect();
  } catch (err) {
    deps.log(`[containers] connecting after the rebuild failed: ${messageOf(err)}`);
    step('reconnecting', 'failed');
    return { ok: false, code: 'reconnectFailed' };
  }
  step('reconnecting', 'done');
  return { ok: true };
}
