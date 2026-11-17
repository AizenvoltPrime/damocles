// Locate… for a project whose folder was moved or renamed: the new folder is picked, core's preflight checks the move,
// the user confirms, Remove Project's terminal question and the editor's unsaved-editors question are asked, the new folder is
// asked for trust as Add Project asks, the project's loaded chats close, and core runs the journaled relocation
// (docs/desktop-app.md "Locate"). A remote project's core is its host's, and its paths are the host's.
import * as path from 'node:path';
import type { Coded, PreflightAnswer, PreflightRequest, RelocationRequest } from '../../core/project-relocation/types';
import type { PathPresence } from '../../core/workspace-folders/folder-presence-probe';
import { visibleText } from '../../shared/visible-text';
import type { RootCloseAnswers } from './editor-pane';
import type { ProjectPresence } from './project-presence';
import type { RemoveProjectDeps } from './remove-project';

type Translate = (message: string, ...args: string[]) => string;

export interface LocateConfirm {
  readonly title: string;
  readonly message: string;
  readonly detail: { readonly label: string; readonly text: string };
  readonly warning?: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

/** What Locate prepared before core started the move, which the host part uses once the move reached coreDone. */
export interface LocatePrepared {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  // the old root's unsaved-editor answers, which closing its tabs after the move needs
  readonly answers: RootCloseAnswers;
}

export interface LocateProjectDeps {
  // a listed project of the core's authority; undefined once it left the list
  readonly project: (key: string) => { readonly name: string; readonly fsPath: string } | undefined;
  readonly presence: (key: string) => ProjectPresence;
  // every listed project's path, which preflight reads for the merge mode and the insideProject notice
  readonly listed: () => readonly string[];
  // what the path is, its volume asked first, within the presence deadline
  readonly pathPresence: (fsPath: string) => Promise<PathPresence>;
  // the path rules of the project's machine
  readonly pathFlavor: path.PlatformPath;
  readonly pickFolder: (defaultPath: string | undefined) => Promise<string | undefined>;
  // D33's busy rule over the project's loaded chats, as Remove Project reads it
  readonly busy: RemoveProjectDeps['busy'];
  readonly preflight: (request: PreflightRequest) => Promise<PreflightAnswer>;
  readonly confirm: (question: LocateConfirm) => Promise<boolean>;
  // the editor's Save, Don't Save or Cancel for each dirty tab of the root; undefined: cancelled
  readonly confirmCloseRoot: (key: string) => Promise<RootCloseAnswers | undefined>;
  readonly terminals: Pick<RemoveProjectDeps['terminals'], 'idsIn' | 'confirmKill'>;
  readonly isTrusted: (fsPath: string) => boolean;
  // Add Project's trust question; resolves whether the folder is trusted afterwards
  readonly requestTrust: (fsPath: string) => Promise<boolean>;
  // closes the project's loaded chats keeping their saved state, settling once core let their sessions go; they wait with the
  // chats the missing folder kept closed, until the folder is back or the move is done
  readonly closeChats: (key: string) => Promise<void>;
  readonly relocate: (request: RelocationRequest) => Promise<{ readonly id: string } | { readonly refusal: Coded }>;
  readonly started: (id: string, prepared: LocatePrepared) => void;
  // the relocate request failed without an answer; core may have written its journal and run the move all the same
  readonly interrupted: (prepared: LocatePrepared) => void;
  // the row shows why the move was refused
  readonly refused: (key: string, refusal: Coded) => void;
  readonly t: Translate;
}

export type LocateOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refused'; readonly refusal: Coded }
  | { readonly kind: 'started'; readonly id: string };

/**
 * Locate… on a missing or unavailable project; every refusal also goes to the row through deps.refused. `offered` is the
 * folder a re-add offer named, whose own question and trust question were asked already, so neither the picker, the
 * confirmation nor the trust question is asked.
 */
export async function locateProject(key: string, deps: LocateProjectDeps, offered?: string): Promise<LocateOutcome> {
  const project = deps.project(key);
  if (!project) throw new Error(deps.t('The project is no longer in the project list.'));
  const refuse = (refusal: Coded): LocateOutcome => {
    deps.refused(key, refusal);
    return { kind: 'refused', refusal };
  };
  if (deps.presence(key) === 'present') return refuse({ code: 'fromExists' });
  // a volume that does not answer would hold every ancestor's stat until its deadline
  const to = offered ?? await deps.pickFolder(deps.presence(key) === 'unavailable' ? undefined : await nearestExistingAncestor(project.fsPath, deps.pathPresence, deps.pathFlavor));
  if (to === undefined) return { kind: 'cancelled' };
  if (await deps.busy(key)) return refuse({ code: 'busy' });
  const request = (): RelocationRequest => ({ from: project.fsPath, to, listed: deps.listed() });
  // the project's chats loaded here close before relocate, which checks every holder again
  const answer = await deps.preflight({ ...request(), heldHere: 'ignore' });
  if (!answer.ok) return refuse(answer.refusal);
  if (offered === undefined && !(await deps.confirm(locateConfirm(project, to, answer, deps.t)))) return { kind: 'cancelled' };
  const answers = await deps.confirmCloseRoot(key);
  if (!answers) return { kind: 'cancelled' };
  if (!(await deps.terminals.confirmKill(deps.terminals.idsIn(key)))) return { kind: 'cancelled' };
  // declining trust keeps the move going, as Add Project keeps the folder
  if (offered === undefined && !deps.isTrusted(to)) await deps.requestTrust(to);
  // a turn may have started while the questions were open
  if (await deps.busy(key)) return refuse({ code: 'busy' });
  await deps.closeChats(key);
  const prepared: LocatePrepared = { key, from: project.fsPath, to, answers };
  let started: Awaited<ReturnType<LocateProjectDeps['relocate']>>;
  try {
    started = await deps.relocate(request());
  } catch (err) {
    deps.interrupted(prepared);
    throw err;
  }
  if ('refusal' in started) return refuse(started.refusal);
  deps.started(started.id, prepared);
  return { kind: 'started', id: started.id };
}

/** Runs one Locate of a project at a time; another request for it meanwhile is cancelled, asking nothing. */
export async function locateOnce(running: Set<string>, key: string, locate: () => Promise<LocateOutcome>): Promise<LocateOutcome> {
  if (running.has(key)) return { kind: 'cancelled' };
  running.add(key);
  try {
    return await locate();
  } finally {
    running.delete(key);
  }
}

/**
 * Locate requests that failed without an answer, by the authority of their core: a move that core reports later from and to
 * the same folders is the request's, so it applies as requested here, with the answers Locate took.
 */
export class InterruptedLocates {
  private requests: { readonly authority: string; readonly prepared: LocatePrepared }[] = [];

  record(authority: string, prepared: LocatePrepared): void {
    this.forget(authority, prepared.key);
    this.requests.push({ authority, prepared });
  }

  // a later Locate of the project started its own move
  forget(authority: string, key: string): void {
    this.requests = this.requests.filter((request) => request.authority !== authority || request.prepared.key !== key);
  }

  /** The request a reported move answers, taken once. */
  adopt(authority: string, view: { readonly from: string; readonly to: string }): LocatePrepared | undefined {
    const found = this.requests.find((request) => request.authority === authority && request.prepared.from === view.from && request.prepared.to === view.to);
    if (found) this.requests = this.requests.filter((request) => request !== found);
    return found?.prepared;
  }
}

/** Whether a move core reports under the id Locate's relocate got is the move Locate prepared: the same folders, by key. */
export function preparedMove(prepared: LocatePrepared, view: { readonly from: string; readonly to: string }, keyOf: (fsPath: string) => string): boolean {
  return keyOf(view.from) === keyOf(prepared.from) && keyOf(view.to) === keyOf(prepared.to);
}

/**
 * The folder the picker opens at: the nearest ancestor of the old path that is a directory now; undefined once an ancestor does
 * not answer, or none is a directory.
 */
export async function nearestExistingAncestor(fsPath: string, pathPresence: (candidate: string) => Promise<PathPresence>, flavor: path.PlatformPath): Promise<string | undefined> {
  for (let candidate = flavor.dirname(fsPath); ; candidate = flavor.dirname(candidate)) {
    const found = await pathPresence(candidate);
    if (found === 'directory') return candidate;
    if (found === 'unreachable' || flavor.dirname(candidate) === candidate) return undefined;
  }
}

/**
 * "Move acme's chats to D:\work\acme?" with the chats it moves and preflight's notices; an unreachable old folder and another
 * repository warn.
 */
export function locateConfirm(project: { readonly name: string; readonly fsPath: string }, to: string, answer: Extract<PreflightAnswer, { ok: true }>, t: Translate): LocateConfirm {
  const name = visibleText(project.name);
  const counted = answer.chats === 0
    ? t('{0} has no chats to move. Its settings follow the folder.', name)
    : answer.chats === 1
      ? t('1 chat moves, with its history, checkpoints, spend and memories.')
      : t('{0} chats move, with their history, checkpoints, spend and memories.', String(answer.chats));
  const worktrees = answer.worktrees === 0 ? [] : [answer.worktrees === 1 ? t('Its chat worktree stays where it is and follows it.') : t('Its {0} chat worktrees stay where they are and follow it.', String(answer.worktrees))];
  const warns = (notice: Coded): boolean => notice.code === 'unreachable' || notice.code === 'otherRepository';
  const notices = answer.notices.filter((notice) => !warns(notice)).map((notice) => relocationText(notice, project, t));
  const warnings = answer.notices.filter(warns).map((notice) => relocationText(notice, project, t));
  return {
    title: t('Move {0}\'s chats to {1}?', name, visibleText(to)),
    message: [counted, ...worktrees, ...notices].join(' '),
    detail: { label: t('New folder'), text: visibleText(to) },
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
    confirmLabel: t('Move Chats'),
    cancelLabel: t('Cancel'),
  };
}

const param = (coded: Coded, name: string): string => {
  const value = coded.params?.[name];
  return value === undefined ? '' : visibleText(String(value));
};

/** A relocation's refusal, notice or step failure in the user's language; project is the project being located. */
export type LocateShown<V> = { readonly state: 'move'; readonly view: V } | { readonly state: 'notLocatable' | 'refused'; readonly reason: Coded };

/**
 * What a project's row shows of its Locate: the move its core runs or paused, else, only while the folder is not there, why a
 * folder in a chat worktree is never located, or the last refusal.
 */
export function locateShown<V>(view: V | undefined, absent: boolean, chatWorktree: () => Coded | undefined, refusal: Coded | undefined): LocateShown<V> | undefined {
  if (view) return { state: 'move', view };
  if (!absent) return undefined;
  const managed = chatWorktree();
  if (managed) return { state: 'notLocatable', reason: managed };
  return refusal && { state: 'refused', reason: refusal };
}

export function relocationText(coded: Coded, project: { readonly name: string; readonly fsPath: string }, t: Translate): string {
  const name = visibleText(project.name);
  const oldPath = visibleText(project.fsPath);
  switch (coded.code) {
    case 'busy': return t('A conversation is running in {0}. Stop it or wait for it to finish, then locate the project.', name);
    case 'fromExists': return t('{0} still exists. Locate moves the chats of a folder that was moved or renamed.', oldPath);
    case 'toMissing': return t('The folder you picked no longer exists.');
    case 'toNotDirectory': return t('What you picked is not a folder.');
    case 'sameFolder': return t('You picked the project\'s own folder.');
    case 'insideDamocles': return t('You picked a folder inside Damocles\' own data folder.');
    case 'otherAuthority': return t('You picked a folder on another host than the project\'s.');
    case 'chatWorktree': return coded.params?.['projectPath'] === undefined
      ? t('{0} is in the folder where Damocles keeps chat worktrees, so it can\'t be located. Remove this project.', oldPath)
      : t('{0} is a chat worktree of {1}, which Damocles keeps in place, so it can\'t be located. Move the folder back if you moved it, or remove this project.', oldPath, param(coded, 'projectPath'));
    case 'pendingRelocation': return t('The chats of {0} are being moved already. Wait for that move to finish.', param(coded, 'path'));
    case 'chatHeld': {
      const title = param(coded, 'title') || t('Untitled chat');
      if (coded.params?.['holder'] === 'thisProcess') return t('The chat "{0}" is open in this window. Close it, then locate the project.', title);
      return t('The chat "{0}" is open in another Damocles window or in VS Code. Close it there, then locate the project.', title);
    }
    case 'agentRunHeld': {
      const title = param(coded, 'title') || t('Untitled chat');
      if (coded.params?.['holder'] === 'thisProcess') return t('A subagent or team of the chat "{0}" is still running in this window. Wait for it to finish, then locate the project.', title);
      return t('A subagent or team of the chat "{0}" is still running in another Damocles window or in VS Code. Wait for it to finish, then locate the project.', title);
    }
    case 'registryUnreadable': return t('Damocles can\'t read the chat worktree registry, so it can\'t check {0}\'s chat worktrees.', name);
    case 'repositoryLayout': return t('The new folder does not lie in its repository as {0} did in {1}, so its chat worktrees can\'t follow it.', name, param(coded, 'path'));
    case 'noRepository': return t('{0} is not a Git repository, so {1}\'s chat worktrees can\'t be linked to it.', param(coded, 'path'), name);
    case 'worktreeFinishing': return t('Apply, Merge, Update or Delete is running on the chat worktree {0}. Try again when it ends.', param(coded, 'branch'));
    case 'worktreeHandOff': return t('A chat is moving into or out of the chat worktree {0}. Try again when the move ends.', param(coded, 'branch'));
    case 'worktreesNotRelinkable': return t('The new folder\'s repository does not know these chat worktrees, so they can\'t be linked to it: {0}. You can delete them after the move.', param(coded, 'branches'));
    case 'untrusted': return coded.params?.['count'] === 1 ? t('Trust {0} to re-link its chat worktree.', name) : t('Trust {0} to re-link its {1} chat worktrees.', name, param(coded, 'count'));
    case 'repairFailed': return coded.params?.['count'] === 1 ? t('A chat worktree of {0} could not be re-linked to its repository.', name) : t('{0} chat worktrees of {1} could not be re-linked to its repository.', param(coded, 'count'), name);
    case 'unreachable': return t('{0} is not reachable, so Damocles can\'t check that {1} is gone. If it still exists there, it will no longer show these chats.', param(coded, 'root'), oldPath);
    case 'otherRepository': return t('The new folder looks like another repository: it shares no remote and no first commit with {0}.', oldPath);
    case 'insideProject': return t('The new folder is inside the project {0}.', param(coded, 'projectPath'));
    case 'merge': return t('{0} is a project already: its settings and layout stay, and these chats join its chats.', param(coded, 'projectPath'));
    case 'conflict': return t('The move paused: {0} is in the new place already with other content. Keep one copy, then retry.', param(coded, 'path'));
    case 'io': return t('The move paused: Damocles could not move {0} ({1}).', param(coded, 'path'), param(coded, 'errno'));
    case 'memoryReadOnly': {
      const reason = coded.params?.['reason'];
      if (reason === 'disabled') return t('The project\'s memories stay with its old folder while memory is turned off. Damocles moves them at a start with memory on.');
      if (reason === 'readOnly') return t('The project\'s memories could not move yet: the memory database is read-only. Damocles tries again at its next start.');
      if (reason === 'unavailable') return t('The project\'s memories could not move yet: the memory database is not available. Damocles tries again at its next start.');
      return t('The project\'s memories could not move yet. Damocles tries again at its next start.');
    }
    case 'locked': return t('The move paused: a chat of {0} was opened while its chats were moving. Close it, then retry.', name);
    case 'agentRunning': return t('The move paused: a subagent or team of a chat of {0} is still running. Wait for it to finish, then retry.', name);
    case 'stopped': return t('The move was stopped.');
    case 'earlierMove': return t('The project\'s memories move once an earlier move of {0} has moved its own. Damocles moves them then.', param(coded, 'path'));
    case 'notPaused': return t('The move of {0} is no longer paused, so it was not stopped.', name);
    case 'relocationRunning': return t('The move of {0} is running, so it was not stopped.', name);
    default: return t('The move paused ({0}).', visibleText(coded.code));
  }
}
