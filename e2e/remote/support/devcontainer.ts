import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { runInTerminal } from '../../desktop/support/terminal';
import { shellPage } from '../../desktop/support/shell';
import { control, expect, remoteHosts } from './remote';
import { runProgram } from './sshd';

// The Dev Containers suite: the app builds and attaches containers through the engine this computer (or a fixture's host)
// runs. scripts/test-remote.ts reads the tag from Playwright's listing and builds the Linux and Alpine packages for it.
export const DEVCONTAINER_TAG = '@devcontainer';

// Every container and image the specs make carries this label (the fixture's runArgs and Dockerfile, and the attach target's
// run); teardown removes them by it and checks that none is left. Nothing else on the engine is touched.
export const E2E_LABEL = 'damocles.e2e=devcontainer';
// The data volume Damocles mounts in a devcontainer, named by its container key (src/desktop/daemon/container-commands.ts).
export const dataVolume = (key: string): string => `damocles-data-${key}`;
// The Node image the fixture builds from, pinned by its multi-arch index digest.
export const NODE_IMAGE = 'node:24.22.0-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f';
export const FIXTURE_DIR = path.join(import.meta.dirname, 'devcontainer');
// The env a launch needs: the e2e hooks; the server packages come from the dev build's cache.
export const CONTAINER_ENV = { DAMOCLES_E2E_HOOKS: '1' };

const ENGINE_TIMEOUT_MS = 10 * 60_000;

/** `<engine> args` on this computer, rejecting with its output on a non-zero exit. */
export async function engine(args: readonly string[], name: 'docker' | 'podman' = 'docker'): Promise<string> {
  const result = await runProgram(name, args, undefined, ENGINE_TIMEOUT_MS);
  if (result.code !== 0) throw new Error(`${name} ${args.join(' ')} exited with ${result.code}: ${result.stderr}${result.stdout}`);
  return result.stdout;
}

/**
 * A fresh copy of the fixture folder under parent (a hermetic home's root, which goes once every launch closed), with its own
 * folder key and container labels.
 */
export function copyFixture(parent: string, prefix = 'dc'): string {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, `${prefix}-`)));
  fs.cpSync(FIXTURE_DIR, folder, { recursive: true });
  return folder;
}

/** Rewrites the copy's devcontainer.json through edit. */
export function editConfig(folder: string, edit: (config: Record<string, unknown>) => Record<string, unknown>): void {
  const file = path.join(folder, '.devcontainer', 'devcontainer.json');
  fs.writeFileSync(file, `${JSON.stringify(edit(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>), null, 2)}\n`);
}

// The devcontainer CLI the app bundles, run here under the test's Node as a user's own CLI would run.
const DEVCONTAINER_CLI = path.resolve(import.meta.dirname, '..', '..', '..', 'node_modules', '@devcontainers', 'cli', 'devcontainer.js');

/**
 * `devcontainer up` for the folder outside Damocles, as VS Code or the plain CLI makes a container: no data volume. The
 * fixture's runArgs label it, so teardown removes it. Resolves with the container id.
 */
export async function upOutsideDamocles(folder: string): Promise<string> {
  const config = path.join(folder, '.devcontainer', 'devcontainer.json');
  const result = await runProgram(process.execPath, [DEVCONTAINER_CLI, 'up', '--workspace-folder', folder, '--config', config], undefined, ENGINE_TIMEOUT_MS);
  const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as { outcome?: string; containerId?: string };
  if (result.code !== 0 || outcome.outcome !== 'success' || outcome.containerId === undefined) throw new Error(`devcontainer up exited with ${result.code}: ${result.stderr}${result.stdout}`);
  return outcome.containerId;
}

export interface Leftovers {
  readonly containers: readonly string[];
  readonly images: readonly string[];
  readonly volumes: readonly string[];
}

const lines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

/** What carries the e2e label on the engine, and the data volumes of keys. */
export async function leftovers(keys: readonly string[], name: 'docker' | 'podman' = 'docker'): Promise<Leftovers> {
  const containers = lines(await engine(['ps', '-a', '-q', '--filter', `label=${E2E_LABEL}`], name));
  const images = lines(await engine(['images', '-q', '--filter', `label=${E2E_LABEL}`], name));
  const volumes = lines(await engine(['volume', 'ls', '-q'], name)).filter((volume) => keys.some((key) => volume === dataVolume(key)));
  return { containers, images, volumes };
}

/** Removes what the specs made: labelled containers and images, and the data volumes of keys; then checks that none is left. */
export async function removeLeftovers(keys: readonly string[], name: 'docker' | 'podman' = 'docker'): Promise<void> {
  const found = await leftovers(keys, name);
  if (found.containers.length) await engine(['rm', '-f', '-v', ...found.containers], name);
  if (found.images.length) await engine(['rmi', '-f', ...new Set(found.images)], name);
  if (found.volumes.length) await engine(['volume', 'rm', ...found.volumes], name);
  expect(await leftovers(keys, name)).toEqual({ containers: [], images: [], volumes: [] });
}

/** A /bin/sh script in the container as user. */
export async function inContainer(id: string, script: string, user = 'root', name: 'docker' | 'podman' = 'docker'): Promise<string> {
  return engine(['exec', '-u', user, id, '/bin/sh', '-c', script], name);
}

// The argv of every process a server package starts: <install>/<version>-<target>/node/node <same>/dist/<entry>.js
const SERVER_PROCESS = /\/node\/node .*\/dist\/(daemon|core-host|pty-host|formatter-host)\.js\b/;

/** The server package's processes in the container: the daemon and its bridge, core, the pty and formatter hosts. */
export async function containerServerProcesses(id: string, name: 'docker' | 'podman' = 'docker'): Promise<string[]> {
  const listed = await inContainer(id, 'for p in /proc/[0-9]*; do tr "\\0" " " < "$p/cmdline" 2>/dev/null; echo; done', 'root', name);
  return listed.split('\n').filter((line) => SERVER_PROCESS.test(line));
}

export interface ContainerHost {
  readonly hostId: string;
  readonly name: string;
  readonly authorityKey: string;
  readonly container: string;
  readonly containerId?: string;
}

/** The container records main holds. */
export async function containerHosts(app: ElectronApplication): Promise<ContainerHost[]> {
  return (await remoteHosts(app)).flatMap((host) => {
    const record = host as typeof host & { container?: string; containerId?: string };
    return record.container !== undefined ? [{ hostId: host.hostId, name: host.name, authorityKey: host.authorityKey, container: record.container, ...(record.containerId !== undefined ? { containerId: record.containerId } : {}) }] : [];
  });
}

/** What `ssh-add -l` saw in a container terminal: its SSH_AUTH_SOCK ('unset' for none), its exit code and its output. */
export interface AgentListing {
  readonly sock: string;
  readonly code: number;
  readonly output: string;
}

/**
 * Runs `ssh-add -l` in the active terminal's shell, so with that terminal's environment: the script lands in /tmp/<marker>.sh
 * through the engine's exec, the terminal is typed only `sh` and its path, and its report is read back once it is whole.
 */
export async function agentInTerminal(app: ElectronApplication, containerId: string, marker: string, user = 'node', name: 'docker' | 'podman' = 'docker'): Promise<AgentListing> {
  const script = `{ echo "sock=\${SSH_AUTH_SOCK-unset}"; ssh-add -l; echo "code=$?"; } > /tmp/${marker}.part 2>&1; mv /tmp/${marker}.part /tmp/${marker}.out\n`;
  await inContainer(containerId, `printf '%s' '${Buffer.from(script).toString('base64')}' | base64 -d > /tmp/${marker}.sh`, user, name);
  await runInTerminal(await shellPage(app), `sh /tmp/${marker}.sh`);
  let report = '';
  await expect.poll(async () => (report = await inContainer(containerId, `cat /tmp/${marker}.out 2>/dev/null || true`, user, name)), { timeout: 60_000 }).not.toBe('');
  const lines = report.trimEnd().split('\n');
  const sock = /^sock=(.*)$/.exec(lines[0] ?? '')?.[1];
  const code = /^code=(\d+)$/.exec(lines.at(-1) ?? '')?.[1];
  if (sock === undefined || code === undefined) throw new Error(`an unreadable ssh-add report: ${JSON.stringify(report)}`);
  return { sock, code: Number(code), output: lines.slice(1, -1).join('\n') };
}

/** The container's agent proxy sockets (agent-<hex>.sock) for the remote user, as `<mode> <owner> <path>` lines. */
export async function agentSockets(containerId: string, name: 'docker' | 'podman' = 'docker'): Promise<string[]> {
  const found = await inContainer(containerId, "find /tmp -maxdepth 2 -name 'agent-*.sock' -type s -exec stat -c '%a %U %n' {} + 2> /dev/null; true", 'root', name);
  return found.split('\n').filter(Boolean);
}

/** Ends the container's daemon with control.shutdownNow and waits until none of its processes is left in the container. */
export async function shutdownContainerDaemon(app: ElectronApplication, hostId: string, containerId: string, name: 'docker' | 'podman' = 'docker'): Promise<void> {
  await control(app, hostId, 'shutdownNow');
  await expect.poll(() => containerServerProcesses(containerId, name), { timeout: 60_000 }).toEqual([]);
}
