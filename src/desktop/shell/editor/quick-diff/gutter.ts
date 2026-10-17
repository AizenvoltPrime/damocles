import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import type { LineChange } from '@shared/scm/apply-line-changes';
import type { Monaco } from '@/components/editor/useMonaco';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import { changeKind, type ChangeKind } from './quick-diff-compute';

// The quick diff's gutter marks (quickDiffDecorator.ts): a bar beside added and changed lines and a wedge where lines were
// removed, solid for unstaged changes (primary) and hollow for staged ones (secondary). Styles: .qd-mark in style.css.

// ms a mark that moved from unstaged to staged plays .qd-arrive (its keyframe's length in motion.css); Monaco re-creates a
// decoration's node when its line scrolls in, so the class is swapped for the static one afterwards and never replays
export const QD_ARRIVE_MS = 450;

export interface GutterMark {
  readonly change: LineChange;
  readonly staged: boolean;
}

export interface GutterLabels {
  readonly added: string;
  readonly modified: string;
  readonly deleted: string;
  readonly staged: (kind: string) => string;
}

function rangeKey(change: LineChange): string {
  return `${change.modifiedStartLineNumber}:${change.modifiedEndLineNumber}`;
}

/** Every mark in line order: the primary changes and the secondary ones shown beside them. */
export function gutterMarks(primary: readonly LineChange[], secondary: readonly LineChange[]): GutterMark[] {
  return [...primary.map((change) => ({ change, staged: false })), ...secondary.map((change) => ({ change, staged: true }))]
    .sort((a, b) => a.change.modifiedStartLineNumber - b.change.modifiedStartLineNumber);
}

export interface Gutter extends IDisposable {
  update(marks: readonly GutterMark[]): void;
}

/** Draws marks on the editor and calls onClick with the mark under a click in the line decorations lane. */
export function attachGutter(editor: MonacoEditor.ICodeEditor, monaco: Monaco, labels: GutterLabels, onClick: (mark: GutterMark) => void): Gutter {
  const collection = editor.createDecorationsCollection();
  let marks: readonly GutterMark[] = [];
  // the ranges of the unstaged marks last drawn, so a mark that becomes staged at the same lines plays its arrival
  let unstaged = new Set<string>();
  let arriveTimer: ReturnType<typeof setTimeout> | undefined;

  function draw(arriving: ReadonlySet<string>): void {
    collection.set(marks.map(({ change, staged }) => {
      const kind: ChangeKind = changeKind(change);
      const start = kind === 'deleted' ? Math.max(1, change.modifiedStartLineNumber) : change.modifiedStartLineNumber;
      const end = kind === 'deleted' ? start : change.modifiedEndLineNumber;
      const arrive = staged && arriving.has(rangeKey(change)) ? ' qd-arrive' : '';
      const top = kind === 'deleted' && change.modifiedStartLineNumber === 0 ? ' qd-top' : '';
      return {
        range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 },
        options: {
          description: 'quick-diff',
          isWholeLine: kind !== 'deleted',
          linesDecorationsClassName: `qd-mark qd-${kind}${staged ? ' qd-staged' : ''}${arrive}${top}`,
          linesDecorationsTooltip: staged ? labels.staged(labels[kind]) : labels[kind],
        },
      };
    }));
  }

  const mouse = editor.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !event.event.leftButton) return;
    const line = event.target.position?.lineNumber;
    if (line === undefined) return;
    const mark = marks.find(({ change }) => {
      if (changeKind(change) === 'deleted') return Math.max(1, change.modifiedStartLineNumber) === line;
      return line >= change.modifiedStartLineNumber && line <= change.modifiedEndLineNumber;
    });
    if (!mark) return;
    event.event.preventDefault();
    onClick(mark);
  });

  return {
    update(next) {
      marks = next;
      clearTimeout(arriveTimer);
      const arriving = prefersReducedMotion() ? new Set<string>() : new Set(next.filter((mark) => mark.staged && unstaged.has(rangeKey(mark.change))).map((mark) => rangeKey(mark.change)));
      unstaged = new Set(next.filter((mark) => !mark.staged).map((mark) => rangeKey(mark.change)));
      draw(arriving);
      if (arriving.size > 0) arriveTimer = setTimeout(() => draw(new Set()), QD_ARRIVE_MS);
    },
    dispose() {
      clearTimeout(arriveTimer);
      mouse.dispose();
      collection.clear();
    },
  };
}
