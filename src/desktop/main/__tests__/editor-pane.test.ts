import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { ActiveEditorContext } from '../../../platform/editor-service';
import type { ShellEditorState, ShellEditorTab } from '../../preload/shell-channels';
import type { BackupRecord } from '../documents/backups';
import type { Project } from '../documents/confine';
import { DocumentService, type TextDocument } from '../documents/document-service';
import { EditorPane, selectionText, settingLine, type BrowserTabSource, type PersistedEditor } from '../editor-pane';
import type { MessageQuestion } from '../message-dialog';

let root: string;
let projectDir: string;
let project: Project;
let platform: FakePlatform;
let documents: DocumentService;
let pane: EditorPane;
let events: string[];
let asked: MessageQuestion[];
let answers: Array<number | undefined>;
let restoreLayout: boolean;
let flushAnswer: 'answer' | 'silent' | 'noPage';
let persisted: PersistedEditor | undefined;
let backupsRemoved: string[];
let states: ShellEditorState[];
// the documents each flush asked the shell to format, and what the shell does with them
let flushFormats: string[][];
let shellFormats: (documentIds: readonly string[]) => void;
let browser: BrowserTabSource | undefined;
let warnings: string[];
// runs while a question is up, before it is answered
let whileAsking: (() => Promise<void>) | undefined;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pane-')));
  projectDir = path.join(root, 'proj');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
  platform = createFakePlatform();
  events = [];
  asked = [];
  answers = [];
  restoreLayout = true;
  flushAnswer = 'answer';
  persisted = undefined;
  backupsRemoved = [];
  states = [];
  flushFormats = [];
  shellFormats = () => undefined;
  browser = undefined;
  warnings = [];
  whileAsking = undefined;
  const ask = async (question: MessageQuestion): Promise<number | undefined> => {
    asked.push(question);
    await whileAsking?.();
    return answers.shift();
  };
  const t = (message: string, ...args: Array<string | number>): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]));
  documents = new DocumentService({
    projects: () => [project],
    watchers: platform.fileWatchers,
    ask,
    t,
    log: () => undefined,
    pickSavePath: async () => undefined,
    backups: { changed: () => undefined, writeNow: async () => undefined, remove: (id) => backupsRemoved.push(id) },
    settings: { locate: (scope) => (scope === 'user' ? path.join(root, 'settings.json') : undefined), save: async () => ({ ok: false, error: 'unused', conflict: false }) },
  });
  pane = new EditorPane({
    documents,
    settings: platform.settings,
    ask,
    t,
    log: () => undefined,
    restoreLayout: () => restoreLayout,
    persist: (editor) => { persisted = editor; },
    flushBackups: async () => { events.push('flushBackups'); },
    logsDir: path.join(root, 'logs'),
    sendState: (state) => states.push(state),
    sendDocument: (documentId) => events.push(`document:${documentId}`),
    sendCommand: (command) => events.push(`command:${command}`),
    sendFlush: (requestId, format) => {
      if (flushAnswer === 'noPage') return false;
      events.push('flush');
      flushFormats.push([...format]);
      shellFormats(format);
      if (flushAnswer === 'answer') setImmediate(() => pane.flushed(requestId));
      return true;
    },
    focusTab: (tabId) => events.push(`focus:${tabId}`),
    revealLine: (tabId, line, range) => events.push(`reveal:${tabId}:${line}${range ? `:${range.startColumn}` : ''}`),
    showPane: () => events.push('showPane'),
    showPaneBeside: () => events.push('showPaneBeside'),
    projects: () => [project],
    copy: async (text) => { events.push(`copy:${text}`); },
    reveal: async (target) => { events.push(`reveal:${target}`); },
    mention: async (target) => { events.push(`mention:${JSON.stringify(target)}`); },
    browser: () => browser,
    warn: (message) => warnings.push(message),
    searchEditorClosed: (documentId) => events.push(`searchEditorClosed:${documentId}`),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  pane.dispose();
  documents.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, content: string): string {
  const file = path.join(projectDir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// A Files rename of `from` to `to` on disk, as the file tree makes it.
function renamed(from: string, to: string) {
  return pane.fileRenamed(project.key, from, async () => {
    fs.renameSync(path.join(projectDir, ...from.split('/')), path.join(projectDir, ...to.split('/')));
    return { ok: true, relativePath: to };
  });
}

function textOf(tabId: string): TextDocument {
  const tab = pane.state().tabs.find((candidate) => candidate.id === tabId)!;
  return documents.get(tab.documentId!) as TextDocument;
}

describe('opens and focus', () => {
  it('focuses a user\'s open and never an agent\'s, and shows the pane for both', async () => {
    write('src/a.ts', 'a');
    const file = write('src/b.ts', 'b');
    const opened = await pane.openFromUser(project.key, 'src/a.ts', { line: 3 });
    if (!opened.ok) throw new Error('not opened');
    await pane.openPath(file, { focus: false });
    const agentTab = pane.state().activeTabId!;
    expect(events).toEqual(['showPane', `focus:${opened.tabId}`, `reveal:${opened.tabId}:3`, 'showPane']);
    expect(agentTab).not.toBe(opened.tabId);
  });

  it('reuses the tab already showing a document, and opens markdown as a preview or its source on request', async () => {
    write('README.md', '# hi');
    const first = await pane.openFromUser(project.key, 'README.md');
    const again = await pane.openFromUser(project.key, 'README.md');
    const preview = await pane.openFromUser(project.key, 'README.md', { as: 'preview' });
    expect(first).toEqual(again);
    expect(pane.state().tabs.map((tab) => tab.kind)).toEqual(['code', 'markdownPreview']);
    expect(preview).toMatchObject({ ok: true });
  });

  it('refuses an open outside the project and keeps recent files most recent first', async () => {
    write('a.ts', 'a');
    write('b.ts', 'b');
    expect(await pane.openFromUser(project.key, '../x')).toEqual({ ok: false, reason: 'outside' });
    await pane.openFromUser(project.key, 'a.ts');
    await pane.openFromUser(project.key, 'b.ts');
    await pane.openFromUser(project.key, 'a.ts');
    expect(pane.recentFiles()).toEqual([{ projectKey: project.key, relativePath: 'a.ts' }, { projectKey: project.key, relativePath: 'b.ts' }]);
  });
});

describe('closing dirty tabs and quitting', () => {
  it('asks Save or Don\'t Save before closing a dirty tab, keeps it when dismissed, saves on Save and discards on Don\'t Save', async () => {
    const file = write('a.ts', 'disk');
    const opened = await pane.openFromUser(project.key, 'a.ts');
    if (!opened.ok) throw new Error('not opened');
    const document = textOf(opened.tabId);
    pane.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });

    answers = [undefined];
    await pane.tabAction('close', opened.tabId);
    expect(pane.state().tabs).toHaveLength(1);

    answers = [0];
    await pane.tabAction('close', opened.tabId);
    expect(pane.state().tabs).toHaveLength(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('mine');

    const reopened = await pane.openFromUser(project.key, 'a.ts');
    if (!reopened.ok) throw new Error('not opened');
    const again = textOf(reopened.tabId);
    pane.edit(again.id, { version: again.version, seq: 1, text: 'dropped', overReload: false });
    answers = [1];
    await pane.tabAction('close', reopened.tabId);
    expect(fs.readFileSync(file, 'utf8')).toBe('mine');
    expect(asked).toHaveLength(3);
    expect(asked.map((question) => [question.actions, question.cancelLabel])).toEqual(Array(3).fill([['Save', "Don't Save"], undefined]));
  });

  it('keeps a document another tab opened while the close asked about it, so that tab still shows it', async () => {
    write('README.md', '# hi');
    const opened = await pane.openFromUser(project.key, 'README.md', { as: 'source' });
    if (!opened.ok) throw new Error('not opened');
    const document = textOf(opened.tabId);
    pane.edit(document.id, { version: document.version, seq: 1, text: '# mine', overReload: false });
    whileAsking = async () => {
      await pane.openPath(path.join(projectDir, 'README.md'), { focus: false, preview: true });
    };
    answers = [1];
    await pane.tabAction('close', opened.tabId);
    expect(pane.state().tabs.map((tab) => tab.kind)).toEqual(['markdownPreview']);
    expect(documents.get(document.id)).toBe(document);
    expect(backupsRemoved).not.toContain(document.backupId);
  });

  it('asks before an agent\'s close of a diff tab drops unsaved edits of the file only that tab shows', async () => {
    const file = write('src/app.ts', 'disk');
    const view = await pane.showDiff((name) => `${name} (At checkpoint ↔ Current)`, file, { name: 'x-app.ts', content: 'before' }, { path: file }, { focus: false });
    const diff = pane.state().tabs.find((tab) => tab.kind === 'diff')!;
    const modified = documents.get(diff.diff!.modifiedId) as TextDocument;
    pane.edit(modified.id, { version: modified.version, seq: 1, text: 'mine', overReload: false });

    answers = [undefined];
    await view.close();
    expect(asked).toHaveLength(1);
    expect(pane.state().tabs).toHaveLength(1);

    answers = [1];
    await view.close();
    expect(pane.state().tabs).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('disk');
  });

  it('with Reopen where I left off, takes the shell\'s last edits, keeps the backups and asks nothing', async () => {
    write('a.ts', 'disk');
    const opened = await pane.openFromUser(project.key, 'a.ts');
    if (!opened.ok) throw new Error('not opened');
    const document = textOf(opened.tabId);
    pane.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    expect(await pane.release()).toBe(true);
    expect(events.slice(-2)).toEqual(['flush', 'flushBackups']);
    expect(asked).toEqual([]);
    expect(persisted?.tabs).toEqual([{ kind: 'code', file: { projectKey: project.key, relativePath: 'a.ts' }, backupId: document.backupId }]);
    expect(await pane.release()).toBe(true);
  });

  it('without it, asks Save or Don\'t Save, and dismissing the question keeps the app open', async () => {
    restoreLayout = false;
    const file = write('a.ts', 'disk');
    const opened = await pane.openFromUser(project.key, 'a.ts');
    if (!opened.ok) throw new Error('not opened');
    const document = textOf(opened.tabId);
    pane.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });

    answers = [undefined];
    expect(await pane.release()).toBe(false);
    expect(pane.isReleased).toBe(false);
    expect(asked[0]).toMatchObject({ actions: ['Save', "Don't Save"], defaultAction: 0 });
    expect(asked[0]).not.toHaveProperty('cancelLabel');
    answers = [0];
    expect(await pane.release()).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('mine');
  });

  it('without it, Don\'t Save drops the buffers and their backups', async () => {
    restoreLayout = false;
    write('a.ts', 'disk');
    const opened = await pane.openFromUser(project.key, 'a.ts');
    if (!opened.ok) throw new Error('not opened');
    const document = textOf(opened.tabId);
    pane.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    answers = [1];
    expect(await pane.release()).toBe(true);
    expect(backupsRemoved).toContain(document.backupId);
    expect(pane.state().tabs).toEqual([]);
  });

  it('formats before the Save of the close and quit prompts while format on save is on, and saves what the shell formatted', async () => {
    restoreLayout = false;
    const file = write('a.ts', 'disk');
    const opened = await pane.openFromUser(project.key, 'a.ts');
    if (!opened.ok) throw new Error('not opened');
    const document = textOf(opened.tabId);
    // The shell formats its buffer and reports the result as an edit before it answers the flush.
    shellFormats = (documentIds) => {
      for (const id of documentIds) pane.edit(id, { version: document.version, seq: 9, text: 'formatted', overReload: false });
    };
    pane.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    answers = [0];
    await pane.tabAction('close', opened.tabId);
    expect(flushFormats).toEqual([[]]);
    expect(fs.readFileSync(file, 'utf8')).toBe('mine');

    await platform.settings.update('damocles.desktop.editor.formatOnSave', true, 'user');
    const again = await pane.openFromUser(project.key, 'a.ts');
    if (!again.ok) throw new Error('not opened');
    const reopened = textOf(again.tabId);
    shellFormats = (documentIds) => {
      for (const id of documentIds) pane.edit(id, { version: reopened.version, seq: 9, text: 'formatted', overReload: false });
    };
    pane.edit(reopened.id, { version: reopened.version, seq: 1, text: 'mine again', overReload: false });
    answers = [0];
    await pane.tabAction('close', again.tabId);
    expect(flushFormats.at(-1)).toEqual([reopened.id]);
    expect(fs.readFileSync(file, 'utf8')).toBe('formatted');

    const third = await pane.openFromUser(project.key, 'a.ts');
    if (!third.ok) throw new Error('not opened');
    const quitting = textOf(third.tabId);
    shellFormats = (documentIds) => {
      for (const id of documentIds) pane.edit(id, { version: quitting.version, seq: 9, text: 'formatted at quit', overReload: false });
    };
    pane.edit(quitting.id, { version: quitting.version, seq: 1, text: 'unsaved', overReload: false });
    answers = [0];
    expect(await pane.release()).toBe(true);
    expect(flushFormats.slice(-2)).toEqual([[], [quitting.id]]);
    expect(fs.readFileSync(file, 'utf8')).toBe('formatted at quit');
  });

  it('names an editable project file as a format target, and nothing else', async () => {
    write('a.ts', 'a');
    const opened = await pane.openFromUser(project.key, 'a.ts');
    if (!opened.ok) throw new Error('not opened');
    const document = textOf(opened.tabId);
    expect(pane.formatTarget(document.id)).toEqual({ path: path.join(projectDir, 'a.ts'), projectKey: project.key, relativePath: 'a.ts', name: 'a.ts', languageId: 'typescript' });
    pane.openUntitled('x', 'Untitled-1', 'typescript', { focus: false });
    const untitled = pane.state().tabs.find((tab) => tab.kind === 'untitled')!;
    expect(pane.formatTarget(untitled.documentId!)).toBeUndefined();
    const outside = path.join(root, 'outside.ts');
    fs.writeFileSync(outside, 'o');
    await pane.openPath(outside, { focus: false });
    const readOnly = pane.state().tabs.find((tab) => tab.readOnly)!;
    expect(pane.formatTarget(readOnly.documentId!)).toBeUndefined();
    expect(pane.formatTarget('not-open')).toBeUndefined();
  });

  it('goes on with the text it holds when the shell does not answer the flush, or has no page', async () => {
    flushAnswer = 'noPage';
    expect(await pane.release()).toBe(true);
  });
});

describe('restore', () => {
  it('reopens saved tabs with their backups, re-confining each, and restores untitled buffers only from a backup', async () => {
    write('a.ts', 'disk');
    const backups: BackupRecord[] = [
      { backupId: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'a.ts', languageId: 'typescript', encoding: 'utf8', bom: false, eol: '\n', text: 'unsaved', target: { kind: 'project', projectKey: project.key, relativePath: 'a.ts' } },
      { backupId: '1f8fad5b-d9cb-469f-a165-70867728950e', name: 'untitled.md', languageId: 'markdown', encoding: 'utf8', bom: false, eol: '\n', text: 'notes', target: { kind: 'untitled' } },
      { backupId: '2f8fad5b-d9cb-469f-a165-70867728950e', name: 'x.ts', languageId: 'typescript', encoding: 'utf8', bom: false, eol: '\n', text: 'x', target: { kind: 'project', projectKey: project.key, relativePath: 'gone.ts' } },
    ];
    await pane.restore({
      tabs: [
        { kind: 'code', file: { projectKey: project.key, relativePath: 'a.ts' }, backupId: '0f8fad5b-d9cb-469f-a165-70867728950e' },
        { kind: 'code', file: { projectKey: project.key, relativePath: 'missing.ts' } },
        { kind: 'untitled', backupId: '9f8fad5b-d9cb-469f-a165-70867728950e' },
      ],
      active: 0,
      recent: [{ projectKey: project.key, relativePath: 'a.ts' }],
    }, backups);
    const state = pane.state();
    expect(state.tabs.map((tab) => [tab.kind, tab.title, tab.dirty, tab.deleted])).toEqual([['code', 'a.ts', true, undefined], ['untitled', 'untitled.md', true, undefined], ['code', 'gone.ts', true, true]]);
    expect(state.activeTabId).toBe(state.tabs[0]!.id);
    expect(textOf(state.tabs[0]!.id).text).toBe('unsaved');
  });
});

describe('restoring a backup whose file cannot be reopened as it was', () => {
  const backup = (id: string, target: BackupRecord['target'], text: string, name = 'gone.ts'): BackupRecord =>
    ({ backupId: `${id}f8fad5b-d9cb-469f-a165-70867728950e`, name, languageId: 'typescript', encoding: 'utf8', bom: false, eol: '\r\n', text, target });
  // Removals of the backups restored; a fresh document's own unused backup id may go.
  const removedOf = (records: readonly BackupRecord[]): string[] => backupsRemoved.filter((id) => records.some((record) => record.backupId === id));

  it('restores the backup of a file deleted on disk as a dirty Deleted tab with its text, and a save recreates the file and its folders', async () => {
    const saved = backup('0', { kind: 'project', projectKey: project.key, relativePath: 'src/gone.ts' }, 'unsaved\r\n');
    const deep = backup('1', { kind: 'project', projectKey: project.key, relativePath: 'lib/deep/lost.ts' }, 'deep\r\n', 'lost.ts');
    await pane.restore({ tabs: [{ kind: 'code', file: { projectKey: project.key, relativePath: 'src/gone.ts' }, backupId: saved.backupId }], active: 0, recent: [] }, [saved, deep]);
    const tabs = pane.state().tabs;
    expect(tabs.map((tab) => [tab.kind, tab.title, tab.relativePath, tab.dirty, tab.deleted])).toEqual([
      ['code', 'gone.ts', 'src/gone.ts', true, true],
      ['code', 'lost.ts', 'lib/deep/lost.ts', true, true],
    ]);
    expect(textOf(tabs[0]!.id).text).toBe('unsaved\r\n');
    expect(removedOf([saved, deep])).toEqual([]);
    expect(warnings).toEqual([]);

    const gone = textOf(tabs[0]!.id);
    expect(await pane.save(gone.id, gone.version, gone.text, false)).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(projectDir, 'src', 'gone.ts'), 'utf8')).toBe('unsaved\r\n');
    const lost = textOf(tabs[1]!.id);
    expect(await pane.save(lost.id, lost.version, lost.text, false)).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(projectDir, 'lib', 'deep', 'lost.ts'), 'utf8')).toBe('deep\r\n');
    expect(pane.state().tabs.map((tab) => [tab.dirty, tab.deleted])).toEqual([[false, undefined], [false, undefined]]);
    expect(removedOf([saved, deep])).toEqual([saved.backupId, deep.backupId]);
  });

  it('brings every other backup back as an untitled buffer with its text and backup, and tells the user why', async () => {
    fs.writeFileSync(path.join(root, 'elsewhere.ts'), 'outside');
    fs.symlinkSync(root, path.join(projectDir, 'out'), 'junction');
    write('blob.bin', Buffer.from([0, 1, 2, 3]).toString('latin1'));
    const records = [
      backup('0', { kind: 'project', projectKey: 'removed-project', relativePath: 'a.ts' }, 'removed', 'a.ts'),
      backup('1', { kind: 'project', projectKey: project.key, relativePath: 'out/elsewhere.ts' }, 'outside text', 'elsewhere.ts'),
      backup('2', { kind: 'project', projectKey: project.key, relativePath: 'blob.bin' }, 'now text', 'blob.bin'),
      backup('3', { kind: 'settings', scope: 'project', path: path.join(projectDir, '.damocles', 'settings.json') }, '{ "a": 1 }', 'settings.json'),
    ];
    await pane.restore({ tabs: [{ kind: 'code', file: { projectKey: 'removed-project', relativePath: 'a.ts' }, backupId: records[0]!.backupId }], active: 0, recent: [] }, records);
    const tabs = pane.state().tabs;
    expect(tabs.map((tab) => [tab.kind, tab.title, tab.dirty])).toEqual([
      ['untitled', 'a.ts', true], ['untitled', 'elsewhere.ts', true], ['untitled', 'blob.bin', true], ['untitled', 'settings.json', true],
    ]);
    expect(tabs.map((tab) => textOf(tab.id).text)).toEqual(['removed', 'outside text', 'now text', '{ "a": 1 }']);
    expect(tabs.map((tab) => textOf(tab.id).backupId)).toEqual(records.map((record) => record.backupId));
    expect(removedOf(records)).toEqual([]);
    expect(warnings).toHaveLength(4);
    for (const [index, name] of ['a.ts', 'elsewhere.ts', 'blob.bin', 'settings.json'].entries()) expect(warnings[index]).toContain(name);
    // blob.bin opened only to be refused; no document is left behind without a tab.
    expect(documents.all().filter((document) => !tabs.some((tab) => tab.documentId === document.id))).toEqual([]);
  });

  it('keeps a second backup of the same file as an untitled buffer instead of overwriting the first', async () => {
    write('a.ts', 'disk');
    const first = backup('0', { kind: 'project', projectKey: project.key, relativePath: 'a.ts' }, 'first', 'a.ts');
    const second = backup('1', { kind: 'project', projectKey: project.key, relativePath: 'a.ts' }, 'second', 'a.ts');
    await pane.restore({ tabs: [], active: null, recent: [] }, [first, second]);
    const tabs = pane.state().tabs;
    expect(tabs.map((tab) => [tab.kind, textOf(tab.id).text, textOf(tab.id).backupId])).toEqual([['code', 'first', first.backupId], ['untitled', 'second', second.backupId]]);
    expect(removedOf([first, second])).toEqual([]);
  });
});

describe('restoring settings buffers', () => {
  it('restores a settings backup into the file it came from, and one whose scope names another file now as an untitled buffer', async () => {
    fs.writeFileSync(path.join(root, 'settings.json'), '{}');
    const record = (backupId: string, filePath: string): BackupRecord => ({
      backupId, name: 'settings.json', languageId: 'json', encoding: 'utf8', bom: false, eol: '\n', text: '{ "a": 1 }', target: { kind: 'settings', scope: 'user', path: filePath },
    });
    await pane.restore({ tabs: [], active: null, recent: [] }, [
      record('0f8fad5b-d9cb-469f-a165-70867728950e', path.join(root, 'elsewhere', 'settings.json')),
      record('1f8fad5b-d9cb-469f-a165-70867728950e', path.join(root, 'settings.json')),
    ]);
    const tabs = pane.state().tabs;
    expect(tabs.map((tab) => [tab.kind, tab.settingsScope, tab.dirty])).toEqual([['untitled', undefined, true], ['settings', 'user', true]]);
    expect(warnings).toEqual(['The unsaved changes to settings.json are in an untitled editor: That settings file does not apply now.']);
  });
});

describe('IDE context', () => {
  it('follows the active text tab and its selection, and clears when no tab is left', async () => {
    const file = write('src/a.ts', 'line one\nline two\nline three\n');
    const contexts: Array<ActiveEditorContext | undefined> = [];
    pane.onDidChangeActiveContext((context) => contexts.push(context));
    const opened = await pane.openFromUser(project.key, 'src/a.ts');
    if (!opened.ok) throw new Error('not opened');
    pane.select(textOf(opened.tabId).id, { startLine: 2, startColumn: 6, endLine: 3, endColumn: 5 });
    await pane.tabAction('close', opened.tabId);
    expect(contexts).toEqual([
      { filePath: file, selection: undefined },
      { filePath: file, selection: { startLine: 2, endLine: 3, text: 'two\nline' } },
      { filePath: undefined, selection: undefined },
    ]);
  });

  it('extracts backward and one-line selections, and nothing for a caret', () => {
    expect(selectionText('abc\ndef', { startLine: 2, startColumn: 3, endLine: 1, endColumn: 2 })).toEqual({ startLine: 1, endLine: 2, text: 'bc\nde' });
    expect(selectionText('abcdef', { startLine: 1, startColumn: 2, endLine: 1, endColumn: 4 })).toEqual({ startLine: 1, endLine: 1, text: 'bc' });
    expect(selectionText('abc', { startLine: 1, startColumn: 2, endLine: 1, endColumn: 2 })).toBeUndefined();
  });
});

describe('settings and logs', () => {
  it('finds a setting key\'s line, else the closing brace', () => {
    expect(settingLine('{\n  "a": 1,\n  "damocles.desktop.files.exclude": {}\n}\n', 'damocles.desktop.files.exclude')).toBe(3);
    expect(settingLine('{\n  "a": 1\n}\n', 'damocles.x')).toBe(3);
  });

  it('opens a log read-only, never dirty', async () => {
    fs.mkdirSync(path.join(root, 'logs'));
    fs.writeFileSync(path.join(root, 'logs', 'Damocles.log'), 'line\n');
    await pane.openLog(path.join(root, 'logs', 'Damocles.log'), true);
    expect(pane.state().tabs[0]).toMatchObject({ kind: 'log', readOnly: true, readOnlyReason: 'log', dirty: false });
  });
});

// The selected chat's pages as browser-tabs.ts lists them; closing one is the page's own close.
function pages(ids: string[]): BrowserTabSource & { ids: string[]; closed: string[]; active: Array<string | null> } {
  const source = {
    ids: [...ids],
    closed: [] as string[],
    active: [] as Array<string | null>,
    tabs: (): ShellEditorTab[] => source.ids.map((id) => ({
      id,
      kind: 'browser',
      title: id,
      displayPath: `https://${id}.example/`,
      dirty: false,
      readOnly: false,
      conflict: false,
      browser: { url: `https://${id}.example/`, loading: false, canGoBack: false, canGoForward: false, picking: false },
    })),
    close: (id: string) => {
      source.closed.push(id);
      source.ids = source.ids.filter((other) => other !== id);
    },
    activeChanged: (id: string | null) => {
      source.active.push(id);
    },
  };
  return source;
}

describe('page tabs (D14)', () => {
  it('lists the selected chat\'s page tabs after the file tabs, activates one without focus and republishes them without persisting', async () => {
    write('a.ts', 'a');
    const source = pages(['p1', 'p2']);
    browser = source;
    const opened = await pane.openFromUser(project.key, 'a.ts');
    if (!opened.ok) throw new Error('not opened');
    events.length = 0;
    pane.activateBrowserTab('p2');
    await new Promise((resolve) => setImmediate(resolve));
    expect(pane.state().tabs.map((tab) => tab.id)).toEqual([opened.tabId, 'p1', 'p2']);
    expect(pane.activeTabId()).toBe('p2');
    expect(source.active.at(-1)).toBe('p2');
    expect(events).toEqual(['showPane']);
    expect(pane.activeContext()).toEqual({ filePath: undefined, selection: undefined });

    const saved = persisted;
    persisted = undefined;
    pane.browserTabsChanged();
    await new Promise((resolve) => setImmediate(resolve));
    expect(states.at(-1)?.activeTabId).toBe('p2');
    expect(persisted).toBeUndefined();
    expect(saved?.active).toBeNull();
  });

  it('cycles through file and page tabs, and counts page tabs as tabs', async () => {
    write('a.ts', 'a');
    const source = pages(['p1']);
    browser = source;
    expect(pane.hasTabs()).toBe(true);
    const opened = await pane.openFromUser(project.key, 'a.ts');
    if (!opened.ok) throw new Error('not opened');
    pane.cycle(1);
    expect(pane.activeTabId()).toBe('p1');
    pane.cycle(1);
    expect(pane.activeTabId()).toBe(opened.tabId);
    expect(events.filter((event) => event.startsWith('focus:'))).toEqual([`focus:${opened.tabId}`, 'focus:p1', `focus:${opened.tabId}`]);
  });

  it('activates and closes a page tab through its page, and Close others and Close all reach the page tabs too', async () => {
    write('a.ts', 'a');
    write('b.ts', 'b');
    const source = pages(['p1', 'p2']);
    browser = source;
    const a = await pane.openFromUser(project.key, 'a.ts');
    const b = await pane.openFromUser(project.key, 'b.ts');
    if (!a.ok || !b.ok) throw new Error('not opened');
    await pane.tabAction('activate', 'p1');
    expect(pane.activeTabId()).toBe('p1');
    await pane.tabAction('copyPath', 'p1');
    expect(events.some((event) => event.startsWith('copy:'))).toBe(false);
    await pane.tabAction('close', 'p1');
    expect(source.closed).toEqual(['p1']);
    await pane.tabAction('closeOthers', a.tabId);
    expect(source.closed).toEqual(['p1', 'p2']);
    expect(pane.state().tabs.map((tab) => tab.id)).toEqual([a.tabId]);
    await expect(pane.tabAction('activate', 'gone')).rejects.toThrow('Unknown tab');
  });

  it('falls back to the file tab activated last when the active page tab leaves', async () => {
    write('a.ts', 'a');
    write('b.ts', 'b');
    const source = pages(['p1']);
    browser = source;
    const a = await pane.openFromUser(project.key, 'a.ts');
    const b = await pane.openFromUser(project.key, 'b.ts');
    if (!a.ok || !b.ok) throw new Error('not opened');
    await pane.tabAction('activate', a.tabId);
    pane.activateBrowserTab('p1');
    pane.leaveBrowserTab();
    expect(pane.activeTabId()).toBe(a.tabId);
    await pane.tabAction('close', a.tabId);
    expect(pane.activeTabId()).toBe(b.tabId);
    await pane.tabAction('close', b.tabId);
    expect(pane.activeTabId()).toBe('p1');
  });
});

describe('Search Editor tabs', () => {
  const config = { query: 'needle', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false, contextLines: 1, showIncludesExcludes: false };

  it('shows a Search Editor with VS Code\'s title, its config and project, dirty only after an edit while untitled', async () => {
    const document = documents.openSearchEditor(project.key, config, '', { dirty: false });
    pane.showSearchEditor(document, { focus: false });
    await new Promise((resolve) => setImmediate(resolve));
    const tab = pane.state().tabs.at(-1)!;
    expect(tab).toMatchObject({ kind: 'searchEditor', title: 'Search: needle', projectKey: project.key, dirty: false, searchEditor: { config, running: false, untitled: true } });
    documents.setSearchEditorResults(document.id, '1 result - 1 file\n');
    expect(pane.state().tabs.at(-1)!.dirty).toBe(false);
    pane.edit(document.id, { version: document.version, seq: 1, text: 'edited', overReload: false });
    expect(pane.state().tabs.at(-1)!.dirty).toBe(true);
    documents.setSearchEditorConfig(document.id, { ...config, query: 'a much longer query' });
    expect(pane.state().tabs.at(-1)!.title).toBe('Search: a much lo...');
    expect(pane.state().tabs.at(-1)!.displayPath).toBe('a much longer query.code-search');
    expect(pane.formatTarget(document.id)).toBeUndefined();
  });

  it('keeps an untitled Search Editor by its header and its dirty backup, a saved one by its file, and restores both', async () => {
    write('q.code-search', '# Query: saved\n\n1 result - 1 file\n');
    const untitled = documents.openSearchEditor(project.key, config, '', { dirty: false });
    pane.showSearchEditor(untitled, { focus: false });
    await pane.openFromUser(project.key, 'q.code-search');
    await new Promise((resolve) => setImmediate(resolve));
    expect(persisted?.tabs).toEqual([
      { kind: 'searchEditor', projectKey: project.key, config },
      { kind: 'searchEditor', file: { projectKey: project.key, relativePath: 'q.code-search' } },
    ]);
    const saved = persisted!;
    await pane.restore(saved, [
      { backupId: '3f8fad5b-d9cb-469f-a165-70867728950e', name: 'x', languageId: 'search-result', encoding: 'utf8', bom: false, eol: '\n', text: '# Query: backed\n\nbody', target: { kind: 'searchEditor', projectKey: 'gone' } },
    ]);
    const tabs = pane.state().tabs.filter((tab) => tab.kind === 'searchEditor').slice(-3);
    expect(tabs.map((tab) => [tab.title, tab.searchEditor?.config.query, tab.searchEditor?.message?.kind, tab.projectKey])).toEqual([
      ['Search: needle', 'needle', 'stale', project.key],
      ['Search: q', 'saved', undefined, project.key],
      ['Search: backed', 'backed', undefined, undefined],
    ]);
  });
});

describe('Files renames and deletes', () => {
  it('retargets each tab at or under a renamed path in place, keeping its id, order, active tab, buffer, layout and recent files, without focus', async () => {
    write('src/notes.txt', 'one');
    write('src/b.ts', 'b');
    write('README.md', '# r');
    const notes = await pane.openFromUser(project.key, 'src/notes.txt');
    const preview = await pane.openFromUser(project.key, 'README.md', { as: 'preview' });
    const other = await pane.openFromUser(project.key, 'src/b.ts');
    if (!notes.ok || !preview.ok || !other.ok) throw new Error('not opened');
    pane.edit(textOf(notes.tabId).id, { version: 1, seq: 1, text: 'one, edited', overReload: false });
    await pane.tabAction('activate', notes.tabId);
    const before = pane.state().tabs.map((tab) => tab.id);
    events.length = 0;

    await renamed('src', 'lib');
    await new Promise((resolve) => setImmediate(resolve));
    const state = pane.state();
    expect(state.tabs.map((tab) => tab.id)).toEqual(before);
    expect(state.activeTabId).toBe(notes.tabId);
    expect(state.tabs.map((tab) => [tab.title, tab.relativePath, tab.dirty])).toEqual([
      ['notes.txt', 'lib/notes.txt', true],
      ['README.md', 'README.md', false],
      ['b.ts', 'lib/b.ts', false],
    ]);
    expect(textOf(notes.tabId).text).toBe('one, edited');
    expect(events.filter((event) => event.startsWith('focus:'))).toEqual([]);
    expect(persisted?.tabs.map((tab) => ('file' in tab ? tab.file.relativePath : undefined))).toEqual(['lib/notes.txt', 'README.md', 'lib/b.ts']);
    expect(pane.recentFiles().map((file) => file.relativePath)).toEqual(['lib/b.ts', 'README.md', 'lib/notes.txt']);

    await renamed('lib/notes.txt', 'lib/renamed.ts');
    expect(pane.state().tabs[0]).toMatchObject({ id: notes.tabId, title: 'renamed.ts', relativePath: 'lib/renamed.ts', dirty: true });
    expect(pane.state().documents[textOf(notes.tabId).id]).toEqual({ name: 'renamed.ts', path: path.join(projectDir, 'lib', 'renamed.ts'), languageId: 'typescript' });
  });

  it('keeps one tab, renamed, for a New File renamed while its open is still in flight, and a click on the new name shows that tab', async () => {
    const fresh = write('fresh.ts', '');
    const original = fs.promises.stat.bind(fs.promises);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding = true;
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (file, options) => {
      if (holding && String(file) === fresh) {
        holding = false;
        await held;
      }
      return original(file, options as never) as never;
    });
    const opening = pane.openFromUser(project.key, 'fresh.ts');
    await waitUntil(() => !holding);
    const renaming = renamed('fresh.ts', 'renamed.ts');
    release();
    const opened = await opening;
    await renaming;
    const again = await pane.openFromUser(project.key, 'renamed.ts');
    if (!opened.ok || !again.ok) throw new Error('not opened');
    expect(again.tabId).toBe(opened.tabId);
    expect(pane.state().tabs.map((tab) => [tab.title, tab.relativePath, tab.deleted])).toEqual([['renamed.ts', 'renamed.ts', undefined]]);
  });

  it('marks a deleted file\'s tab deleted and clean, closes it without asking, and clears the mark once the file is back', async () => {
    const file = write('src/a.ts', 'a');
    const opened = await pane.openFromUser(project.key, 'src/a.ts');
    if (!opened.ok) throw new Error('not opened');
    const watcher = platform.fileWatchers.watcher(path.dirname(file), '*');
    fs.rmSync(file);
    watcher.fireDelete(file);
    await waitUntil(() => pane.state().tabs[0]?.deleted === true);
    expect(pane.state().tabs[0]).toMatchObject({ deleted: true, dirty: false });
    fs.writeFileSync(file, 'a');
    watcher.fireCreate(file);
    await waitUntil(() => pane.state().tabs[0]?.deleted === undefined);
    fs.rmSync(file);
    watcher.fireDelete(file);
    await waitUntil(() => pane.state().tabs[0]?.deleted === true);
    await pane.tabAction('close', opened.tabId);
    expect(asked).toEqual([]);
    expect(pane.state().tabs).toEqual([]);
  });

  it('titles every diff tab after its file\'s current name and path through a Files rename, keeping a snapshot side\'s text', async () => {
    const file = write('src/app.ts', 'disk');
    const titled = (label: string) => (name: string): string => `${name} (${label})`;
    await pane.showDiff(titled('At checkpoint ↔ Current'), file, { name: 'x-app.ts', content: 'before' }, { path: file }, { focus: false });
    await pane.showDiff(titled('Current ↔ Proposed'), file, { name: 'p-original-app.ts', content: 'disk' }, { name: 'p-proposed-app.ts', content: 'proposed' }, { focus: false });
    pane.openReplacePreview({ projectKey: project.key, relativePath: 'src/app.ts' }, 'disk', 'replaced');
    const opened = await pane.openFromUser(project.key, 'src/app.ts');
    if (!opened.ok) throw new Error('not opened');
    const document = textOf(opened.tabId);
    pane.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    fs.writeFileSync(file, 'theirs');
    await pane.save(document.id, document.version, 'mine', false);
    await pane.conflict(document.id, 'compare');
    const diffs = (): ShellEditorTab[] => pane.state().tabs.filter((tab) => tab.kind === 'diff');
    expect(diffs().map((tab) => tab.title)).toEqual(['app.ts (At checkpoint ↔ Current)', 'app.ts (Current ↔ Proposed)', 'app.ts ↔ app.ts (Replace Preview)', 'app.ts (On disk ↔ Yours)']);

    const renamed = path.join(projectDir, 'src', 'main.ts');
    await pane.fileRenamed(project.key, 'src/app.ts', async () => {
      fs.renameSync(file, renamed);
      return { ok: true, relativePath: 'src/main.ts' };
    });
    expect(diffs().map((tab) => [tab.title, tab.relativePath, tab.displayPath])).toEqual([
      ['main.ts (At checkpoint ↔ Current)', 'src/main.ts', renamed],
      ['main.ts (Current ↔ Proposed)', 'src/main.ts', renamed],
      ['main.ts ↔ main.ts (Replace Preview)', 'src/main.ts', renamed],
      ['main.ts (On disk ↔ Yours)', 'src/main.ts', renamed],
    ]);
    // A snapshot side keeps the text it was given.
    expect((documents.get(diffs()[0]!.diff!.originalId) as TextDocument).text).toBe('before');
    expect((documents.get(diffs()[1]!.diff!.modifiedId) as TextDocument).text).toBe('proposed');

    // The file's next replace preview takes over the moved one's tab.
    pane.openReplacePreview({ projectKey: project.key, relativePath: 'src/main.ts' }, 'theirs', 'again');
    await new Promise((resolve) => setImmediate(resolve));
    expect(diffs().map((tab) => tab.title)).toEqual(['main.ts (At checkpoint ↔ Current)', 'main.ts (Current ↔ Proposed)', 'main.ts (On disk ↔ Yours)', 'main.ts ↔ main.ts (Replace Preview)']);
  });

  it('names the conflict compare tab after its file, and Revert or Overwrite closes it and shows the file\'s tab with focus', async () => {
    const file = write('src/app.ts', 'disk');
    const opened = await pane.openFromUser(project.key, 'src/app.ts');
    if (!opened.ok) throw new Error('not opened');
    const document = textOf(opened.tabId);
    pane.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    fs.writeFileSync(file, 'theirs');
    expect(await pane.save(document.id, document.version, 'mine', false)).toEqual({ ok: false, reason: 'conflict' });
    await pane.conflict(document.id, 'compare');
    const compare = pane.state().tabs.find((tab) => tab.kind === 'diff')!;
    expect(compare).toMatchObject({ title: 'app.ts (On disk ↔ Yours)', conflict: true, diff: { conflictCompare: true } });
    expect(pane.state().activeTabId).toBe(compare.id);

    events.length = 0;
    expect(await pane.conflict(document.id, 'revert')).toEqual({ ok: true });
    expect(pane.state().tabs.map((tab) => tab.id)).toEqual([opened.tabId]);
    expect(pane.state().activeTabId).toBe(opened.tabId);
    expect(events).toContain(`focus:${opened.tabId}`);
    expect(document.text).toBe('theirs');

    // Overwrite from the compare tab, with the file's own tab closed: the file reopens in a tab of its own.
    pane.edit(document.id, { version: document.version, seq: 2, text: 'mine again', overReload: false });
    fs.writeFileSync(file, 'theirs again');
    await pane.save(document.id, document.version, 'mine again', false);
    await pane.conflict(document.id, 'compare');
    await pane.tabAction('close', opened.tabId);
    answers.push(0);
    expect(await pane.conflict(document.id, 'overwrite')).toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('mine again');
    const tabs = pane.state().tabs;
    expect(tabs.map((tab) => [tab.kind, tab.title])).toEqual([['code', 'app.ts']]);
    expect(pane.state().activeTabId).toBe(tabs[0]!.id);
  });
});

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}
