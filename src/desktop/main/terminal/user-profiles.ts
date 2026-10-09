// User terminal profiles (damocles.desktop.terminal.profiles), adapted from VS Code's terminalProfiles.ts
// (applyConfigProfilesToMap, validateProfilePaths) and terminalPlatformConfiguration.ts (MIT).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MAX_HOST_ARGS, MAX_HOST_PATH_CHARS } from '../../pty-host/protocol';
import {
  MAX_USER_TERMINAL_PROFILES,
  type TerminalColor,
  type TerminalCustomIcon,
  type TerminalIcon,
  type TerminalProfileProblem,
  type TerminalProfileProblemReason,
} from '../../preload/terminal-channels';
import { followsLocalLinksOnly } from '../documents/confine';
import { executablePathForm, searchPathEntries } from './executable-path';
import type { TerminalProfile } from './profiles';
import { sanitizeTitle } from './shell-integration';
import { isTerminalColor, isTerminalCustomIcon, parseTerminalName } from './terminal-service';

/** A profile a terminal launches with: a detected shell, or a user profile from damocles.desktop.terminal.profiles. */
export interface LaunchProfile extends TerminalProfile {
  readonly source: 'detected' | 'user';
  // a new terminal of the profile starts with these
  readonly customIcon: TerminalCustomIcon | null;
  readonly color: TerminalColor | null;
}

export function detectedProfile(profile: TerminalProfile): LaunchProfile {
  return { ...profile, source: 'detected', customIcon: null, color: null };
}

// Windows' CreateProcess limit on a command line; a profile's path and args, one separator each, must fit in it.
export const MAX_TERMINAL_COMMAND_LINE_CHARS = 32_767;
const PROFILE_FIELDS = new Set(['path', 'args', 'icon', 'color']);
// Paths one entry may list.
export const MAX_PROFILE_PATHS = 16;

// file: a regular file once every link is followed; refused: a link on the way leads to a UNC or device path.
export type ProfileFileKind = 'file' | 'other' | 'missing' | 'refused' | 'unreadable';

export interface UserProfileContext {
  readonly platform: NodeJS.Platform;
  // the login environment the terminals get: its PATH (and on Windows PATHEXT) finds a bare executable name
  readonly env: Readonly<Record<string, string | undefined>>;
  kind(file: string): Promise<ProfileFileKind>;
}

export interface ProfileResolution {
  readonly profiles: LaunchProfile[];
  // detected profile names a null entry hides
  readonly hidden: string[];
  readonly problems: TerminalProfileProblem[];
}

// VS Code's findExecutable without its working-folder fallbacks: each absolute PATH entry, with PATHEXT's extensions first on Windows.
function pathCandidates(name: string, context: UserProfileContext): string[] {
  const windows = context.platform === 'win32';
  const join = windows ? path.win32.join : path.posix.join;
  const pathExt = windows ? (Object.entries(context.env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0) : [];
  return searchPathEntries(context.platform, context.env).flatMap((entry) => [...pathExt.map((ext) => join(entry, name + ext)), join(entry, name)]);
}

type Resolved = { readonly ok: true; readonly file: string } | { readonly ok: false; readonly reason: TerminalProfileProblemReason; readonly detail: string };

// VS Code's validateProfilePaths: the first path that names a file wins.
async function resolvePaths(paths: readonly string[], context: UserProfileContext): Promise<Resolved> {
  const forms = paths.map((value) => executablePathForm(value, context.platform));
  const refused = forms.findIndex((form) => form.kind === 'refused');
  if (refused >= 0) return { ok: false, reason: 'pathNotAllowed', detail: paths[refused]! };
  let failure: Extract<Resolved, { ok: false }> | undefined;
  const rank: Partial<Record<TerminalProfileProblemReason, number>> = { pathNotAllowed: 3, pathUnreadable: 2, pathNotAFile: 1 };
  const note = (reason: TerminalProfileProblemReason, detail: string): void => {
    if (failure === undefined || (rank[reason] ?? 0) > (rank[failure.reason] ?? 0)) failure = { ok: false, reason, detail };
  };
  for (const [index, form] of forms.entries()) {
    if (form.kind === 'absolute') {
      const kind = await context.kind(form.file);
      if (kind === 'file') return { ok: true, file: form.file };
      if (kind === 'refused') note('pathNotAllowed', paths[index]!);
      else if (kind === 'unreadable') note('pathUnreadable', paths[index]!);
      else if (kind === 'other') note('pathNotAFile', paths[index]!);
      continue;
    }
    if (form.kind !== 'bare') continue;
    for (const candidate of pathCandidates(form.name, context)) {
      if ((await context.kind(candidate)) === 'file') return { ok: true, file: candidate };
    }
  }
  return failure ?? { ok: false, reason: 'pathNotFound', detail: paths[0]! };
}

const isPathText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_HOST_PATH_CHARS && !value.includes('\0');

function shellIcon(file: string, platform: NodeJS.Platform): TerminalIcon {
  const name = (platform === 'win32' ? path.win32.basename(file).toLowerCase().replace(/\.exe$/, '') : path.posix.basename(file));
  if (name === 'pwsh' || name === 'powershell') return 'powershell';
  if (name === 'cmd' || name === 'wsl' || name === 'bash' || name === 'zsh' || name === 'fish') return name;
  return 'shell';
}

type Entry = { readonly ok: true; readonly profile: Omit<LaunchProfile, 'id' | 'icon'> } | { readonly ok: false; readonly reason: TerminalProfileProblemReason; readonly detail: string | null };

const problemText = (value: unknown): string | null => (typeof value === 'string' ? sanitizeTitle(value) : null);

async function validateEntry(name: string, value: object, context: UserProfileContext): Promise<Entry> {
  const fail = (reason: TerminalProfileProblemReason, detail: string | null = null): Entry => ({ ok: false, reason, detail });
  if (Array.isArray(value)) return fail('notAnObject');
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((field) => !PROFILE_FIELDS.has(field));
  if (unknown !== undefined) return fail('unknownField', unknown);
  if (!Object.hasOwn(record, 'path')) return fail('missingPath');
  const rawPath = record['path'];
  const paths = typeof rawPath === 'string' ? [rawPath] : Array.isArray(rawPath) ? (rawPath as unknown[]) : [];
  if (paths.length === 0 || paths.length > MAX_PROFILE_PATHS || !paths.every(isPathText)) return fail('invalidPath');
  const rawArgs = record['args'] ?? [];
  if (!Array.isArray(rawArgs) || !(rawArgs as unknown[]).every((arg) => typeof arg === 'string' && !arg.includes('\0'))) return fail('invalidArgs');
  const args = rawArgs as string[];
  if (args.length > MAX_HOST_ARGS) return fail('tooManyArgs');
  if (args.some((arg) => arg.length > MAX_HOST_PATH_CHARS)) return fail('argsTooLong');
  const icon = record['icon'] ?? null;
  if (icon !== null && !isTerminalCustomIcon(icon)) return fail('invalidIcon', problemText(icon));
  const color = record['color'] ?? null;
  if (color !== null && !isTerminalColor(color)) return fail('invalidColor', problemText(color));
  const commandLine = (file: string): number => file.length + args.reduce((sum, arg) => sum + arg.length + 1, 0);
  if (commandLine(paths.reduce((longest, value) => (value.length > longest.length ? value : longest))) > MAX_TERMINAL_COMMAND_LINE_CHARS) return fail('argsTooLong');
  const resolved = await resolvePaths(paths, context);
  if (!resolved.ok) return fail(resolved.reason, resolved.detail);
  // a PATH folder makes a bare name longer than the check above saw
  if (resolved.file.length > MAX_HOST_PATH_CHARS) return fail('invalidPath');
  if (commandLine(resolved.file) > MAX_TERMINAL_COMMAND_LINE_CHARS) return fail('argsTooLong');
  return { ok: true, profile: { name, file: resolved.file, args, source: 'user', customIcon: icon, color } };
}

/**
 * The detected profiles with the user's entries applied as VS Code's applyConfigProfilesToMap does: null hides the detected
 * profile of that name, an entry of a detected profile's name replaces it in place (keeping its id and icon), and any other
 * valid entry is added after them. An entry that fails validation is listed as a problem and never launches.
 */
export async function resolveTerminalProfiles(detected: readonly TerminalProfile[], setting: unknown, context: UserProfileContext): Promise<ProfileResolution> {
  const profiles: LaunchProfile[] = detected.map(detectedProfile);
  const hidden: string[] = [];
  const problems: TerminalProfileProblem[] = [];
  if (setting === undefined || setting === null) return { profiles, hidden, problems };
  if (typeof setting !== 'object' || Array.isArray(setting)) return { profiles, hidden, problems: [{ name: null, reason: 'settingNotAnObject', detail: null }] };
  const entries = Object.entries(setting as Record<string, unknown>);
  if (entries.length > MAX_USER_TERMINAL_PROFILES) problems.push({ name: null, reason: 'tooManyProfiles', detail: null });
  for (const [name, value] of entries.slice(0, MAX_USER_TERMINAL_PROFILES)) {
    const problem = (reason: TerminalProfileProblemReason, detail: string | null = null): void => {
      problems.push({ name: sanitizeTitle(name) ?? '', reason, detail: detail === null ? null : sanitizeTitle(detail) });
    };
    if (parseTerminalName(name) !== name) {
      problem('invalidName');
      continue;
    }
    const index = profiles.findIndex((profile) => profile.source === 'detected' && profile.name === name);
    if (value === null) {
      if (index >= 0) {
        profiles.splice(index, 1);
        hidden.push(name);
      }
      continue;
    }
    if (typeof value !== 'object') {
      problem('notAnObject');
      continue;
    }
    const entry = await validateEntry(name, value, context);
    if (!entry.ok) {
      problem(entry.reason, entry.detail);
      continue;
    }
    if (index >= 0) profiles[index] = { ...entry.profile, id: profiles[index]!.id, icon: profiles[index]!.icon };
    else profiles.push({ ...entry.profile, id: `user:${name}`, icon: shellIcon(entry.profile.file, context.platform) });
  }
  return { profiles, hidden, problems };
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** What a profile's absolute path names on this machine; on Windows no link along it may lead to a UNC or device path. */
export async function profileFileKind(file: string, platform: NodeJS.Platform, log: (line: string) => void): Promise<ProfileFileKind> {
  try {
    if (platform === 'win32') {
      const root = path.parse(file).root;
      if (!(await followsLocalLinksOnly(root, path.relative(root, file).split(path.sep).filter(Boolean)))) return 'refused';
    }
    return (await fs.stat(file)).isFile() ? 'file' : 'other';
  } catch (err) {
    if (isMissing(err)) return 'missing';
    log(`[terminal] cannot read the profile executable ${file}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
    return 'unreadable';
  }
}

/**
 * The profiles terminals launch with: the detected shells once detection settled, with damocles.desktop.terminal.profiles
 * applied. The setting comes from the settings store, which reads it from the user file only (an `application` key).
 */
export class TerminalProfileCatalog {
  private readonly deps: {
    readonly setting: () => unknown;
    readonly context: UserProfileContext;
    readonly log: (line: string) => void;
    readonly onDidChange: () => void;
  };
  private detected: readonly TerminalProfile[] | undefined;
  private resolution: ProfileResolution = { profiles: [], hidden: [], problems: [] };
  private generation = 0;
  private latest: Promise<void> = Promise.resolve();

  constructor(deps: TerminalProfileCatalog['deps']) {
    this.deps = deps;
  }

  /** Detection settled; validates the setting against these shells. */
  setDetected(profiles: readonly TerminalProfile[]): Promise<void> {
    this.detected = profiles;
    return this.refresh();
  }

  /**
   * Validates the setting again (it changed); a validation that a later one overtook is dropped. Resolves once the latest
   * validation, including one started meanwhile, has applied, so a restore never reads the empty list an overtaken one left.
   */
  async refresh(): Promise<void> {
    const detected = this.detected;
    if (detected === undefined) return;
    this.latest = this.validate(detected, ++this.generation);
    let awaited: Promise<void>;
    do {
      awaited = this.latest;
      await awaited;
    } while (awaited !== this.latest);
  }

  private async validate(detected: readonly TerminalProfile[], generation: number): Promise<void> {
    const resolution = await resolveTerminalProfiles(detected, this.deps.setting(), this.deps.context);
    if (generation !== this.generation) return;
    this.resolution = resolution;
    if (resolution.problems.length > 0) this.deps.log(`[terminal] refused ${resolution.problems.length} terminal profile entries: ${resolution.problems.map((problem) => problem.reason).join(', ')}`);
    this.deps.onDidChange();
  }

  profiles(): readonly LaunchProfile[] {
    return this.resolution.profiles;
  }

  hidden(): readonly string[] {
    return this.resolution.hidden;
  }

  problems(): readonly TerminalProfileProblem[] {
    return this.resolution.problems;
  }
}
