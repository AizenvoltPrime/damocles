import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { editor as MonacoEditor, IDisposable, languages } from 'monaco-editor/editor/editor.api';
import type { Monaco } from '@/components/editor/useMonaco';
import { attachConflictLens, CONFLICT_SCAN_DELAY_MS } from '../editor/merge/code-lens';

const CONFLICT = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\n';

let provider: languages.CodeLensProvider | undefined;
const commands = new Map<string, (accessor: unknown, ...args: unknown[]) => void>();
const monaco = {
  editor: { registerCommand: (id: string, run: (accessor: unknown, ...args: unknown[]) => void) => commands.set(id, run) },
  languages: {
    registerCodeLensProvider: (_selector: string, registered: languages.CodeLensProvider) => {
      provider = registered;
      return { dispose: () => undefined };
    },
  },
} as unknown as Monaco;

class FakeModel {
  readonly uri = { toString: () => 'damocles-document://doc-1/c.txt' };
  reads = 0;
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  getValue(): string {
    this.reads++;
    return this.text;
  }
  getLineMaxColumn(): number {
    return 1;
  }
}

let nextEditor = 0;
// A code editor double: its model, its content listeners and the decorations it is given.
function fakeEditor(model: FakeModel) {
  const contentListeners = new Set<() => void>();
  const decorations: unknown[][] = [];
  const id = `editor-${++nextEditor}`;
  const editor = {
    getId: () => id,
    getModel: () => model,
    hasWidgetFocus: () => false,
    createDecorationsCollection: () => ({ set: (list: unknown[]) => decorations.push(list), clear: () => decorations.push([]) }),
    onDidChangeModel: (): IDisposable => ({ dispose: () => undefined }),
    onDidChangeModelContent: (listener: () => void): IDisposable => {
      contentListeners.add(listener);
      return { dispose: () => contentListeners.delete(listener) };
    },
  };
  const type = (text: string): void => {
    model.text = text;
    for (const listener of [...contentListeners]) listener();
  };
  return { editor: editor as unknown as MonacoEditor.ICodeEditor, type, decorations };
}

const deps = { t: (key: string) => key, appContext: null, sideTints: true };
const lensesOf = async (model: FakeModel): Promise<number> => {
  const list = await provider!.provideCodeLenses(model as unknown as MonacoEditor.ITextModel, { isCancellationRequested: false } as never);
  return list?.lenses.length ?? 0;
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('inline conflict lenses', () => {
  it('keep showing in one editor of a model when another editor of the same model goes', async () => {
    const model = new FakeModel(CONFLICT);
    const code = attachConflictLens(fakeEditor(model).editor, monaco, deps);
    const result = attachConflictLens(fakeEditor(model).editor, monaco, deps);
    code.setEnabled(true);
    result.setEnabled(true);
    expect(await lensesOf(model)).toBe(4);
    result.dispose();
    expect(await lensesOf(model)).toBe(4);
    code.dispose();
    expect(await lensesOf(model)).toBe(0);
  });

  it('scan the text once typing pauses, not on every keystroke', () => {
    const model = new FakeModel('plain\n');
    const { editor, type, decorations } = fakeEditor(model);
    const lens = attachConflictLens(editor, monaco, deps);
    lens.setEnabled(true);
    const reads = model.reads;
    for (const text of ['p', 'pl', 'pla', CONFLICT]) type(text);
    expect(model.reads).toBe(reads);
    vi.advanceTimersByTime(CONFLICT_SCAN_DELAY_MS);
    expect(model.reads).toBeGreaterThan(reads);
    expect(decorations.at(-1)!.length).toBeGreaterThan(0);
    lens.dispose();
  });
});
