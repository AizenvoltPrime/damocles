import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import type { LineChange } from '@shared/scm/apply-line-changes';
import { remPx } from '@/composables/useRemPx';
import type { Monaco } from '@/components/editor/useMonaco';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import { changeKind, modifiedEndLine, sameChange } from './quick-diff-compute';

// The quick diff peek (B26): VS Code's quickDiffWidget is a PeekViewWidget, which standalone Monaco lacks, so this is its
// ZoneWidget shape: an empty view zone keeps the lines apart and an overlay widget at the zone's top holds a header and an
// inline diff editor (zoneWidget.ts ViewZoneDelegate and OverlayWidgetDelegate). The conflict lenses' Compare uses it too.

// rem of a zone's header; the body shows its diff in at least and at most these many lines
export const ZONE_HEADER_REM = 2.25;
const MIN_BODY_LINES = 6;
const MAX_BODY_LINES = 18;
const CONTEXT_LINES = 3;
// ms of .qd-peek-out (d-tuck-out's length in style.css); the zone is removed when it ends
export const PEEK_EXIT_MS = 140;

let zoneSerial = 0;

export interface DiffZone {
  readonly root: HTMLElement;
  readonly header: HTMLElement;
  /** Removes the zone; animate plays the exit first, unless motion is reduced. */
  remove(animate: boolean, done?: () => void): void;
}

export interface DiffZoneOptions {
  readonly afterLine: number;
  readonly bodyLines: number;
  // the zone's role label
  readonly label: string;
  readonly testId: string;
  // whether the zone opens in place of another, which fades in rather than unfolding
  readonly moving: boolean;
  // a class on the zone's root, such as the change kind that colours its frame
  readonly className?: string;
  readonly original: MonacoEditor.ITextModel;
  readonly modified: MonacoEditor.ITextModel;
  // the modified side's line to show first
  readonly reveal: number;
  readonly onEscape: () => void;
}

/** A diff zone under afterLine: a header node the caller fills and an inline diff editor of original against modified. */
export function mountDiffZone(editor: MonacoEditor.ICodeEditor, monaco: Monaco, options: DiffZoneOptions): DiffZone {
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
  const headerPx = remPx(ZONE_HEADER_REM);
  const height = headerPx + options.bodyLines * lineHeight;
  const width = (): number => {
    const layout = editor.getLayoutInfo();
    return layout.width - layout.minimap.minimapWidth - layout.verticalScrollbarWidth;
  };

  const root = document.createElement('div');
  root.className = `qd-peek ${options.moving ? 'qd-peek-move' : 'qd-peek-in'}${options.className ? ` ${options.className}` : ''}`;
  root.dataset['testid'] = options.testId;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', options.label);
  const header = document.createElement('div');
  header.className = 'qd-peek-header';
  const body = document.createElement('div');
  body.className = 'qd-peek-body';
  body.style.height = `${height - headerPx}px`;
  root.append(header, body);
  root.style.width = `${width()}px`;
  root.style.height = `${height}px`;
  root.style.top = '-1000px';
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    options.onEscape();
  });

  const diff = monaco.editor.createDiffEditor(body, {
    renderSideBySide: false,
    readOnly: true,
    originalEditable: false,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    renderOverviewRuler: false,
    overviewRulerLanes: 0,
    glyphMargin: false,
    fontSize: editor.getOption(monaco.editor.EditorOption.fontSize),
    fontFamily: editor.getOption(monaco.editor.EditorOption.fontInfo).fontFamily,
    lineDecorationsWidth: remPx(0.5),
    contextmenu: false,
    stickyScroll: { enabled: false },
    fixedOverflowWidgets: true,
    scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: remPx(0.625), horizontalScrollbarSize: remPx(0.625) },
  });
  diff.setModel({ original: options.original, modified: options.modified });
  const onUpdate = diff.onDidUpdateDiff(() => {
    onUpdate.dispose();
    diff.getModifiedEditor().revealLineInCenter(options.reveal);
  });

  // Monaco keys a widget by its id on every call, so the id is fixed once
  const id = `damocles.diffZone.${++zoneSerial}`;
  const overlay: MonacoEditor.IOverlayWidget = { getId: () => id, getDomNode: () => root, getPosition: () => null };
  let zoneId = '';
  editor.changeViewZones((accessor) => {
    zoneId = accessor.addZone({
      afterLineNumber: options.afterLine,
      heightInPx: height,
      domNode: document.createElement('div'),
      onDomNodeTop: (top) => {
        root.style.top = `${top}px`;
      },
    });
  });
  editor.addOverlayWidget(overlay);
  const layout = editor.onDidLayoutChange(() => {
    root.style.width = `${width()}px`;
  });

  let removed = false;
  return {
    root,
    header,
    remove(animate, done) {
      if (removed) return;
      removed = true;
      layout.dispose();
      onUpdate.dispose();
      diff.dispose();
      const finish = (): void => {
        editor.changeViewZones((accessor) => accessor.removeZone(zoneId));
        editor.removeOverlayWidget(overlay);
        done?.();
      };
      if (!animate || prefersReducedMotion()) {
        finish();
        return;
      }
      root.classList.remove('qd-peek-in', 'qd-peek-move');
      root.classList.add('qd-peek-out');
      setTimeout(finish, PEEK_EXIT_MS);
    },
  };
}

/** Lines a zone's diff shows for a change of changeLines lines: the change with its context, within the bounds. */
export function zoneBodyLines(changeLines: number): number {
  return Math.min(MAX_BODY_LINES, Math.max(MIN_BODY_LINES, changeLines + 2 * CONTEXT_LINES));
}

export interface PeekTarget {
  readonly change: LineChange;
  // the original side's text: the index for an unstaged change, HEAD for a staged one
  readonly original: string;
  readonly staged: boolean;
}

export interface PeekHeader {
  // fills the header node; called with null before the header node goes
  render(node: HTMLElement, target: PeekTarget | null): void;
}

export interface Peek extends IDisposable {
  readonly target: () => PeekTarget | null;
  open(target: PeekTarget): void;
  /** Shows target in the open zone when it is the same change, lines and staged state alike; false when it is not. */
  follow(target: PeekTarget): boolean;
  close(): void;
  // renders the header again, for a change of its busy state
  refresh(): void;
}

/** One quick diff peek per editor; opening another change moves it there. */
export function attachPeek(editor: MonacoEditor.IStandaloneCodeEditor, monaco: Monaco, header: PeekHeader, label: () => string, onClosed: () => void, closeLabel: string): Peek {
  let current: { target: PeekTarget; zone: DiffZone; original: MonacoEditor.ITextModel } | null = null;
  // Escape in the editor closes an open peek, as it closes VS Code's dirty diff peek, after the widgets Escape closes first
  const peekOpen = editor.createContextKey<boolean>('damoclesQuickDiffPeekOpen', false);
  const escape = editor.addAction({
    id: 'damocles.quickDiff.closePeek',
    label: closeLabel,
    precondition: 'damoclesQuickDiffPeekOpen',
    keybindingContext: '!suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible',
    keybindings: [monaco.KeyCode.Escape],
    run: () => close(),
  });

  function remove(animate: boolean): void {
    if (!current) return;
    const { zone, original } = current;
    current = null;
    peekOpen.set(false);
    header.render(zone.header, null);
    zone.remove(animate, () => original.dispose());
  }

  function close(): void {
    if (!current) return;
    remove(true);
    onClosed();
  }

  function open(target: PeekTarget): void {
    const model = editor.getModel();
    if (!model) return;
    const moving = current !== null;
    remove(false);
    const start = Math.max(1, target.change.modifiedStartLineNumber);
    const original = monaco.editor.createModel(target.original, model.getLanguageId());
    const zone = mountDiffZone(editor, monaco, {
      afterLine: changeKind(target.change) === 'deleted' ? target.change.modifiedStartLineNumber : modifiedEndLine(target.change),
      bodyLines: zoneBodyLines(modifiedEndLine(target.change) - start + 1),
      label: label(),
      testId: 'quick-diff-peek',
      moving,
      className: `qd-peek-${changeKind(target.change)}`,
      original,
      modified: model,
      reveal: start,
      onEscape: () => {
        close();
        editor.focus();
      },
    });
    current = { target, zone, original };
    peekOpen.set(true);
    header.render(zone.header, target);
    editor.revealLineInCenterIfOutsideViewport(modifiedEndLine(target.change));
  }

  const modelChange = editor.onDidChangeModel(() => {
    if (!current) return;
    remove(false);
    onClosed();
  });

  // The zone stays, so the inline diff keeps its scroll and nothing fades; only the original side's text can differ.
  function follow(target: PeekTarget): boolean {
    if (!current || current.target.staged !== target.staged || !sameChange(current.target.change, target.change)) return false;
    if (current.original.getValue() !== target.original) current.original.setValue(target.original);
    current = { ...current, target };
    header.render(current.zone.header, target);
    return true;
  }

  return {
    target: () => current?.target ?? null,
    open,
    follow,
    close,
    refresh() {
      if (current) header.render(current.zone.header, current.target);
    },
    dispose() {
      modelChange.dispose();
      escape.dispose();
      remove(false);
    },
  };
}
