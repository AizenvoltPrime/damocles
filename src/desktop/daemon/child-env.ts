// Every environment the daemon hands out: the login environment it merged at start,
// without Electron's variables.

export type ChildKind = 'node' | 'user';

/**
 * node: a forked Node child (the pty host, a formatter host, Damocles Core), with ELECTRON_RUN_AS_NODE=1 only
 * when the daemon itself runs under Electron, so the same binary runs the child as Node. user: a terminal, agent shell, hook,
 * MCP server or git, which never sees an ELECTRON_* variable.
 */
export function daemonChildEnv(kind: ChildKind, env: NodeJS.ProcessEnv = process.env, electron: boolean = process.versions['electron'] !== undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && !/^ELECTRON_/i.test(key)) result[key] = value;
  if (kind === 'node' && electron) result['ELECTRON_RUN_AS_NODE'] = '1';
  return result;
}
