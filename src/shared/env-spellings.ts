// Environment variable names compare without case on Windows, so a block can hold one variable under several spellings, and
// which one a child reads is up to its runtime.

/** The keys of env that name `name`: every case of it on Windows, else the exact name when present. */
export function envSpellings(env: Readonly<Record<string, unknown>>, name: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return Object.hasOwn(env, name) ? [name] : [];
  const upper = name.toUpperCase();
  return Object.keys(env).filter((key) => key.toUpperCase() === upper);
}

/** base with each variable of overrides set, every other spelling of its name dropped first on Windows. */
export function withEnvOverrides<T>(base: Readonly<Record<string, T>>, overrides: Readonly<Record<string, T>>, platform: NodeJS.Platform): Record<string, T> {
  const env: Record<string, T> = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    for (const key of envSpellings(env, name, platform)) delete env[key];
    env[name] = value;
  }
  return env;
}
