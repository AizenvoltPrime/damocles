// Finished while away: docs/invariants.md "Remote daemon and wire", one connection attempt per SSH host.
import type { Run } from '../../daemon/control-messages';
import type { AwayChat } from './remote-state';

export interface FinishedAwayDeps {
  readonly recorded: (authorityKey: string) => readonly AwayChat[];
  readonly record: (authorityKey: string, chats: readonly AwayChat[]) => Promise<void>;
  // the host's chat runs now (control.listRuns)
  readonly runs: (authorityKey: string) => Promise<readonly Run[]>;
  // the core the recorded chats ran on has ended since (the server or its engine restarted), which stopped them
  readonly coreRestarted: (authorityKey: string) => boolean;
  readonly hostName: (authorityKey: string) => string;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  // one notice; resolves the action label the user chose, else undefined
  readonly notify: (message: string, actions: readonly string[], authorityKey: string) => Promise<string | undefined>;
  readonly open: (authorityKey: string, chat: AwayChat) => Promise<void>;
  readonly log: (line: string) => void;
}

/** The chats of a detach worth telling about later: the runs that were running, by the sessions this app knows them by. */
export function awayChats(runs: readonly Run[], sessionOf: (panelId: string) => string | undefined): AwayChat[] {
  return runs.flatMap((run) => {
    const sessionId = sessionOf(run.id);
    return run.kind === 'chat' && sessionId !== undefined ? [{ panelId: run.id, sessionId, title: run.title }] : [];
  });
}

/** The recorded chats the host no longer runs. */
export function finishedChats(recorded: readonly AwayChat[], runs: readonly Run[]): AwayChat[] {
  const running = new Set(runs.filter((run) => run.kind === 'chat').map((run) => run.id));
  return recorded.filter((chat) => !running.has(chat.panelId));
}

// An action's label: the chat's title, else its session, numbered when two chats share one.
function actionLabels(chats: readonly AwayChat[], untitled: string): string[] {
  const seen = new Map<string, number>();
  return chats.map((chat) => {
    const base = chat.title.trim() === '' ? untitled : chat.title;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

/**
 * Once a fresh connection's chats reopened: one notice for the recorded chats that finished meanwhile, the still running ones
 * kept for a later attach; when their core ended meanwhile, every recorded chat was stopped with it, and the notice says so.
 */
export async function announceFinishedAway(deps: FinishedAwayDeps, authorityKey: string): Promise<void> {
  const recorded = deps.recorded(authorityKey);
  if (recorded.length === 0) return;
  const stopped = deps.coreRestarted(authorityKey);
  const finished = stopped ? [...recorded] : finishedChats(recorded, await deps.runs(authorityKey));
  const stillRunning = recorded.filter((chat) => !finished.includes(chat));
  await deps.record(authorityKey, stillRunning);
  if (finished.length === 0) return;
  const name = deps.hostName(authorityKey);
  const message = stopped
    ? (finished.length === 1 ? deps.t('1 chat on {0} stopped when Damocles restarted there', name) : deps.t('{0} chats on {1} stopped when Damocles restarted there', finished.length, name))
    : (finished.length === 1 ? deps.t('1 chat on {0} finished while you were away', name) : deps.t('{0} chats on {1} finished while you were away', finished.length, name));
  const labels = actionLabels(finished, deps.t('New conversation'));
  const chosen = await deps.notify(message, labels, authorityKey);
  const index = chosen === undefined ? -1 : labels.indexOf(chosen);
  if (index >= 0) await deps.open(authorityKey, finished[index]!);
  deps.log(`[remote] ${authorityKey}: ${finished.length} chats ${stopped ? 'stopped by a restart' : 'finished'} while away${index >= 0 ? '; opened one' : ''}`);
}
