import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import type { ShellService } from '../../platform/shell-service';
import { webUrlHref } from '../../core/web-url';

export function createVsCodeShellService(): ShellService {
  return {
    openExternal: async (url) => {
      const href = webUrlHref(url);
      return href !== undefined && vscode.env.openExternal(vscode.Uri.parse(href));
    },
    openFolder: async (absolutePath) => {
      const isFolder = await fs.stat(absolutePath).then((stat) => stat.isDirectory(), () => false);
      return isFolder && vscode.env.openExternal(vscode.Uri.file(absolutePath));
    },
    revealPath: async (absolutePath) => {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(absolutePath));
    },
  };
}
