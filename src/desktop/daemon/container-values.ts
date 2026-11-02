// Values about a container that reach a command line or the UI: the engine's and the devcontainer CLI's output is untrusted
// input, and each value is checked here before it is an argv element, a path or shown text.

export type ContainerEngine = 'docker' | 'podman';
export const CONTAINER_ENGINES: readonly ContainerEngine[] = ['docker', 'podman'];

// a full or short container id as docker and podman print them
export const CONTAINER_ID: RegExp = /^[0-9a-f]{12,64}$/;
// a user `docker exec -u` takes: a name or uid, optionally with :group; never option-like
export const CONTAINER_USER: RegExp = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})?$/;
// docker's container name rule, with podman's longer names
export const CONTAINER_NAME: RegExp = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
export const MAX_CONTAINER_TEXT = 512;
export const MAX_CONTAINER_PATH = 4096;

export const isContainerId = (value: unknown): value is string => typeof value === 'string' && CONTAINER_ID.test(value);
export const isContainerUser = (value: unknown): value is string => typeof value === 'string' && CONTAINER_USER.test(value);
export const isContainerName = (value: unknown): value is string => typeof value === 'string' && CONTAINER_NAME.test(value);
export const isContainerEngine = (value: unknown): value is ContainerEngine => value === 'docker' || value === 'podman';

/** One line of text an engine printed, for display: no control, format or separator characters, bounded. */
export function isContainerText(value: unknown, max: number = MAX_CONTAINER_TEXT): value is string {
  return typeof value === 'string' && value.length <= max && !UNSAFE.test(value);
}

/** An absolute POSIX path inside a container, one line with no `.` or `..` segment. */
export function isContainerPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > MAX_CONTAINER_PATH || UNSAFE.test(value)) return false;
  return !value.split('/').some((part) => part === '.' || part === '..');
}
