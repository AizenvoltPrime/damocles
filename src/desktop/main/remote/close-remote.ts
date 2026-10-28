// The close's remote question: docs/invariants.md "Desktop host", the quit lifecycle, and "Remote daemon and wire", Keep running.
import { MAX_OVERLAY_ITEMS, MAX_OVERLAY_LABEL_LENGTH, type CloseRemoteChoice, type CloseRemoteRow, type CloseRemoteStatus, type CloseRowHost } from '../../preload/overlay-channels';
import type { Run } from '../../daemon/control-messages';
import { runKey, type KeepRunningHost, type KeepRunningRefresh, type KeepRunningRun, type TokenNote } from './keep-running-refresh';

export type CloseWithRunningAgents = 'ask' | 'keep' | 'stop';

// the most the close waits for one host to list its runs or stop one; a host past it is left out, as one that fails
export const CLOSE_REMOTE_STEP_MS = 3000;

/** A connected host's chat runs this device started, as its daemon reported them. */
export interface HostRuns {
  readonly hostId: string;
  readonly authorityKey: string;
  readonly runs: readonly Run[];
}

/** A connected host the close reads: list resolves its runs this device started. */
export interface ListedHost {
  readonly hostId: string;
  readonly authorityKey: string;
  readonly list: () => Promise<readonly Run[]>;
}

export interface CloseRemoteDeps {
  // every usable connection's chat runs this device started; a host that does not list them is left out, logged
  readonly hostRuns: () => Promise<readonly HostRuns[]>;
  readonly setting: () => CloseWithRunningAgents;
  readonly saveSetting: (choice: 'keep' | 'stop') => Promise<void>;
  // a run's row as the dialog shows it (panelId closeRowId's), with the status the run reported until activity says otherwise
  readonly row: (host: HostRuns, run: Run) => CloseRemoteRow;
  // the closeRemote overlay request; onRows hands it every row whole whenever one changes
  readonly ask: (rows: readonly CloseRemoteRow[], onRows: (listener: (rows: readonly CloseRemoteRow[]) => void) => void) => Promise<{ readonly choice: CloseRemoteChoice; readonly dontAskAgain: boolean }>;
  // a remote chat's status from its activity while the dialog is open; the subscription ends with the dialog
  readonly onStatus: (listener: (authorityKey: string, panelId: string, status: CloseRemoteStatus) => void) => { dispose(): void };
  // a host was renamed or recolored, or its notices changed (Allow background work enabled linger): its rows follow hostFields
  readonly onHostChanged: (listener: (hostId: string) => void) => { dispose(): void };
  readonly hostFields: (hostId: string) => CloseRowHost;
  readonly startRefresh: (runs: readonly KeepRunningRun[]) => KeepRunningRefresh;
  readonly keepAtShutdown: (runs: readonly KeepRunningRun[], hosts: readonly KeepRunningHost[]) => Promise<void>;
  readonly pushTo: (host: HostRuns) => KeepRunningHost;
  // the Stop path of one run, which records the turn stopped
  readonly stop: (authorityKey: string, panelId: string) => Promise<void>;
  // the runs this app leaves running as it detaches, for the finished-while-away notice
  readonly leftRunning: (hosts: readonly HostRuns[]) => Promise<void>;
  readonly log: (line: string) => void;
  readonly stepMs?: number;
}

/** What the close does with the remote runs once every question of the close passed. */
export type RemoteRelease = () => Promise<void>;

// A row's id: two daemons may hold panels under the same core id.
export const closeRowId = (hostId: string, panelId: string): string => `${hostId}/${panelId}`;

const keepRuns = (hosts: readonly HostRuns[]): KeepRunningRun[] => hosts.flatMap((host) => host.runs.map((run) => ({ hostId: host.hostId, panelId: run.id, providers: run.providers })));

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

class StepTimeout extends Error {}

// settles with the step, or rejects with a StepTimeout once ms passed
function withinStep<T>(step: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([step, timeout]).finally(() => clearTimeout(timer));
}

/** Each host's chat runs, each listing bounded; a host that fails or does not answer in time is left out, logged. */
export async function listHostRuns(hosts: readonly ListedHost[], log: (line: string) => void, stepMs: number = CLOSE_REMOTE_STEP_MS): Promise<HostRuns[]> {
  const listed = await Promise.all(hosts.map(async (host): Promise<HostRuns | undefined> => {
    try {
      const runs = await withinStep(host.list(), stepMs, `${host.authorityKey}'s run list`);
      return { hostId: host.hostId, authorityKey: host.authorityKey, runs: runs.filter((run) => run.kind === 'chat') };
    } catch (err) {
      log(`[close] ${host.authorityKey} did not list its runs: ${errorText(err)}`);
      return undefined;
    }
  }));
  return listed.filter((host): host is HostRuns => host !== undefined);
}

// a row's title or project as the dialog can show it: past the overlay's label bound it is cut, the last character an ellipsis
function shownLabel(label: string): string {
  if (label.length <= MAX_OVERLAY_LABEL_LENGTH) return label;
  return `${label.slice(0, MAX_OVERLAY_LABEL_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/**
 * Asks the remote question, or reads the setting; undefined when the user cancelled, else what the close does once nothing
 * can cancel it any more. unattended (an OS shutdown, an update's quit) keeps the runs without asking, its pushes best effort.
 */
export async function askRemoteRuns(deps: CloseRemoteDeps, unattended: boolean): Promise<RemoteRelease | undefined> {
  const hosts = (await deps.hostRuns()).filter((host) => host.runs.length > 0);
  if (hosts.length === 0) return async () => undefined;
  // a release that fails is logged: the close goes on, since its questions all passed
  const logged = (release: RemoteRelease): RemoteRelease => () => release().catch((err: unknown) => deps.log(`[close] releasing the remote runs failed: ${errorText(err)}`));
  const runs = keepRuns(hosts);
  // read again as the close detaches: a chat that finished while the questions were open did not finish while the app was away
  const left = async (): Promise<void> => deps.leftRunning((await deps.hostRuns()).filter((host) => host.runs.length > 0));
  if (unattended) {
    return logged(async () => {
      deps.log(`[close] keeping ${runs.length} remote runs without asking`);
      await deps.keepAtShutdown(runs, hosts.map(deps.pushTo));
      await left();
    });
  }
  const mode = deps.setting();
  // a refresh starts as the question opens, so a row can tell how long its token lasts before the user answers
  const refresh = mode === 'stop' ? undefined : deps.startRefresh(runs);
  const choice = mode === 'ask' ? await ask(deps, hosts, refresh!) : mode;
  if (choice === 'cancel') return undefined;
  if (choice === 'keep') {
    return logged(async () => {
      await refresh!.push(hosts.map(deps.pushTo));
      await left();
    });
  }
  return logged(() => stopRuns(deps, hosts));
}

async function stopRuns(deps: CloseRemoteDeps, hosts: readonly HostRuns[]): Promise<void> {
  await Promise.all(hosts.flatMap((host) => host.runs.map(async (run) => {
    deps.log(`[close] stopping ${run.id} on ${host.authorityKey}`);
    try {
      await withinStep(deps.stop(host.authorityKey, run.id), deps.stepMs ?? CLOSE_REMOTE_STEP_MS, `stopping ${run.id} on ${host.authorityKey}`);
      deps.log(`[close] stopped ${run.id} on ${host.authorityKey}`);
    } catch (err) {
      deps.log(`[close] stopping ${run.id} on ${host.authorityKey} failed: ${errorText(err)}`);
    }
  })));
}

async function ask(deps: CloseRemoteDeps, hosts: readonly HostRuns[], refresh: KeepRunningRefresh): Promise<CloseRemoteChoice> {
  let rows = hosts.flatMap((host) => host.runs.map((run) => {
    const row = deps.row(host, run);
    return { ...row, title: shownLabel(row.title), projectLabel: shownLabel(row.projectLabel) };
  })).slice(0, MAX_OVERLAY_ITEMS);
  const rowOf = new Map(hosts.flatMap((host) => host.runs.map((run) => [runKey(host.authorityKey, run.id), closeRowId(host.hostId, run.id)] as const)));
  const runOf = new Map(hosts.flatMap((host) => host.runs.map((run) => [closeRowId(host.hostId, run.id), runKey(host.hostId, run.id)] as const)));
  let listener: ((next: readonly CloseRemoteRow[]) => void) | undefined;
  const changed = (next: CloseRemoteRow[]): void => {
    rows = next;
    listener?.(rows);
  };
  const statuses = deps.onStatus((authorityKey, panelId, status) => {
    const id = rowOf.get(runKey(authorityKey, panelId));
    if (id === undefined || !rows.some((row) => row.panelId === id && row.status !== status)) return;
    changed(rows.map((row) => (row.panelId === id ? { ...row, status } : row)));
  });
  const hostChanges = deps.onHostChanged((hostId) => {
    const fields = deps.hostFields(hostId);
    const same = (row: CloseRemoteRow): boolean => row.hostLabel === fields.hostLabel && row.hostTone === fields.hostTone && row.lingerWarning === fields.lingerWarning;
    if (rows.every((row) => row.hostId !== hostId || same(row))) return;
    changed(rows.map((row) => {
      if (row.hostId !== hostId) return row;
      const { hostTone: _tone, lingerWarning: _warning, ...rest } = row;
      return { ...rest, ...fields };
    }));
  });
  refresh.notes.then((notes: ReadonlyMap<string, TokenNote>) => {
    if (notes.size === 0) return;
    changed(rows.map((row) => {
      const key = runOf.get(row.panelId);
      const note = key === undefined ? undefined : notes.get(key);
      return note === undefined ? row : { ...row, tokenNote: { provider: note.provider, minutesLeft: note.minutesLeft } };
    }));
  }).catch((err: unknown) => deps.log(`[close] the rows' token notes failed: ${errorText(err)}`));
  try {
    const answer = await deps.ask(rows, (next) => {
      listener = next;
    });
    if (answer.dontAskAgain && answer.choice !== 'cancel') await deps.saveSetting(answer.choice);
    return answer.choice;
  } finally {
    statuses.dispose();
    hostChanges.dispose();
    listener = undefined;
  }
}
