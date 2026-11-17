// Add Project on a folder of the same repository as listed projects whose folders are missing (docs/desktop-app.md "Locate"):
// the user is asked whether such a project's chats move here. Either way the folder is added and its trust asked; Move Chats then
// runs Locate's relocation in merge mode, whose finish selects the moved project's last chat, where a plain add opens a new chat.
import type { OverlayQuickPickItem } from '../preload/overlay-channels';
import { visibleText } from '../../shared/visible-text';
import type { LocateConfirm, LocateOutcome } from './locate-project';

type Translate = (message: string, ...args: string[]) => string;

/** A listed local project whose folder is missing and whose chats the added folder may take over. */
export interface MissingProject {
  readonly key: string;
  readonly name: string;
  readonly fsPath: string;
  readonly chats: number;
}

export interface ReaddDeps {
  // core's projects.movedFrom, limited to listed local projects
  readonly candidates: (folder: string) => Promise<readonly MissingProject[]>;
  readonly confirm: (question: LocateConfirm) => Promise<boolean>;
  // the chosen item's id; undefined: dismissed
  readonly pick: (placeholder: string, items: readonly OverlayQuickPickItem[]) => Promise<string | undefined>;
  readonly add: (folder: string) => Promise<void>;
  readonly isTrusted: (folder: string) => boolean;
  // Add Project's trust question
  readonly requestTrust: (folder: string) => Promise<boolean>;
  // Locate of the missing project onto the added folder, without its picker, confirmation or trust question
  readonly moveChats: (key: string, folder: string) => Promise<LocateOutcome>;
  readonly newChat: (folder: string) => Promise<void>;
  readonly t: Translate;
}

const NOT_NOW = 'notNow';

/** 'moving' once a relocation started, whose finish selects the moved chat; 'added' after a plain add, which opened a new chat. */
export async function addProjectAt(folder: string, deps: ReaddDeps): Promise<'added' | 'moving'> {
  const candidates = await deps.candidates(folder);
  const chosen = candidates.length > 0 ? await askToMove(folder, candidates, deps) : undefined;
  await deps.add(folder);
  if (!deps.isTrusted(folder)) await deps.requestTrust(folder);
  if (chosen && (await deps.moveChats(chosen.key, folder)).kind === 'started') return 'moving';
  await deps.newChat(folder);
  return 'added';
}

/** One candidate: a question with Move Chats and Not Now; several: a pick list ending in Not Now. undefined: not now. */
export async function askToMove(folder: string, candidates: readonly MissingProject[], deps: Pick<ReaddDeps, 'confirm' | 'pick' | 't'>): Promise<MissingProject | undefined> {
  const { t } = deps;
  const chatsText = (chats: number): string => (chats === 1 ? t('1 chat') : t('{0} chats', String(chats)));
  if (candidates.length === 1) {
    const project = candidates[0]!;
    const name = visibleText(project.name);
    const moves = project.chats === 1
      ? t('1 chat moves, with its history, checkpoints, spend and memories.')
      : t('{0} chats move, with their history, checkpoints, spend and memories.', String(project.chats));
    const confirmed = await deps.confirm({
      title: t('Move {0}\'s chats here?', name),
      message: `${t('The folder of {0} is missing, and {1} is a folder of the same repository.', name, visibleText(folder))} ${moves}`,
      detail: { label: t('Missing folder'), text: visibleText(project.fsPath) },
      confirmLabel: t('Move Chats'),
      cancelLabel: t('Not Now'),
    });
    return confirmed ? project : undefined;
  }
  const items: OverlayQuickPickItem[] = [
    ...candidates.map((project) => ({ id: project.key, label: visibleText(project.name), description: visibleText(project.fsPath), hint: chatsText(project.chats) })),
    { id: NOT_NOW, label: t('Not Now') },
  ];
  const picked = await deps.pick(t('Move the chats of a missing project to {0}?', visibleText(folder)), items);
  return candidates.find((project) => project.key === picked);
}
