// The daemon's runs: the persistent terminals and the core panels with a run. Lifetime,
// control.listRuns and the panel rule read only this registry; a panel's part comes only from core's chat.activity and
// chat.turnSettled, which core derives from the session's RunLifecycle.
import type { ChatActivity } from '../../core/pi-session/session-state';
import type { Disposable } from '../../platform/disposable';
import { MAX_RUN_TITLE_CHARS, type Run } from './control-messages';

const DAY_MS = 24 * 60 * 60 * 1000;
// setTimeout's largest delay; a later deadline is re-armed from there
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface TerminalRun {
  readonly id: string;
  // the native key of the project that spawned it; '' for none
  readonly projectKey: string;
  readonly title: string;
}

export interface PanelRun {
  // core's PanelManager id
  readonly panelId: string;
  readonly projectKey: string;
  readonly title: string;
}

export interface RunRegistry {
  // a panel's latest chat.activity: a running turn, a pending prompt or background agents make it a run. clientId: the
  // event's actor, which owns the run when the event starts it
  panelActivity(panel: PanelRun, activity: ChatActivity, clientId?: string): void;
  // chat.turnSettled: the turn ended, so only its pending prompts or background agents keep it a run
  panelSettled(panelId: string): void;
  // chat.providers: the providers the panel's runs read through the token broker
  panelProviders(panelId: string, providers: readonly string[]): void;
  // the panel closed, or its core ended
  removePanel(panelId: string): void;
  hasPanelRun(panelId: string): boolean;
  addTerminal(run: TerminalRun): void;
  removeTerminal(id: string): void;
  hasTerminal(id: string): boolean;
  // how many connections view it; 0 starts its idle clock
  setAttached(id: string, connections: number): void;
  // the latest attach's damocles.desktop.remote.terminalIdleDays; 0 never ends a terminal
  setIdleDays(days: number): void;
  // a terminal nobody attached for the idle limit; the listener ends it
  onIdle(listener: (id: string) => void): void;
  runs(): readonly Run[];
  // the chat runs the client started, so its close stops or keeps only its own
  ownRuns(clientId: string): readonly Run[];
  isEmpty(): boolean;
  onChange(listener: () => void): Disposable;
  dispose(): void;
}

interface Entry {
  readonly run: TerminalRun;
  // when its last connection detached; undefined while one views it
  detachedAt: number | undefined;
}

const title = (text: string): string => text.slice(0, MAX_RUN_TITLE_CHARS);

function panelState(activity: ChatActivity): Run['state'] | undefined {
  if (activity.pendingPrompts.length > 0 || activity.state === 'requires_action') return 'waiting';
  if (activity.state === 'running') return 'running';
  return activity.background ? 'background' : undefined;
}

export function createRunRegistry(now: () => number = Date.now): RunRegistry {
  const terminals = new Map<string, Entry>();
  const panels = new Map<string, { readonly run: PanelRun; activity: ChatActivity; readonly owner: string | undefined }>();
  // kept while the panel lives, whether or not it has a run now
  const providers = new Map<string, readonly string[]>();
  const changed = new Set<() => void>();
  const idle = new Set<(id: string) => void>();
  let idleDays = 0;
  let timer: NodeJS.Timeout | undefined;

  const deadline = (entry: Entry): number | undefined => (idleDays === 0 || entry.detachedAt === undefined ? undefined : entry.detachedAt + idleDays * DAY_MS);

  const arm = (): void => {
    clearTimeout(timer);
    timer = undefined;
    let next: number | undefined;
    for (const entry of terminals.values()) {
      const at = deadline(entry);
      if (at !== undefined && (next === undefined || at < next)) next = at;
    }
    if (next === undefined) return;
    timer = setTimeout(sweep, Math.min(Math.max(next - now(), 0), MAX_TIMER_MS));
  };

  function sweep(): void {
    timer = undefined;
    const expired = [...terminals.values()].filter((entry) => (deadline(entry) ?? Infinity) <= now()).map((entry) => entry.run.id);
    for (const id of expired) for (const listener of [...idle]) listener(id);
    arm();
  }

  const fire = (): void => {
    for (const listener of [...changed]) listener();
  };

  const settle = (panelId: string): void => {
    const entry = panels.get(panelId);
    if (entry === undefined || panelState(entry.activity) !== undefined) return;
    panels.delete(panelId);
    fire();
  };

  const panelRun = ({ run, activity }: { readonly run: PanelRun; readonly activity: ChatActivity }): Run => ({ kind: 'chat', id: run.panelId, projectKey: run.projectKey, title: title(run.title), state: panelState(activity) ?? 'running', providers: providers.get(run.panelId) ?? [] });

  return {
    panelActivity: (run, activity, clientId) => {
      const had = panels.get(run.panelId);
      panels.set(run.panelId, { run, activity, owner: had ? had.owner : clientId });
      if (panelState(activity) === undefined) {
        panels.delete(run.panelId);
        if (had) fire();
        return;
      }
      if (!had || panelState(had.activity) !== panelState(activity)) fire();
    },
    panelSettled: (panelId) => {
      const entry = panels.get(panelId);
      if (entry === undefined) return;
      entry.activity = { ...entry.activity, state: entry.activity.state === 'running' ? 'idle' : entry.activity.state };
      settle(panelId);
    },
    panelProviders: (panelId, used) => {
      providers.set(panelId, used);
    },
    removePanel: (panelId) => {
      providers.delete(panelId);
      if (panels.delete(panelId)) fire();
    },
    hasPanelRun: (panelId) => panels.has(panelId),
    addTerminal: (run) => {
      terminals.set(run.id, { run, detachedAt: undefined });
      fire();
    },
    removeTerminal: (id) => {
      if (!terminals.delete(id)) return;
      arm();
      fire();
    },
    hasTerminal: (id) => terminals.has(id),
    setAttached: (id, connections) => {
      const entry = terminals.get(id);
      if (!entry) return;
      if (connections > 0) entry.detachedAt = undefined;
      else entry.detachedAt ??= now();
      arm();
    },
    setIdleDays: (days) => {
      idleDays = days;
      arm();
    },
    onIdle: (listener) => {
      idle.add(listener);
    },
    runs: () => [
      ...[...panels.values()].map(panelRun),
      ...[...terminals.values()].map(({ run }): Run => ({ kind: 'terminal', id: run.id, projectKey: run.projectKey, title: title(run.title), state: 'running', providers: [] })),
    ],
    ownRuns: (clientId) => [...panels.values()].filter((entry) => entry.owner === clientId).map(panelRun),
    isEmpty: () => terminals.size === 0 && panels.size === 0,
    onChange: (listener) => {
      changed.add(listener);
      return { dispose: () => { changed.delete(listener); } };
    },
    dispose: () => {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
