// Remove Project, with VS Code's close-with-unsaved-changes question when a chat of the project holds its first prompt for
// its worktree (rule 6): such a chat has no session file to come back from, so its message is discarded only once the user
// says so.
import type { UserContentBlock } from '../../shared/types/content';
import { visibleText } from '../../shared/visible-text';
import { MAX_MESSAGE_PREVIEW_LINES, MAX_OVERLAY_LABEL_LENGTH } from '../preload/overlay-channels';
import type { RemoveProjectResult } from '../preload/shell-channels';
import type { AskMessage, MessageQuestion } from './message-dialog';
import type { KillListEntry } from './terminal/terminal-service';

/** A loaded chat of the project, its worktrees' included, holding its first prompt while its worktree is created or set up. */
export interface WaitingChat {
  readonly corePanelId: string;
  // '' for a chat with no title yet
  readonly title: string;
  readonly prompt: readonly UserContentBlock[];
  // the worktree being set up for it, once created
  readonly worktreeId?: string;
}

type Translate = (message: string, ...args: string[]) => string;

export interface RemoveProjectDeps {
  readonly project: (key: string) => { readonly name: string };
  // D33's busy rule over the project's loaded chats, its worktrees' included, which core decides
  readonly busy: (key: string) => Promise<boolean>;
  readonly waitingChats: (key: string) => WaitingChat[];
  readonly terminals: {
    // the project's terminals and its worktrees'
    readonly idsIn: (key: string) => string[];
    readonly setupTerminal: (worktreeId: string) => string | undefined;
    readonly toConfirm: (ids: readonly string[]) => KillListEntry[];
    readonly confirmKill: (ids: readonly string[]) => Promise<boolean>;
  };
  readonly ask: AskMessage;
  // closes the chats, then settles once each unused worktree is discarded (stopped Setup terminal, released folder)
  readonly discard: (chats: readonly WaitingChat[]) => Promise<void>;
  // unloads the project's worktree chats and removes it from the list
  readonly remove: (key: string) => Promise<void>;
  readonly t: Translate;
}

const EXCERPT_LENGTH = 40;

/**
 * Asks once, then removes the project: with no waiting first message only the terminal question it always asked (G22), else
 * one danger question that lists the waiting chats and counts the other terminals it stops. A refusal comes back as the reason
 * the project list shows; a Cancel changes nothing.
 */
export async function removeProject(key: string, deps: RemoveProjectDeps): Promise<RemoveProjectResult> {
  const { name } = deps.project(key);
  const running = (): RemoveProjectResult => ({ ok: false, reason: deps.t('A conversation is running in {0}. Stop it or wait for it to finish, then remove the project.', name) });
  if (await deps.busy(key)) return running();
  let waiting = deps.waitingChats(key);
  for (;;) {
    if (!(await confirmRemoval(key, name, waiting, deps))) return { ok: true };
    // a turn may have started, or another chat held its first prompt, while the question was open
    if (await deps.busy(key)) return running();
    const asked = new Set(waiting.map((chat) => chat.corePanelId));
    waiting = deps.waitingChats(key);
    if (waiting.every((chat) => asked.has(chat.corePanelId))) break;
  }
  if (waiting.length > 0) await deps.discard(waiting);
  await deps.remove(key);
  return { ok: true };
}

async function confirmRemoval(key: string, name: string, waiting: readonly WaitingChat[], deps: RemoveProjectDeps): Promise<boolean> {
  const ids = deps.terminals.idsIn(key);
  if (waiting.length === 0) return deps.terminals.confirmKill(ids);
  // a waiting chat's Setup terminal stops with its worktree's discard, which the question already names
  const setups = new Set(waiting.flatMap((chat) => (chat.worktreeId === undefined ? [] : deps.terminals.setupTerminal(chat.worktreeId) ?? [])));
  const terminals = deps.terminals.toConfirm(ids.filter((id) => !setups.has(id)));
  return (await deps.ask(removeProjectQuestion(name, waiting, terminals.length, deps.t))) === 0;
}

/** The danger question: Remove Project, with Cancel focused first; a preview line per chat, the overflow folded into "and N more". */
export function removeProjectQuestion(projectName: string, chats: readonly WaitingChat[], terminals: number, t: Translate): MessageQuestion {
  const name = visibleText(projectName);
  const one = chats.length === 1;
  const fits = chats.length <= MAX_MESSAGE_PREVIEW_LINES;
  const shown = fits ? chats : chats.slice(0, MAX_MESSAGE_PREVIEW_LINES - 1);
  const discards = one ? t('Removing it discards the message and the worktree being prepared for it.') : t('Removing it discards the messages and the worktrees being prepared for them.');
  const stops = terminals === 0 ? [] : [terminals === 1 ? t('It also terminates an active terminal session.') : t('It also terminates {0} active terminal sessions.', String(terminals))];
  return {
    severity: 'danger',
    message: one
      ? t('{0} has a chat whose first message is waiting for its worktree. Do you want to remove the project?', name)
      : t('{0} has {1} chats whose first messages are waiting for their worktrees. Do you want to remove the project?', name, String(chats.length)),
    detail: [discards, ...stops].join(' '),
    preview: [...shown.map((chat) => chatLine(chat, t)), ...(fits ? [] : [t('and {0} more', String(chats.length - shown.length))])],
    actions: [t('Remove Project')],
    cancelLabel: t('Cancel'),
  };
}

// The chat's title, else a short excerpt of its waiting message on one line.
function chatLine(chat: WaitingChat, t: Translate): string {
  if (chat.title !== '') return clip(visibleText(chat.title), MAX_OVERLAY_LABEL_LENGTH);
  const text = chat.prompt.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ').replace(/\s+/g, ' ').trim();
  return text === '' ? t('A message with images only') : visibleText(clip(text, EXCERPT_LENGTH));
}

// At most max code points, the last one an ellipsis when cut.
function clip(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}
