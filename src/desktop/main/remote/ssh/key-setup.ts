// Set up passwordless login: Damocles' own ed25519 key under ~/.damocles/ssh/ (never ~/.ssh), installed on the host by its
// daemon (ssh.installAuthorizedKey) and checked by a publickey-only ssh that offers that key first. A saved or configured
// IdentityFile is still offered after it, so the check proves the host takes a key without a password, not which key.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { RunOutput, SpawnSpec } from '../../../../core/process-launcher';
import type { AskpassRegistration, AskpassServer } from '../../../../core/scm/askpass/askpass-server';
import { DAMOCLES_PUBLIC_KEY, type InstallKeyResult } from '../../../daemon/control-messages';
import type { PasswordlessFailureCode, PasswordlessResult, PasswordlessStep } from '../../../preload/overlay-channels';
import type { InstalledKey } from '../host-store';
import type { SshRun } from './control-master';
import { buildSshConfigQueryArgs, buildSshVerifyArgs } from './ssh-args';
import type { SshDestination } from './ssh-command-parse';
import { sshPercentLiteral } from './ssh-percent';
import { sshCallEnv } from './ssh-transport';

const KEY_FILE_NAME = 'id_ed25519';
const KEYGEN_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 10_000;
// ssh-keygen -l: "<bits> SHA256:<43 base64> <comment> (ED25519)"
const FINGERPRINT_LINE = /^\d+ (SHA256:[A-Za-z0-9+/]{43}) /;

export interface KeySetupDeps {
  // keyFolder(<Damocles' home>)
  readonly folder: string;
  // this computer's name, for the key comment
  readonly clientName: string;
  readonly resolveKeygen: () => Promise<string | undefined>;
  readonly resolveSsh: () => Promise<string | undefined>;
  // through main's process launcher
  readonly run: (spec: SpawnSpec, options: { readonly timeoutMs: number }) => Promise<RunOutput>;
  // `ssh -G`, which reads the PreferredAuthentications in effect
  readonly sshQuery: SshRun;
  // main's askpass server: the check registers in the background, so every question it raises is answered cancel
  readonly askpass: () => Promise<Pick<AskpassServer, 'register'>>;
  // `ssh -V`'s version, for the askpass variables
  readonly sshVersion: (ssh: string) => Promise<readonly [number, number] | undefined>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
}

export interface KeySetupTarget {
  readonly destination: SshDestination;
  // the e2e hook's -F file
  readonly configFile?: string;
  // whether the host's daemon serves ssh.installAuthorizedKey
  readonly canInstall: boolean;
  readonly install: (publicKey: string) => Promise<InstallKeyResult>;
  // the daemon appended the key line: recorded before the check, so a failed check still leaves Remove Damocles server the line
  readonly recordInstalled: (installed: InstalledKey) => Promise<void>;
  // step events for the host card's three inline steps
  readonly progress: (step: PasswordlessStep, state: 'running' | 'done' | 'failed', failure?: { readonly code: PasswordlessFailureCode; readonly params: Readonly<Record<string, string>> }) => void;
}

/** The result, and the key file the host store passes to ssh from now on, once the check passed. */
export interface KeySetupOutcome {
  readonly result: PasswordlessResult;
  readonly identityFile?: string;
}

/** The folder of Damocles' key pair: under Damocles' home, never ~/.ssh. */
export function keyFolder(damoclesHome: string): string {
  return path.join(damoclesHome, 'ssh');
}

/** The key comment's client part: this computer's name in the characters the public key line allows. */
export function keyCommentName(hostname: string): string {
  const name = hostname.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
  return name === '' ? 'client' : name;
}

/** ssh-keygen's arguments: an ed25519 key with no passphrase and Damocles' comment, written to file, quietly. */
export function keygenArgs(file: string, clientName: string): string[] {
  return ['-t', 'ed25519', '-N', '', '-C', `damocles@${keyCommentName(clientName)}`, '-f', file, '-q'];
}

/** The SHA256 fingerprint `ssh-keygen -l -E sha256 -f <file>` printed, or undefined. */
export function parseFingerprint(output: string): string | undefined {
  return FINGERPRINT_LINE.exec(output.trim())?.[1];
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, (err: NodeJS.ErrnoException) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

// A public key without its private key: only the user can tell whether to delete it.
class KeyPairIncomplete extends Error {
  override readonly name = 'KeyPairIncomplete';
  readonly path: string;
  constructor(file: string) {
    super(`${file} has no private key beside it`);
    this.path = file;
  }
}

const exitText = (exit: RunOutput['exit']): string => (exit === null ? 'after the timeout' : String(exit.code ?? exit.signal));

// The public key line rebuilt from the private key with `ssh-keygen -y`, with Damocles' comment.
async function rebuildPublic(deps: KeySetupDeps, keygen: string, file: string): Promise<void> {
  const { exit, stdout, stderr } = await deps.run({ file: keygen, args: ['-y', '-f', file], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: KEYGEN_TIMEOUT_MS });
  const [type, blob] = stdout.toString('utf8').trim().split(/\s+/);
  if (exit?.code !== 0 || type === undefined || blob === undefined) throw new Error(`ssh-keygen -y exited ${exitText(exit)}: ${stderr.toString('utf8').trim().slice(0, 512)}`);
  await fs.writeFile(`${file}.pub`, `${type} ${blob} damocles@${keyCommentName(deps.clientName)}\n`, { flag: 'wx' });
  deps.log(`[ssh] rebuilt ${file}.pub from its private key`);
}

// The key pair, generated once and shared by every host; a private key whose .pub is missing gets it back.
async function ensureKey(deps: KeySetupDeps, keygen: string): Promise<string> {
  const file = path.join(deps.folder, KEY_FILE_NAME);
  const [hasPrivate, hasPublic] = await Promise.all([exists(file), exists(`${file}.pub`)]);
  if (hasPrivate && hasPublic) return file;
  if (hasPublic) throw new KeyPairIncomplete(`${file}.pub`);
  if (hasPrivate) {
    await rebuildPublic(deps, keygen, file);
    return file;
  }
  await fs.mkdir(deps.folder, { recursive: true, mode: 0o700 });
  const { exit, stderr } = await deps.run({ file: keygen, args: keygenArgs(file, deps.clientName), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }, { timeoutMs: KEYGEN_TIMEOUT_MS });
  if (exit?.code !== 0) throw new Error(`ssh-keygen exited ${exitText(exit)}: ${stderr.toString('utf8').trim().slice(0, 512)}`);
  deps.log(`[ssh] generated ${file}`);
  return file;
}

// one run per folder, so two setups at once never race ssh-keygen over the same files
const keyRuns = new Map<string, Promise<string>>();

function sharedKey(deps: KeySetupDeps, keygen: string): Promise<string> {
  let run = keyRuns.get(deps.folder);
  if (!run) {
    run = ensureKey(deps, keygen).finally(() => keyRuns.delete(deps.folder));
    keyRuns.set(deps.folder, run);
  }
  return run;
}

async function fingerprintOf(deps: KeySetupDeps, keygen: string, publicFile: string): Promise<string> {
  const { exit, stdout, stderr } = await deps.run({ file: keygen, args: ['-l', '-E', 'sha256', '-f', publicFile], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: KEYGEN_TIMEOUT_MS });
  const fingerprint = exit?.code === 0 ? parseFingerprint(stdout.toString('utf8')) : undefined;
  if (fingerprint === undefined) throw new Error(`ssh-keygen -l gave no fingerprint: ${stderr.toString('utf8').trim().slice(0, 512)}`);
  return fingerprint;
}

// ssh tries PreferredAuthentications in order, so a list asking for a password before publickey, or without it, would prompt
// on every connect while the verify call, which forces publickey, passed.
function promptsBeforeKey(preferred: string): boolean {
  const methods = preferred.split(',');
  const key = methods.indexOf('publickey');
  return key < 0 || methods.slice(0, key).some((method) => method === 'password' || method === 'keyboard-interactive');
}

// ssh's own order (sshconnect2.c) while PreferredAuthentications is unset, which `ssh -G` then leaves out of its output
const SSH_DEFAULT_PREFERRED_AUTHENTICATIONS = 'gssapi-with-mic,publickey,keyboard-interactive,password';

// PreferredAuthentications as `ssh -G` resolves it from the saved options and the user's config; undefined, logged, when
// ssh cannot tell.
async function preferredAuthentications(deps: KeySetupDeps, target: KeySetupTarget, ssh: string): Promise<string | undefined> {
  try {
    const { code, stdout, stderr } = await deps.sshQuery(ssh, buildSshConfigQueryArgs(target.destination, target.configFile), QUERY_TIMEOUT_MS);
    if (code === 0) return /^preferredauthentications[ \t]+(\S+)\r?$/im.exec(stdout)?.[1] ?? SSH_DEFAULT_PREFERRED_AUTHENTICATIONS;
    deps.log(`[ssh] ssh -G exited ${String(code)}: ${stderr.trim().slice(0, 2000)}`);
    return undefined;
  } catch (err) {
    deps.log(`[ssh] ssh -G did not run: ${messageOf(err)}`);
    return undefined;
  }
}

/** Thrown by KeySetupTarget.install when the host's connection closed before the daemon answered. */
export class HostNotConnectedError extends Error {
  override readonly name = 'HostNotConnectedError';
}

// The check, under a background askpass registration: a jump host's question is answered cancel, never shown elsewhere.
async function verifies(deps: KeySetupDeps, target: KeySetupTarget, ssh: string, file: string): Promise<boolean> {
  let registration: AskpassRegistration | undefined;
  try {
    registration = await (await deps.askpass()).register('background', 'ssh passwordless check');
    const env = sshCallEnv(deps.env, registration.env, await deps.sshVersion(ssh));
    const args = buildSshVerifyArgs(target.destination, target.configFile, sshPercentLiteral(file));
    const { exit, stderr } = await deps.run({ file: ssh, args, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }, { timeoutMs: VERIFY_TIMEOUT_MS });
    if (exit?.code === 0) return true;
    deps.log(`[ssh] the passwordless check exited ${exitText(exit)}: ${stderr.toString('utf8').trim().slice(0, 2000)}`);
    return false;
  } catch (err) {
    deps.log(`[ssh] the passwordless check did not run: ${messageOf(err)}`);
    return false;
  } finally {
    registration?.dispose();
  }
}

/** Generate, install, verify; each step reports running, then done or failed with a code. */
export async function setUpPasswordless(deps: KeySetupDeps, target: KeySetupTarget): Promise<KeySetupOutcome> {
  const failed = (step: PasswordlessStep, code: PasswordlessFailureCode, params: Readonly<Record<string, string>> = {}): KeySetupOutcome => {
    target.progress(step, 'failed', { code, params });
    return { result: { ok: false, step, code, params } };
  };
  target.progress('generate', 'running');
  let ssh: string | undefined;
  try {
    ssh = await deps.resolveSsh();
  } catch (err) {
    deps.log(`[ssh] finding ssh for passwordless login failed: ${messageOf(err)}`);
    return failed('generate', 'configUnreadable');
  }
  if (ssh === undefined) {
    deps.log('[ssh] no ssh on this computer for passwordless login');
    return failed('generate', 'configUnreadable');
  }
  const preferred = await preferredAuthentications(deps, target, ssh);
  if (preferred === undefined) return failed('generate', 'configUnreadable');
  if (promptsBeforeKey(preferred)) return failed('generate', 'publickeyNotPreferred');
  let file: string;
  let publicKey: string;
  let fingerprint: string;
  try {
    const keygen = await deps.resolveKeygen();
    if (keygen === undefined) {
      deps.log('[ssh] no ssh-keygen on this computer');
      return failed('generate', 'keygenFailed');
    }
    file = await sharedKey(deps, keygen);
    publicKey = (await fs.readFile(`${file}.pub`, 'utf8')).trim();
    fingerprint = await fingerprintOf(deps, keygen, `${file}.pub`);
  } catch (err) {
    deps.log(`[ssh] the passwordless key: ${messageOf(err)}`);
    return err instanceof KeyPairIncomplete ? failed('generate', 'keyPairIncomplete', { path: err.path }) : failed('generate', 'keygenFailed');
  }
  if (!DAMOCLES_PUBLIC_KEY.test(publicKey)) {
    deps.log(`[ssh] ${file}.pub is not a Damocles ed25519 key line`);
    return failed('generate', 'keygenFailed');
  }
  target.progress('generate', 'done');

  target.progress('install', 'running');
  if (!target.canInstall) {
    deps.log('[ssh] the host\'s Damocles server does not serve ssh.installAuthorizedKey');
    return failed('install', 'unsupported');
  }
  let installed: InstallKeyResult;
  try {
    installed = await target.install(publicKey);
  } catch (err) {
    deps.log(`[ssh] installing the key failed: ${messageOf(err)}`);
    return failed('install', err instanceof HostNotConnectedError ? 'notConnected' : 'installFailed');
  }
  if (installed.result === 'failed') return failed('install', installed.code, { path: installed.path });
  target.progress('install', 'done');
  if (installed.result === 'installed') await target.recordInstalled({ fingerprint, entry: publicKey.split(' ').slice(0, 2).join(' '), file: installed.path });

  target.progress('verify', 'running');
  if (!(await verifies(deps, target, ssh, file))) return failed('verify', 'verifyFailed');
  target.progress('verify', 'done');
  return { result: { ok: true }, identityFile: file };
}
