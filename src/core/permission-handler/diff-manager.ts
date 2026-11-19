import * as path from 'path';
import type { DiffView, EditorService } from '../../platform/editor-service';
import { TOOL_WRITE } from '../../shared/tool-names';
import type { FilePatch } from '../../shared/types/file-patch';
import { filePatch, readTextForPatch } from '../pi-session/tools/file-patch';
import { EDIT_EMPTY_OLD_STRING, exactEdit, previewEdit, replaceAllNotFound, replaceAllUnchanged } from '../pi-session/tools/edit-tool';
import { couldNotEdit, editOperations, notARegularFile, notARegularFileToWrite } from '../pi-session/tools/local-file-operations';
import type { PiCodingAgentModule } from '../pi-session/pi-loader';
import { l } from '../l10n';
import { log } from '../logger';

export interface DiffInfo {
  /** Empty for a new file; absent when the file exists but cannot be read as text, so no diff of it can be shown. */
  originalContent?: string;
  /** Absent for an Edit of a file that cannot be read as text, whose new text is not known before it runs. */
  proposedContent?: string;
  editLineNumber?: number;
  /** The change's real-numbered patch, as its result will record it, or why there is none; absent for a new file. */
  patch?: FilePatch;
  /** The host's editor holds unsaved changes to the file, which the diff of the file on disk leaves out. */
  unsavedChanges?: true;
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

  /**
   * `filePath` is absolute, resolved as the tool resolves it; the file is read as pi's edit reads it, never as an editor holds it.
   * `call` is the tool call's own folder and path as written, which pi's refusals name.
   */
  async prepareDiff(
    _diffId: string,
    toolName: string,
    filePath: string,
    input: { content?: string; old_string?: string; new_string?: string; replace_all?: boolean },
    call: { readonly cwd: string; readonly path: string } = { cwd: path.dirname(filePath), path: filePath },
  ): Promise<DiffInfo | { refused: string }> {
    const oldString = input.old_string ?? '';
    if (toolName !== TOOL_WRITE && oldString === '') return { refused: EDIT_EMPTY_OLD_STRING };
    const original = await readTextForPatch(filePath);
    const originalContent = typeof original === 'string' ? original : '';

    let proposedContent: string;
    let editLineNumber: number | undefined;

    if (toolName === TOOL_WRITE) {
      // The write tool refuses a non-regular file before it writes, in every mode.
      if (typeof original !== 'string' && original?.patchOmitted === 'notAFile') return { refused: notARegularFileToWrite(call.path) };
      proposedContent = input.content || '';
      editLineNumber = 1;
    } else if (original !== undefined && (typeof original !== 'string' || input.replace_all === true)) {
      // The Edit tool refuses a non-regular file before pi's access check, which pi's edit and replace_all run next; a single edit of a text file gets it from previewEdit.
      if (typeof original !== 'string' && original.patchOmitted === 'notAFile') return { refused: notARegularFile(call.path) };
      const denied = await editOperations.access(filePath).then(() => undefined, (error: unknown) => couldNotEdit(call.path, error));
      if (denied !== undefined) return { refused: denied };
      if (typeof original !== 'string') {
        // Asked without a diff; the card names why.
        return this.withEditorState(filePath, { patch: original });
      }
      const edit = exactEdit(original, oldString, input.new_string ?? '');
      if (!edit) return { refused: replaceAllNotFound(call.path) };
      if (edit.newContent === edit.baseContent) return { refused: replaceAllUnchanged(call.path) };
      editLineNumber = edit.baseContent.slice(0, edit.replacements[0]!.matchIndex).split('\n').length;
      proposedContent = edit.written;
    } else {
      const pi = this.pi();
      if (!pi) throw new Error('An Edit approval needs pi\'s edit, which is not loaded');
      // The edit pi runs, on the text this diff shows as the original; a missing file gets pi's own refusal.
      const edit = await previewEdit(pi, call.cwd, call.path, original, oldString, input.new_string ?? '');
      if ('refused' in edit) return edit;
      editLineNumber = edit.firstChangedLine;
      proposedContent = edit.written;
    }

    const lineNumber = editLineNumber !== undefined ? { editLineNumber } : {};
    if (original === undefined) return this.withEditorState(filePath, { originalContent, proposedContent, ...lineNumber });
    if (typeof original !== 'string') return this.withEditorState(filePath, { proposedContent, ...lineNumber, patch: original });
    return this.withEditorState(filePath, { originalContent, proposedContent, ...lineNumber, patch: filePatch(call.path, originalContent, proposedContent) });
  }

  /** The diff, noting when the host's editor holds unsaved changes to the file, which the diff of the file on disk leaves out. */
  private async withEditorState(filePath: string, diff: DiffInfo): Promise<DiffInfo> {
    return (await this.editor.isDirty(filePath)) ? { ...diff, unsavedChanges: true } : diff;
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
