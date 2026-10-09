// How a shell executable's path is read before any file system call, for detected and user terminal profiles alike.
import * as path from 'node:path';

// Windows opens these names as devices in every folder and with any extension.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export type ExecutablePathForm = { readonly kind: 'absolute'; readonly file: string } | { readonly kind: 'bare'; readonly name: string } | { readonly kind: 'refused' };

/**
 * An executable path decided lexically, before any file system call: UNC, device, drive-relative, root-relative and `~`
 * paths, a relative path with a folder, and a Windows device name are refused, as documents/confine.ts and terminal links
 * refuse them; a bare name is for a PATH lookup.
 */
export function executablePathForm(value: string, platform: NodeJS.Platform): ExecutablePathForm {
  if (value.startsWith('~')) return { kind: 'refused' };
  if (platform !== 'win32') {
    if (value.startsWith('/')) return { kind: 'absolute', file: path.posix.normalize(value) };
    return value.includes('/') || value === '.' || value === '..' ? { kind: 'refused' } : { kind: 'bare', name: value };
  }
  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => WINDOWS_DEVICE_NAME.test(segment.replace(/[. ]+$/, '')))) return { kind: 'refused' };
  if (/^[a-z]:[\\/]/i.test(value)) return value.slice(2).includes(':') ? { kind: 'refused' } : { kind: 'absolute', file: path.win32.normalize(value) };
  if (/[\\/:]/.test(value) || value === '.' || value === '..') return { kind: 'refused' };
  return { kind: 'bare', name: value };
}

/**
 * The PATH folders an executable may be found in, normalized: only absolute local entries, since a relative entry resolves
 * against main's working folder and a UNC or device entry reaches another machine.
 */
export function searchPathEntries(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): string[] {
  const windows = platform === 'win32';
  // Windows keeps PATH as Path; the environment main passes is a plain copy, so find the key case-insensitively there.
  const key = windows ? Object.keys(env).find((name) => name.toUpperCase() === 'PATH') : 'PATH';
  const value = key === undefined ? undefined : env[key];
  return (value ?? '')
    .split(windows ? ';' : ':')
    .map((entry) => executablePathForm(entry.replace(/^"(.*)"$/, '$1'), platform))
    .flatMap((form) => (form.kind === 'absolute' ? [form.file] : []));
}
