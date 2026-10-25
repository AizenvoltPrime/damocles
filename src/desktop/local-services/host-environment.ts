/** The login environment main merged at startup, without Electron's own variables, which a host process must not inherit. */
export function hostEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && !/^ELECTRON_/i.test(key)) result[key] = value;
  return result;
}
