// The daemon's runs: the terminals of its terminal hosts, the core panels with a run and the pending CLI waits. Lifetime,
// control.listRuns and the panel rule read only this registry; a panel's part comes only from core's chat.activity and
// chat.turnSettled, which core derives from the session's RunLifecycle.
import type { ChatActivity } from '../../core/pi-session/session-state';
import type { Disposable } from '../../platform/disposable';
import { MAX_RUN_TITLE_CHARS, type OwnRun, type Run } from './control-messages';

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
  // the panel's chat was titled while it is a run; '' until its first title, which the app words itself
  panelTitle(panelId: string, title: string): void;
  // chat.turnSettled: the turn ended, so only its pending prompts or background agents keep it a run
  panelSettled(panelId: string): void;
  // chat.providers: the providers the panel's runs read through the token broker
  panelProviders(panelId: string, providers: readonly string[]): void;
  // chat.configuredProviders: the providers the panel's configuration names; the latest report replaces the previous one
  panelConfiguredProviders(panelId: string, providers: readonly string[]): void;
  // the panel closed, or its core ended
  removePanel(panelId: string): void;
  hasPanelRun(panelId: string): boolean;
  addTerminal(run: TerminalRun): void;
  removeTerminal(id: string): void;
  hasTerminal(id: string): boolean;
  runs(): readonly Run[];
  // whether a run of kind chat exists, which with a pending CLI wait holds back a hand-over
  hasChatRun(): boolean;
  // a damocles --wait request a client holds, named by its files, until the disposable; never one of runs(), which listRuns
  // freezes
  cliWait(title: string): Disposable;
  // the pending CLI waits' titles, oldest first
  cliWaits(): readonly string[];
  // the chat runs the client started, so its close stops or keeps only its own
  ownRuns(clientId: string): readonly OwnRun[];
  isEmpty(): boolean;
  onChange(listener: () => void): Disposable;
}

const title = (text: string): string => text.slice(0, MAX_RUN_TITLE_CHARS);

function panelState(activity: ChatActivity): Run['state'] | undefined {
  if (activity.pendingPrompts.length > 0 || activity.state === 'requires_action') return 'waiting';
  if (activity.state === 'running') return 'running';
  return activity.background ? 'background' : undefined;
}

export function createRunRegistry(): RunRegistry {
  const terminals = new Map<string, TerminalRun>();
  const panels = new Map<string, { readonly run: PanelRun; activity: ChatActivity; readonly owner: string | undefined }>();
  // kept while the panel lives, whether or not it has a run now
  const providers = new Map<string, readonly string[]>();
  const configured = new Map<string, readonly string[]>();
  const waits = new Set<{ readonly title: string }>();
  const changed = new Set<() => void>();

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
    panelTitle: (panelId, named) => {
      const entry = panels.get(panelId);
      if (entry === undefined || entry.run.title === named) return;
      panels.set(panelId, { ...entry, run: { ...entry.run, title: named } });
      fire();
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
    panelConfiguredProviders: (panelId, named) => {
      configured.set(panelId, named);
    },
    removePanel: (panelId) => {
      providers.delete(panelId);
      configured.delete(panelId);
      if (panels.delete(panelId)) fire();
    },
    hasPanelRun: (panelId) => panels.has(panelId),
    addTerminal: (run) => {
      terminals.set(run.id, run);
      fire();
    },
    removeTerminal: (id) => {
      if (terminals.delete(id)) fire();
    },
    hasTerminal: (id) => terminals.has(id),
    hasChatRun: () => panels.size > 0,
    cliWait: (named) => {
      const wait = { title: title(named) };
      waits.add(wait);
      fire();
      return {
        dispose: () => {
          if (waits.delete(wait)) fire();
        },
      };
    },
    cliWaits: () => [...waits].map((wait) => wait.title),
    runs: () => [
      ...[...panels.values()].map(panelRun),
      ...[...terminals.values()].map((run): Run => ({ kind: 'terminal', id: run.id, projectKey: run.projectKey, title: title(run.title), state: 'running', providers: [] })),
    ],
    ownRuns: (clientId) => [...panels.values()].filter((entry) => entry.owner === clientId).map((entry): OwnRun => {
      const named = configured.get(entry.run.panelId);
      return named === undefined ? panelRun(entry) : { ...panelRun(entry), configuredProviders: named };
    }),
    isEmpty: () => terminals.size === 0 && panels.size === 0,
    onChange: (listener) => {
      changed.add(listener);
      return { dispose: () => { changed.delete(listener); } };
    },
  };
}
