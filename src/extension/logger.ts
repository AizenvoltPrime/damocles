import * as vscode from 'vscode';
import { format } from 'node:util';

let outputChannel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Damocles');
  }
  return outputChannel;
}

export function log(...args: unknown[]): void {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Damocles');
  }
  outputChannel.appendLine(`[${new Date().toISOString()}] ${format(...args)}`);
}

export function showLog(preserveFocus?: boolean): void {
  outputChannel?.show(preserveFocus);
}
