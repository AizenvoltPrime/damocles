import * as path from 'path';
import type { DiffView, EditorService } from '../../platform/editor-service';
import { TOOL_WRITE } from '../../shared/tool-names';
import type { FilePatch } from '../../shared/types/file-patch';
import { readTextForPatch } from '../pi-session/tools/patch-text';
import { EDIT_EMPTY_OLD_STRING, editAccessRefusal, editPatchOf, previewEdit } from '../pi-session/tools/edit-tool';
import { notARegularFile, notARegularFileToWrite } from '../pi-session/tools/local-file-operations';
import type { PiCodingAgentModule } from '../pi-session/pi-loader';
import type { DiffService } from '../diff';
import { l } from '../l10n';
import { log } from '../logger';

export interface DiffInfo {
  /** Empty for a new file; absent when the file exists but cannot be read as text, so no diff of it can be shown. */
  originalContent?: string;
  /** Absent for an Edit of a file that cannot be read as text, whose new text is not known before it runs. */
  proposedContent?: string;
  editLineNumber?: number;
  /** The change's real-numbered patch, computed as its result computes it, or why there is none; absent for a new file. */
  patch?: FilePatch;
  /** The host's editor holds unsaved changes to the file, which the diff of the file on disk leaves out. */
  unsavedChanges?: true;
}

export class DiffManager {
  private activeDiffs: Map<string, DiffView> = new Map();
  private disposed = false;
  private readonly editor: EditorService;
  private readonly panelId: string | undefined;
  private readonly pi: () => PiCodingAgentModule | null;
  // the card's patch, on the diff worker's tool lane
  private readonly diff: Pick<DiffService, 'filePatch' | 'editPatch'>;

  constructor(editor: EditorService, panelId: string | undefined, pi: () => PiCodingAgentModule | null, diff: Pick<DiffService, 'filePatch' | 'editPatch'>) {
    this.editor = editor;
    this.panelId = panelId;
    this.pi = pi;
    this.diff = diff;
  }

  /**
   * The approval of a change to `file`: `path` as the call wrote it, which the run's messages and patch name, and `absolute`, the
   * file it resolves to. The file is read from disk as the run reads it, never as an editor holds it, and an Edit is refused here
   * exactly where its run would refuse it, with the run's message.
   */
  async prepareDiff(
    _diffId: string,
    toolName: string,
    file: { readonly path: string; readonly absolute: string },
    input: { content?: string; old_string?: string; new_string?: string; replace_all?: boolean },
    signal: AbortSignal
  ): Promise<DiffInfo | { refused: string }> {
    if (toolName === TOOL_WRITE) {
      const original = await readTextForPatch(file.absolute);
      const proposedContent = input.content || '';
      if (original === undefined) return this.withEditorState(file.absolute, { originalContent: '', proposedContent, editLineNumber: 1 });
      if (typeof original !== 'string') {
        // The write tool refuses a non-regular file before it writes, in every mode.
        if (original.patchOmitted === 'notAFile') return { refused: notARegularFileToWrite(file.path) };
        return this.withEditorState(file.absolute, { proposedContent, editLineNumber: 1, patch: original });
      }
      // the patch the write override records for the same change
      const patch = await this.patchOrUnavailable(file.absolute, this.diff.filePatch(file.path, original, proposedContent, { signal }));
      return this.withEditorState(file.absolute, { originalContent: original, proposedContent, editLineNumber: 1, patch });
    }

    const change = { old_string: input.old_string ?? '', new_string: input.new_string ?? '', ...(input.replace_all === true ? { replace_all: true } : {}) };
    if (change.old_string === '') return { refused: EDIT_EMPTY_OLD_STRING };
    const original = await readTextForPatch(file.absolute);
    // The run's checks in its order: a non-regular file, then the access check, which also refuses a missing file.
    if (typeof original === 'object' && original.patchOmitted === 'notAFile') return { refused: notARegularFile(file.path) };
    const denied = await editAccessRefusal(file.absolute, file.path);
    if (denied !== undefined) return { refused: denied };
    // Created since the read: asked with the requested change alone, and the run reads it again.
    if (original === undefined) return this.withEditorState(file.absolute, {});
    // Asked without a diff; the card names why.
    if (typeof original !== 'string') return this.withEditorState(file.absolute, { patch: original });
    const pi = this.pi();
    if (!pi) throw new Error('An Edit approval needs pi\'s edit, which is not loaded');
    const edit = previewEdit(pi, file.path, original, change);
    if ('refused' in edit) return edit;
    const lineNumber = edit.firstChangedLine !== undefined ? { editLineNumber: edit.firstChangedLine } : {};
    // the patch `runEdit` records for the same change
    const patch = await this.patchOrUnavailable(file.absolute, editPatchOf(this.diff, file.path, edit, change.replace_all, { signal }));
    return this.withEditorState(file.absolute, { originalContent: original, proposedContent: edit.written, ...lineNumber, patch });
  }

  /** The diff, noting when the host's editor holds unsaved changes to the file, which the diff of the file on disk leaves out. */
  private async withEditorState(filePath: string, diff: DiffInfo): Promise<DiffInfo> {
    return (await this.editor.isDirty(filePath)) ? { ...diff, unsavedChanges: true } : diff;
  }

  private patchOrUnavailable(filePath: string, patching: Promise<FilePatch>): Promise<FilePatch> {
    return patching.catch((error: unknown): FilePatch => {
      log('[DiffManager] no diff for the approval of %s: %O', filePath, error);
      return { patchOmitted: 'unavailable' };
    });
  }

  // diffId is the tool use id the pending permission prompt is keyed by. Opens nothing once disposed.
  async showDiffView(diffId: string, filePath: string, originalContent: string, proposedContent: string): Promise<void> {
    if (this.disposed) return;
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
    if (this.disposed) await this.closeDiffView(diffId);
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
    this.disposed = true;
    await Promise.all([...this.activeDiffs.keys()].map((diffId) => this.closeDiffView(diffId)));
  }
}
