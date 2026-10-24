// The path functions D62 worktree isolation reads (docs/worktree-isolation.md "Path functions"): each gives the text
// the real function prints, or undefined where the shells disagree or the case was not verified on Windows PowerShell
// 5.1, pwsh 7 and Git Bash.

const WINDOWS = process.platform === 'win32';
const SEPARATOR = WINDOWS ? '\\' : '/';
// Characters PowerShell may read as a wildcard or escape, and on Unix the separator it may rewrite.
const PS_UNREAD = WINDOWS ? /[*?[\]`\r\n]/ : /[*?[\]`\\\r\n]/;

/**
 * A FileSystem path PowerShell reads as written: no wildcard, no provider or other drive, no UNC, and a drive letter from
 * `drives` (upper case), which are known to exist; a missing drive makes the cmdlet fail and print nothing.
 */
function psPlain(text: string, drives: ReadonlySet<string>): boolean {
  if (text === '' || PS_UNREAD.test(text) || /^[\\/]{2}/.test(text)) return false;
  const drive = WINDOWS ? /^([A-Za-z]):/.exec(text) : null;
  if (text.slice(drive === null ? 0 : 2).includes(':')) return false;
  return drive === null || drives.has(drive[1]!.toUpperCase());
}

/**
 * `Join-Path parent child` on the FileSystem provider (`NavigationProviderBase.MakePath`): separators normalized, one
 * leading separator of the child dropped, and one separator between them unless the parent ends with one.
 */
export function psJoinPath(parent: string, child: string, drives: ReadonlySet<string>): string | undefined {
  if (!psPlain(parent, drives) || !psPlain(child, drives) || child.includes(':')) return undefined;
  const base = parent.replace(/[\\/]/g, SEPARATOR);
  const rest = child.replace(/[\\/]/g, SEPARATOR);
  // Windows PowerShell 5.1 keeps a doubled separator here and pwsh 7 drops it.
  if (rest.startsWith(SEPARATOR + SEPARATOR)) return undefined;
  const tail = rest.startsWith(SEPARATOR) ? rest.slice(1) : rest;
  return base.endsWith(SEPARATOR) ? base + tail : base + SEPARATOR + tail;
}

/** `Split-Path -Parent`, `-Leaf` or `-Qualifier`; undefined for a root, a doubled or trailing separator, and a last `.` or `..`. */
export function psSplitPath(text: string, part: 'parent' | 'leaf' | 'qualifier', drives: ReadonlySet<string>): string | undefined {
  // Split-Path resolves a lone `~` to the home folder, and keeps it as written anywhere else.
  if (!psPlain(text, drives) || text === '~') return undefined;
  if (part === 'qualifier') return WINDOWS ? /^([A-Za-z]:)[\\/]/.exec(text)?.[1] : undefined;
  if (WINDOWS && /^[A-Za-z]:(?![\\/])/.test(text)) return undefined;
  const normalized = text.replace(/[\\/]/g, SEPARATOR);
  const pieces = normalized.split(SEPARATOR);
  const leaf = pieces.at(-1)!;
  if (pieces.slice(1).includes('') || leaf === '.' || leaf === '..') return undefined;
  if (part === 'leaf') return leaf;
  const parent = pieces.slice(0, -1).join(SEPARATOR);
  return parent === '' || /^[A-Za-z]:$/.test(parent) ? undefined : parent;
}

/**
 * `[IO.Path]::Combine(args)`: each rooted argument restarts the path, an empty one is skipped, and a separator joins two
 * only when the first does not end with one. A drive-relative argument and characters 5.1 rejects stay unread.
 */
export function pathCombine(args: readonly string[]): string | undefined {
  let combined = '';
  for (const arg of args) {
    // .NET Framework rejects these characters; .NET Core accepts them.
    if (/["<>|]/.test(arg) || [...arg].some((c) => c < ' ')) return undefined;
    // 5.1 takes a `:` anywhere as a volume separator, and 7 only after a leading drive letter.
    if (WINDOWS && (/^[A-Za-z]:(?![\\/])/.test(arg) || arg.slice(/^[A-Za-z]:/.test(arg) ? 2 : 0).includes(':'))) return undefined;
    if (arg === '') continue;
    const rooted = WINDOWS ? /^(?:[\\/]|[A-Za-z]:)/.test(arg) : arg.startsWith('/');
    if (rooted || combined === '') combined = arg;
    else combined += (WINDOWS ? /[\\/]$/ : /\/$/).test(combined) ? arg : SEPARATOR + arg;
  }
  return combined === '' ? undefined : combined;
}

// Git Bash's coreutils take `\` as a separator too, and a leading drive as a root.
const BASH_SEPARATOR = WINDOWS ? /[\\/]/ : /\//;
const BASH_TRAILING = WINDOWS ? /[\\/]+$/ : /\/+$/;

/** A POSIX `dirname` or `basename` operand both read alike: not empty, one line, and no `//` the standard leaves open. */
function posixOperand(text: string): boolean {
  return text !== '' && !text.includes('\n') && !(WINDOWS ? /^[\\/]{2}/ : /^\/\//).test(text);
}

/** POSIX `dirname`; a drive with nothing below it stays unread, since Git Bash keeps the drive. */
export function posixDirname(text: string): string | undefined {
  if (!posixOperand(text)) return undefined;
  if (text === '/') return '/';
  const trimmed = text.replace(BASH_TRAILING, '');
  if (trimmed === '') return undefined;
  const last = Math.max(trimmed.lastIndexOf('/'), WINDOWS ? trimmed.lastIndexOf('\\') : -1);
  if (WINDOWS && /^[A-Za-z]:/.test(text)) {
    if (last < 0) return undefined;
    const parent = trimmed.slice(0, last).replace(BASH_TRAILING, '');
    return /^[A-Za-z]:[\\/]+[^\\/]/.test(parent) ? parent : undefined;
  }
  if (last < 0) return '.';
  const parent = trimmed.slice(0, last).replace(BASH_TRAILING, '');
  if (parent !== '') return parent;
  return text.startsWith('/') ? '/' : undefined;
}

/** POSIX `basename` without a suffix operand; a drive leaf stays unread. */
export function posixBasename(text: string): string | undefined {
  if (!posixOperand(text)) return undefined;
  if (text === '/') return '/';
  const trimmed = text.replace(BASH_TRAILING, '');
  const leaf = trimmed.split(BASH_SEPARATOR).at(-1)!;
  return leaf === '' || (WINDOWS && leaf.includes(':')) ? undefined : leaf;
}
