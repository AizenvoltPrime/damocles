import * as vscode from 'vscode';
import type { NotificationOptions, NotificationService } from '../../platform/notification-service';

type Show = (message: string, options: vscode.MessageOptions, ...items: string[]) => Thenable<string | undefined>;

// A leading object argument is NotificationOptions and goes through as vscode's MessageOptions, so modal stays modal.
function show(fn: Show, message: string, rest: ReadonlyArray<NotificationOptions | string>): Thenable<string | undefined> {
  const [first, ...others] = rest;
  if (typeof first === 'object') return fn(message, { ...(first.modal !== undefined ? { modal: first.modal } : {}) }, ...(others as string[]));
  return (fn as unknown as (message: string, ...items: string[]) => Thenable<string | undefined>)(message, ...(rest as string[]));
}

export function createVsCodeNotificationService(): NotificationService {
  return {
    info: async (message: string, ...rest: Array<NotificationOptions | string>) => show(vscode.window.showInformationMessage, message, rest),
    warn: async (message: string, ...rest: Array<NotificationOptions | string>) => show(vscode.window.showWarningMessage, message, rest),
    error: async (message: string, ...rest: Array<NotificationOptions | string>) => show(vscode.window.showErrorMessage, message, rest),
  };
}
