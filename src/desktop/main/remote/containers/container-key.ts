// A container's authority key (container+<key>): derived from where the CLI runs and the configuration it reads, never from
// the container, so trust, layout and the session mirror, all keyed by the project key, survive a rebuild.
import { createHash } from 'node:crypto';

// Hex digits of the SHA-256 a key keeps: 128 bits, short enough for the per-authority folders built from it.
const KEY_HEX_DIGITS = 32;
export const CONTAINER_KEY: RegExp = /^[0-9a-f]{32}$/;

const keyOf = (parts: readonly string[]): string => createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, KEY_HEX_DIGITS);

/** A devcontainer's key: the SSH host the CLI runs on (or this computer), the workspace folder and the configuration file. */
export function devcontainerKey(via: string | undefined, workspaceFolder: string, configPath: string): string {
  return keyOf(['devcontainer', via ?? 'local', workspaceFolder, configPath]);
}

/** An attached container's key: the SSH host it runs on (or this computer) and its name, which a re-created container keeps. */
export function attachKey(via: string | undefined, containerName: string): string {
  return keyOf(['attach', via ?? 'local', containerName]);
}

export const containerAuthorityKey = (key: string): string => `container+${key}`;
