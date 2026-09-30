import * as path from "path";
import { folderKey } from "../../../../workspace-folders/folder-key";
import type { FolderTarget } from "../../../../workspace-folders/folder-registry";
import type { McpServerConfig } from "../../../../../shared/types/mcp";
import type { McpManager } from "../mcp-manager";

export function folderTarget(fsPath: string, projectScope = true): FolderTarget {
  const name = path.basename(fsPath);
  return { key: folderKey(fsPath), fsPath, name, label: name, projectScope };
}

/** What a panel in `key` connects: the user servers visible there plus that folder's own servers. */
export function connectedIn(manager: McpManager, key: string): Record<string, McpServerConfig> {
  const scope = manager.getEnabledServers(key);
  const visible = scope.userVisible.map(name => [name, scope.userUnion[name]!] as const);
  return { ...Object.fromEntries(visible), ...scope.folder };
}
