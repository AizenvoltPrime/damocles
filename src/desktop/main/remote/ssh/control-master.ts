// SSH master connections (docs/invariants.md "Remote daemon and wire", the master connection rule).
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProcess } from '../../../../core/process-launcher';
import { resolveSshExecutable } from '../../../../core/system-tools';
import { buildSshConfigQueryArgs, buildSshControlArgs } from './ssh-args';
import type { SshDestination } from './ssh-command-parse';
import { sshPercentLiteral } from './ssh-percent';

const EXIT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 10_000;
// %C expands to 40 hex digits, and a master first binds `<path>.<16 random characters>`, then renames it
const CONTROL_NAME_BYTES = 40;
const BIND_SUFFIX_BYTES = 17;

// damocles: Damocles adds its ControlMaster options with this path; off: ssh is told no master and no ControlPath, ahead of
// the user's config; none: Damocles adds nothing, so the user's config decides
export type ControlMasterPlan = { readonly kind: 'damocles'; readonly controlPath: string } | { readonly kind: 'off' } | { readonly kind: 'none' };

// `ssh -V`, `ssh -G` and `ssh -O`, which end on their own; code null after the timeout, and an abort kills ssh and rejects
export type SshRun = (file: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>;

/** An ssh call that ends on its own, on this process's launcher. */
export const runSsh: SshRun = async (file, args, timeoutMs, signal) => {
  const { exit, stdout, stderr } = await runProcess({ file, args: [...args], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs, ...(signal ? { signal } : {}) });
  return { code: exit?.code ?? null, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
};

export interface ControlMasterDeps {
  readonly platform: NodeJS.Platform;
  // where Damocles' ControlPath may live, the first that fits sun_path and is private winning: <Damocles' home>/ssh/cm first
  readonly folders: readonly string[];
  readonly resolveSsh: () => Promise<string | undefined>;
  readonly run: SshRun;
  // creates the folder 0700; false unless it is a directory this user owns, never a link, in a parent no other user can rename it in
  readonly makePrivateFolder: (folder: string) => Promise<boolean>;
  readonly log: (line: string) => void;
}

/** The ControlPath folders a POSIX client tries: Damocles' own, then shorter private ones for a home too long for sun_path. */
export function controlFolders(damoclesFolder: string, env: Readonly<Record<string, string | undefined>>, tmpdir: string, uid: number): string[] {
  const runtime = env['XDG_RUNTIME_DIR'];
  const folders = [damoclesFolder];
  if (runtime !== undefined && path.posix.isAbsolute(runtime)) folders.push(path.posix.join(runtime, 'damocles-cm'));
  folders.push(path.posix.join(tmpdir, `damocles-cm-${uid}`));
  // macOS's per-user TMPDIR alone is about 49 bytes, which leaves no room in its 104-byte sun_path
  if (tmpdir !== '/tmp') folders.push(`/tmp/damocles-cm-${uid}`);
  return folders;
}

/** Whether a master's socket in folder fits sun_path (104 bytes on macOS, 108 elsewhere, its NUL included) while it binds. */
export function controlPathFits(folder: string, platform: NodeJS.Platform): boolean {
  const sunPath = platform === 'darwin' ? 104 : 108;
  return Buffer.byteLength(folder) + 1 + CONTROL_NAME_BYTES + BIND_SUFFIX_BYTES < sunPath;
}

async function makePrivateFolder(folder: string, log: (line: string) => void): Promise<boolean> {
  try {
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const uid = process.getuid!();
    const [own, parent] = await Promise.all([fs.lstat(folder), fs.stat(path.dirname(folder))]);
    if (!own.isDirectory() || own.uid !== uid) {
      log(`[ssh] ${folder} is not a folder this user owns; it holds no ControlPath`);
      return false;
    }
    // a sticky parent (/tmp) lets only the owner rename or remove what is in it
    if (parent.uid !== uid && (parent.mode & 0o1000) === 0) {
      log(`[ssh] ${path.dirname(folder)} is another user's and not sticky; ${folder} holds no ControlPath`);
      return false;
    }
    // mkdir's mode is filtered by the umask and leaves an existing folder as it was
    await fs.chmod(folder, 0o700);
    return true;
  } catch (err) {
    log(`[ssh] ${folder} cannot hold a ControlPath: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** This client's ssh on the process launcher, and the ControlPath folders after Damocles' own. */
export function systemControlMasterDeps(damoclesFolder: string, log: (line: string) => void): ControlMasterDeps {
  return {
    platform: process.platform,
    folders: process.platform === 'win32' ? [] : controlFolders(damoclesFolder, process.env, os.tmpdir(), process.getuid!()),
    resolveSsh: () => resolveSshExecutable(),
    run: runSsh,
    makePrivateFolder: (folder) => makePrivateFolder(folder, log),
    log,
  };
}

/** controlmaster and controlpath as `ssh -G` reports them; ssh prints `false` for no, and no controlpath line while unset. */
export function parseControlConfig(sshG: string): { readonly master: string | undefined; readonly path: string | undefined } {
  const values = new Map<string, string>();
  for (const line of sshG.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (match && !values.has(match[1]!.toLowerCase())) values.set(match[1]!.toLowerCase(), match[2]!.trim());
  }
  const controlPath = values.get('controlpath');
  return { master: values.get('controlmaster')?.toLowerCase(), path: controlPath === undefined || controlPath.toLowerCase() === 'none' ? undefined : controlPath };
}

/** Whether, and with which ControlPath, the host's ssh calls share a master; a failure to find out uses none. */
export async function controlMasterPlan(deps: ControlMasterDeps, destination: SshDestination, configFile: string | undefined): Promise<ControlMasterPlan> {
  // Win32-OpenSSH has no master connections, and a ControlMaster from dotfiles shared with another OS breaks it
  if (deps.platform === 'win32') return { kind: 'off' };
  try {
    const ssh = await deps.resolveSsh();
    if (ssh === undefined) return { kind: 'none' };
    const { code, stdout } = await deps.run(ssh, buildSshConfigQueryArgs(destination, configFile), QUERY_TIMEOUT_MS);
    if (code !== 0) {
      deps.log(`[ssh] ssh -G failed (exit ${String(code)}); no master connection is used`);
      return { kind: 'none' };
    }
    const config = parseControlConfig(stdout);
    // a ControlMaster the user set without a ControlPath multiplexes nothing, and stays as they set it
    if (config.path !== undefined || (config.master !== 'no' && config.master !== 'false')) return { kind: 'none' };
    for (const folder of deps.folders) {
      if (!controlPathFits(folder, deps.platform)) continue;
      // %C: a hash of the local host, remote host, port and user, so each destination has its own master
      if (await deps.makePrivateFolder(folder)) return { kind: 'damocles', controlPath: path.posix.join(sshPercentLiteral(folder), '%C') };
    }
    deps.log('[ssh] no private folder is short enough for a ControlPath; no master connection is used');
    return { kind: 'none' };
  } catch (err) {
    deps.log(`[ssh] the master connection plan failed: ${err instanceof Error ? err.message : String(err)}; no master connection is used`);
    return { kind: 'none' };
  }
}

/** `ssh -O exit` on Damocles' own master, which ends its connection and every session on it; a user's master is left alone. */
export async function exitControlMaster(deps: ControlMasterDeps, destination: SshDestination, configFile: string | undefined, plan: ControlMasterPlan): Promise<void> {
  if (plan.kind !== 'damocles') return;
  try {
    const ssh = await deps.resolveSsh();
    if (ssh === undefined) return;
    const { code } = await deps.run(ssh, buildSshControlArgs(destination, configFile, plan.controlPath), EXIT_TIMEOUT_MS);
    // ssh -O exit fails when no master runs, which leaves nothing to end
    deps.log(`[ssh] ssh -O exit on Damocles' master ${code === 0 ? 'ended it' : `found none (exit ${String(code)})`}`);
  } catch (err) {
    deps.log(`[ssh] ssh -O exit on Damocles' master failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
