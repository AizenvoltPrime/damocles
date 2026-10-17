// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as monaco from 'monaco-editor/editor/editor.api';
import { attachPeek, type PeekTarget } from '../editor/quick-diff/peek';

// Real Monaco for the peek's zone and its Escape key; its inline diff editor is a double, since no diff worker runs here.
vi.spyOn(monaco.editor, 'createDiffEditor').mockImplementation(() => ({
  setModel: () => undefined,
  onDidUpdateDiff: () => ({ dispose: () => undefined }),
  getModifiedEditor: () => ({ revealLineInCenter: () => undefined }),
  dispose: () => undefined,
}) as unknown as monaco.editor.IStandaloneDiffEditor);
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
  const editor = monaco.editor.create(host, { value: 'one\nTWO\nthree\n' });
  created.push({ host, editor });
  return editor;
}

const change = { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 };
const target = (original: string, staged = false): PeekTarget => ({ change, original, staged });

function peekOn(editor: monaco.editor.IStandaloneCodeEditor) {
  const render = vi.fn();
  const peek = attachPeek(editor, monaco, { render }, () => 'Changes', () => undefined, 'Close');
  return { peek, render };
}

function pressEscape(editor: monaco.editor.IStandaloneCodeEditor): void {
  editor.focus();
  const input = editor.getDomNode()!.querySelector('textarea')!;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
}

const zones = (editor: monaco.editor.IStandaloneCodeEditor): HTMLElement[] => [...editor.getDomNode()!.querySelectorAll<HTMLElement>('[data-testid="quick-diff-peek"]')];

describe('the quick diff peek', () => {
  it('follows its change in place, keeping its zone, when the change keeps its lines and staged state', () => {
    const editor = create();
    const { peek, render } = peekOn(editor);
    peek.open(target('one\ntwo\nthree\n'));
    const [zone] = zones(editor);
    expect(peek.follow(target('one\ntwo\nthree\nfour\n'))).toBe(true);
    expect(zones(editor)).toEqual([zone]);
    expect(peek.target()?.original).toBe('one\ntwo\nthree\nfour\n');
    expect(render).toHaveBeenLastCalledWith(zone!.querySelector('.qd-peek-header'), peek.target());
    expect(peek.follow(target('one\ntwo\nthree\n', true))).toBe(false);
    peek.dispose();
  });

  it('closes on Escape, but leaves Escape to an open suggest, find or parameter hints widget', () => {
    const editor = create();
    const { peek } = peekOn(editor);
    peek.open(target('one\ntwo\nthree\n'));
    const suggest = editor.createContextKey<boolean>('suggestWidgetVisible', true);
    pressEscape(editor);
    expect(peek.target()).not.toBeNull();
    suggest.set(false);
    pressEscape(editor);
    expect(peek.target()).toBeNull();
    peek.dispose();
  });

  it('binds its Escape in its own editor only', () => {
    const first = create();
    const second = create();
    const { peek } = peekOn(first);
    peek.open(target('one\ntwo\nthree\n'));
    pressEscape(second);
    expect(peek.target()).not.toBeNull();
    peek.dispose();
  });
});
