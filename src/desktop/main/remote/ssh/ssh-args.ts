// The one place ssh's argument list is built. Nothing user-controlled becomes an option: aliases and hosts come after `--`,
// users as `-l`'s value, all refused when they start with `-`, and only allowlisted options are passed, each as one
// `-o Name="value"`.
import * as path from 'node:path';
import type { ControlMasterPlan } from './control-master';
import { isAllowedSshOption, isSafeHost, isSafeUser, UNSAFE, type SshDestination } from './ssh-command-parse';

// ssh keeps the first value it reads for an option, and these come before the saved options and win over them and the user's
// config: RemoteCommand=none, and the keepalive and timeout that decide drop detection.
export const FIXED_SSH_OPTIONS: readonly string[] = [
  '-T',
  '-o', 'RemoteCommand=none',
  '-o', 'RequestTTY=no',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ConnectTimeout=15',
  '-o', 'PermitLocalCommand=no',
  '-o', 'ClearAllForwardings=yes',
];

// at most 255 characters, a DNS name's bound
const ALIAS = /^[^\s-][^\s]{0,254}$/;

export class SshArgumentError extends Error {
  override readonly name = 'SshArgumentError';
}

/** A Host alias ssh takes as written: no option, no `user@` or `ssh://` it would reinterpret, no pattern. */
export function isSafeAlias(alias: string): boolean {
  return ALIAS.test(alias) && !UNSAFE.test(alias) && !/[*?!@]/.test(alias) && !alias.startsWith('ssh://');
}

/**
 * One `-o Name="value"` argument that OpenSSH before and after 8.7 read back as the value: quoted, so a space, `'` or a leading
 * `#` stay literal; on Windows each backslash becomes `/`, which Win32-OpenSSH reads as a separator, since 8.7 and later read
 * `\\` as one backslash; elsewhere a backslash, and anywhere a double quote, is refused.
 */
export function optionArg(name: string, value: string, platform: NodeJS.Platform = process.platform): string {
  if (value.includes('"') || UNSAFE.test(value) || (platform !== 'win32' && value.includes('\\'))) throw new SshArgumentError(`The ${name} value holds a character ssh would not read back as written.`);
  return `${name}="${platform === 'win32' ? value.replaceAll('\\', '/') : value}"`;
}

// Damocles' own master connection, kept 10 minutes after its last session so a reconnect skips the handshake
const CONTROL_PERSIST = '10m';

export interface SshArgsInput {
  readonly destination: SshDestination;
  // the e2e hook's -F file, never anything the renderer sent
  readonly configFile?: string;
  // the host's Forward SSH agent switch, on POSIX targets only
  readonly forwardAgent: boolean;
  // Damocles' passwordless key (absolute, under ~/.damocles/ssh/, each `%` doubled), offered before any saved key
  readonly identityFile?: string;
  // the remote command: stage 0, or a detection command
  readonly command: string;
  // control-master.ts's plan for the host; absent as none
  readonly controlMaster?: ControlMasterPlan;
}

/**
 * Damocles' key as the first identity ssh offers, with no agent or default key: an IdentityFile line rather than `-i`, which
 * checks the literal path before ssh expands `%%`. A saved IdentityFile after it is still offered after it.
 */
export function identityArgs(identityFile: string): string[] {
  if (!path.isAbsolute(identityFile)) throw new SshArgumentError('Damocles\' key path is not absolute.');
  return ['-o', 'IdentitiesOnly=yes', '-o', optionArg('IdentityFile', identityFile)];
}

function controlMasterArgs(plan: ControlMasterPlan | undefined): string[] {
  switch (plan?.kind) {
    case 'damocles':
      return ['-o', 'ControlMaster=auto', '-o', optionArg('ControlPath', plan.controlPath), '-o', `ControlPersist=${CONTROL_PERSIST}`];
    case 'off':
      return ['-o', 'ControlMaster=no', '-o', 'ControlPath=none'];
    default:
      return [];
  }
}

interface DestinationParts {
  // [-F file] [-l user] [-p port]
  readonly leading: string[];
  // the saved address's allowlisted options
  readonly saved: string[];
  readonly target: string;
}

function destinationParts(destination: SshDestination, configFile: string | undefined): DestinationParts {
  const leading: string[] = configFile !== undefined ? ['-F', configFile] : [];
  if (destination.kind === 'alias') {
    if (!isSafeAlias(destination.alias)) throw new SshArgumentError('The alias could be read by ssh as an option, a user or a pattern.');
    return { leading, saved: [], target: destination.alias };
  }
  if (!isSafeHost(destination.host)) throw new SshArgumentError('The host name could be read by ssh as an option.');
  if (destination.user !== undefined) {
    if (!isSafeUser(destination.user)) throw new SshArgumentError('The user name holds a character ssh refuses or reads as an option.');
    leading.push('-l', destination.user);
  }
  if (destination.port !== undefined) {
    if (!Number.isInteger(destination.port) || destination.port < 1 || destination.port > 65535) throw new SshArgumentError('The port is outside 1 to 65535.');
    leading.push('-p', String(destination.port));
  }
  const saved = destination.options.flatMap((option) => {
    // read before the guard, whose false branch narrows option to never
    const { name } = option;
    if (!isAllowedSshOption(option)) throw new SshArgumentError(`${name} is outside the allowlist or has a value it refuses.`);
    return ['-o', optionArg(option.name, option.value)];
  });
  return { leading, saved, target: destination.host };
}

// Every connecting call's order: [-F file] [-l user] [-p port], the fixed set, the call's own options, Damocles' key, the saved
// options, one ForwardAgent, `--`, the target, the command; so Damocles' values come first and win.
function connectArgs(parts: DestinationParts, own: readonly string[], identityFile: string | undefined, forwardAgent: boolean, command: string): string[] {
  const identity = identityFile !== undefined ? identityArgs(identityFile) : [];
  return [...parts.leading, ...FIXED_SSH_OPTIONS, ...own, ...identity, ...parts.saved, '-o', `ForwardAgent=${forwardAgent ? 'yes' : 'no'}`, '--', parts.target, command];
}

/** ssh's arguments for a connection, with the plan's ControlMaster options. */
export function buildSshArgs(input: SshArgsInput): string[] {
  return connectArgs(destinationParts(input.destination, input.configFile), controlMasterArgs(input.controlMaster), input.identityFile, input.forwardAgent, input.command);
}

/**
 * The passwordless check, in the connection's order: public key only, no prompt (BatchMode) and no master connection, with
 * Damocles' key offered first and no agent; a saved IdentityFile is still offered after it. The command is `exit 0`, which
 * every target shell runs.
 */
export function buildSshVerifyArgs(destination: SshDestination, configFile: string | undefined, identityFile: string): string[] {
  const own = ['-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'ControlMaster=no', '-o', 'ControlPath=none'];
  return connectArgs(destinationParts(destination, configFile), own, identityFile, false, 'exit 0');
}

/** `ssh -V`, which prints the client's version and connects nowhere. */
export function buildSshVersionArgs(): string[] {
  return ['-V'];
}

/** `ssh -G` for the destination, which evaluates its configuration without connecting. */
export function buildSshConfigQueryArgs(destination: SshDestination, configFile: string | undefined): string[] {
  const { leading, saved, target } = destinationParts(destination, configFile);
  return [...leading, ...saved, '-G', '--', target];
}

/** `ssh -O exit` on the destination's master at Damocles' ControlPath. */
export function buildSshControlArgs(destination: SshDestination, configFile: string | undefined, controlPath: string): string[] {
  const { leading, saved, target } = destinationParts(destination, configFile);
  return [...leading, ...saved, '-o', optionArg('ControlPath', controlPath), '-O', 'exit', '--', target];
}
