import * as vscode from 'vscode';
import type { Disposable } from '../../platform/disposable';
import type { OpenFolder, WorkspaceFolders } from '../../platform/workspace-folders';

export function openFileFolders(): readonly OpenFolder[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => ({ fsPath: folder.uri.fsPath, name: folder.name }));
}

export function createVsCodeWorkspaceFolders(): WorkspaceFolders {
  return {
    folders: openFileFolders,
    onDidChange: (cb): Disposable => vscode.workspace.onDidChangeWorkspaceFolders(() => cb()),
  };
}
