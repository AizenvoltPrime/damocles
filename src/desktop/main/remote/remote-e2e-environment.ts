// The e2e hooks that make this app speak to a target as another app version or device, honored only in a development build
// run with DAMOCLES_E2E_HOOKS=1; a packaged build reads none of them.
import { appVersionOf, parseServerRequirement, type ServerManifest, type ServerPackage, type ServerRequirement, type ServerTarget } from './server-manifest-format';

export interface RemoteE2eEnvironment {
  // DAMOCLES_E2E_APP_VERSION: the server version packages install as on targets, plain or with its +<build>, whose app version
  // the hello sends as its appVersion; a daemon runs as it only from a package of that version the test placed itself
  readonly appVersion?: string;
  // DAMOCLES_E2E_PROTOCOL_VERSION: the hello's protocolVersion
  readonly protocolVersion?: number;
  // DAMOCLES_E2E_DEVICE_NAME: the hello's deviceName, so two instances on one machine are two devices
  readonly deviceName?: string;
  // DAMOCLES_E2E_SERVER_REQUIREMENT: the manifest's requirement, as JSON, e.g. {"minimumServerVersion":"3.7.0","graceHours":0.01}
  readonly requirement?: ServerRequirement;
  // DAMOCLES_E2E_SWITCH_DRAIN_MS: how long other computers delay a switch, in place of the 15 minutes
  readonly drainMs?: number;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9a-f]{12})?$/;
const DEVICE_NAME = /^[\p{L}\p{N} ._-]{1,64}$/u;

export function remoteE2eEnvironment(options: { readonly packaged: boolean; readonly env: Readonly<Record<string, string | undefined>> }): RemoteE2eEnvironment {
  if (options.packaged || options.env['DAMOCLES_E2E_HOOKS'] !== '1') return {};
  const appVersion = options.env['DAMOCLES_E2E_APP_VERSION'];
  const protocol = options.env['DAMOCLES_E2E_PROTOCOL_VERSION'];
  const deviceName = options.env['DAMOCLES_E2E_DEVICE_NAME'];
  if (appVersion !== undefined && !VERSION.test(appVersion)) throw new Error('DAMOCLES_E2E_APP_VERSION must be a version such as 3.6.9 or 3.6.9+0123456789ab');
  const protocolVersion = protocol === undefined ? undefined : Number(protocol);
  if (protocolVersion !== undefined && (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1)) throw new Error('DAMOCLES_E2E_PROTOCOL_VERSION must be a positive integer');
  if (deviceName !== undefined && !DEVICE_NAME.test(deviceName)) throw new Error('DAMOCLES_E2E_DEVICE_NAME must be 1 to 64 letters, digits, spaces, dots, underscores or hyphens');
  const requirement = requirementOf(options.env['DAMOCLES_E2E_SERVER_REQUIREMENT']);
  const drain = options.env['DAMOCLES_E2E_SWITCH_DRAIN_MS'];
  const drainMs = drain === undefined ? undefined : Number(drain);
  if (drainMs !== undefined && (!Number.isSafeInteger(drainMs) || drainMs < 1)) throw new Error('DAMOCLES_E2E_SWITCH_DRAIN_MS must be a positive integer');
  return {
    ...(appVersion !== undefined ? { appVersion } : {}),
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(deviceName !== undefined ? { deviceName } : {}),
    ...(requirement !== undefined ? { requirement } : {}),
    ...(drainMs !== undefined ? { drainMs } : {}),
  };
}

// the manifest's own parser, with the minimum's bound against the version left to e2eManifest
function requirementOf(text: string | undefined): ServerRequirement | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const minimum = (value as { minimumServerVersion?: unknown } | null)?.minimumServerVersion;
  const requirement = typeof minimum === 'string' ? parseServerRequirement(value, minimum) : undefined;
  if (requirement === undefined) throw new Error('DAMOCLES_E2E_SERVER_REQUIREMENT must be JSON such as {"minimumServerVersion":"3.7.0","graceHours":0.01}');
  return requirement;
}

/**
 * `manifest` as an app of the e2e version `serverVersion` reads it: every package installs as, and is adopted as, that server
 * version; a daemon still runs as its own server-package.json's. `requirement` replaces the manifest's, and must not name a
 * minimum above that app version.
 */
export function e2eManifest(manifest: ServerManifest, serverVersion: string | undefined, requirement?: ServerRequirement): ServerManifest {
  const packages: Partial<Record<ServerTarget, ServerPackage>> = {};
  for (const [target, pkg] of Object.entries(manifest.packages) as Array<[ServerTarget, ServerPackage]>) packages[target] = serverVersion === undefined ? pkg : { ...pkg, serverVersion };
  const version = serverVersion === undefined ? manifest.version : appVersionOf(serverVersion);
  if (requirement !== undefined && parseServerRequirement(requirement, version) === undefined) throw new Error(`DAMOCLES_E2E_SERVER_REQUIREMENT names the minimum ${requirement.minimumServerVersion}, above this app's ${version}`);
  return { ...manifest, version, packages, ...(requirement !== undefined ? { requirement } : {}) };
}
