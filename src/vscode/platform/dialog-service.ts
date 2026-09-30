import * as vscode from 'vscode';
import type { DialogService } from '../../platform/dialog-service';

// A CancellationTokenSource cancelled when the signal aborts; call release once the prompt settles.
function cancellationFor(signal: AbortSignal | undefined): { token: vscode.CancellationToken; release: () => void } {
  const cts = new vscode.CancellationTokenSource();
  const onAbort = (): void => cts.cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) cts.cancel();
  return {
    token: cts.token,
    release: () => {
      signal?.removeEventListener('abort', onAbort);
      cts.dispose();
    },
  };
}

export function createVsCodeDialogService(): DialogService {
  return {
    pickFolder: async (opts) => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.defaultPath !== undefined ? { defaultUri: vscode.Uri.file(opts.defaultPath) } : {}),
      });
      return picked?.[0]?.fsPath;
    },
    pickFile: async (opts) => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        ...(opts.filters ? { filters: Object.fromEntries(Object.entries(opts.filters).map(([label, exts]) => [label, [...exts]])) } : {}),
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.defaultPath !== undefined ? { defaultUri: vscode.Uri.file(opts.defaultPath) } : {}),
      });
      return picked?.[0]?.fsPath;
    },
    inputBox: async (opts, signal) => {
      const cancellation = cancellationFor(signal);
      try {
        return await vscode.window.showInputBox(
          {
            ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
            ...(opts.password !== undefined ? { password: opts.password } : {}),
            ...(opts.placeholder !== undefined ? { placeHolder: opts.placeholder } : {}),
            ...(opts.ignoreFocusOut !== undefined ? { ignoreFocusOut: opts.ignoreFocusOut } : {}),
          },
          cancellation.token,
        );
      } finally {
        cancellation.release();
      }
    },
    quickPick: async (items, opts, signal) => {
      const cancellation = cancellationFor(signal);
      try {
        const picked = await vscode.window.showQuickPick(
          items.map((item) => ({
            label: item.label,
            id: item.id,
            ...(item.description !== undefined ? { description: item.description } : {}),
            ...(item.detail !== undefined ? { detail: item.detail } : {}),
          })),
          {
            ...(opts.title !== undefined ? { title: opts.title } : {}),
            ...(opts.placeholder !== undefined ? { placeHolder: opts.placeholder } : {}),
          },
          cancellation.token,
        );
        return picked?.id;
      } finally {
        cancellation.release();
      }
    },
  };
}
