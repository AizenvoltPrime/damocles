// Which local port a forward takes (docs/invariants.md "Ports and the remote browser"): never one this computer's sign-ins
// listen on, never a privileged one on a POSIX client, else the remote port's own number when free, else the next free one.
import { configuredOAuthCallbackPort } from '../../../../core/pi-session/mcp/oauth-callback-port';

// pi-ai's OAuth callback ports: ChatGPT and Codex (1455), radius (1456), Claude (53692)
export const PI_OAUTH_CALLBACK_PORTS: readonly number[] = [1455, 1456, 53692];
// a POSIX client binds a port below this only with privileges
export const PRIVILEGED_BELOW = 1024;
// where a privileged remote port maps on a POSIX client
export const PRIVILEGED_FALLBACK_FROM = 4000;
export const MAX_PORT = 65535;

export type PortRefusal = 'inUse' | 'reserved' | 'privileged' | 'invalid';

/** The ports no forward binds: pi-ai's sign-in callbacks and Damocles' MCP OAuth callback, as this process's environment sets it. */
export function reservedClientPorts(env: NodeJS.ProcessEnv = process.env): ReadonlySet<number> {
  return new Set([...PI_OAUTH_CALLBACK_PORTS, configuredOAuthCallbackPort(env)]);
}

export function isPrivileged(port: number, clientPlatform: NodeJS.Platform): boolean {
  return clientPlatform !== 'win32' && port < PRIVILEGED_BELOW;
}

/** Why a port the user names for a forward cannot be its local port, or undefined when the rules allow it. */
export function refusalOf(port: number, reserved: ReadonlySet<number>, clientPlatform: NodeJS.Platform): Exclude<PortRefusal, 'inUse'> | undefined {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) return 'invalid';
  if (reserved.has(port)) return 'reserved';
  if (isPrivileged(port, clientPlatform)) return 'privileged';
  return undefined;
}

/**
 * The local ports to try for a remote port, in order: its own number, unless reserved or privileged, then every number after
 * it (from PRIVILEGED_FALLBACK_FROM for a privileged one on a POSIX client) that the rules allow.
 */
export function* candidatePorts(remotePort: number, reserved: ReadonlySet<number>, clientPlatform: NodeJS.Platform): Generator<number> {
  const start = isPrivileged(remotePort, clientPlatform) ? PRIVILEGED_FALLBACK_FROM : remotePort;
  for (let port = start; port <= MAX_PORT; port++) if (refusalOf(port, reserved, clientPlatform) === undefined) yield port;
}
