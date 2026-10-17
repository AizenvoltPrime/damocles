import { h, render, type AppContext } from 'vue';
import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import type { Monaco } from '@/components/editor/useMonaco';
import { visibleText } from '@shared/visible-text';
import { mountDiffZone, zoneBodyLines, type DiffZone } from '../quick-diff/peek';
import { conflictReplacement, containsConflict, parseConflicts, type Conflict, type ConflictChoice } from './conflict-parser';
import ConflictCompareHeader from './ConflictCompareHeader.vue';

// Inline conflicts (B29): VS Code's merge-conflict extension (codelensProvider.ts, commandHandler.ts, mergeDecorator.ts) over
// any editable buffer with markers. It reads text only, so it needs neither trust nor git.

export type ConflictCommand = 'acceptCurrent' | 'acceptIncoming' | 'acceptBoth' | 'acceptAllCurrent' | 'acceptAllIncoming' | 'nextConflict' | 'previousConflict';

const ACCEPT_COMMAND = 'damocles.mergeConflict.accept';
const COMPARE_COMMAND = 'damocles.mergeConflict.compare';
// ms after the last edit before an editor scans its text for markers again (VS Code's merge-conflict tracker delays its scan)
export const CONFLICT_SCAN_DELAY_MS = 250;

interface LensOwner {
  readonly accept: (conflictStart: number, choice: ConflictChoice) => void;
  readonly compare: (conflictStart: number) => void;
}

// The editors that show lenses, by editor id, since a file's code tab and a merge editor's Result can show one model; the
// provider and its commands are registered once a page.
const owners = new Map<string, { readonly editor: MonacoEditor.ICodeEditor; readonly owner: LensOwner }>();

// The owner acting on a model's lens: the editor holding focus among those showing it, else the first.
function ownerOf(uri: string): LensOwner | undefined {
  const showing = [...owners.values()].filter(({ editor }) => editor.getModel()?.uri.toString() === uri);
  return (showing.find(({ editor }) => editor.hasWidgetFocus()) ?? showing[0])?.owner;
}
let registered: { titles: () => Record<ConflictChoice | 'compare', string> } | null = null;

function register(monaco: Monaco, titles: () => Record<ConflictChoice | 'compare', string>): void {
  if (registered) {
    registered.titles = titles;
    return;
  }
  registered = { titles };
  monaco.editor.registerCommand(ACCEPT_COMMAND, (_accessor, uri: string, start: number, choice: ConflictChoice) => ownerOf(uri)?.accept(start, choice));
  monaco.editor.registerCommand(COMPARE_COMMAND, (_accessor, uri: string, start: number) => ownerOf(uri)?.compare(start));
  monaco.languages.registerCodeLensProvider('*', {
    provideCodeLenses(model) {
      if (![...owners.values()].some(({ editor }) => editor.getModel() === model)) return { lenses: [], dispose: () => undefined };
      const names = registered!.titles();
      const uri = model.uri.toString();
      const lenses = parseConflicts(model.getValue()).flatMap((conflict) => {
        const range = { startLineNumber: conflict.startLine, startColumn: 1, endLineNumber: conflict.startLine, endColumn: 1 };
        return [
          { range, command: { id: ACCEPT_COMMAND, title: names.current, arguments: [uri, conflict.start, 'current'] } },
          { range, command: { id: ACCEPT_COMMAND, title: names.incoming, arguments: [uri, conflict.start, 'incoming'] } },
          { range, command: { id: ACCEPT_COMMAND, title: names.both, arguments: [uri, conflict.start, 'both'] } },
          { range, command: { id: COMPARE_COMMAND, title: names.compare, arguments: [uri, conflict.start] } },
        ];
      });
      return { lenses, dispose: () => undefined };
    },
  });
}

export interface ConflictLens extends IDisposable {
  /** Turns lenses on for the editor's buffer while editable, or off. */
  setEnabled(enabled: boolean): void;
  /** A palette command on the conflict at the cursor; false when there is none to act on. */
  run(command: ConflictCommand): boolean;
}

export interface ConflictLensDeps {
  readonly t: (key: string, named?: Record<string, unknown>) => string;
  readonly appContext: AppContext | null;
  /** Off in the merge editor's Result, whose merge regions already draw each conflict as one block. */
  readonly sideTints: boolean;
}

/** The lenses, decorations, accept commands and Compare zone of one code editor. */
export function attachConflictLens(editor: MonacoEditor.ICodeEditor, monaco: Monaco, deps: ConflictLensDeps): ConflictLens {
  const { t } = deps;
  register(monaco, () => ({ current: t('conflict.acceptCurrent'), incoming: t('conflict.acceptIncoming'), both: t('conflict.acceptBoth'), compare: t('conflict.compare') }));
  const decorations = editor.createDecorationsCollection();
  let enabled = false;
  let compare: { zone: DiffZone; models: MonacoEditor.ITextModel[] } | null = null;

  const conflicts = (): Conflict[] => {
    const model = editor.getModel();
    return model ? parseConflicts(model.getValue()) : [];
  };

  function decorate(): void {
    const model = editor.getModel();
    if (!deps.sideTints || !enabled || !model || !containsConflict(model.getValue())) {
      decorations.clear();
      return;
    }
    const whole = (start: number, end: number, className: string): MonacoEditor.IModelDeltaDecoration => ({
      range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 },
      options: { isWholeLine: true, className },
    });
    const markerText = (line: number): MonacoEditor.IModelDeltaDecoration => ({
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) },
      options: { inlineClassName: 'qd-conflict-marker-text' },
    });
    decorations.set(conflicts().flatMap((conflict) => [
      ...[conflict.current.headerLine, ...conflict.commonAncestors.map((ancestors) => ancestors.headerLine), conflict.splitterLine, conflict.incoming.headerLine].map(markerText),
      whole(conflict.current.headerLine, conflict.current.headerLine, 'qd-conflict-current-header'),
      ...(conflict.current.lineCount > 0 ? [whole(conflict.current.firstLine, conflict.current.firstLine + conflict.current.lineCount - 1, 'qd-conflict-current')] : []),
      ...conflict.commonAncestors.map((ancestors) => whole(ancestors.headerLine, ancestors.headerLine + ancestors.lineCount, 'qd-conflict-base')),
      whole(conflict.splitterLine, conflict.splitterLine, 'qd-conflict-splitter'),
      ...(conflict.incoming.lineCount > 0 ? [whole(conflict.incoming.firstLine, conflict.incoming.firstLine + conflict.incoming.lineCount - 1, 'qd-conflict-incoming')] : []),
      whole(conflict.incoming.headerLine, conflict.incoming.headerLine, 'qd-conflict-incoming-header'),
    ]));
  }

  function closeCompare(animate: boolean): void {
    if (!compare) return;
    const { zone, models } = compare;
    compare = null;
    render(null, zone.header);
    zone.remove(animate, () => {
      for (const model of models) model.dispose();
    });
  }

  function apply(edits: Array<{ conflict: Conflict; text: string }>): void {
    const model = editor.getModel();
    if (!model || edits.length === 0) return;
    closeCompare(false);
    model.pushStackElement();
    model.pushEditOperations(editor.getSelections() ?? [], edits.map(({ conflict, text }) => {
      const start = model.getPositionAt(conflict.start);
      const end = model.getPositionAt(conflict.end);
      return { range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, text };
    }), () => null);
    model.pushStackElement();
  }

  function accept(start: number, choice: ConflictChoice): void {
    const model = editor.getModel();
    const conflict = conflicts().find((candidate) => candidate.start === start);
    if (model && conflict) apply([{ conflict, text: conflictReplacement(model.getValue(), conflict, choice) }]);
  }

  function openCompare(start: number): void {
    const model = editor.getModel();
    const conflict = conflicts().find((candidate) => candidate.start === start);
    if (!model || !conflict) return;
    closeCompare(false);
    const text = model.getValue();
    const language = model.getLanguageId();
    const current = monaco.editor.createModel(text.slice(conflict.current.contentStart, conflict.current.contentEnd), language);
    const incoming = monaco.editor.createModel(text.slice(conflict.incoming.contentStart, conflict.incoming.contentEnd), language);
    const zone = mountDiffZone(editor, monaco, {
      afterLine: conflict.endLine,
      bodyLines: zoneBodyLines(Math.max(conflict.current.lineCount, conflict.incoming.lineCount) - 4),
      label: t('conflict.compareTitle', { current: visibleText(conflict.current.name), incoming: visibleText(conflict.incoming.name) }),
      testId: 'conflict-compare',
      moving: false,
      original: current,
      modified: incoming,
      reveal: 1,
      onEscape: () => {
        closeCompare(true);
        editor.focus();
      },
    });
    compare = { zone, models: [current, incoming] };
    const vnode = h(ConflictCompareHeader, {
      current: conflict.current.name,
      incoming: conflict.incoming.name,
      onClose: () => {
        closeCompare(true);
        editor.focus();
      },
    });
    vnode.appContext = deps.appContext;
    render(vnode, zone.header);
  }

  function own(): void {
    if (enabled && editor.getModel()) owners.set(editor.getId(), { editor, owner: { accept, compare: openCompare } });
    else owners.delete(editor.getId());
    decorate();
  }

  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const disposables: IDisposable[] = [
    editor.onDidChangeModel(() => {
      clearTimeout(scanTimer);
      closeCompare(false);
      own();
    }),
    // each scan copies the whole text, so it waits for typing to pause; the decorations move with the edits meanwhile
    editor.onDidChangeModelContent(() => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(decorate, CONFLICT_SCAN_DELAY_MS);
    }),
  ];

  function atCursor(): Conflict | undefined {
    const line = editor.getPosition()?.lineNumber ?? 0;
    return conflicts().find((conflict) => line >= conflict.startLine && line <= conflict.endLine);
  }

  function goTo(step: 1 | -1): boolean {
    const all = conflicts();
    if (all.length === 0) return false;
    const line = editor.getPosition()?.lineNumber ?? 1;
    const target = step === 1
      ? all.find((conflict) => conflict.startLine > line) ?? all[0]!
      : [...all].reverse().find((conflict) => conflict.endLine < line) ?? all.at(-1)!;
    editor.setPosition({ lineNumber: target.startLine, column: 1 });
    editor.revealLineInCenterIfOutsideViewport(target.startLine);
    return true;
  }

  return {
    setEnabled(next) {
      enabled = next;
      own();
    },
    run(command) {
      const model = editor.getModel();
      if (!enabled || !model) return false;
      if (command === 'nextConflict') return goTo(1);
      if (command === 'previousConflict') return goTo(-1);
      if (command === 'acceptAllCurrent' || command === 'acceptAllIncoming') {
        const text = model.getValue();
        const choice = command === 'acceptAllCurrent' ? 'current' : 'incoming';
        const edits = parseConflicts(text).map((conflict) => ({ conflict, text: conflictReplacement(text, conflict, choice) }));
        apply(edits);
        return edits.length > 0;
      }
      const conflict = atCursor();
      if (!conflict) return false;
      accept(conflict.start, command === 'acceptCurrent' ? 'current' : command === 'acceptIncoming' ? 'incoming' : 'both');
      return true;
    },
    dispose() {
      clearTimeout(scanTimer);
      for (const disposable of disposables) disposable.dispose();
      closeCompare(false);
      owners.delete(editor.getId());
      decorations.clear();
    },
  };
}
