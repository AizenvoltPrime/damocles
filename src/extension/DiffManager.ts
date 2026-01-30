import * as vscode from 'vscode';
import * as path from 'path';

export interface DiffInfo {
  originalContent: string;
  proposedContent: string;
  editLineNumber?: number;
}

interface ActiveDiff {
  originalUri: vscode.Uri;
  proposedUri: vscode.Uri;
}

const DIFF_SCHEME = 'claude-diff';

class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private contents: Map<string, string> = new Map();

  setContent(key: string, content: string): void {
    this.contents.set(key, content);
  }

  deleteContent(key: string): void {
    this.contents.delete(key);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) || '';
  }

  dispose(): void {
    this.contents.clear();
  }
}

export class DiffManager {
  private activeDiffs: Map<string, ActiveDiff> = new Map();
  private contentProvider: DiffContentProvider;
  private registration: vscode.Disposable;

  constructor() {
    this.contentProvider = new DiffContentProvider();
    this.registration = vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      this.contentProvider
    );
  }

  async prepareDiff(
    _diffId: string,
    toolName: string,
    filePath: string,
    input: { content?: string; old_string?: string; new_string?: string }
  ): Promise<DiffInfo | null> {
    const fileUri = vscode.Uri.file(filePath);

    let originalContent = '';
    try {
      const document = await vscode.workspace.openTextDocument(fileUri);
      originalContent = document.getText();
    } catch {
      // File doesn't exist yet
    }

    let proposedContent: string;
    let editLineNumber: number | undefined;

    if (toolName === 'Write') {
      proposedContent = input.content || '';
      editLineNumber = 1;
    } else {
      if (!originalContent) {
        return null;
      }

      const normalizeToLF = (str: string): string => str.replace(/\r\n/g, '\n');

      const normalizedOriginal = normalizeToLF(originalContent);
      const normalizedOldString = normalizeToLF(input.old_string || '');
      const normalizedNewString = normalizeToLF(input.new_string || '');

      const matchIndex = normalizedOriginal.indexOf(normalizedOldString);
      if (matchIndex !== -1) {
        const textBeforeMatch = normalizedOriginal.substring(0, matchIndex);
        editLineNumber = textBeforeMatch.split('\n').length;
      }

      const normalizedProposed = normalizedOriginal.replace(normalizedOldString, normalizedNewString);
      if (normalizedProposed === normalizedOriginal) {
        return null;
      }

      const useCRLF = originalContent.includes('\r\n');
      proposedContent = useCRLF ? normalizedProposed.replace(/\n/g, '\r\n') : normalizedProposed;
    }

    return { originalContent, proposedContent, editLineNumber };
  }

  async showDiffView(diffId: string, filePath: string, originalContent: string, proposedContent: string): Promise<void> {
    const fileName = path.basename(filePath);

    const originalKey = `/${diffId}-original-${fileName}`;
    const proposedKey = `/${diffId}-proposed-${fileName}`;

    this.contentProvider.setContent(originalKey, originalContent);
    this.contentProvider.setContent(proposedKey, proposedContent);

    const originalUri = vscode.Uri.parse(`${DIFF_SCHEME}:${originalKey}`);
    const proposedUri = vscode.Uri.parse(`${DIFF_SCHEME}:${proposedKey}`);

    this.activeDiffs.set(diffId, { originalUri, proposedUri });

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      `${fileName} (Current ↔ Proposed)`,
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false }
    );
  }

  async closeDiffView(diffId: string): Promise<void> {
    const activeDiff = this.activeDiffs.get(diffId);
    if (!activeDiff) {
      return;
    }

    const proposedUri = activeDiff.proposedUri;

    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          const diffInput = tab.input as vscode.TabInputTextDiff;
          if (diffInput.modified.toString() === proposedUri.toString()) {
            await vscode.window.tabGroups.close(tab);
            break;
          }
        }
      }
    }

    this.contentProvider.deleteContent(activeDiff.originalUri.path);
    this.contentProvider.deleteContent(activeDiff.proposedUri.path);
    this.activeDiffs.delete(diffId);
  }

  async dispose(): Promise<void> {
    for (const diffId of this.activeDiffs.keys()) {
      await this.closeDiffView(diffId);
    }
    this.contentProvider.dispose();
    this.registration.dispose();
  }
}
