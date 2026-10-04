import * as vscode from 'vscode';
import type { Disposable } from '../../platform/disposable';
import type { SettingInspection, SettingsChange, SettingsFolder, SettingsScope, SettingsStore } from '../../platform/settings-store';

function configurationTarget(scope: SettingsScope): vscode.ConfigurationTarget {
  switch (scope) {
    case 'user': return vscode.ConfigurationTarget.Global;
    case 'project': return vscode.ConfigurationTarget.Workspace;
    case 'local': return vscode.ConfigurationTarget.WorkspaceFolder;
  }
}

// VS Code has no personal per-folder file, so a worktree's personalPath has nothing to name; the folder is the resource.
function configuration(folder: SettingsFolder | undefined): vscode.WorkspaceConfiguration {
  return folder === undefined ? vscode.workspace.getConfiguration() : vscode.workspace.getConfiguration(undefined, vscode.Uri.file(folder.path));
}

// A property VS Code reports as undefined is omitted, so absent stays distinct from a present undefined.
// VS Code reports workspaceFolderValue, and writes WorkspaceFolder, only for a configuration scoped to a resource.
function toInspection<T>(raw: { defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined): SettingInspection<T> {
  if (!raw) return {};
  return {
    ...(raw.defaultValue !== undefined ? { defaultValue: raw.defaultValue } : {}),
    ...(raw.globalValue !== undefined ? { userValue: raw.globalValue } : {}),
    ...(raw.workspaceValue !== undefined ? { projectValue: raw.workspaceValue } : {}),
    ...(raw.workspaceFolderValue !== undefined ? { localValue: raw.workspaceFolderValue } : {}),
  };
}

export class VsCodeSettingsStore implements SettingsStore {
  get<T>(key: string, defaultValue?: undefined, folder?: SettingsFolder): T | undefined;
  get<T>(key: string, defaultValue: T, folder?: SettingsFolder): T;
  get<T>(key: string, defaultValue?: T, folder?: SettingsFolder): T | undefined {
    const config = configuration(folder);
    return defaultValue === undefined ? config.get<T>(key) : config.get<T>(key, defaultValue);
  }

  inspect<T>(key: string, folder?: SettingsFolder): SettingInspection<T> {
    return toInspection(configuration(folder).inspect<T>(key));
  }

  async update(key: string, value: unknown, scope: SettingsScope, folder?: SettingsFolder): Promise<void> {
    await configuration(folder).update(key, value, configurationTarget(scope));
  }

  onDidChange(section: string, cb: (change: SettingsChange) => void): Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(section)) cb({ affects: (key) => e.affectsConfiguration(key) });
    });
  }

  // VS Code's settings editor owns its files; the settings panel shows no per-value source there.
  scopeFile(): undefined {
    return undefined;
  }
}
