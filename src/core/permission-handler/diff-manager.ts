import { stat } from 'fs/promises';
import * as path from 'path';
import type { DiffView, EditorService } from '../../platform/editor-service';
import { TOOL_WRITE } from '../../shared/tool-names';
import type { FilePatch, FilePatchOmitted } from '../../shared/types/file-patch';
import { FILE_PATCH_MAX_BYTES, filePatch } from '../pi-session/tools/file-patch';
import { exactEdit, previewEdit } from '../pi-session/tools/edit-tool';
import type { PiCodingAgentModule } from '../pi-session/pi-loader';
import { l } from '../l10n';
import { log } from '../logger';

export interface DiffInfo {
  /** Empty for a new file; absent when the file exists but cannot be read as text, so no diff of it can be shown. */
  originalContent?: string;
  proposedContent: string;
  editLineNumber?: number;
  /** The change's real-numbered patch, as its result will record it, or why there is none; absent for a new file. */
  patch?: FilePatch;
}

/**
 * The file's text as the editor holds it, undefined when it does not exist, or why it cannot be diffed.
 * Neither host's `readText` rejection says which (VS Code's carries only a message), so the path is stat'ed.
 */
async function readOriginal(editor: EditorService, filePath: string): Promise<string | { patchOmitted: FilePatchOmitted } | undefined> {
  try {
    return await editor.readText(filePath);
  } catch {
    try {
      return { patchOmitted: (await stat(filePath)).size > FILE_PATCH_MAX_BYTES ? 'tooLarge' : 'binary' };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : { patchOmitted: 'binary' };
    }
  }
}

export class DiffManager {
  private activeDiffs: Map<string, DiffView> = new Map();
  private readonly editor: EditorService;
  private readonly panelId: string | undefined;
  private readonly pi: () => PiCodingAgentModule | null;

  constructor(editor: EditorService, panelId: string | undefined, pi: () => PiCodingAgentModule | null) {
    this.editor = editor;
    this.panelId = panelId;
    this.pi = pi;
  }

  async prepareDiff(
    _diffId: string,
    toolName: string,
    filePath: string,
    input: { content?: string; old_string?: string; new_string?: string; replace_all?: boolean }
  ): Promise<DiffInfo | { refused: string } | null> {
    const original = await readOriginal(this.editor, filePath);
    const originalContent = typeof original === 'string' ? original : '';

    let proposedContent: string;
    let editLineNumber: number | undefined;

    if (toolName === TOOL_WRITE) {
      proposedContent = input.content || '';
      editLineNumber = 1;
    } else if (input.replace_all === true) {
      if (!originalContent) {
        return null;
      }

      const edit = exactEdit(originalContent, input.old_string ?? '', input.new_string ?? '');
      if (!edit || edit.newContent === edit.baseContent) {
        return null;
      }
      editLineNumber = edit.baseContent.slice(0, edit.replacements[0]!.matchIndex).split('\n').length;
      proposedContent = edit.written;
    } else {
      if (typeof original !== 'string') {
        return null;
      }
      const pi = this.pi();
      if (!pi) throw new Error('An Edit approval needs pi\'s edit, which is not loaded');
      // The edit pi runs, on the text this diff shows as the original.
      const edit = await previewEdit(pi, filePath, original, input.old_string ?? '', input.new_string ?? '');
      if ('refused' in edit) return edit;
      editLineNumber = edit.firstChangedLine;
      proposedContent = edit.written;
    }

    const lineNumber = editLineNumber !== undefined ? { editLineNumber } : {};
    if (original === undefined) return { originalContent, proposedContent, ...lineNumber };
    if (typeof original !== 'string') return { proposedContent, ...lineNumber, patch: original };
    return { originalContent, proposedContent, ...lineNumber, patch: filePatch(filePath, originalContent, proposedContent) };
  }

  // diffId is the tool use id the pending permission prompt is keyed by.
  async showDiffView(diffId: string, filePath: string, originalContent: string, proposedContent: string): Promise<void> {
    const fileName = path.basename(filePath);

    const view = await this.editor.showDiff({
      title: (name) => l('{0} (Current ↔ Proposed)', name),
      filePath,
      left: { name: `${diffId}-original-${fileName}`, content: originalContent },
      right: { name: `${diffId}-proposed-${fileName}`, content: proposedContent },
      purpose: 'proposal',
      column: 1,
      // The agent opens this diff, not the user, so focus stays in the chat, where the permission card decides.
      preserveFocus: true,
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
