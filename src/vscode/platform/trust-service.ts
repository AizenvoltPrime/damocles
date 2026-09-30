import * as vscode from 'vscode';
import type { Disposable } from '../../platform/disposable';
import type { TrustService } from '../../platform/trust-service';
import { homeDirectory } from '../../core/workspace-folders/folder-registry';
import { openFileFolders } from './workspace-folders';

// Every folder a runtime can exist for: the open file folders, or the registry's home target when none is open.
function grantedFolderPaths(): readonly string[] {
  const folders = openFileFolders();
  return folders.length > 0 ? folders.map((folder) => folder.fsPath) : [homeDirectory()];
}

// VS Code trust is window wide, so every method ignores the folder path.
export function createVsCodeTrustService(): TrustService {
  return {
    isTrusted: () => vscode.workspace.isTrusted,
    onDidGrantTrust: (cb): Disposable => vscode.workspace.onDidGrantWorkspaceTrust(() => cb(grantedFolderPaths())),
    requestTrust: async () => {
      await vscode.commands.executeCommand('workbench.trust.manage');
      return vscode.workspace.isTrusted;
    },
  };
}
