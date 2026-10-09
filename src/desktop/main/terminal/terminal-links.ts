import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import type { QuickOpenScope } from '../../preload/overlay-channels';
import type { FileRef } from '../../preload/shell-channels';
import { MAX_TERMINAL_LINK_PATH_LENGTH, type TerminalLinkKind } from '../../preload/terminal-channels';
import { confineExisting, type Project } from '../documents/confine';

// How a terminal writes paths: a Windows shell, a WSL distro's shell on Windows, or a macOS or Linux shell.
export type LinkPathStyle = 'win32' | 'wsl' | 'posix';

/**
 * A terminal's links resolve against baseDir, its working directory, and only ever name an entry inside project. A null
 * baseDir (the shell reported a directory main refused) resolves no relative path.
 */
export interface LinkBase {
  readonly project: Project;
  readonly baseDir: string | null;
  readonly style: LinkPathStyle;
}

export interface ResolvedTerminalLink {
  readonly kind: TerminalLinkKind;
  // inside the project, '/'-separated; '' is the project folder
  readonly relativePath: string;
}

export type FolderLinkAction =
  | { readonly kind: 'reveal'; readonly file: FileRef }
  | { readonly kind: 'quickOpen'; readonly scope: QuickOpenScope };

/**
 * A folder link reveals in Files only while Files shows its project; otherwise Quick Open lists that folder, as VS Code
 * searches for a link it cannot reveal, so the selected chat and project stay as they are.
 */
export function folderLinkAction(project: Project, relativePath: string, filesProjectKey: string | undefined): FolderLinkAction {
  if (project.key === filesProjectKey) return { kind: 'reveal', file: { projectKey: project.key, relativePath } };
  return { kind: 'quickOpen', scope: { projectKey: project.key, projectName: project.name, folder: relativePath === '' ? '' : `${relativePath}/` } };
}

// VS Code's LinkCache TTL (terminalLinkResolver.ts); entries past it are resolved again.
export const LINK_CACHE_TTL_MS = 10_000;
export const LINK_CACHE_MAX_ENTRIES = 500;

const WSL_MOUNT = /^\/mnt\/([a-z])(?:\/(.*))?$/i;
// \\server\share, \\?\, \\.\ and their '/' forms: a stat of one opens a network session.
const WIN32_DOUBLE_ROOT = /^[\\/]{2}/;
const WIN32_DRIVE_ABSOLUTE = /^[a-z]:[\\/]/i;
const WIN32_DRIVE = /^[a-z]:/i;

/** How the shell writes paths, from the executable it runs, so a user profile of wsl.exe is a WSL shell whatever its name. */
export function linkPathStyle(platform: NodeJS.Platform, file: string): LinkPathStyle {
  if (platform !== 'win32') return 'posix';
  return path.win32.basename(file).toLowerCase() === 'wsl.exe' ? 'wsl' : 'win32';
}

// The candidate as an absolute path in the style's own path module, or undefined when no file system call may see it.
function absoluteOf(candidate: string, base: LinkBase): string | undefined {
  if (candidate.startsWith('~')) return undefined;
  const { baseDir } = base;
  if (base.style === 'posix') {
    if (candidate.startsWith('/')) return path.posix.normalize(candidate);
    return baseDir === null ? undefined : path.posix.join(baseDir, candidate);
  }
  if (base.style === 'wsl') {
    if (candidate.includes('\\')) return undefined;
    if (!candidate.startsWith('/')) return baseDir === null ? undefined : path.win32.join(baseDir, candidate);
    const mount = WSL_MOUNT.exec(candidate);
    return mount ? path.win32.normalize(`${mount[1]!.toUpperCase()}:\\${mount[2] ?? ''}`) : undefined;
  }
  if (WIN32_DOUBLE_ROOT.test(candidate) || candidate.startsWith('/') || candidate.startsWith('\\')) return undefined;
  if (WIN32_DRIVE_ABSOLUTE.test(candidate)) return path.win32.normalize(candidate);
  return WIN32_DRIVE.test(candidate) || baseDir === null ? undefined : path.win32.join(baseDir, candidate);
}

/**
 * The candidate as a project-relative path ('' for the project folder), decided lexically before any file system call: a
 * missing project prefix, a '..' escape, a UNC, device or drive-relative path, '~' or (WSL) a POSIX path outside /mnt/<drive>
 * is undefined.
 */
export function linkRelativePath(candidate: string, base: LinkBase): string | undefined {
  if (candidate.length === 0 || candidate.length > MAX_TERMINAL_LINK_PATH_LENGTH || candidate.includes('\0')) return undefined;
  const absolute = absoluteOf(candidate, base);
  if (absolute === undefined) return undefined;
  const flavor = base.style === 'posix' ? path.posix : path.win32;
  const relative = flavor.relative(base.project.fsPath, absolute);
  if (relative === '') return '';
  if (flavor.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${flavor.sep}`)) return undefined;
  return relative.split(flavor.sep).join('/');
}

/** A candidate that names an existing file or folder inside the project after every link is followed; null otherwise. */
export async function resolveTerminalLink(candidate: string, base: LinkBase, log: (line: string) => void): Promise<ResolvedTerminalLink | null> {
  const relativePath = linkRelativePath(candidate, base);
  if (relativePath === undefined) return null;
  const confined = await confineExisting(base.project, relativePath);
  if (!confined.ok) {
    if (confined.reason === 'failed') log(`[terminal] a link inside ${base.project.name} could not be resolved`);
    return null;
  }
  let stat: Stats;
  try {
    stat = await fs.stat(confined.path);
  } catch (err) {
    // removed since the realpath
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (stat.isFile()) return { kind: 'file', relativePath };
  return stat.isDirectory() ? { kind: 'folder', relativePath } : null;
}

interface CacheEntry {
  readonly value: ResolvedTerminalLink | null;
  readonly expires: number;
}

/** Resolved links, least recently used first; an entry lives LINK_CACHE_TTL_MS and the cache holds at most maxEntries. */
export class TerminalLinkCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(now: () => number = Date.now, maxEntries: number = LINK_CACHE_MAX_ENTRIES) {
    this.now = now;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  // undefined: not cached, or expired
  get(key: string): ResolvedTerminalLink | null | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    if (entry.expires <= this.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: ResolvedTerminalLink | null): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + LINK_CACHE_TTL_MS });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void {
    this.entries.clear();
  }
}

// The base is part of the key, so one terminal's answer never answers another project, directory or path style.
function cacheKey(candidate: string, base: LinkBase): string {
  return JSON.stringify([base.style, base.project.key, base.project.fsPath, base.baseDir, candidate]);
}

/** Link resolution for every terminal of the window; hover-time answers come from the cache, an open always resolves again. */
export class TerminalLinks {
  private readonly cache: TerminalLinkCache;
  private readonly log: (line: string) => void;

  constructor(log: (line: string) => void, cache: TerminalLinkCache = new TerminalLinkCache()) {
    this.log = log;
    this.cache = cache;
  }

  resolveAll(paths: readonly string[], base: LinkBase): Promise<Array<TerminalLinkKind | null>> {
    return Promise.all(paths.map(async (candidate) => {
      const key = cacheKey(candidate, base);
      const cached = this.cache.get(key);
      const resolved = cached !== undefined ? cached : await this.resolveFresh(candidate, base);
      return resolved?.kind ?? null;
    }));
  }

  async resolveFresh(candidate: string, base: LinkBase): Promise<ResolvedTerminalLink | null> {
    const resolved = await resolveTerminalLink(candidate, base, this.log);
    this.cache.set(cacheKey(candidate, base), resolved);
    return resolved;
  }

  /** The projects changed: no answer outlives the project it was given for. */
  clear(): void {
    this.cache.clear();
  }
}
