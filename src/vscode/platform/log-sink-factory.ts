import * as vscode from 'vscode';
import type { LogSinkFactory } from '../../platform/log-sink';

export function createVsCodeLogSinkFactory(): LogSinkFactory {
  return {
    create: (name) => vscode.window.createOutputChannel(name),
  };
}
