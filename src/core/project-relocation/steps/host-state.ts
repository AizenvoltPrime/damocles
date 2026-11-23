// The `hostState` step: the path-keyed state this core keeps, MCP toggles on every core, and forge bindings and the desktop
// themes' project looks and pins on the desktop core. Idempotent, so projects.applyHostState runs it again in a core that did
// not run the relocation.
import { folderKey } from '../../workspace-folders/folder-key';
import type { RelocationFolder } from '../types';
import { STEP_DONE, type StepOutcome } from './outcome';

interface ProjectKeyed {
  relocateProject(fromKey: string, toKey: string): Promise<void>;
}

export interface HostStateTargets {
  readonly mcp: { relocateFolders(pairs: ReadonlyArray<{ readonly from: string; readonly to: string }>): Promise<void> };
  /** This computer's desktop core alone keeps Git hosting bindings. */
  readonly forge?: ProjectKeyed;
  /** This computer's desktop core alone keeps project looks and character pins (themes/projects.json). */
  readonly themes?: ProjectKeyed;
}

export async function runHostStateStep(folders: readonly RelocationFolder[], targets: HostStateTargets): Promise<StepOutcome> {
  await targets.mcp.relocateFolders(folders.map(({ from, to }) => ({ from, to })));
  for (const folder of folders) {
    if (folder.kind !== 'project') continue;
    await targets.forge?.relocateProject(folderKey(folder.from), folderKey(folder.to));
    await targets.themes?.relocateProject(folderKey(folder.from), folderKey(folder.to));
  }
  return STEP_DONE;
}
