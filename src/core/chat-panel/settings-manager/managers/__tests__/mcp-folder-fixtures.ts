import * as path from "path";
import { folderKey } from "../../../../workspace-folders/folder-key";
import type { FolderTarget } from "../../../../workspace-folders/folder-registry";
import type { McpServerConfig } from "../../../../../shared/types/mcp";
import type { McpServerSpec } from "../../../../pi-session/mcp/types";
import type { McpManager } from "../mcp-manager";

export function folderTarget(fsPath: string, projectScope = true): FolderTarget {
  const name = path.basename(fsPath);
  return { key: folderKey(fsPath), fsPath, name, label: name, projectScope };
}

// The host fills in a stdio server's working directory; `mcp-manager-pi-sources.test.ts` pins it.
const withoutResolvedCwd = (config: McpServerConfig): McpServerConfig => {
  if (!("command" in config)) return config;
  const { cwd: _cwd, ...rest } = config;
  return rest;
};

const configsOf = (specs: Record<string, McpServerSpec>): Record<string, McpServerConfig> =>
  Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, withoutResolvedCwd(spec.config)]));

/** A folder's MCP scope with each spec reduced to its config without its resolved cwd, for tests about which definition wins. */
export function enabledConfigs(manager: McpManager, key: string) {
  const scope = manager.getEnabledServers(key);
  return { userUnion: configsOf(scope.userUnion), userVisible: scope.userVisible, folder: configsOf(scope.folder) };
}

/** What a panel in `key` connects: the user servers visible there plus that folder's own servers. */
export function connectedIn(manager: McpManager, key: string): Record<string, McpServerConfig> {
  const scope = enabledConfigs(manager, key);
  const visible = scope.userVisible.map(name => [name, scope.userUnion[name]!] as const);
  return { ...Object.fromEntries(visible), ...scope.folder };
}
