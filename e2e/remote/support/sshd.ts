import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { HermeticHome } from '../../desktop/support/hermetic';

// The sshd fixtures: one Docker container per fixture, its sshd on a localhost port, and a temp ~/.ssh on this computer.

// scripts/test-remote.mjs FIXTURE_IMAGES, which builds only the images a selected spec names as `image: '<name>'`.
export type FixtureImage = 'ubuntu' | 'alpine' | 'centos7';
export const imageTag = (image: FixtureImage): string => `damocles-e2e-sshd-${image}`;
// Containers and networks carry both labels, so scripts/test-remote.mjs removes what a run left once its process is gone.
export const FIXTURE_LABEL = 'damocles-e2e-sshd';
const RUN_LABEL = 'damocles-e2e-run';
// test-remote.mjs's pid; under a bare `playwright test`, the runner's, every worker's parent.
const RUN = process.env['DAMOCLES_E2E_RUN'] ?? String(process.ppid);
export const fixtureLabels = (): string[] => ['--label', FIXTURE_LABEL, '--label', `${RUN_LABEL}=${RUN}`];
export const TARGET_USER = 'dev';
export const TARGET_HOME = `/home/${TARGET_USER}`;
// A second account on the Ubuntu image, for a host added by address as user@host.
export const DEPLOY_USER = 'deploy';
type Account = 'root' | typeof TARGET_USER | typeof DEPLOY_USER;

// The containers reach this computer's servers (release mirror, model stub) by this name, never a loopback address, which a
// remote core takes for its own. Docker Desktop forwards it to this computer's 127.0.0.1; on Linux it is the bridge's gateway.
export const HOST_FROM_CONTAINER = 'host.docker.internal';

const DOCKER_TIMEOUT_MS = 120_000;
// sshd's own log (-E): the image has no syslog, and the authentication lines show which method a connection used.
export const SSHD_LOG = '/var/log/sshd.log';
// sshd writes it once its listen sockets are bound, so it marks the moment a connection can succeed.
const SSHD_PID_FILE = '/run/sshd.pid';

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program with `input` on stdin; never a synchronous child, which would stall the worker's lock refreshes. */
export function runProgram(command: string, args: readonly string[], input?: string | Buffer, timeoutMs = DOCKER_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.once('error', reject);
    child.once('close', (code) => (child.killed ? reject(new Error(`${command} ${args.join(' ')} did not finish within ${timeoutMs} ms`)) : resolve({ code, stdout, stderr })));
    child.stdin.end(input);
  });
}

async function docker(args: readonly string[], input?: string | Buffer): Promise<string> {
  const result = await runProgram('docker', args, input);
  if (result.code !== 0) throw new Error(`docker ${args.join(' ')} exited with ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}

/** A port free on 127.0.0.1 now, from the OS's own ephemeral pick; closed again before it returns. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

let listenAddress: Promise<string> | undefined;

/** Where a server the containers reach listens: 127.0.0.1 under Docker Desktop, the default bridge's gateway on Linux. */
export function containerReachableAddress(): Promise<string> {
  listenAddress ??= process.platform === 'linux'
    ? docker(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']).then((out) => out.trim())
    : Promise.resolve('127.0.0.1');
  return listenAddress;
}

export interface SshdOptions {
  readonly image?: FixtureImage;
  /** The user's home on a tmpfs mounted noexec. */
  readonly noexecHome?: boolean;
}

export interface SshdFixture {
  readonly container: string;
  readonly image: FixtureImage;
  /** The port sshd listens on, on this computer's 127.0.0.1. */
  readonly port: number;
  /** `sh -c script` in the container, as `user`; rejects on a non-zero exit. */
  sh(script: string, user?: Account, input?: string | Buffer): Promise<string>;
  /** The host's public ed25519 key line (`ssh-ed25519 AAAA...`). */
  hostKey(): Promise<string>;
  /** The SHA256 fingerprint ssh shows for the host key (`SHA256:...`). */
  fingerprint(): Promise<string>;
  /**
   * Ends every process named sshd: the listener, so new connections are refused, and the sessions where they run as sshd too.
   * On Alpine (OpenSSH 9.8 and later) sessions run as sshd-session and survive. The users' other processes keep running.
   */
  stopSshd(): Promise<void>;
  startSshd(): Promise<void>;
  /** A new host key, as after a reinstall of the host; sshd restarts with it. */
  rotateHostKey(): Promise<void>;
  /** sshd's authentication results in order, as `Accepted password dev`, `Accepted publickey dev SHA256:...` or `Failed pam dev`. */
  authentications(): Promise<string[]>;
  /** Every process of an account, as `pid args` lines, sorted. */
  userProcesses(user?: Account): Promise<string[]>;
  /** Authorizes one more client's public key for every account of the image. */
  authorize(publicKey: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Starts a fixture container from its image (scripts/test-remote.mjs builds them) and its sshd. */
export async function startSshd(options: SshdOptions = {}): Promise<SshdFixture> {
  const image = options.image ?? 'ubuntu';
  const tag = imageTag(image);
  const present = await runProgram('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
  if (present.code !== 0) throw new Error(`the fixture image ${tag} is missing; \`npm run test:remote\` builds each image a selected spec names as image: '${image}'`);
  const name = `damocles-e2e-${randomBytes(6).toString('hex')}`;
  // A port the OS hands out, never one in a Windows excluded port range, where Docker Desktop's own pick can land.
  const port = await freeLoopbackPort();
  const args = ['run', '-d', '--init', '--name', name, ...fixtureLabels(), '-p', `127.0.0.1:${port}:22`, '--hostname', 'prod-1', '--add-host', `${HOST_FROM_CONTAINER}:host-gateway`];
  // Docker's tmpfs default is 64 MiB, below the probe's 300 MB free space check, which must not be what fails.
  if (options.noexecHome) args.push('--tmpfs', `${TARGET_HOME}:rw,noexec,nosuid,size=1g,uid=1000,gid=1000,mode=0755`);
  args.push(tag);
  const sh = async (script: string, user: Account = 'root', input?: string | Buffer): Promise<string> =>
    docker(['exec', '-i', '-u', user, '-w', user === 'root' ? '/' : `/home/${user}`, name, 'sh', '-c', script], input);
  // sshd returns once it forked, before it binds; the loop ends early when no sshd is left to write the pid file.
  const startSshdProcess = (): Promise<string> =>
    sh(`rm -f ${SSHD_PID_FILE} && /usr/sbin/sshd -E ${SSHD_LOG} -o PidFile=${SSHD_PID_FILE} && while [ ! -s ${SSHD_PID_FILE} ]; do pgrep -x sshd > /dev/null || exit 1; sleep 0.1; done`);
  const newHostKey = (): Promise<string> => sh("rm -f /etc/ssh/ssh_host_* && ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key");
  try {
    await docker(args);
    await newHostKey();
    await startSshdProcess();
  } catch (error) {
    // a failed `docker run` leaves the container created or none at all, so the removal's exit code is not checked
    await runProgram('docker', ['rm', '-f', '-v', name]);
    throw error;
  }
  const stopSshd = async (): Promise<void> => {
    await sh('pkill -x sshd; while pgrep -x sshd > /dev/null; do sleep 0.1; done');
  };
  return {
    container: name,
    image,
    port,
    sh,
    hostKey: async () => (await sh('cat /etc/ssh/ssh_host_ed25519_key.pub')).trim().split(/\s+/).slice(0, 2).join(' '),
    fingerprint: async () => {
      const line = await sh('ssh-keygen -l -E sha256 -f /etc/ssh/ssh_host_ed25519_key.pub');
      const found = /SHA256:\S+/.exec(line)?.[0];
      if (!found) throw new Error(`ssh-keygen -l printed no SHA256 fingerprint: ${line}`);
      return found;
    },
    stopSshd,
    startSshd: async () => {
      await startSshdProcess();
    },
    rotateHostKey: async () => {
      await stopSshd();
      await newHostKey();
      await startSshdProcess();
    },
    authentications: async () =>
      (await sh(`cat ${SSHD_LOG}`)).split('\n').flatMap((line) => {
        // a refused keyboard-interactive answer is logged by PAM alone
        const pam = /\bPAM: Authentication failure for (\S+) from /.exec(line);
        if (pam) return [`Failed pam ${pam[1]}`];
        const found = /\b(Accepted|Failed) (\S+) for (\S+) from \S+ port \d+ ssh2(?:: \S+ (SHA256:\S+))?/.exec(line);
        return found && found[2] !== 'none' ? [[found[1], found[2], found[3], ...(found[4] ? [found[4]] : [])].join(' ')] : [];
      }),
    userProcesses: async (user = TARGET_USER) =>
      (await sh('ps -A -o user= -o pid= -o args='))
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([owner]) => owner === user)
        .map(([, ...rest]) => rest.join(' '))
        .sort(),
    authorize: async (publicKey: string) => {
      const users = image === 'ubuntu' ? [TARGET_USER, DEPLOY_USER] : [TARGET_USER];
      for (const user of users) await sh(`cat >> /etc/ssh/authorized_keys/${user} && chmod 644 /etc/ssh/authorized_keys/${user}`, 'root', `${publicKey.trim()}\n`);
    },
    dispose: async () => {
      await docker(['rm', '-f', '-v', name]);
    },
  };
}

// ssh-keygen ships beside ssh: Windows' OpenSSH client folder, else the system's.
const SSH_KEYGEN = process.platform === 'win32' ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe') : '/usr/bin/ssh-keygen';

export interface SshClientHome {
  /** The temp ~/.ssh under the hermetic home. */
  readonly dir: string;
  /** The config the app reads through DAMOCLES_E2E_SSH_CONFIG. */
  readonly config: string;
  readonly knownHosts: string;
  readonly identity: string;
  readonly publicKey: string;
  /** Adds `Host <alias>` for a fixture; `extra` lines go into the block after the fixed ones. */
  addHost(alias: string, fixture: Pick<SshdFixture, 'port'>, extra?: readonly string[]): void;
  /** Adds `Host <alias>` for a fixture that only SSH_AUTH_SOCK's agent signs in to: no key file, not even ssh's defaults. */
  addAgentHost(alias: string, fixture: Pick<SshdFixture, 'port'>): void;
  /** Adds `Host <alias>` with exactly these option lines, for a destination other than a fixture's published port. */
  addBlock(alias: string, lines: readonly string[]): void;
  /** Records a fixture's host key in known_hosts, as a user who connected before has it. */
  trust(fixture: Pick<SshdFixture, 'port' | 'hostKey'>): Promise<void>;
  /** The mtime in ms of every file in ~/.ssh, by name. */
  mtimes(): Record<string, number>;
}

export const knownHostsName = (port: number): string => (port === 22 ? '127.0.0.1' : `[127.0.0.1]:${port}`);

/** A temp ~/.ssh in `home` with a fresh ed25519 key, an empty known_hosts and a config that names only the fixtures. */
export async function sshClientHome(home: Pick<HermeticHome, 'home' | 'root'>): Promise<SshClientHome> {
  const dir = path.join(home.home, '.ssh');
  fs.mkdirSync(dir, { recursive: true });
  const identity = path.join(dir, 'id_ed25519');
  const generated = await runProgram(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', 'damocles-e2e', '-f', identity]);
  if (generated.code !== 0) throw new Error(`ssh-keygen exited with ${generated.code}: ${generated.stderr}`);
  const config = path.join(dir, 'config');
  const knownHosts = path.join(dir, 'known_hosts');
  // forward slashes: ssh's config parser reads a backslash as an escape
  const posix = (file: string): string => file.split(path.sep).join('/');
  fs.writeFileSync(knownHosts, '');
  // Every destination, an address typed as user@host included, gets these, so ssh never reads or writes the real ~/.ssh;
  // an agent-only host gets no key file.
  const agentOnly: string[] = [];
  const everyHost = (): string[] => [
    ['Host *', ...agentOnly.map((alias) => `!${alias}`)].join(' '),
    `  IdentityFile "${posix(identity)}"`,
    '  IdentitiesOnly yes',
    '  IdentityAgent none',
    'Host *',
    `  UserKnownHostsFile "${posix(knownHosts)}"`,
    `  GlobalKnownHostsFile "${posix(path.join(home.root, 'no-global-known-hosts'))}"`,
    '',
  ];
  // ssh keeps the first value it reads, so the host blocks precede `Host *` and an option one of them sets wins.
  const blocks: string[] = [];
  const write = (): void => fs.writeFileSync(config, `${[...blocks, everyHost().join('\n')].join('\n')}\n`);
  write();
  return {
    dir,
    config,
    knownHosts,
    identity,
    publicKey: fs.readFileSync(`${identity}.pub`, 'utf8').trim(),
    addHost: (alias, fixture, extra = []) => {
      blocks.push([`Host ${alias}`, '  HostName 127.0.0.1', `  Port ${fixture.port}`, `  User ${TARGET_USER}`, ...extra.map((line) => `  ${line}`), ''].join('\n'));
      write();
    },
    addAgentHost: (alias, fixture) => {
      agentOnly.push(alias);
      // Win32-OpenSSH reads its default key files from the real profile whatever USERPROFILE says; none names no file at all
      blocks.push([`Host ${alias}`, '  HostName 127.0.0.1', `  Port ${fixture.port}`, `  User ${TARGET_USER}`, '  IdentityFile none', '  IdentityAgent SSH_AUTH_SOCK', ''].join('\n'));
      write();
    },
    addBlock: (alias, lines) => {
      blocks.push([`Host ${alias}`, ...lines.map((line) => `  ${line}`), ''].join('\n'));
      write();
    },
    trust: async (fixture) => {
      fs.appendFileSync(knownHosts, `${knownHostsName(fixture.port)} ${await fixture.hostKey()}\n`);
    },
    mtimes: () => Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.statSync(path.join(dir, name)).mtimeMs])),
  };
}
