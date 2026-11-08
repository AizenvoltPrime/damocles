import { registryEnvironment } from '../../workspace/terminal/terminal-env';
import { MACHINE_ENVIRONMENT_KEY, readStringValues, USER_ENVIRONMENT_KEY } from '../cli-path-win32';

/**
 * The registry's current machine and user variables over env, as Windows Terminal builds each new tab's environment; throws
 * when the registry cannot be read.
 */
export function registryTerminalEnvironment(env: NodeJS.ProcessEnv, read: typeof readStringValues = readStringValues): NodeJS.ProcessEnv {
  return registryEnvironment(env, read('HKLM', MACHINE_ENVIRONMENT_KEY), read('HKCU', USER_ENVIRONMENT_KEY));
}

/**
 * A new Windows terminal's starting environment: registryTerminalEnvironment, so a Path changed since Damocles started (the
 * damocles command's own entry included) reaches it. A registry that cannot be read leaves env as it is.
 */
export function windowsTerminalEnvironment(env: NodeJS.ProcessEnv, log: (line: string) => void, read: typeof readStringValues = readStringValues): NodeJS.ProcessEnv {
  try {
    return registryTerminalEnvironment(env, read);
  } catch (err) {
    log(`[terminal] the registry's environment could not be read, so the terminal starts with Damocles' own: ${err instanceof Error ? err.message : String(err)}`);
    return env;
  }
}
