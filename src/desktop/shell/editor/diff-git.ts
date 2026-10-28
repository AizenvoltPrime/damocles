import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import { applyLineChanges, selectedLineChanges, type LineChange } from '@shared/scm/apply-line-changes';
import type { Monaco } from '@/components/editor/useMonaco';
import type { ScmQuickDiffBaseResult, ScmRangeAction, ScmRangeRefusal } from '../../preload/scm-channels';
import type { DamoclesShellApi, ShellDiffGit } from '../../preload/shell-channels';
import type { EditorTargetCommand } from './editor-store';
import { lineEdits } from './format-edits';
import { changesKeptByRevert, selectionLineRanges, splitLines } from './quick-diff/quick-diff-compute';

// A diff tab of a change (B27, B47): against the index (Changes) it has Stage Block on each hunk's gutter, Stage Selection on a
// selection's gutter, and Stage and Revert Selected Ranges; against HEAD (Staged Changes) Unstage Selected Ranges. Main
// replaces the index side in place after each stage or unstage, so the tab follows.

export interface DiffGitDeps {
  readonly api: DamoclesShellApi;
  readonly t: (key: string) => string;
  // sends the working file's pending edit to main first
  readonly flush: (documentId: string) => void;
  readonly documentId: string;
  readonly readOnly: () => boolean;
}

export interface DiffGit extends IDisposable {
  run(command: EditorTargetCommand): Promise<void>;
}

const sameLines = (a: string, b: string): boolean => {
  const left = splitLines(a);
  const right = splitLines(b);
  return left.length === right.length && left.every((line, index) => line === right[index]);
};

export function attachDiffGit(diff: MonacoEditor.IStandaloneDiffEditor, monaco: Monaco, git: ShellDiffGit, deps: DiffGitDeps): DiffGit {
  const modified = diff.getModifiedEditor();
  const glyphs = modified.createDecorationsCollection();
  let busy = false;

  const lineChanges = (): LineChange[] => (diff.getLineChanges() ?? []).map((change) => ({
    originalStartLineNumber: change.originalStartLineNumber,
    originalEndLineNumber: change.originalEndLineNumber,
    modifiedStartLineNumber: change.modifiedStartLineNumber,
    modifiedEndLineNumber: change.modifiedEndLineNumber,
  }));

  const blockLine = (change: LineChange): number => Math.max(1, change.modifiedStartLineNumber);

  // The selection's ranges, or none when it is empty: Stage Selection needs a selection, Stage Block a hunk.
  const selectedRanges = () => {
    const selections = (modified.getSelections() ?? []).filter((selection) => !selection.isEmpty());
    return selectionLineRanges(selections);
  };

  function drawGlyphs(): void {
    if (git.group !== 'workingTree' || deps.readOnly()) {
      glyphs.clear();
      return;
    }
    const model = modified.getModel();
    const changes = lineChanges();
    const ranges = selectedRanges();
    const selectionLine = ranges.length > 0 && model && selectedLineChanges(changes, ranges, model.getLineCount()).length > 0 ? ranges[0]!.startLineNumber : null;
    glyphs.set([
      ...changes.filter((change) => blockLine(change) !== selectionLine).map((change) => ({
        range: { startLineNumber: blockLine(change), startColumn: 1, endLineNumber: blockLine(change), endColumn: 1 },
        options: { description: 'stage-block', glyphMarginClassName: 'qd-stage-glyph qd-stage-block', glyphMarginHoverMessage: { value: deps.t('quickDiff.stageBlock') } },
      })),
      ...(selectionLine === null ? [] : [{
        range: { startLineNumber: selectionLine, startColumn: 1, endLineNumber: selectionLine, endColumn: 1 },
        options: { description: 'stage-selection', glyphMarginClassName: 'qd-stage-glyph qd-stage-selection', glyphMarginHoverMessage: { value: deps.t('quickDiff.stageSelection') } },
      }]),
    ]);
  }

  // The sides on screen must be the blobs the ranges go to; main refreshes the index side after every status.
  async function baseOf(indexText: string): Promise<Extract<ScmQuickDiffBaseResult, { ok: true }> | null> {
    const base = await deps.api.scm.quickDiffBase({ repoId: git.repoId, path: git.path });
    return base.ok && sameLines(base.indexText, indexText) ? base : null;
  }

  async function indexOid(indexText: string): Promise<string | null> {
    return (await baseOf(indexText))?.indexOid ?? null;
  }

  // main owns notices, so an action that cannot apply is told there
  async function refuse(action: ScmRangeAction, reason: ScmRangeRefusal): Promise<void> {
    await deps.api.scm.run({ op: 'refuseRanges', repoId: git.repoId, action, reason });
  }

  async function stage(changes: readonly LineChange[]): Promise<void> {
    const models = diff.getModel();
    if (!models) return;
    if (changes.length === 0) return refuse('stage', 'noChanges');
    const version = models.modified.getVersionId();
    const oid = await indexOid(models.original.getValue());
    if (oid === null) return refuse('stage', 'changed');
    // the ranges belong to the text they were taken from; a keystroke during the read makes them stale
    if (models.modified.getVersionId() !== version) return refuse('stage', 'outOfRange');
    deps.flush(deps.documentId);
    await deps.api.scm.run({ op: 'stageRanges', repoId: git.repoId, path: git.path, documentId: deps.documentId, ranges: changes, indexOid: oid });
  }

  // HEAD's side is a snapshot of HEAD at the change's source path, which core reads again and checks by headOid
  async function unstage(changes: readonly LineChange[]): Promise<void> {
    const models = diff.getModel();
    if (!models) return;
    if (changes.length === 0) return refuse('unstage', 'noChanges');
    const base = await baseOf(models.modified.getValue());
    if (base === null || !sameLines(base.headText ?? '', models.original.getValue())) return refuse('unstage', 'changed');
    await deps.api.scm.run({ op: 'unstageRanges', repoId: git.repoId, path: git.path, documentId: deps.documentId, ranges: changes, indexOid: base.indexOid, headOid: base.headOid });
  }

  async function revert(kept: readonly LineChange[]): Promise<void> {
    const models = diff.getModel();
    if (!models || deps.readOnly()) return;
    const current = models.modified.getValue();
    const edits = lineEdits(current, applyLineChanges(models.original.getValue(), current, kept));
    if (edits.length === 0) return refuse('revert', 'noChanges');
    models.modified.pushStackElement();
    models.modified.pushEditOperations(modified.getSelections() ?? [], edits.map((edit) => ({ range: edit.range, text: edit.text })), () => null);
    models.modified.pushStackElement();
  }

  async function guarded(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await work();
    } finally {
      busy = false;
    }
  }

  const mouse = modified.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !event.event.leftButton) return;
    const line = event.target.position?.lineNumber;
    const element = event.target.element;
    if (line === undefined || !element?.classList.contains('qd-stage-glyph')) return;
    event.event.preventDefault();
    const model = modified.getModel();
    if (!model) return;
    const changes = lineChanges();
    if (element.classList.contains('qd-stage-selection')) void guarded(() => stage(selectedLineChanges(changes, selectedRanges(), model.getLineCount())));
    else {
      const block = changes.find((change) => blockLine(change) === line);
      if (block) void guarded(() => stage([block]));
    }
  });

  const disposables: IDisposable[] = [mouse, diff.onDidUpdateDiff(drawGlyphs), modified.onDidChangeCursorSelection(drawGlyphs)];
  drawGlyphs();

  return {
    async run(command) {
      const model = modified.getModel();
      if (!model) return;
      const ranges = selectionLineRanges(modified.getSelections() ?? []);
      const changes = lineChanges();
      const count = model.getLineCount();
      if (git.group === 'workingTree' && command === 'stageSelectedRanges') await guarded(() => stage(selectedLineChanges(changes, ranges, count)));
      else if (git.group === 'workingTree' && command === 'revertSelectedRanges') await revert(changesKeptByRevert(changes, ranges, count));
      else if (git.group === 'index' && command === 'unstageSelectedRanges') await guarded(() => unstage(selectedLineChanges(changes, ranges, count)));
    },
    dispose() {
      for (const disposable of disposables) disposable.dispose();
      glyphs.clear();
    },
  };
}
