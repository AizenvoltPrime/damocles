import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import type { OverlayClipboardAction, OverlayMenuItem, OverlayRect } from '../../preload/overlay-channels';
import type { DamoclesShellApi, EditorMenuShortcut } from '../../preload/shell-channels';
import { tidyMenu } from '../../preload/overlay-channels';
import type { Monaco } from './monaco';

// VS Code's editor context menu as far as this page's language services fill it, in its group order (goToCommands.js,
// rename.js, multicursor.js). The go-to commands show only where their provider exists, as their menu `when` says.
const GO_TO: ReadonlyArray<{ readonly id: string; readonly item: EditorMenuShortcut; readonly provider: 'definitions' | 'references' }> = [
  { id: 'editor.action.revealDefinition', item: 'goToDefinition', provider: 'definitions' },
  { id: 'editor.action.goToReferences', item: 'goToReferences', provider: 'references' },
];
// Editor actions whose precondition is their menu `when` (editorExtensions.js withDefaults).
const EDITS: ReadonlyArray<{ readonly id: string; readonly item: EditorMenuShortcut }> = [
  { id: 'editor.action.rename', item: 'renameSymbol' },
  { id: 'editor.action.changeAll', item: 'changeAllOccurrences' },
];
const MONACO_COMMANDS: ReadonlySet<string> = new Set([...GO_TO, ...EDITS].map((entry) => entry.id));

export interface EditorContextMenuDeps {
  readonly api: Pick<DamoclesShellApi, 'requestOverlay' | 'showCommands'>;
  readonly t: (key: string) => string;
  readonly shortcuts: () => Readonly<Record<EditorMenuShortcut, string>>;
  readonly hasGoToProvider: (languageId: string, kind: 'definitions' | 'references') => boolean;
  // the registry's Format Document (D29); available is read each time the menu opens, since an editor shows one tab after another
  readonly formatDocument?: { readonly available: () => boolean; readonly run: () => Promise<void> };
}

/** The editor context menu for the model `target` shows. */
export function editorContextMenuItems(target: MonacoEditor.ICodeEditor, monaco: Monaco, deps: EditorContextMenuDeps): OverlayMenuItem[] {
  const shortcuts = deps.shortcuts();
  const item = (id: string, key: EditorMenuShortcut, clipboard?: OverlayClipboardAction): OverlayMenuItem => ({
    kind: 'item', id, label: deps.t(`editor.contextMenu.${key}`), shortcut: shortcuts[key], ...(clipboard !== undefined ? { clipboard } : {}),
  });
  const languageId = target.getModel()?.getLanguageId() ?? '';
  const writable = !target.getOption(monaco.editor.EditorOption.readOnly);
  const separator: OverlayMenuItem = { kind: 'separator' };
  return tidyMenu([
    ...GO_TO.flatMap((entry) => (deps.hasGoToProvider(languageId, entry.provider) ? [item(entry.id, entry.item)] : [])),
    separator,
    ...EDITS.flatMap((entry) => (target.getAction(entry.id)?.isSupported() ? [item(entry.id, entry.item)] : [])),
    ...(deps.formatDocument?.available() ? [item('formatDocument', 'formatDocument')] : []),
    separator,
    // Main runs these itself on the user's pick, on this page while it has keyboard focus.
    ...(writable ? [item('cut', 'cut', 'cut')] : []),
    item('copy', 'copy', 'copy'),
    ...(writable ? [item('paste', 'paste', 'paste')] : []),
    separator,
    item('commandPalette', 'commandPalette'),
  ]);
}

async function runItem(target: MonacoEditor.ICodeEditor, id: string, deps: EditorContextMenuDeps): Promise<void> {
  // Main gives the page keyboard focus back before the overlay's answer arrives; Monaco's commands check the editor's text focus.
  target.focus();
  if (id === 'formatDocument') await deps.formatDocument?.run();
  else if (id === 'commandPalette') await deps.api.showCommands();
  // trigger also reaches the go-to commands, which Monaco registers as commands rather than editor actions
  else if (MONACO_COMMANDS.has(id)) target.trigger('contextMenu', id, null);
}

/**
 * Replaces Monaco's in-page context menu with the overlay's (menus render in the top-most overlay view, AD1): a right click
 * on the text and the context menu key or Shift+F10 open it. The editor must be created with `contextmenu: false`.
 */
export function attachEditorContextMenu(target: MonacoEditor.ICodeEditor, monaco: Monaco, deps: EditorContextMenuDeps): IDisposable {
  const textTargets: ReadonlySet<MonacoEditor.MouseTargetType> = new Set([
    monaco.editor.MouseTargetType.CONTENT_TEXT,
    monaco.editor.MouseTargetType.CONTENT_EMPTY,
    monaco.editor.MouseTargetType.TEXTAREA,
  ]);
  const open = async (anchor: OverlayRect): Promise<void> => {
    const model = target.getModel();
    if (!model) return;
    const answer = await deps.api.requestOverlay({
      kind: 'menu',
      label: deps.t('editor.contextMenu.label'),
      anchor: { x: Math.max(0, anchor.x), y: Math.max(0, anchor.y), width: anchor.width, height: anchor.height },
      items: editorContextMenuItems(target, monaco, deps),
    });
    // The editor may show another file by now (an agent's open switches the active tab); the pick was for this one.
    if (answer.kind === 'menu' && target.getModel() === model) await runItem(target, answer.itemId, deps);
  };
  const mouse = target.onContextMenu((event) => {
    if (!textTargets.has(event.target.type)) return;
    event.event.preventDefault();
    // As VS Code's ContextMenuController does before it reads the menu: the preconditions need text focus, and a click
    // outside every selection moves the caret there.
    target.focus();
    const clicked = event.target.position;
    if (clicked && !target.getSelections()?.some((selection) => selection.containsPosition(clicked))) target.setPosition(clicked);
    const { clientX, clientY } = event.event.browserEvent;
    void open({ x: clientX, y: clientY, width: 0, height: 0 });
  });
  const keyboard = target.onKeyDown((event) => {
    const shiftF10 = event.keyCode === monaco.KeyCode.F10 && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
    if (event.keyCode !== monaco.KeyCode.ContextMenu && !shiftF10) return;
    event.preventDefault();
    event.stopPropagation();
    const position = target.getPosition();
    const caret = position ? target.getScrolledVisiblePosition(position) : null;
    const box = target.getDomNode()?.getBoundingClientRect();
    if (!caret || !box) return;
    void open({ x: box.left + caret.left, y: box.top + caret.top, width: 0, height: caret.height });
  });
  return { dispose: () => { mouse.dispose(); keyboard.dispose(); } };
}
