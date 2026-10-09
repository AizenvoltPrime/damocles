// The path validators every renderer-named project path passes: search, Quick Open, the Search Editor, the file drag, shell IPC
// and main's confinement (documents/confine.ts).

// Must stay equal to MAX_RELATIVE_PATH_LENGTH in src/desktop/preload/shell-channels.ts.
const MAX_RELATIVE_PATH_LENGTH = 4096;

/** A relative path a renderer may name: non-empty, bounded, '/' separated, no NUL, backslash, drive or root, and no '.' or '..' segment. */
export function isRelativeFilePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RELATIVE_PATH_LENGTH) return false;
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

// VS Code's WINDOWS_FORBIDDEN_NAMES (src/vs/base/common/extpath.ts), plus the superscript digits Windows also reserves.
const WIN32_RESERVED_NAME = /^(con|prn|aux|clock\$|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * A name Windows resolves to something else than the entry it names: Win32 path normalization strips a trailing '.' or space
 * ('.. ' becomes the parent), ':' opens an alternate data stream, and a device name opens the device. Node reaches such an
 * entry through \\?\ paths, but the shell's trash and reveal do not.
 */
export function isUnsafeWindowsName(name: string): boolean {
  const control = [...name].some((character) => character.charCodeAt(0) < 0x20);
  return control || /[<>:"|?*]/.test(name) || /[. ]$/.test(name) || WIN32_RESERVED_NAME.test(name);
}

/** Whether any segment of a '/' separated relative path is a name Windows would resolve elsewhere. */
export function hasUnsafeWindowsSegment(relativePath: string): boolean {
  return relativePath.split('/').some(isUnsafeWindowsName);
}
