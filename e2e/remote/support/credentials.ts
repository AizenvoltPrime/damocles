import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { fixtureLabels, runProgram, TARGET_USER, type SshClientHome, type SshdFixture } from './sshd';

// sshd variants and target-side recorders for the credential specs, applied to a running fixture container.

const SSHD_CONFIG = '/etc/ssh/sshd_config';
// fake loginctl's record of its arguments, one call per line
export const LOGINCTL_LOG = '/var/log/loginctl.log';
// the git wrapper's record: each call's arguments, then ` relay` when its GIT_CONFIG pairs carry a credential.helper
export const GIT_CALLS_LOG = '/var/log/git-calls.log';

type Account = typeof TARGET_USER | 'deploy';

export interface PasswordOptions {
  /** keyboard-interactive only, through PAM: the password, then a TOTP verification code from this base32 secret */
  readonly otpSecret?: string;
}

/**
 * sshd with password and keyboard-interactive sign-in, and public keys only from the user's own ~/.ssh/authorized_keys,
 * which holds none until one is installed there.
 */
export async function usePasswords(fixture: SshdFixture, passwords: Partial<Record<Account, string>>, options: PasswordOptions = {}): Promise<void> {
  const config = [
    'Port 22',
    'HostKey /etc/ssh/ssh_host_ed25519_key',
    'AuthorizedKeysFile .ssh/authorized_keys',
    'PasswordAuthentication yes',
    'KbdInteractiveAuthentication yes',
    'UsePAM yes',
    'PermitRootLogin no',
    'PidFile /run/sshd.pid',
    ...(options.otpSecret !== undefined ? ['AuthenticationMethods keyboard-interactive'] : []),
    '',
  ].join('\n');
  await fixture.stopSshd();
  await fixture.sh(`cat > ${SSHD_CONFIG}`, 'root', config);
  for (const [user, password] of Object.entries(passwords)) await setPassword(fixture, user as Account, password);
  if (options.otpSecret !== undefined) {
    // pam_google_authenticator after common-auth: PAM asks the password first, then the code
    await fixture.sh("grep -q pam_google_authenticator /etc/pam.d/sshd || echo 'auth required pam_google_authenticator.so' >> /etc/pam.d/sshd");
    await fixture.sh(`cat > ~/.google_authenticator && chmod 400 ~/.google_authenticator`, TARGET_USER, `${options.otpSecret}\n" TOTP_AUTH\n" WINDOW_SIZE 3\n`);
  }
  await fixture.startSshd();
}

export async function setPassword(fixture: SshdFixture, user: Account, password: string): Promise<void> {
  await fixture.sh('chpasswd', 'root', `${user}:${password}\n`);
}

/** A password no earlier run used. */
export const newPassword = (): string => `pw-${randomBytes(9).toString('base64url')}`;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const newOtpSecret = (): string => Array.from(randomBytes(16), (byte) => BASE32[byte % 32]).join('');

/** The RFC 6238 code (30-second steps, 6 digits, HMAC-SHA1) pam_google_authenticator accepts for `secret` now. */
export function totp(secret: string, at = Date.now()): string {
  let bits = '';
  for (const char of secret) bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The key lines of the account's own ~/.ssh/authorized_keys; none while the file is missing. */
export async function userAuthorizedKeys(fixture: SshdFixture, user: Account = TARGET_USER): Promise<string[]> {
  return (await fixture.sh(`cat /home/${user}/.ssh/authorized_keys 2>/dev/null || true`)).split('\n').filter((line) => line.trim() !== '');
}

/** The mode and owner of a path as `stat -c '%a %U'` prints them. */
export async function modeAndOwner(fixture: SshdFixture, file: string): Promise<string> {
  return (await fixture.sh(`stat -c '%a %U' '${file}'`)).trim();
}

/**
 * logind that ends a user's processes at logout (KillUserProcesses=yes, so the probe reports no linger) and a loginctl that
 * records its arguments and keeps the linger folder's files as logind does; the images run no systemd.
 */
export async function fakeLoginctl(fixture: SshdFixture): Promise<void> {
  const loginctl = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${LOGINCTL_LOG}`,
    'for user; do :; done',
    'case " $* " in',
    '  *" enable-linger "*) : > "/var/lib/systemd/linger/$user" ;;',
    '  *" disable-linger "*) rm -f "/var/lib/systemd/linger/$user" ;;',
    'esac',
    '',
  ].join('\n');
  await fixture.sh([
    'mkdir -p /etc/systemd /var/lib/systemd/linger',
    'chmod 1777 /var/lib/systemd/linger',
    "printf '[Login]\\nKillUserProcesses=yes\\n' > /etc/systemd/logind.conf",
    'cat > /usr/bin/loginctl',
    'chmod 755 /usr/bin/loginctl',
    `: > ${LOGINCTL_LOG}`,
    `chmod 666 ${LOGINCTL_LOG}`,
  ].join(' && '), 'root', loginctl);
}

/** Whether logind's linger folder names the user. */
export async function lingering(fixture: SshdFixture, user: Account = TARGET_USER): Promise<boolean> {
  return (await fixture.sh(`if [ -e /var/lib/systemd/linger/${user} ]; then echo yes; fi`)).trim() === 'yes';
}

export async function loginctlCalls(fixture: SshdFixture): Promise<string[]> {
  return (await fixture.sh(`cat ${LOGINCTL_LOG}`)).split('\n').filter(Boolean);
}

/** Puts a recorder in front of /usr/bin/git: every call through that path lands in GIT_CALLS_LOG, then runs the real git. */
export async function recordGitCalls(fixture: SshdFixture): Promise<void> {
  const wrapper = [
    '#!/bin/sh',
    "relay=''",
    'i=0',
    'while [ "$i" -lt "${GIT_CONFIG_COUNT:-0}" ]; do',
    '  eval "key=\\${GIT_CONFIG_KEY_$i}"',
    "  [ \"$key\" = credential.helper ] && relay=' relay'",
    '  i=$((i + 1))',
    'done',
    `printf '%s%s\\n' "$*" "$relay" >> ${GIT_CALLS_LOG}`,
    'exec /usr/bin/git.real "$@"',
    '',
  ].join('\n');
  await fixture.sh(`mv /usr/bin/git /usr/bin/git.real && cat > /usr/bin/git && chmod 755 /usr/bin/git && : > ${GIT_CALLS_LOG} && chmod 666 ${GIT_CALLS_LOG}`, 'root', wrapper);
}

export async function gitCalls(fixture: SshdFixture): Promise<string[]> {
  return (await fixture.sh(`cat ${GIT_CALLS_LOG}`)).split('\n').filter(Boolean);
}

/** Makes the target's system trust store (which its git reads) trust `caPem`. */
export async function trustCa(fixture: SshdFixture, caPem: string): Promise<void> {
  await fixture.sh('cat > /usr/local/share/ca-certificates/damocles-e2e.crt && update-ca-certificates > /dev/null', 'root', caPem);
}

/**
 * Puts `jump` and `target` on a Docker network of their own, where the jump host reaches the target as `targetName` port 22,
 * and adds `Host <alias>` reaching the target through `ProxyJump <jumpAlias>`, its host key trusted under `targetName`.
 * Resolves with the network's removal, which disconnects both first.
 */
export async function proxyJumpPair(ssh: SshClientHome, jump: { alias: string; fixture: SshdFixture }, target: { alias: string; fixture: SshdFixture }, targetName: string, extra: readonly string[] = []): Promise<() => Promise<void>> {
  const network = `damocles-e2e-net-${randomBytes(6).toString('hex')}`;
  const docker = async (args: readonly string[]): Promise<void> => {
    const result = await runProgram('docker', args);
    if (result.code !== 0) throw new Error(`docker ${args.join(' ')} exited with ${result.code}: ${result.stderr.trim()}`);
  };
  await docker(['network', 'create', ...fixtureLabels(), network]);
  try {
    await docker(['network', 'connect', network, jump.fixture.container]);
    await docker(['network', 'connect', '--alias', targetName, network, target.fixture.container]);
    ssh.addBlock(target.alias, [`HostName ${targetName}`, 'Port 22', `User ${TARGET_USER}`, `ProxyJump ${jump.alias}`, ...extra]);
    fs.appendFileSync(ssh.knownHosts, `${targetName} ${await target.fixture.hostKey()}\n`);
  } catch (error) {
    // a container that never joined cannot be disconnected, so these exit codes are not checked; the first failure is thrown
    for (const fixture of [jump.fixture, target.fixture]) await runProgram('docker', ['network', 'disconnect', '-f', network, fixture.container]);
    await runProgram('docker', ['network', 'rm', network]);
    throw error;
  }
  return async () => {
    for (const fixture of [jump.fixture, target.fixture]) await docker(['network', 'disconnect', '-f', network, fixture.container]);
    await docker(['network', 'rm', network]);
  };
}
