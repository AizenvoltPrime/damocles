import type * as vscode from 'vscode';
import type { KeyValueState, Memento } from '../../platform/key-value-state';

class VsCodeMemento implements Memento {
  private readonly memento: vscode.Memento;

  constructor(memento: vscode.Memento) {
    this.memento = memento;
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return defaultValue === undefined ? this.memento.get<T>(key) : this.memento.get<T>(key, defaultValue);
  }

  async update(key: string, value: unknown): Promise<void> {
    await this.memento.update(key, value);
  }
}

export function createVsCodeKeyValueState(context: vscode.ExtensionContext): KeyValueState {
  return { global: new VsCodeMemento(context.globalState), workspace: new VsCodeMemento(context.workspaceState) };
}
