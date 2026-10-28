// The e2e hooks that make this app speak to a target as another app version or device, honored only in a development build
// run with DAMOCLES_E2E_HOOKS=1; a packaged build reads none of them.
export interface RemoteE2eEnvironment {
  // DAMOCLES_E2E_APP_VERSION: the version installed and run on targets and sent as the hello's appVersion
  readonly appVersion?: string;
  // DAMOCLES_E2E_PROTOCOL_VERSION: the hello's protocolVersion
  readonly protocolVersion?: number;
  // DAMOCLES_E2E_DEVICE_NAME: the hello's deviceName, so two instances on one machine are two devices
  readonly deviceName?: string;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEVICE_NAME = /^[\p{L}\p{N} ._-]{1,64}$/u;

export function remoteE2eEnvironment(options: { readonly packaged: boolean; readonly env: Readonly<Record<string, string | undefined>> }): RemoteE2eEnvironment {
  if (options.packaged || options.env['DAMOCLES_E2E_HOOKS'] !== '1') return {};
  const appVersion = options.env['DAMOCLES_E2E_APP_VERSION'];
  const protocol = options.env['DAMOCLES_E2E_PROTOCOL_VERSION'];
  const deviceName = options.env['DAMOCLES_E2E_DEVICE_NAME'];
  if (appVersion !== undefined && !VERSION.test(appVersion)) throw new Error('DAMOCLES_E2E_APP_VERSION must be a version such as 3.6.9');
  const protocolVersion = protocol === undefined ? undefined : Number(protocol);
  if (protocolVersion !== undefined && (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1)) throw new Error('DAMOCLES_E2E_PROTOCOL_VERSION must be a positive integer');
  if (deviceName !== undefined && !DEVICE_NAME.test(deviceName)) throw new Error('DAMOCLES_E2E_DEVICE_NAME must be 1 to 64 letters, digits, spaces, dots, underscores or hyphens');
  return {
    ...(appVersion !== undefined ? { appVersion } : {}),
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(deviceName !== undefined ? { deviceName } : {}),
  };
}
