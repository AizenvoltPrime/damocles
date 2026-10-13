import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// Above every OS's own limit (Windows 63, Linux 40, macOS 32), so the walk never refuses a chain realpath would follow.
const MAX_LINK_HOPS = 64;

// A link target as a local Windows path: \??\C:\ is how a junction names a drive; any other \??\ path, and a drive-relative
// C:x, which resolves against a per-drive cwd the OS keeps, is undefined.
function localLinkTarget(target: string): string | undefined {
  const spelled = target.replace(/\//g, '\\');
  if (!spelled.startsWith('\\??\\')) return /^[a-z]:(?!\\)/i.test(spelled) ? undefined : spelled;
  return /^\\\?\?\\[a-z]:\\/i.test(spelled) ? spelled.slice(4) : undefined;
}

function isUnder(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Whether following every link along segments under base stays off UNC and device roots other than base's own, decided by
 * lstat and readlink alone, so a refused target is never opened (opening \\server\share sends the user's NTLM credentials).
 * Windows resolves a relative target lexically against the link's folder, and so does the walk. POSIX has no such roots.
 */
export async function followsLocalLinksOnly(base: string, segments: readonly string[]): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const baseRoot = path.parse(base).root.toLowerCase();
  let current = base;
  let pending = [...segments];
  for (let hops = 0; pending.length > 0; ) {
    const next = path.join(current, pending.shift()!);
    if (!(await fs.lstat(next)).isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) throw Object.assign(new Error(`Too many links under ${base}`), { code: 'ELOOP' });
    const target = localLinkTarget(await fs.readlink(next));
    if (target === undefined) return false;
    const resolved = path.resolve(current, target, ...pending);
    if (resolved.startsWith('\\\\') && path.parse(resolved).root.toLowerCase() !== baseRoot) return false;
    // current and everything above it up to base hold no link, so the walk resumes from the deepest of them it can.
    current = isUnder(current, resolved) ? current : isUnder(base, resolved) ? base : path.parse(resolved).root;
    pending = path.relative(current, resolved).split(path.sep).filter(Boolean);
  }
  return true;
}
