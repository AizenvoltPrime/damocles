// WSL UNC paths and the Linux paths they name. Paths from a project list are untrusted input.
import { isWslDistroName } from './distro-name';

// \\wsl.localhost\<distro>\... (Windows 11) and \\wsl$\<distro>\..., either separator, any case
const WSL_UNC = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i;
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** A WSL UNC path's distro and Linux path; undefined for any other path, one naming no valid distro, or one with . or .. parts. */
export function wslUncToLinux(windowsPath: string): { readonly distro: string; readonly path: string } | undefined {
  const match = WSL_UNC.exec(windowsPath);
  if (!match) return undefined;
  const distro = match[1]!;
  if (!isWslDistroName(distro)) return undefined;
  const parts = (match[2] ?? '').split(/[\\/]/).filter((part) => part !== '');
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) return undefined;
  return { distro, path: `/${parts.join('/')}` };
}

/** The UNC path File Explorer opens a distro's Linux path at; undefined for a path it cannot name. */
export function linuxToWslUnc(distro: string, linuxPath: string): string | undefined {
  if (!isWslDistroName(distro) || !linuxPath.startsWith('/') || UNSAFE.test(linuxPath) || linuxPath.includes('\\')) return undefined;
  const parts = linuxPath.split('/').filter((part) => part !== '');
  if (parts.some((part) => part === '.' || part === '..')) return undefined;
  return `\\\\wsl.localhost\\${distro}${parts.map((part) => `\\${part}`).join('')}`;
}
