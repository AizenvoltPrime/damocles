import { describe, expect, it, vi } from 'vitest';
import type { editor as MonacoEditor } from 'monaco-editor/editor/editor.api';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import { attachEditorContextMenu, editorContextMenuItems, type EditorContextMenuDeps } from '../editor/context-menu';
import type { Monaco } from '../editor/monaco';
import { STATE } from './fakes';

const READ_ONLY_OPTION = 1;
const CONTENT_TEXT = 6;
const SCROLLBAR = 11;
const monaco = {
  editor: { EditorOption: { readOnly: READ_ONLY_OPTION }, MouseTargetType: { CONTENT_TEXT, CONTENT_EMPTY: 7, TEXTAREA: 1 } },
  KeyCode: { F10: 68, ContextMenu: 58 },
} as unknown as Monaco;

// A code editor double: `supported` names the editor actions whose precondition holds.
function fakeEditor(opts: { readOnly?: boolean; supported?: readonly string[]; language?: string } = {}) {
  const trigger = vi.fn();
  let onContextMenu: ((event: unknown) => void) | undefined;
  let model = { getLanguageId: () => opts.language ?? 'typescript' };
  const editor = {
    getModel: () => model,
    getOption: (option: number) => (option === READ_ONLY_OPTION ? opts.readOnly === true : undefined),
    getAction: (id: string) => ({ isSupported: () => opts.supported?.includes(id) === true }),
    trigger,
    focus: vi.fn(),
    onContextMenu: (listener: (event: unknown) => void) => {
      onContextMenu = listener;
      return { dispose: () => {} };
    },
    onKeyDown: () => ({ dispose: () => {} }),
  };
  const rightClick = (type: number): { preventDefault: ReturnType<typeof vi.fn> } => {
    const event = { preventDefault: vi.fn(), browserEvent: { clientX: 40, clientY: 50 } };
    onContextMenu!({ target: { type }, event });
    return event;
  };
  // Another tab's model, as an agent's open switches the active tab under the editor.
  const showAnotherModel = (): void => { model = { getLanguageId: () => 'typescript' }; };
  return { editor: editor as unknown as MonacoEditor.ICodeEditor, focus: editor.focus, trigger, rightClick, showAnotherModel };
}

function deps(answer: OverlayAnswer = { kind: 'dismissed' }, formatAvailable?: boolean) {
  const requestOverlay = vi.fn(async (_request: OverlayRequest) => answer);
  const format = vi.fn(async () => {});
  const value: EditorContextMenuDeps = {
    api: { requestOverlay, showCommands: vi.fn(async () => {}) },
    t: (key) => key.replace('editor.contextMenu.', ''),
    shortcuts: () => STATE.shortcuts.editorMenu,
    hasGoToProvider: (languageId) => languageId === 'typescript',
    ...(formatAvailable === undefined ? {} : { formatDocument: { available: () => formatAvailable, run: format } }),
  };
  return { value, requestOverlay, format };
}

const labels = (items: ReturnType<typeof editorContextMenuItems>): string[] => items.map((item) => (item.kind === 'item' ? item.label : '---'));

describe('editor context menu', () => {
  it('lists the go-to commands, the supported edits, Format Document and the clipboard in VS Code\'s order, with their keys', () => {
    const { editor } = fakeEditor({ supported: ['editor.action.rename', 'editor.action.changeAll'] });
    const items = editorContextMenuItems(editor, monaco, deps(undefined, true).value);
    expect(labels(items)).toEqual(['goToDefinition', 'goToReferences', '---', 'renameSymbol', 'changeAllOccurrences', 'formatDocument', '---', 'cut', 'copy', 'paste', '---', 'commandPalette']);
    expect(items[0]).toEqual({ kind: 'item', id: 'editor.action.revealDefinition', label: 'goToDefinition', shortcut: 'F12' });
    // Main runs a clipboard item itself on the pick; the page has no clipboard call.
    expect(items.flatMap((item) => (item.kind === 'item' && item.clipboard ? [[item.id, item.clipboard]] : []))).toEqual([['cut', 'cut'], ['copy', 'copy'], ['paste', 'paste']]);
  });

  it('offers only Copy and the palette in a read-only buffer of a language without a service', () => {
    const { editor } = fakeEditor({ readOnly: true, language: 'log' });
    expect(labels(editorContextMenuItems(editor, monaco, deps(undefined, false).value))).toEqual(['copy', '---', 'commandPalette']);
  });

  it('opens on a right click on the text at the pointer and runs the chosen command after focusing the editor', async () => {
    const { editor, focus, trigger, rightClick } = fakeEditor();
    const menu = deps({ kind: 'menu', itemId: 'editor.action.revealDefinition' });
    attachEditorContextMenu(editor, monaco, menu.value);
    expect(rightClick(SCROLLBAR).preventDefault).not.toHaveBeenCalled();
    expect(menu.requestOverlay).not.toHaveBeenCalled();
    expect(rightClick(CONTENT_TEXT).preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(trigger).toHaveBeenCalledWith('contextMenu', 'editor.action.revealDefinition', null));
    expect(menu.requestOverlay.mock.calls[0]![0]).toMatchObject({ kind: 'menu', label: 'label', anchor: { x: 40, y: 50, width: 0, height: 0 } });
    expect(focus).toHaveBeenCalled();
  });

  it.each([
    ['commandPalette', (menu: ReturnType<typeof deps>) => expect(menu.value.api.showCommands).toHaveBeenCalled()],
    ['formatDocument', (menu: ReturnType<typeof deps>) => expect(menu.format).toHaveBeenCalled()],
  ])('routes %s to its host command', async (itemId, check) => {
    const { editor, trigger, rightClick } = fakeEditor();
    const menu = deps({ kind: 'menu', itemId }, true);
    attachEditorContextMenu(editor, monaco, menu.value);
    rightClick(CONTENT_TEXT);
    await vi.waitFor(() => check(menu));
    expect(trigger).not.toHaveBeenCalled();
  });

  it('runs nothing when the editor shows another model by the time the pick arrives', async () => {
    const { editor, focus, trigger, rightClick, showAnotherModel } = fakeEditor();
    let answer: (value: OverlayAnswer) => void = () => {};
    const menu = deps();
    menu.requestOverlay.mockImplementation(() => new Promise<OverlayAnswer>((resolve) => { answer = resolve; }));
    attachEditorContextMenu(editor, monaco, menu.value);
    rightClick(CONTENT_TEXT);
    await vi.waitFor(() => expect(menu.requestOverlay).toHaveBeenCalled());
    showAnotherModel();
    answer({ kind: 'menu', itemId: 'editor.action.rename' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trigger).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it.each(['cut', 'copy', 'paste'])('leaves %s to main, focusing the editor and running nothing', async (itemId) => {
    const { editor, focus, trigger, rightClick } = fakeEditor();
    const menu = deps({ kind: 'menu', itemId }, true);
    attachEditorContextMenu(editor, monaco, menu.value);
    rightClick(CONTENT_TEXT);
    await vi.waitFor(() => expect(focus).toHaveBeenCalledTimes(2));
    expect(trigger).not.toHaveBeenCalled();
    expect(menu.value.api.showCommands).not.toHaveBeenCalled();
    expect(menu.format).not.toHaveBeenCalled();
  });
});
