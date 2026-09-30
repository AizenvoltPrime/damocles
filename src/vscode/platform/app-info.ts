import type * as vscode from 'vscode';
import type { AppInfo } from '../../platform/app-info';

export function createVsCodeAppInfo(context: vscode.ExtensionContext): AppInfo {
  return { version: String(context.extension?.packageJSON?.version ?? 'unknown') };
}
