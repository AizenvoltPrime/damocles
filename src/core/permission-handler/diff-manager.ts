import * as path from 'path';
import type { DiffView, EditorService } from '../../platform/editor-service';
import { TOOL_WRITE } from '../../shared/tool-names';
import { t } from '../l10n';
import { log } from '../logger';

export interface DiffInfo {
  originalContent: string;
  proposedContent: string;
  editLineNumber?: number;
}

export class DiffManager {
  private activeDiffs: Map<string, DiffView> = new Map();
  private readonly editor: EditorService;
  private readonly panelId: string | undefined;

  constructor(editor: EditorService, panelId: string | undefined) {
    this.editor = editor;
    this.panelId = panelId;
  }

  async prepareDiff(
    _diffId: string,
    toolName: string,
    filePath: string,
    input: { content?: string; old_string?: string; new_string?: string }
  ): Promise<DiffInfo | null> {
    let originalContent = '';
    try {
      originalContent = await this.editor.readText(filePath);
    } catch {
      // File doesn't exist yet
    }

    let proposedContent: string;
    let editLineNumber: number | undefined;

    if (toolName === TOOL_WRITE) {
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

      // A replacer function keeps `$&`, `$$` and the other replacement patterns literal, as Edit writes them.
      const normalizedProposed = normalizedOriginal.replace(normalizedOldString, () => normalizedNewString);
      if (normalizedProposed === normalizedOriginal) {
        return null;
      }

      const useCRLF = originalContent.includes('\r\n');
      proposedContent = useCRLF ? normalizedProposed.replace(/\n/g, '\r\n') : normalizedProposed;
    }

    return { originalContent, proposedContent, ...(editLineNumber !== undefined ? { editLineNumber } : {}) };
  }

  // diffId is the tool use id the pending permission prompt is keyed by.
  async showDiffView(diffId: string, filePath: string, originalContent: string, proposedContent: string): Promise<void> {
    const fileName = path.basename(filePath);

    const view = await this.editor.showDiff({
      title: t('{0} (Current ↔ Proposed)', fileName),
      left: { name: `${diffId}-original-${fileName}`, content: originalContent },
      right: { name: `${diffId}-proposed-${fileName}`, content: proposedContent },
      purpose: 'proposal',
      column: 1,
      preserveFocus: false,
      approvalId: diffId,
      ...(this.panelId !== undefined ? { panelId: this.panelId } : {}),
    });
    this.activeDiffs.set(diffId, view);
  }

  /** Close the view; a close the host fails is logged, since the prompt it belonged to is over either way. Never rejects. */
  async closeDiffView(diffId: string): Promise<void> {
    const view = this.activeDiffs.get(diffId);
    if (!view) {
      return;
    }
    this.activeDiffs.delete(diffId);
    try {
      await view.close();
    } catch (err) {
      log('[DiffManager] closing the diff view of %s failed: %O', diffId, err);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.activeDiffs.keys()].map((diffId) => this.closeDiffView(diffId)));
  }
}
