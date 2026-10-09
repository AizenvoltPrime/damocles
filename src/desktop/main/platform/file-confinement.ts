import * as path from 'node:path';
import type { FileConfinement } from '../../../platform/file-confinement';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { confineExisting } from '../documents/confine';

/** confine.ts's rule, so a link to a share is refused before anything follows it. */
export function createDesktopFileConfinement(): FileConfinement {
  return {
    confineExisting: (folder, relativePath) => confineExisting({ key: folderKey(folder), fsPath: folder, name: path.basename(folder) }, relativePath),
  };
}
