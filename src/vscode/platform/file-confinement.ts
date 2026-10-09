import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileConfinement } from '../../platform/file-confinement';
import { folderKey } from '../../core/workspace-folders/folder-key';

/**
 * Links followed by realpath. VS Code's own file service stats and opens through every link in the workspace, so a walk here
 * would keep no credentials off the network, and no VS Code view names a project file for a mention (fileMentionDrop).
 */
export function createVsCodeFileConfinement(): FileConfinement {
  return {
    confineExisting: async (folder, relativePath) => {
      try {
        const [realFolder, realFile] = await Promise.all([fs.realpath(folder), fs.realpath(path.join(folder, ...relativePath.split('/')))]);
        const relative = path.relative(folderKey(realFolder), folderKey(realFile));
        const inside = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
        return inside ? { ok: true, path: realFile } : { ok: false, reason: 'outside' };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'failed' };
      }
    },
  };
}
