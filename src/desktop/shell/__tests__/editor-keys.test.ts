// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as monaco from 'monaco-editor/editor/editor.api';
import { addEditorGitKeybindings, editorChordLabels } from '../editor/editor-keys';

const LABELS = { nextChange: 'Next', previousChange: 'Previous', stageSelectedRanges: 'Stage', unstageSelectedRanges: 'Unstage', revertSelectedRanges: 'Revert' };

// Real Monaco: the bindings must stay in the editor they were added to and end with it.
const created: Array<{ host: HTMLElement; editor: monaco.editor.IStandaloneCodeEditor }> = [];
afterEach(() => {
  for (const { host, editor } of created.splice(0)) {
    editor.dispose();
    host.remove();
  }
});

function create(): monaco.editor.IStandaloneCodeEditor {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = monaco.editor.create(host, { value: 'one\ntwo\n' });
  created.push({ host, editor });
  return editor;
}

// Alt+F5 pressed in the editor's own input, as the keybinding service reads it
function pressNextChange(editor: monaco.editor.IStandaloneCodeEditor): void {
  editor.focus();
  const input = editor.getDomNode()!.querySelector('textarea')!;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', code: 'F5', keyCode: 116, altKey: true, bubbles: true, cancelable: true }));
}

describe('editor git keybindings', () => {
  it('fire only in the editor they were added to', () => {
    const first = create();
    const second = create();
    const run = vi.fn();
    addEditorGitKeybindings(first, monaco, LABELS, run);
    pressNextChange(second);
    expect(run).not.toHaveBeenCalled();
    pressNextChange(first);
    expect(run).toHaveBeenCalledExactlyOnceWith('nextChange');
  });

  it('end when disposed, so an editor mounted again holds one binding per key', () => {
    const run = vi.fn();
    const before = create();
    addEditorGitKeybindings(before, monaco, LABELS, run).dispose();
    const again = create();
    addEditorGitKeybindings(again, monaco, LABELS, run);
    pressNextChange(again);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('write the peek\'s keys per platform', () => {
    expect(editorChordLabels('win32')).toEqual({ next: 'Alt+F5', previous: 'Shift+Alt+F5' });
    expect(editorChordLabels('darwin')).toEqual({ next: '⌥F5', previous: '⇧⌥F5' });
  });
});
