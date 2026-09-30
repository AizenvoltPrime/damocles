import * as vscode from 'vscode';
import type { HostLifecycle } from '../../platform/host-lifecycle';

export function createVsCodeHostLifecycle(): HostLifecycle {
  return {
    reload: async () => {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
  };
}
