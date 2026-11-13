// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as monaco from 'monaco-editor/editor/editor.api';
import type { Monaco } from '@/components/editor/useMonaco';
import type { ShellEditorTab } from '../../preload/shell-channels';
import { createScmStore } from '../scm/scm-store';
import { attachEditorGit, type EditorGit } from '../editor/editor-git';
import { fakeScmApi, fakeShellApi, NO_CLONE, SCM_SETTINGS, type FakeShellApi } from './fakes';

// A code tab's file links and history context: the lines a permalink names, the unsaved-edits flag, whether the links are
// offered, and that tabs of one repository share one history context.

const created: Array<{ host: HTMLElement; editor: monaco.editor.IStandaloneCodeEditor; git: EditorGit }> = [];
afterEach(() => {
  for (const { host, editor, git } of created.splice(0)) {
    git.dispose();
    editor.dispose();
    host.remove();
  }
  vi.restoreAllMocks();
});

const tab = (repoId: string, path: string): ShellEditorTab => ({ id: `${repoId}:${path}`, kind: 'code', title: path, displayPath: path, dirty: false, readOnly: false, conflict: false, git: { repoId, path } }) as unknown as ShellEditorTab;

async function attach(modified = false): Promise<{ editor: monaco.editor.IStandaloneCodeEditor; git: EditorGit; shell: FakeShellApi; model: monaco.editor.ITextModel }> {
  // happy-dom has no canvas, which Monaco's overview ruler draws on once a frame runs; any drawing call does nothing
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => undefined, set: () => true }) as never);
  const host = document.createElement('div');
  document.body.append(host);
  const model = monaco.editor.createModel(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n'));
  const editor = monaco.editor.create(host, { model });
  const shell = fakeShellApi();
  shell.forge.contexts.set('r1', { kind: 'github', serverName: 'github.com', showAvatars: false });
  const store = createScmStore(fakeScmApi({ views: [], snapshots: [], decorations: [], settings: SCM_SETTINGS, clone: NO_CLONE }));
  await store.start();
  const git = attachEditorGit(editor, monaco as unknown as Monaco, {
    api: shell,
    scm: store,
    t: (key) => key,
    locale: () => 'en',
    appContext: null,
    flush: () => undefined,
    shortcuts: () => ({ next: '', previous: '' }),
    onQuickDiff: () => undefined,
    onBlameEnabled: () => undefined,
    modified: () => modified,
  });
  created.push({ host, editor, git });
  return { editor, git, shell, model };
}

describe('a code tab\'s file links', () => {
  it('links the selection\'s lines, and the caret\'s line when nothing is selected', async () => {
    const { editor, git, shell, model } = await attach();
    git.bind(tab('r1', 'src/a.ts'), model);
    editor.setSelection({ startLineNumber: 3, startColumn: 2, endLineNumber: 7, endColumn: 4 });
    await git.run('copyPermalink');
    expect(shell.forge.link).toHaveBeenLastCalledWith({ action: 'copyPermalink', repoId: 'r1', path: 'src/a.ts', startLine: 3, endLine: 7 });
    editor.setPosition({ lineNumber: 5, column: 1 });
    await git.run('openFileOnServer');
    expect(shell.forge.link).toHaveBeenLastCalledWith({ action: 'openFile', repoId: 'r1', path: 'src/a.ts', startLine: 5, endLine: 5 });
  });

  it('tells main the buffer holds unsaved edits, so the lines may not match', async () => {
    const { git, shell, model } = await attach(true);
    git.bind(tab('r1', 'src/a.ts'), model);
    await git.run('copyPermalink');
    expect(shell.forge.link).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'copyPermalink', modified: true }));
  });

  it('offers the links only once a remote is known to be on a server with an account', async () => {
    const { git, shell, model } = await attach();
    expect(git.hasForge()).toBe(false);
    git.bind(tab('r1', 'src/a.ts'), model);
    await vi.waitFor(() => expect(git.hasForge()).toBe(true));
    shell.forge.contexts.delete('r1');
    shell.forge.changed({});
    await vi.waitFor(() => expect(git.hasForge()).toBe(false));
  });

  it('reads the history context once for the tabs of one repository, and again for another repository', async () => {
    const { git, shell, model } = await attach();
    git.bind(tab('r1', 'src/a.ts'), model);
    git.bind(tab('r1', 'src/b.ts'), model);
    await vi.waitFor(() => expect(git.hasForge()).toBe(true));
    expect(shell.forge.historyContext).toHaveBeenCalledTimes(1);
    git.bind(tab('r2', 'src/a.ts'), model);
    await vi.waitFor(() => expect(shell.forge.historyContext).toHaveBeenCalledTimes(2));
    expect(shell.forge.historyContext).toHaveBeenLastCalledWith('r2');
  });
});
