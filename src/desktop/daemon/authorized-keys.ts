// ssh.installAuthorizedKey: Damocles' public key appended to the daemon user's authorized keys, as ssh-copy-id installs a
// key (openssh-portable contrib/ssh-copy-id, installkeys_sh). A user-run action, one of the writes outside .damocles that
// docs/invariants.md "Desktop host" lists.
import { promises as fs, type Stats } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executablePathForm } from '../../core/executable-path';
import { runProcess, type RunOutput, type SpawnSpec } from '../../core/process-launcher';
import { posixToolAsync, windowsSystemTool } from '../../core/system-tools';
import type { InstallKeyFailure, InstallKeyResult } from './control-messages';

const TOOL_TIMEOUT_MS = 30_000;
// the Administrators group and LocalSystem, by SID because the group names are localized
export const ADMINISTRATORS_SID = 'S-1-5-32-544';
export const SYSTEM_SID = 'S-1-5-18';
// whoami /user names one SID, of whatever authority: a local or domain account's S-1-5-21-..., Microsoft Entra ID's S-1-12-1-...
const USER_SID = /^S-1-\d+(-\d+)+$/;
// authorized_keys options that keep the key from logging Damocles in: a forced command replaces its server, from= and
// expiry-time= may refuse the login, restrict drops agent forwarding, cert-authority makes the line a CA's (sshd(8))
const RESTRICTING_OPTIONS = new Set(['command', 'from', 'restrict', 'expiry-time', 'cert-authority']);

export interface AuthorizedKeysDeps {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  // POSIX: the daemon's uid, which owns ~/.ssh and the file
  readonly uid: number | undefined;
  readonly run: (spec: SpawnSpec, options: { readonly timeoutMs: number }) => Promise<RunOutput>;
  // POSIX: restorecon when SELinux tools are installed
  readonly restorecon: () => Promise<string | undefined>;
  readonly log: (line: string) => void;
}

export function systemAuthorizedKeysDeps(log: (line: string) => void): AuthorizedKeysDeps {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    env: process.env,
    uid: process.getuid?.(),
    run: runProcess,
    restorecon: () => posixToolAsync('restorecon'),
    log,
  };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The options field ends at the first whitespace outside double quotes, in which a backslash escapes the next character.
function optionsEnd(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted && c === '\\') i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && (c === ' ' || c === '\t')) return i;
  }
  return line.length;
}

// The option names of an options field, split at commas outside double quotes, lowercased as sshd compares them.
function optionNames(field: string): string[] {
  const names: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i <= field.length; i++) {
    const c = field[i];
    if (quoted && c === '\\') i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && (c === ',' || c === undefined)) {
      names.push(field.slice(start, i).split('=')[0]!.toLowerCase());
      start = i + 1;
    }
  }
  return names;
}

/**
 * An authorized_keys line as sshd reads it: the ssh-ed25519 key's type and blob and its option names, or undefined for a
 * comment, a blank line or another key. A line not starting with a key type starts with options (auth2-pubkeyfile.c).
 */
function parseKeyLine(raw: string): { readonly identity: string; readonly options: readonly string[] } | undefined {
  const line = raw.trim();
  if (line === '' || line.startsWith('#')) return undefined;
  const keyAt = (text: string): string | undefined => /^(ssh-ed25519)[ \t]+([A-Za-z0-9+/=]+)(?:[ \t]|$)/.exec(text)?.slice(1, 3).join(' ');
  const direct = keyAt(line);
  if (direct !== undefined) return { identity: direct, options: [] };
  if (/^(?:ssh|ecdsa|sk)-\S+[ \t]/.test(line)) return undefined;
  const end = optionsEnd(line);
  const identity = keyAt(line.slice(end).trimStart());
  return identity === undefined ? undefined : { identity, options: optionNames(line.slice(0, end)) };
}

/**
 * How text holds the key, by its type and blob whatever its comment: absent; present on its first such line; or restricted,
 * when that line, which sshd takes, carries an option RESTRICTING_OPTIONS names.
 */
export function keyEntry(text: string, publicKey: string): 'absent' | 'present' | 'restricted' {
  const wanted = parseKeyLine(publicKey)?.identity;
  if (wanted === undefined) return 'absent';
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseKeyLine(line);
    if (parsed?.identity === wanted) return parsed.options.some((name) => RESTRICTING_OPTIONS.has(name)) ? 'restricted' : 'present';
  }
  return 'absent';
}

type Appended = { readonly result: 'installed' | 'present' } | { readonly result: 'failed'; readonly code: InstallKeyFailure };

// Appends the key unless the file holds it, a newline first when the file lacks a final one; mode 0600 for a new file.
async function appendKey(file: string, publicKey: string, uid: number | undefined, log: (line: string) => void): Promise<Appended> {
  // opening a folder for append fails with EISDIR on POSIX and succeeds on Windows, so the kind is checked first
  let existing: Stats | undefined;
  try {
    existing = await fs.stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`[keys] reading ${file} failed: ${messageOf(err)}`);
      return { result: 'failed', code: 'writeFailed' };
    }
  }
  if (existing && !existing.isFile()) return { result: 'failed', code: 'notFile' };
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, 'a+', 0o600);
  } catch (err) {
    log(`[keys] opening ${file} failed: ${messageOf(err)}`);
    return { result: 'failed', code: 'writeFailed' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { result: 'failed', code: 'notFile' };
    if (uid !== undefined && stat.uid !== uid) return { result: 'failed', code: 'ownership' };
    const text = (await handle.readFile()).toString('utf8');
    const entry = keyEntry(text, publicKey);
    if (entry === 'present') return { result: 'present' };
    if (entry === 'restricted') {
      log(`[keys] ${file} holds Damocles' key with options that restrict it`);
      return { result: 'failed', code: 'restricted' };
    }
    const lead = text.length > 0 && !text.endsWith('\n') ? (text.endsWith('\r') ? '\n' : os.EOL) : '';
    await handle.appendFile(`${lead}${publicKey}${os.EOL}`);
    if (uid !== undefined) await handle.chmod(0o600);
    return { result: 'installed' };
  } catch (err) {
    log(`[keys] writing ${file} failed: ${messageOf(err)}`);
    return { result: 'failed', code: 'writeFailed' };
  } finally {
    await handle.close();
  }
}

// ~/.ssh made 0700 and owned by the user; created when missing.
async function sshFolder(folder: string, uid: number, log: (line: string) => void): Promise<'ok' | 'ownership' | 'notFile' | 'writeFailed'> {
  try {
    const found = await fs.stat(folder).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });
    if (found && !found.isDirectory()) return 'notFile';
    if (!found) await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const stat = found ?? (await fs.stat(folder));
    if (stat.uid !== uid) return 'ownership';
    await fs.chmod(folder, 0o700);
    return 'ok';
  } catch (err) {
    log(`[keys] preparing ${folder} failed: ${messageOf(err)}`);
    return 'writeFailed';
  }
}

async function installPosix(publicKey: string, deps: AuthorizedKeysDeps): Promise<InstallKeyResult> {
  const folder = path.join(deps.homedir, '.ssh');
  const file = path.join(folder, 'authorized_keys');
  const uid = deps.uid;
  if (uid === undefined) throw new Error('A POSIX daemon has a uid');
  const checked = await sshFolder(folder, uid, deps.log);
  if (checked !== 'ok') return { result: 'failed', code: checked, path: folder };
  const appended = await appendKey(file, publicKey, uid, deps.log);
  if (appended.result === 'failed') return { ...appended, path: file };
  const restorecon = await deps.restorecon();
  if (restorecon !== undefined) {
    // ssh-copy-id leaves the install standing when restorecon fails; the client's verification then reports it
    try {
      const { exit, stderr } = await deps.run({ file: restorecon, args: ['-F', folder, file], stdio: ['ignore', 'ignore', 'pipe'] }, { timeoutMs: TOOL_TIMEOUT_MS });
      if (exit?.code !== 0) deps.log(`[keys] restorecon -F exited ${exit === null ? 'after the timeout' : String(exit.code ?? exit.signal)}: ${stderr.toString('utf8').trim().slice(0, 512)}`);
    } catch (err) {
      deps.log(`[keys] restorecon -F did not start: ${messageOf(err)}`);
    }
  }
  deps.log(`[keys] ${appended.result === 'installed' ? 'appended Damocles\' key to' : 'Damocles\' key is already in'} ${file}`);
  return { result: appended.result, path: file };
}

/** The SID column of `whoami /groups /fo csv /nh` or `whoami /user /fo csv /nh` lines, whose values are quoted. */
export function csvSids(output: string): string[] {
  return output.split(/\r?\n/).flatMap((line) => [...line.matchAll(/"(S-1-[0-9-]+)"/g)].map((match) => match[1]!));
}

/** The user's administrators_authorized_keys or own authorized_keys, as Win32-OpenSSH's default sshd_config reads them. */
export function windowsKeysFile(admin: boolean, env: Readonly<Record<string, string | undefined>>, homedir: string): string {
  if (!admin) return path.win32.join(homedir, '.ssh', 'authorized_keys');
  const programData = env['ProgramData'];
  const root = programData !== undefined && executablePathForm(programData, 'win32').kind === 'absolute' ? programData : 'C:\\ProgramData';
  return path.win32.join(root, 'ssh', 'administrators_authorized_keys');
}

/**
 * icacls' runs: /reset drops every explicit entry an existing file had, then inheritance goes and the file grants full
 * control only to Administrators and SYSTEM (administrators_authorized_keys), or to the user and SYSTEM, the account sshd
 * reads it as. administrators_authorized_keys is owned by Administrators, since Win32-OpenSSH refuses a file another
 * administrator owns (check_secure_file_permission).
 */
export function icaclsRuns(file: string, account: { readonly admin: true } | { readonly admin: false; readonly userSid: string }): string[][] {
  if (account.admin) {
    return [[file, '/reset'], [file, '/setowner', `*${ADMINISTRATORS_SID}`], [file, '/inheritance:r', '/grant:r', `*${ADMINISTRATORS_SID}:F`, '/grant:r', `*${SYSTEM_SID}:F`]];
  }
  return [[file, '/reset'], [file, '/inheritance:r', '/grant:r', `*${account.userSid}:F`, '/grant:r', `*${SYSTEM_SID}:F`]];
}

// The SIDs whoami lists, or undefined when it did not run or failed.
async function whoami(deps: AuthorizedKeysDeps, args: readonly string[]): Promise<string[] | undefined> {
  try {
    const { exit, stdout, stderr } = await deps.run({ file: windowsSystemTool('whoami', deps.env), args: [...args, '/fo', 'csv', '/nh'], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: TOOL_TIMEOUT_MS });
    if (exit?.code === 0) return csvSids(stdout.toString('utf8'));
    deps.log(`[keys] whoami ${args.join(' ')} exited ${exit === null ? 'after the timeout' : String(exit.code ?? exit.signal)}: ${stderr.toString('utf8').trim().slice(0, 512)}`);
  } catch (err) {
    deps.log(`[keys] whoami ${args.join(' ')} did not start: ${messageOf(err)}`);
  }
  return undefined;
}

async function installWindows(publicKey: string, deps: AuthorizedKeysDeps): Promise<InstallKeyResult> {
  const groups = await whoami(deps, ['/groups']);
  if (groups === undefined) return { result: 'failed', code: 'accountFailed', path: '' };
  const admin = groups.includes(ADMINISTRATORS_SID);
  let account: Parameters<typeof icaclsRuns>[1] = { admin: true };
  if (!admin) {
    const userSid = (await whoami(deps, ['/user']))?.find((sid) => USER_SID.test(sid));
    if (userSid === undefined) {
      deps.log('[keys] whoami /user named no user SID');
      return { result: 'failed', code: 'accountFailed', path: '' };
    }
    account = { admin: false, userSid };
  }
  const file = windowsKeysFile(admin, deps.env, deps.homedir);
  const folder = path.win32.dirname(file);
  try {
    await fs.mkdir(folder, { recursive: true });
  } catch (err) {
    deps.log(`[keys] creating ${folder} failed: ${messageOf(err)}`);
    return { result: 'failed', code: 'writeFailed', path: folder };
  }
  const appended = await appendKey(file, publicKey, undefined, deps.log);
  if (appended.result === 'failed') return { ...appended, path: file };
  for (const args of icaclsRuns(file, account)) {
    let output: RunOutput;
    try {
      output = await deps.run({ file: windowsSystemTool('icacls', deps.env), args, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }, { timeoutMs: TOOL_TIMEOUT_MS });
    } catch (err) {
      deps.log(`[keys] icacls ${args.slice(1).join(' ')} on ${file} did not start: ${messageOf(err)}`);
      return { result: 'failed', code: 'aclFailed', path: file };
    }
    const { exit, stderr } = output;
    if (exit?.code !== 0) {
      deps.log(`[keys] icacls ${args.slice(1).join(' ')} on ${file} exited ${exit === null ? 'after the timeout' : String(exit.code ?? exit.signal)}: ${stderr.toString('utf8').trim().slice(0, 512)}`);
      return { result: 'failed', code: 'aclFailed', path: file };
    }
  }
  deps.log(`[keys] ${appended.result === 'installed' ? 'appended Damocles\' key to' : 'Damocles\' key is already in'} ${file} (${admin ? 'administrator' : 'user'})`);
  return { result: appended.result, path: file };
}

/** Installs Damocles' public key for the daemon's own user; the caller validated it (DAMOCLES_PUBLIC_KEY). */
export function installAuthorizedKey(publicKey: string, deps: AuthorizedKeysDeps): Promise<InstallKeyResult> {
  return deps.platform === 'win32' ? installWindows(publicKey, deps) : installPosix(publicKey, deps);
}
