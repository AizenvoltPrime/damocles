// Reopen in WSL (docs/invariants.md "Remote connections and credentials", WSL): a local project at a WSL UNC path, or a folder
// on a Windows drive through `wslpath -u` in a chosen distro, opened as that distro's project. Nothing here runs without the
// user's click. Paths from a project list and from wslpath are untrusted input.
import * as path from 'node:path';
import { runProcess } from '../../../../core/process-launcher';
import { windowsSystemTool } from '../../../../core/system-tools';
import type { ReopenInWslResult } from '../../../preload/shell-channels';
import { isWslDistroName } from './distro-name';
import { decodeWslMessages, wslExeEnvironment } from './wsl-list';
import { wslUncToLinux } from './wsl-paths';

const WSLPATH_TIMEOUT_MS = 30_000;
// characters of wslpath's own message kept for the user
const MAX_MESSAGE_CHARS = 500;
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Whether a local project's folder is on a Windows drive, which wslpath -u maps to /mnt/<drive>. */
export function isWindowsDrivePath(folder: string): boolean {
  return /^[A-Za-z]:\\/.test(folder) && path.win32.isAbsolute(folder) && !folder.includes('\0');
}

/** wslpath's answer taken only as one absolute Linux path on one line; undefined for anything else. */
export function parseWslpathOutput(stdout: string): string | undefined {
  const text = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  // a second line is a control character too
  if (!text.startsWith('/') || UNSAFE.test(text)) return undefined;
  const parts = text.split('/');
  return parts.some((part) => part === '.' || part === '..') ? undefined : text;
}

export type WslpathRun = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>;

// wslpath's own output is the distro's UTF-8; a message of wsl.exe's is UTF-8 under WSL_UTF8 except from an inbox wsl.exe
const runWslpath: WslpathRun = async (file, args, env) => {
  const { exit, stdout, stderr } = await runProcess({ file, args: [...args], env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: WSLPATH_TIMEOUT_MS });
  return { code: exit?.code ?? null, stdout: stdout.toString('utf8'), stderr: decodeWslMessages(stderr) };
};

const shown = (text: string): string => text.replace(/\0/g, '').replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').trim().slice(0, MAX_MESSAGE_CHARS);

/** A Windows-drive folder's Linux path in a distro, through `wslpath -u` run there. */
export async function wslpathInDistro(distro: string, folder: string, run: WslpathRun = runWslpath, env: NodeJS.ProcessEnv = process.env): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string }> {
  if (!isWslDistroName(distro) || !isWindowsDrivePath(folder)) throw new RangeError('Not a distro and a Windows-drive folder');
  let result: Awaited<ReturnType<WslpathRun>>;
  try {
    result = await run(windowsSystemTool('wsl', env), ['-d', distro, '--exec', 'wslpath', '-u', folder], { ...wslExeEnvironment(env), WSL_UTF8: '1' });
  } catch (err) {
    return { ok: false, message: shown(err instanceof Error ? err.message : String(err)) };
  }
  if (result.code !== 0) return { ok: false, message: shown(result.stderr || result.stdout) || `wslpath exited with ${String(result.code)}` };
  const mapped = parseWslpathOutput(result.stdout);
  return mapped === undefined ? { ok: false, message: shown(result.stdout) } : { ok: true, path: mapped };
}

export interface OpenInDistroDeps {
  // the distro's host record, made on its first use; undefined when wsl.exe does not list the distro
  readonly distroHost: (distro: string) => Promise<{ readonly hostId: string; readonly authorityKey: string } | undefined>;
  // resolves once the host is connected, rejecting with the attempt's failure
  readonly connect: (hostId: string) => Promise<void>;
  // adds the folder as the authority's project (or finds it), trusted without asking when trusted, and selects it
  readonly open: (authorityKey: string, folder: string, trusted: boolean) => Promise<string>;
  readonly failureCode: (err: unknown) => string;
  readonly log: (line: string) => void;
}

/** Opens a Linux folder of a distro as its project, connecting the distro first: Reopen in WSL's last step, and `damocles .` in WSL. */
export async function openFolderInDistro(deps: OpenInDistroDeps, distro: string, folder: string, trusted: boolean): Promise<ReopenInWslResult> {
  if (!isWslDistroName(distro) || parseWslpathOutput(folder) === undefined) throw new RangeError('Not a distro and an absolute Linux folder');
  const host = await deps.distroHost(distro);
  if (!host) return { ok: false, code: 'unknownDistro' };
  try {
    await deps.connect(host.hostId);
  } catch (err) {
    const code = deps.failureCode(err);
    deps.log(`[wsl] connecting ${distro} for its folder failed: ${code}`);
    return { ok: false, code: 'connectFailed', message: code };
  }
  return { ok: true, projectKey: await deps.open(host.authorityKey, folder, trusted) };
}

export interface ReopenDeps extends OpenInDistroDeps {
  // a listed local project's folder and trust; undefined for any other key
  readonly localProject: (projectKey: string) => { readonly fsPath: string; readonly trusted: boolean } | undefined;
  readonly wslpath: (distro: string, folder: string) => ReturnType<typeof wslpathInDistro>;
}

/**
 * Reopen in WSL: without a distro, a WSL UNC project in its own distro; with one, a Windows-drive project through /mnt in it.
 * The local project and its chats stay; the trust grant carries over, since both name the same folder.
 */
export async function reopenInWsl(deps: ReopenDeps, projectKey: string, distro?: string): Promise<ReopenInWslResult> {
  const local = deps.localProject(projectKey);
  if (!local) throw new Error('Not a local project of the list');
  if (distro === undefined) {
    const mapped = wslUncToLinux(local.fsPath);
    if (!mapped) return { ok: false, code: 'notWindowsFolder' };
    return openFolderInDistro(deps, mapped.distro, mapped.path, local.trusted);
  }
  if (!isWslDistroName(distro)) throw new RangeError('Not a WSL distro name');
  if (!isWindowsDrivePath(local.fsPath)) return { ok: false, code: 'notWindowsFolder' };
  if (!(await deps.distroHost(distro))) return { ok: false, code: 'unknownDistro' };
  const mapped = await deps.wslpath(distro, local.fsPath);
  if (!mapped.ok) return { ok: false, code: 'wslpathFailed', message: mapped.message };
  return openFolderInDistro(deps, distro, mapped.path, local.trusted);
}
