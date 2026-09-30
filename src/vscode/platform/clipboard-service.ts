import * as vscode from 'vscode';
import type { ClipboardService } from '../../platform/clipboard-service';

export function createVsCodeClipboardService(): ClipboardService {
  return {
    writeText: async (text) => vscode.env.clipboard.writeText(text),
  };
}
