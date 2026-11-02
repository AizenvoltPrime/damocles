// The argv of every engine and devcontainer CLI call, built the same way on this computer and on an SSH host's daemon.
// Repository-controlled values (folders, the configuration path) and engine output (ids, users) enter only as checked argv
// elements, never through a shell.
import * as path from 'node:path';
import { POSIX_STAGE0_SCRIPT } from '../../remote/stage0-script';
import { isContainerId, isContainerPath, isContainerUser } from './container-values';

/** The devcontainer CLI's entry in a server package or a checkout; the package's own Node runs it. */
export function devcontainersCliEntry(root: string): string {
  return path.join(root, 'node_modules', '@devcontainers', 'cli', 'devcontainer.js');
}

const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const MAX_PATH = 4096;
// the read-configuration label value: a random id that matches no container
const TRUST_READ_ID = /^[0-9a-f]{32}$/;

/** A folder or file on the machine the CLI runs on: absolute (POSIX, or a Windows drive path), one line, never option-like. */
export function isCliPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH && !UNSAFE.test(value) && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value));
}

// The folder a devcontainer's volume of Damocles' own data mounts at; stage 1 links the remote user's ~/.damocles to it, so the
// install, the sessions and the settings outlive a rebuild.
export const CONTAINER_DATA_FOLDER = '/var/lib/damocles-data';
// a container key: 32 hex digits (main/remote/containers/container-key.ts)
const DATA_KEY = /^[0-9a-f]{32}$/;

/** The volume of a container key's Damocles data, named by the key, so a rebuild under the same key mounts it again. */
export function dataVolumeName(key: string): string {
  if (!DATA_KEY.test(key)) throw new RangeError('a container key is 32 hex digits');
  return `damocles-data-${key}`;
}

export interface DevcontainerTarget {
  readonly workspaceFolder: string;
  readonly configPath: string;
  // the engine's absolute path, docker's or podman's
  readonly enginePath: string;
}

function targetArgs(target: DevcontainerTarget): string[] {
  if (!isCliPath(target.workspaceFolder) || !isCliPath(target.configPath) || !isCliPath(target.enginePath)) throw new RangeError('devcontainer takes absolute paths on one line only');
  return ['--workspace-folder', target.workspaceFolder, '--config', target.configPath, '--docker-path', target.enginePath, '--log-format', 'json'];
}

/**
 * `devcontainer up` with the key's data volume mounted; removeExisting: Rebuild, which removes the container the folder and
 * configuration have.
 */
export function devcontainerUpArgs(target: DevcontainerTarget, dataKey: string, removeExisting: boolean): string[] {
  return ['up', ...targetArgs(target), '--mount', `type=volume,source=${dataVolumeName(dataKey)},target=${CONTAINER_DATA_FOLDER}`, ...(removeExisting ? ['--remove-existing-container'] : [])];
}

/**
 * `<engine> exec` as root that gives the data volume's folder and everything in it to the remote user, who otherwise cannot
 * write a new volume, or what an earlier remote user (a Rebuild that changed it) left there.
 */
export function dataOwnerArgs(containerId: string, user: string): string[] {
  if (!isContainerId(containerId) || !isContainerUser(user)) throw new RangeError('chown takes a container id and a user name');
  // -h: a link the user placed in the folder is given itself, never its target (busybox's -R alone follows links)
  return ['exec', '-u', '0', containerId, 'chown', '-hR', user, CONTAINER_DATA_FOLDER];
}

/**
 * `devcontainer read-configuration` with the merged configuration (the image's and the Features' metadata included). The id
 * label matches no container, so the merge is what the next up creates, not what an existing container was created with.
 */
export function devcontainerReadArgs(target: DevcontainerTarget, trustReadId: string): string[] {
  if (!TRUST_READ_ID.test(trustReadId)) throw new RangeError('a read-configuration id is 32 hex digits');
  return ['read-configuration', ...targetArgs(target), '--include-merged-configuration', '--id-label', `damocles.trust-read=${trustReadId}`];
}

// `<engine> ps`, one JSON object a line, and `<engine> inspect` of checked ids
export const PS_ARGS: readonly string[] = ['ps', '--no-trunc', '--format', '{{json .}}'];
export function inspectArgs(ids: readonly string[]): string[] {
  if (ids.length === 0 || !ids.every(isContainerId)) throw new RangeError('inspect takes container ids only');
  return ['inspect', '--type', 'container', ...ids];
}

/** `<engine> exec` of stage 0 as user, its stdin and stdout the transport. */
export function execStageArgs(containerId: string, user: string): string[] {
  if (!isContainerId(containerId) || !isContainerUser(user)) throw new RangeError('exec takes a container id and a user name');
  // an empty SSH_AUTH_SOCK names no agent to the bridge: the container's own one is never the client's (attach.ts)
  return ['exec', '-i', '-u', user, '-e', 'SSH_AUTH_SOCK=', containerId, '/bin/sh', '-c', POSIX_STAGE0_SCRIPT];
}

/** `<engine> cp` of a package file into a folder of the container. */
export function copyPackageArgs(source: string, containerId: string, folder: string, file: string): string[] {
  if (!isCliPath(source) || !isContainerId(containerId) || !isContainerPath(folder) || !PACKAGE_FILE.test(file)) throw new RangeError('cp takes a package file, a container id and a folder');
  return ['cp', source, `${containerId}:${folder}/${file}`];
}

// a server package's file name as the manifest names it
export const PACKAGE_FILE: RegExp = /^damocles-server-[0-9A-Za-z.+-]{1,64}-(?:linux|alpine)-(?:x64|arm64)\.tar\.gz$/;

// The folders a devcontainer configuration may be read from, in the CLI's own order.
export const DEVCONTAINER_CONFIGS: readonly (readonly string[])[] = [['.devcontainer', 'devcontainer.json'], ['.devcontainer.json']];
