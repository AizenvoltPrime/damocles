import type { ElectronApplication } from '@playwright/test';
import { control, expect } from './remote';
import { TARGET_USER, type SshdFixture } from './sshd';

// The argv of every process the server package starts on a POSIX target: <install>/<version>-<target>/node/node <same>/dist/<entry>.js
// An install folder may hold spaces, so a path matches anything up to the entry.
const SERVER_PROCESS = /\/node\/node .*\/dist\/(daemon|core-host|pty-host|formatter-host)\.js\b/;
const DAEMON_SERVE = /\/node\/node .*\/dist\/daemon\.js serve\b/;

/** The server package's processes among an account's: the daemon and its bridge, core, the pty and formatter hosts. */
export async function serverProcesses(fixture: Pick<SshdFixture, 'userProcesses'>, user: 'dev' | 'deploy' = TARGET_USER): Promise<string[]> {
  return (await fixture.userProcesses(user)).filter((line) => SERVER_PROCESS.test(line));
}

/** The pids of the account's running daemons (`daemon.js serve`). */
export async function daemonPids(fixture: Pick<SshdFixture, 'userProcesses'>, user: 'dev' | 'deploy' = TARGET_USER): Promise<number[]> {
  return (await fixture.userProcesses(user)).filter((line) => DAEMON_SERVE.test(line)).map((line) => Number(line.split(' ')[0]));
}

/**
 * Ends the host's daemon with control.shutdownNow and waits until the account has no process left: no daemon, bridge, core,
 * pty host, formatter host, terminal shell or ssh session. Every spec that starts a daemon ends with this.
 */
export async function shutdownHostDaemon(app: ElectronApplication, hostId: string, fixture: Pick<SshdFixture, 'userProcesses'>, user: 'dev' | 'deploy' = TARGET_USER): Promise<void> {
  expect(await daemonPids(fixture, user)).toHaveLength(1);
  await control(app, hostId, 'shutdownNow');
  await expect.poll(() => fixture.userProcesses(user), { timeout: 30_000 }).toEqual([]);
}
