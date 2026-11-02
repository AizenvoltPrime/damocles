// The damocles command on this computer's PATH: the user's Path entry on Windows (cli-path-win32.ts) and the
// /usr/local/bin/damocles link on macOS. Each change is a user-run install action, the installer's or a palette command's
// (docs/invariants.md "The damocles command"); Linux packages register it as an alternative in build/linux.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { installLogSink } from '../../core/logger';
import { createDesktopLogSinkFactory } from '../local-services/log-sink';
import { changePath, withEntry, withoutEntry, type PathRegistry } from './cli-path-win32';

/**
 * Runs the installer's --cli-path action with main's log going to <logsDir>/<logName>.log, since that launch exits before any
 * window installs a sink; settles once every line is written.
 */
export async function withInstallerLog<T>(logsDir: string, logName: string, run: () => Promise<T>): Promise<T> {
  const sinks = createDesktopLogSinkFactory(logsDir, false, () => undefined);
  installLogSink(sinks.create(logName));
  try {
    return await run();
  } finally {
    await sinks.endAsyncWrites();
  }
}

export type CliPathOrigin = 'installer' | 'user';
export type WindowsCliPathResult = 'added' | 'alreadyPresent' | 'keptRemoved' | 'removed' | 'notPresent';
export type MacCliPathResult = 'installed' | 'alreadyInstalled' | 'uninstalled' | 'notInstalled' | 'notOurs' | 'cancelled';

export interface CliPath {
  // Windows: adds the bin folder to the user's Path once; from the installer, a removal the user chose leaves Path alone
  add(origin: CliPathOrigin): Promise<WindowsCliPathResult>;
  // Windows: removes only that entry; the user's own removal is recorded, so no update adds it back
  remove(origin: CliPathOrigin): Promise<WindowsCliPathResult>;
  // macOS: links /usr/local/bin/damocles to the app's bin/damocles, asking for an administrator when the folder is not writable
  install(): Promise<MacCliPathResult>;
  // macOS: removes that link, only when it points into the app
  uninstall(): Promise<MacCliPathResult>;
}

// userData's record that the user removed the command from Path
export const CLI_PATH_RECORD = 'cli-path.json';
export const MAC_LINK = '/usr/local/bin/damocles';

export interface CliPathDeps {
  // <install>\resources\bin on Windows, Damocles.app/Contents/Resources/bin on macOS
  readonly binDir: string;
  readonly userDataDir: string;
  // Windows: the user's Path value and the broadcast that tells running programs
  readonly registry?: () => PathRegistry;
  readonly broadcast?: () => Promise<void>;
  // macOS: the app bundle every link of ours points into, and an AppleScript run with osascript
  readonly appBundle?: string;
  readonly osascript?: (script: string) => Promise<{ readonly code: number | null; readonly stderr: string }>;
  readonly log: (line: string) => void;
}

/** An AppleScript that runs command with administrator privileges, as VS Code's Install 'code' command does. */
export function adminScript(command: string): string {
  return `do shell script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
}

/** A word for sh, single-quoted. */
export function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Whether a link's target, as readlink gives it relative to the link's folder, lies inside the app bundle. */
export function pointsInto(linkTarget: string, linkDir: string, appBundle: string): boolean {
  const resolved = path.posix.resolve(linkDir, linkTarget);
  return resolved.startsWith(`${appBundle.replace(/\/+$/, '')}/`);
}

// osascript's error -128: the user cancelled the administrator prompt
const USER_CANCELLED = /\(-128\)/;

export function createCliPath(deps: CliPathDeps): CliPath {
  const record = path.join(deps.userDataDir, CLI_PATH_RECORD);
  const removedByUser = async (): Promise<boolean> => {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(record, 'utf8'));
      return typeof parsed === 'object' && parsed !== null && (parsed as { removed?: unknown }).removed === true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  };
  const windows = (): { registry: PathRegistry; broadcast: () => Promise<void> } => {
    if (!deps.registry || !deps.broadcast) throw new Error('The PATH entry is a Windows command');
    return { registry: deps.registry(), broadcast: deps.broadcast };
  };
  const mac = (): { appBundle: string; osascript: NonNullable<CliPathDeps['osascript']> } => {
    if (!deps.appBundle || !deps.osascript) throw new Error('The /usr/local/bin link is a macOS command');
    return { appBundle: deps.appBundle, osascript: deps.osascript };
  };
  const asAdmin = async (command: string): Promise<'done' | 'cancelled'> => {
    const { code, stderr } = await mac().osascript(adminScript(command));
    if (code === 0) return 'done';
    if (USER_CANCELLED.test(stderr)) return 'cancelled';
    throw new Error(`osascript failed with ${code}: ${stderr.trim()}`);
  };
  const linkOf = async (): Promise<{ readonly kind: 'none' } | { readonly kind: 'link'; readonly target: string } | { readonly kind: 'other' }> => {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(MAC_LINK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
      throw err;
    }
    return stat.isSymbolicLink() ? { kind: 'link', target: await fs.readlink(MAC_LINK) } : { kind: 'other' };
  };
  const denied = (err: unknown): boolean => ['EACCES', 'EPERM'].includes((err as NodeJS.ErrnoException).code ?? '');
  const target = path.posix.join(deps.binDir, 'damocles');

  return {
    add: async (origin) => {
      const { registry, broadcast } = windows();
      if (origin === 'installer' && await removedByUser()) {
        deps.log('[cli-path] leaving Path alone: the user removed the damocles command');
        return 'keptRemoved';
      }
      if (origin === 'user') await fs.rm(record, { force: true });
      if (!changePath(registry, (value) => withEntry(value, deps.binDir))) return 'alreadyPresent';
      await broadcast();
      deps.log(`[cli-path] added ${deps.binDir} to the user's Path`);
      return 'added';
    },
    remove: async (origin) => {
      const { registry, broadcast } = windows();
      if (origin === 'user') await fs.writeFile(record, `${JSON.stringify({ removed: true })}\n`);
      if (!changePath(registry, (value) => withoutEntry(value, deps.binDir))) return 'notPresent';
      await broadcast();
      deps.log(`[cli-path] removed ${deps.binDir} from the user's Path`);
      return 'removed';
    },
    install: async () => {
      mac();
      const link = await linkOf();
      // a file of the user's own is never replaced; a link elsewhere (an earlier install's) is, as VS Code's command does
      if (link.kind === 'other') throw new Error(`${MAC_LINK} exists and is not a link`);
      if (link.kind === 'link' && path.posix.resolve(path.posix.dirname(MAC_LINK), link.target) === target) return 'alreadyInstalled';
      try {
        await fs.mkdir(path.posix.dirname(MAC_LINK), { recursive: true });
        if (link.kind === 'link') await fs.unlink(MAC_LINK);
        await fs.symlink(target, MAC_LINK);
      } catch (err) {
        if (!denied(err)) throw err;
        const command = `mkdir -p ${shellWord(path.posix.dirname(MAC_LINK))} && ln -sfh ${shellWord(target)} ${shellWord(MAC_LINK)}`;
        if (await asAdmin(command) === 'cancelled') return 'cancelled';
      }
      deps.log(`[cli-path] linked ${MAC_LINK} to ${target}`);
      return 'installed';
    },
    uninstall: async () => {
      const { appBundle } = mac();
      const link = await linkOf();
      if (link.kind === 'none') return 'notInstalled';
      if (link.kind === 'other' || !pointsInto(link.target, path.posix.dirname(MAC_LINK), appBundle)) return 'notOurs';
      try {
        await fs.unlink(MAC_LINK);
      } catch (err) {
        if (!denied(err)) throw err;
        if (await asAdmin(`rm -f ${shellWord(MAC_LINK)}`) === 'cancelled') return 'cancelled';
      }
      deps.log(`[cli-path] removed ${MAC_LINK}`);
      return 'uninstalled';
    },
  };
}
