// A folder of a connected authority joins the project list (docs/remote-development.md "Moved project folders"): its trust is
// asked first and the host's core reads it from then on, so the host core's projects.movedFrom reads its root commits; a missing
// project of the host whose chats the folder may take over is offered as Add Project offers a local one.
import type { LocateOutcome } from '../locate-project';
import { folderProject, type OpenAsProjectDeps } from '../open-as-project';
import type { MissingProject } from '../project-readd';
import { undoOnThrow, type TrustAnswer } from '../trust-store';

export interface RemoteProjectAddDeps {
  readonly opening: Pick<OpenAsProjectDeps, 'isDirectory' | 'projectKeyOf' | 'isProject' | 'notFolder' | 'add' | 'added' | 'select'>;
  // the host's trust question for the folder as the project the key names
  readonly askTrust: (projectKey: string, folder: string) => Promise<TrustAnswer>;
  // the host core's trust mirror lists the folder until the returned release
  readonly holdTrust: (projectKey: string, folder: string) => () => void;
  // the host core's projects.movedFrom among the host's listed projects, and the user's answer whether one's chats move here
  readonly missingProjectOf: (folder: string) => Promise<MissingProject | undefined>;
  // Locate of the missing project onto the added folder, without its picker, confirmation or trust question
  readonly moveChats: (key: string, folder: string) => Promise<LocateOutcome>;
  // the quit's store flush waits for work (shutdown.ts QuitJoins)
  readonly joinQuit: <T>(work: Promise<T>) => Promise<T>;
}

/**
 * Adds the authority's folder as a project and selects it, or a move that started selects the moved chat once it is done; a
 * folder that is a project already is selected, asking nothing. Resolves the project's key.
 */
export async function addRemoteProjectAt(deps: RemoteProjectAddDeps, authorityKey: string, folder: string): Promise<string> {
  const { projectKey, listed } = await folderProject(deps.opening, authorityKey, folder);
  if (listed) {
    await deps.opening.select(projectKey);
    return projectKey;
  }
  let release: (() => void) | undefined;
  try {
    // the grant lands before the folder is listed, so a quit in between keeps both or neither
    const chosen = await deps.joinQuit((async () => {
      const trust = await deps.askTrust(projectKey, folder);
      return undoOnThrow(trust.undo, async () => {
        release = deps.holdTrust(projectKey, folder);
        const picked = await deps.missingProjectOf(folder);
        await deps.opening.add(authorityKey, folder, projectKey, undefined);
        return picked;
      });
    })());
    deps.opening.added(authorityKey);
    if (!chosen || (await deps.moveChats(chosen.key, folder)).kind !== 'started') await deps.opening.select(projectKey);
    return projectKey;
  } finally {
    release?.();
  }
}
