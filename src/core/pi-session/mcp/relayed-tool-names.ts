// The tools of relayed MCP servers on a daemon's core, by pi name, each with its server's name and its own: a turn reaches one
// only through the device it is pinned to (deferred-tools.ts userScopeToolNames). One map per MCP manager.
export interface RelayedTool {
  readonly server: string;
  readonly tool: string;
}

const byManager = new Map<string, ReadonlyMap<string, RelayedTool>>();

export function setRelayedToolNames(managerId: string, names: ReadonlyMap<string, RelayedTool>): void {
  if (names.size === 0) byManager.delete(managerId);
  else byManager.set(managerId, names);
}

/** The relayed server and tool a pi tool name belongs to; undefined for every other tool. */
export function relayedToolOf(piName: string): RelayedTool | undefined {
  for (const names of byManager.values()) {
    const relayed = names.get(piName);
    if (relayed !== undefined) return relayed;
  }
  return undefined;
}

/** The relayed server a pi tool name belongs to; undefined for every other tool. */
export function relayedServerOfTool(piName: string): string | undefined {
  return relayedToolOf(piName)?.server;
}

export function relayedToolNames(): string[] {
  return [...byManager.values()].flatMap((names) => [...names.keys()]);
}

/** Every relayed server's name. */
export function relayedServerNames(): string[] {
  return [...new Set([...byManager.values()].flatMap((names) => [...names.values()].map((relayed) => relayed.server)))];
}
