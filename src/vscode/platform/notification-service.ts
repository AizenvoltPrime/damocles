import * as vscode from 'vscode';
import type { NotificationOptions, NotificationService } from '../../platform/notification-service';
import type { LocalizedText } from '../../shared/localized-text';
import { renderVsCode } from './localization-service';

type Show = (message: string, options: vscode.MessageOptions, ...items: vscode.MessageItem[]) => Thenable<vscode.MessageItem | undefined>;

// Items rather than strings, so the answer is the chosen action's index however its label renders.
async function show(fn: Show, message: LocalizedText, actions: readonly LocalizedText[] = [], options?: NotificationOptions): Promise<number | undefined> {
  const items = actions.map((action) => ({ title: renderVsCode(action) }));
  const chosen = await fn(renderVsCode(message), { ...(options?.modal !== undefined ? { modal: options.modal } : {}) }, ...items);
  return chosen === undefined ? undefined : items.indexOf(chosen);
}

export function createVsCodeNotificationService(): NotificationService {
  return {
    info: (message, actions, options) => show(vscode.window.showInformationMessage, message, actions, options),
    warn: (message, actions, options) => show(vscode.window.showWarningMessage, message, actions, options),
    error: (message, actions, options) => show(vscode.window.showErrorMessage, message, actions, options),
  };
}
