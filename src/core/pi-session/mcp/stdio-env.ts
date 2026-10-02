/*
 * Ported from @modelcontextprotocol/sdk 1.29.0 (MIT), dist/esm/client/stdio.js
 * `DEFAULT_INHERITED_ENV_VARS` and `getDefaultEnvironment()`. Keep the lists identical to the SDK's.
 */

/** The only host variables a stdio MCP server inherits; everything else, provider keys included, stays behind. */
export const DEFAULT_INHERITED_ENV_VARS: readonly string[] =
  process.platform === 'win32'
    ? [
        'APPDATA',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOCALAPPDATA',
        'PATH',
        'PROCESSOR_ARCHITECTURE',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'USERNAME',
        'USERPROFILE',
        'PROGRAMFILES',
      ]
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

/**
 * The environment a stdio server starts with: the allowlisted defaults overlaid with its own `env`. Windows
 * variable names are case-insensitive, so there an own `Path` replaces the default `PATH`; a spawn given
 * both keeps whichever sorts first.
 */
export function stdioEnvironment(own: Record<string, string> | undefined, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env = getDefaultEnvironment();
  if (platform === 'win32' && own) {
    const overridden = new Set(Object.keys(own).map((key) => key.toUpperCase()));
    for (const key of Object.keys(env)) if (overridden.has(key.toUpperCase())) delete env[key];
  }
  return { ...env, ...own };
}

/** The allowlisted variables that are set, skipping exported shell functions (values starting with `()`). */
export function getDefaultEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = process.env[key];
    if (value === undefined) continue;
    if (value.startsWith('()')) continue;
    env[key] = value;
  }
  return env;
}
