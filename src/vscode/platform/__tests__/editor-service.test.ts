import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener<T> = (e: T) => void;

const H = vi.hoisted(() => {
  const providers = new Map<string, { provideTextDocumentContent(uri: { path: string }): string }>();
  return {
    providers,
    groups: [] as Array<{ tabs: Array<{ input: unknown }> }>,
    tabListeners: [] as Array<(e: { closed: Array<{ input: unknown }> }) => void>,
    editorListeners: [] as Array<(editor: unknown) => void>,
    selectionListeners: [] as Array<(e: { textEditor: unknown }) => void>,
    activeTextEditor: undefined as unknown,
    executeCommand: vi.fn((..._args: unknown[]) => Promise.resolve(undefined)),
    openTextDocument: vi.fn(async (arg: unknown) => ({ source: arg, getText: () => 'buffer text' })),
    showTextDocument: vi.fn((..._args: unknown[]) => Promise.resolve(undefined)),
    closeTab: vi.fn((..._args: unknown[]) => Promise.resolve(true)),
    extensions: new Map<string, { isActive: boolean }>(),
  };
});

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vscode') & Record<string, unknown>>();
  class FakeUri {
    readonly scheme: string;
    readonly path: string;
    readonly fsPath: string;
    constructor(scheme: string, path: string) {
      this.scheme = scheme;
      this.path = path;
      this.fsPath = path;
    }
    toString(): string { return `${this.scheme}:${this.path}`; }
  }
  const uri = (scheme: string, path: string) => new FakeUri(scheme, path);
  class TabInputTextDiff {
    readonly original: unknown;
    readonly modified: unknown;
    constructor(original: unknown, modified: unknown) {
      this.original = original;
      this.modified = modified;
    }
  }
  return {
    ...actual,
    TabInputTextDiff,
    Uri: {
      file: (p: string) => uri('file', p),
      // As vscode.Uri.parse: a query or fragment is cut from the path, and the path is percent-decoded.
      parse: (s: string) => {
        const i = s.indexOf(':');
        const rest = s.slice(i + 1);
        const cut = rest.search(/[?#]/);
        return uri(s.slice(0, i), decodeURIComponent(cut < 0 ? rest : rest.slice(0, cut)));
      },
      from: ({ scheme, path }: { scheme: string; path: string }) => uri(scheme, path),
    },
    commands: { ...actual.commands, executeCommand: H.executeCommand },
    extensions: { getExtension: (id: string) => H.extensions.get(id) },
    workspace: {
      ...actual.workspace,
      registerTextDocumentContentProvider: (scheme: string, provider: { provideTextDocumentContent(uri: { path: string }): string }) => {
        H.providers.set(scheme, provider);
        return { dispose: () => H.providers.delete(scheme) };
      },
      openTextDocument: H.openTextDocument,
    },
    window: {
      ...actual.window,
      showTextDocument: H.showTextDocument,
      get activeTextEditor() { return H.activeTextEditor; },
      onDidChangeActiveTextEditor: (cb: Listener<unknown>) => { H.editorListeners.push(cb); return { dispose: () => H.editorListeners.splice(H.editorListeners.indexOf(cb), 1) }; },
      onDidChangeTextEditorSelection: (cb: Listener<{ textEditor: unknown }>) => { H.selectionListeners.push(cb); return { dispose: () => H.selectionListeners.splice(H.selectionListeners.indexOf(cb), 1) }; },
      tabGroups: {
        get all() { return H.groups; },
        onDidChangeTabs: (cb: Listener<{ closed: Array<{ input: unknown }> }>) => { H.tabListeners.push(cb); return { dispose: () => undefined }; },
        close: H.closeTab,
      },
    },
  };
});

import * as vscode from 'vscode';
import { createVsCodeEditorService } from '../editor-service';
import type { EditorService } from '../../../platform/editor-service';

const TabInputTextDiff = (vscode as unknown as { TabInputTextDiff: new (o: unknown, m: unknown) => { original: { scheme: string; path: string }; modified: unknown } }).TabInputTextDiff;
const content = (scheme: string, path: string) => H.providers.get(scheme)!.provideTextDocumentContent({ path });
const diffTab = (original: unknown, modified: unknown) => ({ input: new TabInputTextDiff(original, modified) });
const lastDiffArgs = () => H.executeCommand.mock.calls.filter((c) => c[0] === 'vscode.diff').at(-1)!;

function editor(scheme: string, fsPath: string, selection: { empty: boolean; start: number; end: number } = { empty: true, start: 0, end: 0 }) {
  return {
    document: {
      uri: { scheme, fsPath },
      getText: (range: unknown) => (range ? 'selected text' : 'whole'),
    },
    selection: { isEmpty: selection.empty, start: { line: selection.start }, end: { line: selection.end } },
  };
}

let service: EditorService;
let subscriptions: Array<{ dispose(): void }>;

beforeEach(() => {
  H.providers.clear();
  H.groups = [];
  H.tabListeners.length = 0;
  H.editorListeners.length = 0;
  H.selectionListeners.length = 0;
  H.activeTextEditor = undefined;
  H.extensions.clear();
  H.executeCommand.mockClear();
  H.openTextDocument.mockClear();
  H.showTextDocument.mockClear();
  H.closeTab.mockClear();
  subscriptions = [];
  service = createVsCodeEditorService(subscriptions);
});

describe('openFile', () => {
  it('opens the default editor for the file type through vscode.open, with no options when no line is given', async () => {
    await service.openFile('/ws/a.png');

    expect(H.executeCommand).toHaveBeenCalledWith('vscode.open', vscode.Uri.file('/ws/a.png'), undefined);
  });

  it('puts the cursor at the start of a 1-based line', async () => {
    await service.openFile('/ws/a.ts', { line: 12 });

    expect(H.executeCommand).toHaveBeenCalledWith('vscode.open', vscode.Uri.file('/ws/a.ts'), { selection: new vscode.Range(11, 0, 11, 0) });
  });

  it('opens the text editor as a pinned tab', async () => {
    await service.openFile('/logs/s.jsonl', { editor: 'text', preview: false });

    expect(H.openTextDocument).toHaveBeenCalledWith(vscode.Uri.file('/logs/s.jsonl'));
    expect(H.showTextDocument).toHaveBeenCalledWith(expect.objectContaining({ source: vscode.Uri.file('/logs/s.jsonl') }), { preview: false });
    expect(H.executeCommand).not.toHaveBeenCalled();
  });

  it('opens the text editor at a line', async () => {
    await service.openFile('/ws/b.ts', { editor: 'text', line: 3 });

    expect(H.showTextDocument).toHaveBeenCalledWith(expect.anything(), { selection: new vscode.Range(2, 0, 2, 0) });
  });

  it('ignores the originating panel', async () => {
    await service.openFile('/ws/a.png', { panelId: 'host-1' });
    await service.openFile('/ws/b.ts', { editor: 'text', line: 3, panelId: 'host-1' });
    await service.openUntitled('<div></div>', 'html', { panelId: 'host-1' });

    expect(H.executeCommand).toHaveBeenCalledWith('vscode.open', vscode.Uri.file('/ws/a.png'), undefined);
    expect(H.showTextDocument).toHaveBeenNthCalledWith(1, expect.anything(), { selection: new vscode.Range(2, 0, 2, 0) });
    expect(H.showTextDocument).toHaveBeenNthCalledWith(2, expect.anything(), { preview: true });
  });
});

describe('documents', () => {
  it('opens an untitled document of the language as a preview', async () => {
    await service.openUntitled('<div></div>', 'html');

    expect(H.openTextDocument).toHaveBeenCalledWith({ content: '<div></div>', language: 'html' });
    expect(H.showTextDocument).toHaveBeenCalledWith(expect.anything(), { preview: true });
  });

  it('reads the text the editor holds for a file', async () => {
    await expect(service.readText('/ws/a.ts')).resolves.toBe('buffer text');
    expect(H.openTextDocument).toHaveBeenCalledWith(vscode.Uri.file('/ws/a.ts'));
  });

  it('shows the markdown preview of a file', async () => {
    await service.showMarkdownPreview('/tmp/damocles-x.md');

    expect(H.executeCommand).toHaveBeenCalledWith('markdown.showPreview', vscode.Uri.file('/tmp/damocles-x.md'));
  });
});

describe('showDiff, proposal', () => {
  const proposal = {
    title: 'a.ts (Current ↔ Proposed)',
    left: { name: 'd1-original-a.ts', content: 'old' },
    right: { name: 'd1-proposed-a.ts', content: 'new' },
    purpose: 'proposal' as const,
    column: 1,
    preserveFocus: false,
  };

  it('serves both sides under claude-diff and opens them in the first column with focus', async () => {
    await service.showDiff({ ...proposal, panelId: 'host-1', approvalId: 'd1' });

    const [, left, right, title, options] = lastDiffArgs();
    expect(String(left)).toBe('claude-diff:/d1-original-a.ts');
    expect(String(right)).toBe('claude-diff:/d1-proposed-a.ts');
    expect(title).toBe('a.ts (Current ↔ Proposed)');
    expect(options).toEqual({ viewColumn: 1, preserveFocus: false });
    expect(content('claude-diff', '/d1-original-a.ts')).toBe('old');
    expect(content('claude-diff', '/d1-proposed-a.ts')).toBe('new');
  });

  it('serves a side whose file name holds #, ? or %, which a parsed URI would cut or decode', async () => {
    await service.showDiff({ ...proposal, left: { name: 'd2-original-a#1?x%41.ts', content: 'old' }, right: { name: 'd2-proposed-a#1?x%41.ts', content: 'new' } });

    const [, left, right] = lastDiffArgs() as [unknown, { path: string }, { path: string }];
    const provider = H.providers.get('claude-diff')!;
    expect(provider.provideTextDocumentContent(left)).toBe('old');
    expect(provider.provideTextDocumentContent(right)).toBe('new');
  });

  it('keeps the text after its tab closes, until close() closes the tab showing the proposed side and releases both', async () => {
    const view = await service.showDiff(proposal);
    const other = diffTab(vscode.Uri.parse('claude-diff:/d0-original-b.ts'), vscode.Uri.parse('claude-diff:/d0-proposed-b.ts'));
    const mine = diffTab(vscode.Uri.parse('claude-diff:/d1-original-a.ts'), vscode.Uri.parse('claude-diff:/d1-proposed-a.ts'));
    H.tabListeners.forEach((cb) => cb({ closed: [mine] }));
    expect(content('claude-diff', '/d1-original-a.ts')).toBe('old');

    H.groups = [{ tabs: [other, mine] }];
    await view.close();

    expect(H.closeTab).toHaveBeenCalledTimes(1);
    expect(H.closeTab).toHaveBeenCalledWith(mine);
    expect(content('claude-diff', '/d1-original-a.ts')).toBe('');
    expect(content('claude-diff', '/d1-proposed-a.ts')).toBe('');
  });

  it('releases both texts and rethrows when the diff cannot be opened', async () => {
    H.executeCommand.mockRejectedValueOnce(new Error('no diff editor'));

    await expect(service.showDiff(proposal)).rejects.toThrow('no diff editor');

    expect(content('claude-diff', '/d1-original-a.ts')).toBe('');
    expect(content('claude-diff', '/d1-proposed-a.ts')).toBe('');
  });

  it('keeps the text when closing the tab fails', async () => {
    const view = await service.showDiff(proposal);
    H.groups = [{ tabs: [diffTab(vscode.Uri.parse('claude-diff:/d1-original-a.ts'), vscode.Uri.parse('claude-diff:/d1-proposed-a.ts'))] }];
    H.closeTab.mockRejectedValueOnce(new Error('tab gone'));

    await expect(view.close()).rejects.toThrow('tab gone');
    expect(content('claude-diff', '/d1-proposed-a.ts')).toBe('new');
  });
});

describe('showDiff, checkpoint', () => {
  const checkpoint = (name: string) => ({
    title: 'a.ts (At checkpoint ↔ Current)',
    left: { name, content: `before ${name}` },
    right: { path: '/ws/a.ts' },
    purpose: 'checkpoint' as const,
    preview: true,
  });

  it('serves the checkpoint side under damocles-rewind beside the file, as a preview', async () => {
    await service.showDiff(checkpoint('c1-a.ts'));

    const [, left, right, , options] = lastDiffArgs();
    expect(String(left)).toBe('damocles-rewind:/c1-a.ts');
    expect(right).toEqual(vscode.Uri.file('/ws/a.ts'));
    expect(options).toEqual({ preview: true });
    expect(content('damocles-rewind', '/c1-a.ts')).toBe('before c1-a.ts');
  });

  it('releases the text when its tab closes', async () => {
    await service.showDiff(checkpoint('c1-a.ts'));

    H.tabListeners.forEach((cb) => cb({ closed: [diffTab(vscode.Uri.parse('damocles-rewind:/c1-a.ts'), vscode.Uri.file('/ws/a.ts'))] }));

    expect(content('damocles-rewind', '/c1-a.ts')).toBe('');
  });

  it('drops text whose tab is no longer open before showing the next checkpoint diff', async () => {
    await service.showDiff(checkpoint('c1-a.ts'));
    await service.showDiff(checkpoint('c2-a.ts'));
    H.groups = [{ tabs: [diffTab(vscode.Uri.parse('damocles-rewind:/c2-a.ts'), vscode.Uri.file('/ws/a.ts'))] }];

    await service.showDiff(checkpoint('c3-a.ts'));

    expect(content('damocles-rewind', '/c1-a.ts')).toBe('');
    expect(content('damocles-rewind', '/c2-a.ts')).toBe('before c2-a.ts');
    expect(content('damocles-rewind', '/c3-a.ts')).toBe('before c3-a.ts');
  });

  it('never drops proposal text when reconciling checkpoint tabs', async () => {
    await service.showDiff({ title: 't', left: { name: 'p-original-a.ts', content: 'old' }, right: { name: 'p-proposed-a.ts', content: 'new' }, purpose: 'proposal' });

    await service.showDiff(checkpoint('c1-a.ts'));

    expect(content('claude-diff', '/p-original-a.ts')).toBe('old');
  });

  it('hands both content provider registrations and the tab listener to the subscriptions', () => {
    expect(subscriptions).toHaveLength(3);
    subscriptions.forEach((d) => d.dispose());
    expect(H.providers.size).toBe(0);
  });
});

describe('active editor context', () => {
  it('reports a file with no selection, and a selection with 1-based lines and its text', () => {
    H.activeTextEditor = editor('file', '/ws/a.ts');
    expect(service.getActiveContext()).toEqual({ filePath: '/ws/a.ts', selection: undefined });

    H.activeTextEditor = editor('file', '/ws/a.ts', { empty: false, start: 4, end: 6 });
    expect(service.getActiveContext()).toEqual({ filePath: '/ws/a.ts', selection: { startLine: 5, endLine: 7, text: 'selected text' } });
  });

  it('reports no file for a document that is not on disk, and nothing for no editor or a webview document', () => {
    H.activeTextEditor = editor('untitled', 'Untitled-1');
    expect(service.getActiveContext()).toEqual({ filePath: undefined, selection: undefined });

    H.activeTextEditor = undefined;
    expect(service.getActiveContext()).toBeUndefined();

    H.activeTextEditor = editor('vscode-webview', '/x');
    expect(service.getActiveContext()).toBeUndefined();
  });

  it('fires with the context of the editor that changed, from both editor and selection events, until disposed', () => {
    const seen: unknown[] = [];
    const subscription = service.onDidChangeActiveContext((c) => seen.push(c));

    H.editorListeners.forEach((cb) => cb(editor('file', '/ws/a.ts')));
    H.editorListeners.forEach((cb) => cb(undefined));
    H.selectionListeners.forEach((cb) => cb({ textEditor: editor('file', '/ws/b.ts', { empty: false, start: 0, end: 0 }) }));
    subscription.dispose();
    H.editorListeners.forEach((cb) => cb(editor('file', '/ws/c.ts')));

    expect(seen).toEqual([
      { filePath: '/ws/a.ts', selection: undefined },
      undefined,
      { filePath: '/ws/b.ts', selection: { startLine: 1, endLine: 1, text: 'selected text' } },
    ]);
  });
});

describe('host settings and extensions', () => {
  it('opens the settings filtered by the query', async () => {
    await service.openHostSettings('damocles.browser.devToolsPort');

    expect(H.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', 'damocles.browser.devToolsPort');
  });

  it('answers whether an extension is installed and active, and searches the extensions view', async () => {
    H.extensions.set('ms-vscode.vscode-speech', { isActive: true });
    H.extensions.set('inactive.ext', { isActive: false });

    expect(service.isHostExtensionActive('ms-vscode.vscode-speech')).toBe(true);
    expect(service.isHostExtensionActive('inactive.ext')).toBe(false);
    expect(service.isHostExtensionActive('missing.ext')).toBe(false);

    await service.searchHostExtensions('@id:ms-vscode.vscode-speech');
    expect(H.executeCommand).toHaveBeenCalledWith('workbench.extensions.search', '@id:ms-vscode.vscode-speech');
  });
});
