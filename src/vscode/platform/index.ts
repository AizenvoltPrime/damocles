import type * as vscode from 'vscode';
import type { Platform } from '../../platform/platform';
import { VSCODE_HOST_CAPABILITIES } from '../../shared/types/messages';
import { createVsCodeAppInfo } from './app-info';
import { createVsCodeAppPaths } from './app-paths';
import { createVsCodeClipboardService } from './clipboard-service';
import { createVsCodeDialogService } from './dialog-service';
import { createVsCodeEditorService } from './editor-service';
import { createVsCodeFileWatcherFactory } from './file-watcher';
import { createVsCodeHostLifecycle } from './host-lifecycle';
import { createVsCodeKeyValueState } from './key-value-state';
import { createVsCodeLocalizationService } from './localization-service';
import { createVsCodeLogSinkFactory } from './log-sink-factory';
import { createVsCodeNotificationService } from './notification-service';
import { createVsCodeSecretsStore } from './secrets-store';
import { VsCodeSettingsStore } from './settings-store';
import { createVsCodeShellService } from './shell-service';
import { createVsCodeTrustService } from './trust-service';
import { createVsCodeWindowService } from './window-service';
import { createVsCodeWorkspaceFolders } from './workspace-folders';

// Every service subscribes per caller and returns that Disposable; only the editor's window-wide diff providers go to context.subscriptions.
export function createVsCodePlatform(context: vscode.ExtensionContext): Platform {
  return {
    capabilities: VSCODE_HOST_CAPABILITIES,
    settings: new VsCodeSettingsStore(),
    secrets: createVsCodeSecretsStore(context.secrets),
    state: createVsCodeKeyValueState(context),
    trust: createVsCodeTrustService(),
    workspaceFolders: createVsCodeWorkspaceFolders(),
    fileWatchers: createVsCodeFileWatcherFactory(),
    notifications: createVsCodeNotificationService(),
    paths: createVsCodeAppPaths(context.extensionUri.fsPath),
    appInfo: createVsCodeAppInfo(context),
    localization: createVsCodeLocalizationService(),
    clipboard: createVsCodeClipboardService(),
    shell: createVsCodeShellService(),
    dialogs: createVsCodeDialogService(),
    editor: createVsCodeEditorService(context.subscriptions),
    window: createVsCodeWindowService(),
    lifecycle: createVsCodeHostLifecycle(),
    logSinks: createVsCodeLogSinkFactory(),
  };
}
