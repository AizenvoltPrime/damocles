import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import type { LineChange } from '@shared/scm/apply-line-changes';
import type { Monaco } from '@/components/editor/useMonaco';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import { visibleText } from '@shared/visible-text';
import type { ScmBlameCommit, ScmBlameResult } from '../../preload/scm-channels';
import { bufferToOriginalLine } from './quick-diff/quick-diff-compute';
import type { QuickDiffState } from './quick-diff/quick-diff-model';

// Inline blame on the cursor line (B31), as VS Code's extensions/git/src/blame.ts maps it and Zed shows it at the line's end.

// ms the cursor rests on a line before its blame shows (Zed's inline blame delay)
export const BLAME_REST_MS = 300;
// ms the .qd-blame-in fade plays (o-fade's length in style.css); then the class goes, so showing the widget again stays still
export const BLAME_FADE_MS = 300;
// ms the pointer may travel from the blame text onto its card before the card hides
const CARD_HIDE_DELAY_MS = 240;

export type LineBlame =
  | { readonly kind: 'uncommitted' }
  | { readonly kind: 'staged' }
  | { readonly kind: 'commit'; readonly commit: ScmBlameCommit };

const inside = (line: number, changes: readonly LineChange[]): boolean =>
  changes.some((change) => change.modifiedEndLineNumber !== 0 && line >= change.modifiedStartLineNumber && line <= change.modifiedEndLineNumber);

/**
 * The cursor line's blame (blame.ts updateTextEditorBlameInformation): a line inside an unstaged change is not committed,
 * one inside a staged change is staged, any other maps through HEAD → buffer to HEAD's line. quick null: no diff to map
 * through, so nothing shows, except in a file HEAD lacks, where every line is not committed.
 */
export function lineBlame(line: number, quick: QuickDiffState | null, blame: ScmBlameResult | null): LineBlame | null {
  if (blame && !blame.ok && blame.reason === 'notCommitted') return { kind: 'uncommitted' };
  if (!quick) return null;
  if (inside(line, quick.primary)) return { kind: 'uncommitted' };
  if (quick.headText !== null && inside(line, quick.head)) return { kind: 'staged' };
  if (!blame?.ok) return null;
  const headLine = bufferToOriginalLine(line, quick.head);
  const index = headLine === null ? undefined : blame.lines[headLine - 1];
  const commit = index === undefined ? undefined : blame.commits[index];
  return commit ? { kind: 'commit', commit } : null;
}

export interface BlameText {
  readonly uncommitted: string;
  readonly staged: string;
  readonly line: (commit: ScmBlameCommit, ago: string) => string;
  readonly ago: (time: number) => string;
}

/** The end-of-line text: "Maria, 2 days ago • Tighten CORS", or You, Not Committed Yet. The commit's text is repository text. */
export function blameText(blame: LineBlame, text: BlameText): string {
  if (blame.kind === 'uncommitted') return text.uncommitted;
  if (blame.kind === 'staged') return text.staged;
  const { commit } = blame;
  return text.line({ ...commit, author: visibleText(commit.author), summary: visibleText(commit.summary) }, text.ago(commit.authorTime));
}

export interface BlameController extends IDisposable {
  /** Turns blame on for a file, or off with null; enabled follows the setting. */
  bind(target: { readonly read: () => Promise<ScmBlameResult>; readonly quick: () => QuickDiffState | null } | null): void;
  setEnabled(enabled: boolean): void;
  /** The quick diff changed: the shown line's blame is mapped again. */
  refreshLine(): void;
  /** HEAD moved: the blame is read again for the next line shown. */
  invalidate(): void;
  /** The blame on screen, with its line, or null. */
  shown(): { readonly line: number; readonly blame: LineBlame } | null;
  /** The pointer and focus left the card: it hides after the delay that lets the pointer come back to the text. */
  cardLeft(): void;
}

export interface BlameCardHost {
  show(anchor: { readonly line: number; readonly element: HTMLElement }, commit: ScmBlameCommit): void;
  hide(): void;
  // the card holds the pointer or focus, so it stays
  held(): boolean;
}

/**
 * Shows the cursor line's blame after BLAME_REST_MS without moving the cursor, read once per HEAD commit (main caches by
 * commit too) and mapped through the quick diff, and opens the card while the pointer is over the text. The text is a
 * content widget at the line's end, so it never shifts the line's own layout and keeps its node while the line scrolls.
 * It takes no pointer events (.qd-blame), so clicks and drags on it reach the editor as on VS Code's after decoration, and
 * the pointer over it is found from the editor's own mouse moves.
 */
export function attachBlame(editor: MonacoEditor.ICodeEditor, monaco: Monaco, text: BlameText, card: BlameCardHost): BlameController {
  let target: { readonly read: () => Promise<ScmBlameResult>; readonly quick: () => QuickDiffState | null } | null = null;
  let enabled = true;
  let result: ScmBlameResult | null = null;
  let reading: Promise<ScmBlameResult> | null = null;
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let shown: { line: number; blame: LineBlame; content: string } | null = null;
  let serial = 0;
  let pointerOver = false;
  const node = document.createElement('span');
  node.className = 'qd-blame';
  node.dataset['testid'] = 'inline-blame';
  let widget: MonacoEditor.IContentWidget | null = null;
  // the code's line box, so the smaller blame text centres on the line instead of sitting at its top
  const fitLineHeight = (): void => {
    node.style.lineHeight = `${editor.getOption(monaco.editor.EditorOption.lineHeight)}px`;
  };
  fitLineHeight();

  function clear(): void {
    clearTimeout(restTimer);
    clearTimeout(fadeTimer);
    shown = null;
    pointerOver = false;
    if (widget) editor.removeContentWidget(widget);
    widget = null;
    card.hide();
  }

  function draw(fading: boolean): void {
    if (!shown) return;
    const model = editor.getModel();
    if (!model || shown.line > model.getLineCount()) return;
    const position = { lineNumber: shown.line, column: model.getLineMaxColumn(shown.line) };
    node.textContent = shown.content;
    node.classList.toggle('qd-blame-in', fading);
    if (widget) {
      editor.removeContentWidget(widget);
      widget = null;
    }
    widget = {
      getId: () => 'damocles.inlineBlame',
      getDomNode: () => node,
      getPosition: () => ({ position, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] }),
    };
    editor.addContentWidget(widget);
  }

  async function show(line: number, asked: number): Promise<void> {
    if (!target) return;
    const quick = target.quick();
    if (result === null) {
      reading ??= target.read();
      const read = reading;
      const answer = await read.catch((): ScmBlameResult => ({ ok: false, reason: 'failed' }));
      if (reading === read) reading = null;
      if (asked !== serial) return;
      result = answer;
    }
    const blame = lineBlame(line, quick, result);
    if (!blame) {
      clear();
      return;
    }
    const content = blameText(blame, text);
    if (shown?.line === line && shown.content === content) return;
    shown = { line, blame, content };
    const fading = !prefersReducedMotion();
    draw(fading);
    clearTimeout(fadeTimer);
    // the fade has played; a later show of the widget (the line scrolled back in) stays still
    if (fading) fadeTimer = setTimeout(() => node.classList.remove('qd-blame-in'), BLAME_FADE_MS);
  }

  function schedule(): void {
    clearTimeout(restTimer);
    const asked = ++serial;
    const line = editor.getPosition()?.lineNumber;
    if (!enabled || !target || line === undefined) {
      clear();
      return;
    }
    // Moving off the line hides its blame at once; the new line's waits for the rest.
    if (shown && shown.line !== line) clear();
    restTimer = setTimeout(() => void show(line, asked), BLAME_REST_MS);
  }

  // the card stays while the text or the card holds the pointer, whichever one it last left
  function hideSoon(): void {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!pointerOver && !card.held()) card.hide();
    }, CARD_HIDE_DELAY_MS);
  }

  // the pointer is in the text's box over the code area, so not over a scrollbar, the minimap or a widget drawn above it
  function overText(event: MonacoEditor.IEditorMouseEvent): boolean {
    const { type } = event.target;
    if (!widget || (type !== monaco.editor.MouseTargetType.CONTENT_TEXT && type !== monaco.editor.MouseTargetType.CONTENT_EMPTY)) return false;
    const box = node.getBoundingClientRect();
    const { clientX: x, clientY: y } = event.event.browserEvent;
    return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
  }

  // entering the text opens the card and leaving it starts the hide delay, as mouseenter and mouseleave would
  function pointerMoved(event: MonacoEditor.IEditorMouseEvent): void {
    const over = overText(event);
    if (over === pointerOver) return;
    pointerOver = over;
    if (!over) {
      hideSoon();
      return;
    }
    if (shown?.blame.kind !== 'commit') return;
    clearTimeout(hideTimer);
    card.show({ line: shown.line, element: node }, shown.blame.commit);
  }

  const disposables: IDisposable[] = [
    editor.onDidChangeCursorPosition(schedule),
    editor.onMouseMove(pointerMoved),
    editor.onDidChangeModel(() => {
      result = null;
      clear();
    }),
    // Typing moves the line's text; the blame follows once the cursor rests again.
    editor.onDidChangeModelContent(() => clear()),
    editor.onMouseLeave(() => {
      pointerOver = false;
      hideSoon();
    }),
    editor.onDidChangeConfiguration((event) => {
      if (event.hasChanged(monaco.editor.EditorOption.lineHeight)) fitLineHeight();
    }),
  ];

  return {
    bind(next) {
      target = next;
      result = null;
      reading = null;
      clear();
      schedule();
    },
    setEnabled(next) {
      enabled = next;
      schedule();
    },
    refreshLine() {
      if (shown) void show(shown.line, serial);
      else schedule();
    },
    shown: () => (shown ? { line: shown.line, blame: shown.blame } : null),
    cardLeft: hideSoon,
    invalidate() {
      result = null;
      reading = null;
      if (shown) void show(shown.line, serial);
    },
    dispose() {
      clearTimeout(restTimer);
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
      for (const disposable of disposables) disposable.dispose();
      clear();
    },
  };
}
