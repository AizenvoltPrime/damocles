import * as fs from 'node:fs';
import * as path from 'node:path';
import { run } from '../../desktop/support/app';
import type { HermeticHome } from '../../desktop/support/hermetic';
import { WINDOWS_SSH_ENV } from './remote';

// The target suites run on a CI runner against its own sshd (remote-e2e-nightly.yml), which authorizes a key for the runner's
// account and passes it, the known host line and the account here. The target's home is the runner's, discarded with it.
const IDENTITY = process.env['DAMOCLES_E2E_TARGET_IDENTITY'];
const KNOWN_HOSTS = process.env['DAMOCLES_E2E_TARGET_KNOWN_HOSTS'];
const USER = process.env['DAMOCLES_E2E_TARGET_USER'];

// A release URL nothing serves: the target's download fails at once and the app uploads the package it built.
const NO_RELEASE = 'http://127.0.0.1:1';

const SYSTEM32 = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');

async function windowsTool(name: string, args: string[]): Promise<string> {
  const result = await run(path.join(SYSTEM32, `${name}.exe`), args, 60_000);
  if (result.code !== 0) throw new Error(`${name} ${args.join(' ')} exited ${String(result.code)}: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * Copies a private key to `file`, readable by this account alone, as ssh requires: Win32-OpenSSH ignores a key whose ACL grants
 * anyone else, which a copy inherits from a folder such as the runner's temp drive. /reset drops the explicit entries first,
 * as src/desktop/daemon/token.ts does.
 */
async function copyPrivateKey(source: string, file: string): Promise<void> {
  fs.copyFileSync(source, file);
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o600);
    return;
  }
  const sid = /"(S-1-[\d-]+)"/.exec(await windowsTool('whoami', ['/user', '/fo', 'csv', '/nh']))?.[1];
  if (!sid) throw new Error('whoami /user named no SID');
  await windowsTool('icacls', [file, '/reset']);
  await windowsTool('icacls', [file, '/inheritance:r', '/grant:r', `*${sid}:F`]);
}

/** The launch environment of a test against the runner's sshd: a temp ~/.ssh naming it as prod-1, with the workflow's key and known host. */
export async function runnerTargetEnv(home: HermeticHome): Promise<Record<string, string>> {
  if (!IDENTITY || !KNOWN_HOSTS || !USER) throw new Error('DAMOCLES_E2E_TARGET_IDENTITY, _KNOWN_HOSTS and _USER are unset; the target suites run in remote-e2e-nightly.yml');
  const dir = path.join(home.home, '.ssh');
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'id_ed25519');
  await copyPrivateKey(IDENTITY, key);
  const knownHosts = path.join(dir, 'known_hosts');
  fs.copyFileSync(KNOWN_HOSTS, knownHosts);
  const posix = (file: string): string => file.split(path.sep).join('/');
  const config = path.join(dir, 'config');
  fs.writeFileSync(config, [
    'Host prod-1',
    '  HostName 127.0.0.1',
    '  Port 22',
    `  User ${USER}`,
    `  IdentityFile "${posix(key)}"`,
    '  IdentitiesOnly yes',
    '  IdentityAgent none',
    `  UserKnownHostsFile "${posix(knownHosts)}"`,
    '',
  ].join('\n'));
  return { ...WINDOWS_SSH_ENV, DAMOCLES_E2E_HOOKS: '1', DAMOCLES_REMOTE: '1', DAMOCLES_E2E_SSH_CONFIG: config, DAMOCLES_E2E_RELEASE_URL: NO_RELEASE };
}
