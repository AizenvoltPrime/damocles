import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileConfinement } from '../../platform/file-confinement';
import { followsLocalLinksOnly, realpathOnOwnShare } from '../../core/local-links';
import { isInsideRealRoot, linkRootOf } from '../../core/workspace-folders/real-root';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';

/**
 * Desktop's rule (confine.ts): under either rule the segments are walked by followsLocalLinksOnly before any stat or realpath,
 * and the realpath must stay off other shares (realpathOnOwnShare); throughLinks also follows a link out of the folder to the
 * deepest link's realpath.
 */
export function createVsCodeFileConfinement(): FileConfinement {
  return {
    confineExisting: async (folder, relativePath, rule) => {
      const segments = relativePath === '' ? [] : relativePath.split('/');
      // the walk and the link root read lexical prefixes, which a '..' segment would leave
      if (relativePath !== '' && (!isRelativeFilePath(relativePath) || (process.platform === 'win32' && hasUnsafeWindowsSegment(relativePath)))) return { ok: false, reason: 'outside' };
      try {
        if (!(await followsLocalLinksOnly(folder, segments))) return { ok: false, reason: 'outside' };
        const [realFolder, realFile] = await Promise.all([fs.realpath(folder), fs.realpath(path.join(folder, ...segments))]);
        if (!realpathOnOwnShare(folder, realFolder, realFile)) return { ok: false, reason: 'outside' };
        if (isInsideRealRoot(realFolder, realFile)) return { ok: true, path: realFile };
        const via = rule === 'throughLinks' ? await linkRootOf(folder, segments, realFile) : undefined;
        return via ? { ok: true, path: realFile, via } : { ok: false, reason: 'outside' };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'failed' };
      }
    },
  };
}
