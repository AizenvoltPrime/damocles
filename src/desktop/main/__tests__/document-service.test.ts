import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { EDITOR_MAX_DOCUMENT_BYTES } from '../../../shared/types/messages';
import { settingsFileVersion } from '../../../core/config/settings-file';
import type { SettingsFileSaveOutcome } from '../../../core/chat-panel/settings-file-editor';
import { DEFAULT_SEARCH_EDITOR_CONFIG } from '../search/search-editor-format';
import type { MessageQuestion } from '../message-dialog';
import type { Project } from '../documents/confine';
import { DocumentService, isDocumentDirty, type Backups, type DocumentChange, type TextDocument } from '../documents/document-service';

let root: string;
let projectDir: string;
let outside: string;
let platform: FakePlatform;
let asked: MessageQuestion[];
let answer: number | undefined;
let savePath: string | undefined;
// order: every backup call in sequence, a write with the text it backs up
let backups: { changed: string[]; removed: string[]; order: string[] };
// what an immediate backup write awaits before it counts as landed
let backupLands: () => Promise<void>;
let changes: DocumentChange[];
let logged: string[];
let service: DocumentService;
let project: Project;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-docs-')));
  projectDir = path.join(root, 'proj');
  outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
  platform = createFakePlatform();
  asked = [];
  answer = 0;
  savePath = undefined;
  backups = { changed: [], removed: [], order: [] };
  backupLands = async () => undefined;
  changes = [];
  logged = [];
  const fakeBackups: Backups = {
    changed: (document) => {
      backups.changed.push(document.backupId);
      backups.order.push(`changed:${document.text}`);
    },
    writeNow: async (document) => {
      backups.order.push(`now:${document.text}`);
      await backupLands();
    },
    remove: (backupId) => {
      backups.removed.push(backupId);
      backups.order.push('removed');
    },
  };
  service = new DocumentService({
    projects: () => [project],
    watchers: platform.fileWatchers,
    ask: async (question) => {
      asked.push(question);
      return answer;
    },
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
    log: (line) => logged.push(line),
    pickSavePath: async () => savePath,
    backups: fakeBackups,
    settings: {
      locate: (scope) => (scope === 'project' ? path.join(projectDir, '.damocles', 'settings.json') : undefined),
      save: async (scope, filePath, content, baseVersion) => {
        await settingsWriting();
        if (settingsOutcome) return settingsOutcome;
        settingsSaves.push({ scope, filePath, content });
        settingsBaseVersions.push(baseVersion);
        return { ok: true, path: filePath, version: settingsFileVersion(content) };
      },
    },
  });
  service.onDidChange((change) => changes.push(change));
});

let settingsSaves: Array<{ scope: string; filePath: string; content: string }> = [];
let settingsBaseVersions: string[] = [];
// what the settings writer awaits before it writes
let settingsWriting: () => Promise<void> = async () => undefined;
// what the settings writer answers instead of writing
let settingsOutcome: SettingsFileSaveOutcome | undefined;
beforeEach(() => {
  settingsSaves = [];
  settingsBaseVersions = [];
  settingsWriting = async () => undefined;
  settingsOutcome = undefined;
});

// Runs swap once, right before the first fs.promises.open of target: a racer replacing a checked path before the open.
function swapBeforeOpen(target: string, swap: () => void): void {
  const original = fs.promises.open.bind(fs.promises);
  let swapped = false;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
    if (!swapped && String(file) === target && (flags === 'r+' || flags === 'wx')) {
      swapped = true;
      swap();
    }
    return original(file, flags, mode);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  service.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, content: string | Buffer): string {
  const file = path.join(projectDir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function open(relativePath: string): Promise<TextDocument> {
  const result = await service.openProjectFile(project.key, relativePath);
  if (!result.ok || result.document.kind !== 'text') throw new Error(`not a text document: ${JSON.stringify(result)}`);
  return result.document;
}

async function saveText(document: TextDocument, text: string) {
  return service.save(document.id, document.version, text);
}

describe('encoding, byte order mark and line endings', () => {
  it('round-trips UTF-8 without a BOM and keeps CRLF', async () => {
    const file = write('src/a.ts', 'const a = 1;\r\nconst b = 2;\r\n');
    const document = await open('src/a.ts');
    expect(service.content(document.id)).toMatchObject({ kind: 'text', encoding: 'utf8', bom: false, eol: '\r\n', text: 'const a = 1;\r\nconst b = 2;\r\n' });

    expect(await saveText(document, 'const a = 2;\r\nconst b = 2;\r\n')).toEqual({ ok: true });
    expect(fs.readFileSync(file)).toEqual(Buffer.from('const a = 2;\r\nconst b = 2;\r\n'));
  });

  it('writes the document line ending even when the buffer text has another', async () => {
    const file = write('crlf.txt', 'one\r\ntwo\r\n');
    const document = await open('crlf.txt');
    expect(await saveText(document, 'one\ntwo\nthree\n')).toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('one\r\ntwo\r\nthree\r\n');
  });

  it('keeps a UTF-8 BOM', async () => {
    const file = write('bom.ts', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\r\n')]));
    const document = await open('bom.ts');
    expect(service.content(document.id)).toMatchObject({ text: 'x\r\n', encoding: 'utf8', bom: true });
    await saveText(document, 'yé\r\n');
    expect(fs.readFileSync(file)).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('yé\r\n')]));
  });

  it.each([
    ['utf16le', [0xff, 0xfe], (text: string) => Buffer.from(text, 'utf16le')],
    ['utf16be', [0xfe, 0xff], (text: string) => Buffer.from(text, 'utf16le').swap16()],
  ] as const)('round-trips %s with its BOM', async (encoding, bom, encode) => {
    const file = write(`${encoding}.txt`, Buffer.concat([Buffer.from(bom), encode('héllo\nwörld\n')]));
    const document = await open(`${encoding}.txt`);
    expect(service.content(document.id)).toMatchObject({ text: 'héllo\nwörld\n', encoding, bom: true, eol: '\n' });
    await saveText(document, 'αβγ\n');
    expect(fs.readFileSync(file)).toEqual(Buffer.concat([Buffer.from(bom), encode('αβγ\n')]));
  });

  it('opens text that is not valid UTF-8 read-only and refuses to save it', async () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const file = write('latin1.txt', bytes);
    const document = await open('latin1.txt');
    expect(document.readOnlyReason).toBe('encoding');
    expect(await saveText(document, 'changed')).toEqual({ ok: false, reason: 'readOnly' });
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it('refuses a save whose encoded bytes pass the document limit', async () => {
    write('big.txt', 'x');
    const document = await open('big.txt');
    const result = await saveText(document, 'é'.repeat(EDITOR_MAX_DOCUMENT_BYTES / 2 + 1));
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(fs.readFileSync(path.join(projectDir, 'big.txt'), 'utf8')).toBe('x');
  });
});

describe('kinds', () => {
  it('previews an image from a data URL, SVG included, and shows binary files as not displayed', async () => {
    write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
    write('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    write('blob.bin', Buffer.from([1, 0, 2]));
    const png = await service.openProjectFile(project.key, 'logo.png');
    const svg = await service.openProjectFile(project.key, 'icon.svg');
    const blob = await service.openProjectFile(project.key, 'blob.bin');
    if (!png.ok || !svg.ok || !blob.ok) throw new Error('open failed');
    expect(service.content(png.document.id)).toMatchObject({ kind: 'image', dataUrl: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]).toString('base64')}` });
    expect(service.content(svg.document.id)).toMatchObject({ kind: 'image' });
    expect((service.content(svg.document.id) as { dataUrl: string }).dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(service.content(blob.document.id)).toEqual({ kind: 'notDisplayed', documentId: blob.document.id, reason: 'binary', bytes: 3 });
  });

  it('opens a path core names outside every project read-only', async () => {
    const file = path.join(outside, 'agent.ts');
    fs.writeFileSync(file, 'x');
    const document = await service.openPath(file);
    expect(document).toMatchObject({ kind: 'text', readOnlyReason: 'outsideProject' });
    expect(await service.save(document.id, 1, 'y')).toEqual({ ok: false, reason: 'readOnly' });
    expect(fs.readFileSync(file, 'utf8')).toBe('x');
  });

  it('opens a path core names inside a project writable, with its place in the project', async () => {
    const file = write('src/core.ts', 'x');
    expect(await service.openPath(file)).toMatchObject({ readOnlyReason: undefined, location: { projectKey: project.key, relativePath: 'src/core.ts' } });
  });
});

describe('confinement', () => {
  it.each([['../outside/x.txt'], ['src/../../outside/x.txt'], ['<absolute>'], ['/etc/passwd'], ['C:x.txt'], ['C:\\x.txt'], ['\\\\server\\share\\x'], ['src\\a.ts'], ['a\0b'], ['a:b'], ['']])(
    'refuses %j',
    async (named) => {
      fs.writeFileSync(path.join(outside, 'x.txt'), 'secret');
      const relativePath = named === '<absolute>' ? path.join(outside, 'x.txt') : named;
      expect(await service.openProjectFile(project.key, relativePath)).toEqual({ ok: false, reason: 'outside' });
    },
  );

  it('refuses a project key main does not list', async () => {
    write('a.ts', 'x');
    expect(await service.openProjectFile(folderKey(outside), 'a.ts')).toEqual({ ok: false, reason: 'outside' });
  });

  it('refuses a symlink and a junction that lead outside the project, and follows one that stays inside', async () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(projectDir, 'link.txt'), 'file');
    fs.symlinkSync(outside, path.join(projectDir, 'junction'), 'junction');
    write('src/real.ts', 'inside');
    fs.symlinkSync(path.join(projectDir, 'src', 'real.ts'), path.join(projectDir, 'inner.ts'), 'file');
    expect(await service.openProjectFile(project.key, 'link.txt')).toEqual({ ok: false, reason: 'outside' });
    expect(await service.openProjectFile(project.key, 'junction/secret.txt')).toEqual({ ok: false, reason: 'outside' });
    expect(await service.openProjectFile(project.key, 'inner.ts')).toMatchObject({ ok: true });
  });

  it('reports a missing file as missing', async () => {
    expect(await service.openProjectFile(project.key, 'none.ts')).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('save, conflicts and reloads', () => {
  it('writes in place, so a hard link sees the saved text', async () => {
    const file = write('linked.txt', 'one');
    const other = path.join(projectDir, 'other.txt');
    fs.linkSync(file, other);
    const document = await open('linked.txt');
    await saveText(document, 'two');
    expect(fs.readFileSync(other, 'utf8')).toBe('two');
  });

  it('refuses a save when the disk changed, keeps the text, and overwrites only after the user confirms', async () => {
    const file = write('c.ts', 'base');
    const document = await open('c.ts');
    service.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    fs.writeFileSync(file, 'theirs');

    expect(await saveText(document, 'mine')).toEqual({ ok: false, reason: 'conflict' });
    expect(document).toMatchObject({ conflict: true, text: 'mine' });
    expect(fs.readFileSync(file, 'utf8')).toBe('theirs');

    answer = undefined;
    expect(await service.overwrite(document.id)).toEqual({ ok: false, reason: 'cancelled' });
    expect(fs.readFileSync(file, 'utf8')).toBe('theirs');

    answer = 0;
    expect(await service.overwrite(document.id)).toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('mine');
    expect(document.conflict).toBe(false);
    expect(asked).toHaveLength(2);
  });

  it('does not call a touch that keeps the bytes a conflict', async () => {
    const file = write('touch.ts', 'same');
    const document = await open('touch.ts');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(await saveText(document, 'new')).toEqual({ ok: true });
  });

  it('reloads a clean buffer in place on a watcher event and flags a dirty one', async () => {
    const file = write('w.ts', 'one');
    const document = await open('w.ts');
    const watcher = platform.fileWatchers.watcher(path.dirname(file), '*');

    fs.writeFileSync(file, 'two');
    watcher.fireChange(file);
    await waitFor(() => document.text === 'two');
    expect(document.version).toBe(2);
    expect(changes).toContainEqual({ documentId: document.id, content: true });

    service.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    fs.writeFileSync(file, 'three');
    watcher.fireChange(file);
    await waitFor(() => document.conflict);
    expect(document.text).toBe('mine');

    await service.revert(document.id);
    expect(document).toMatchObject({ text: 'three', conflict: false, version: 3 });
    expect(backups.removed).toContain(document.backupId);
  });

  it('drops an edit made against text main has since replaced', async () => {
    write('v.ts', 'one');
    const document = await open('v.ts');
    service.edit(document.id, { version: document.version + 1, seq: 1, text: 'stale', overReload: false });
    expect(document.text).toBe('one');
    service.edit(document.id, { version: document.version, seq: 1, text: 'fresh', overReload: false });
    expect(document.text).toBe('fresh');
    expect(backups.changed).toEqual([document.backupId]);
  });

  it('keeps a keystroke typed over a clean-buffer reload as a dirty buffer in conflict, never as an edit of the new text', async () => {
    const file = write('race-reload.ts', 'one');
    const document = await open('race-reload.ts');
    const watcher = platform.fileWatchers.watcher(path.dirname(file), '*');
    fs.writeFileSync(file, 'two');
    watcher.fireChange(file);
    await waitFor(() => document.text === 'two');
    expect(service.content(document.id)).toMatchObject({ version: 2, editSeq: 0 });

    // The keystroke the shell sent before the reload reached it arrives after, for the replaced version; the shell kept it
    // and reports it again over the reload.
    service.edit(document.id, { version: 1, seq: 1, text: 'one!', overReload: false });
    expect(document.text).toBe('two');
    service.edit(document.id, { version: 2, seq: 2, text: 'one!', overReload: true });
    expect(document).toMatchObject({ text: 'one!', diskText: 'two', conflict: true });
    expect(service.content(document.id)).toMatchObject({ editSeq: 2 });
    expect(await saveText(document, 'one!')).toEqual({ ok: false, reason: 'conflict' });
    expect(fs.readFileSync(file, 'utf8')).toBe('two');
  });

  it('takes a keystroke typed over a reload that left the text as on disk as a clean buffer', async () => {
    const file = write('race-same.ts', 'one');
    const document = await open('race-same.ts');
    const watcher = platform.fileWatchers.watcher(path.dirname(file), '*');
    fs.writeFileSync(file, 'two');
    watcher.fireChange(file);
    await waitFor(() => document.text === 'two');
    service.edit(document.id, { version: 2, seq: 1, text: 'two', overReload: true });
    expect(document).toMatchObject({ text: 'two', conflict: false });
  });

  it('keeps the text of a deleted file as an orphaned buffer, clean until edited, that a save recreates', async () => {
    const file = write('gone.ts', 'kept');
    const document = await open('gone.ts');
    changes.length = 0;
    fs.rmSync(file);
    platform.fileWatchers.watcher(path.dirname(file), '*').fireDelete(file);
    await waitFor(() => document.orphaned);
    expect(changes).toEqual([{ documentId: document.id, content: false }]);
    expect(document.text).toBe('kept');
    expect(isDocumentDirty(document)).toBe(false);
    expect(backups.changed).toEqual([]);
    expect(await saveText(document, 'kept')).toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('kept');
    expect(document.orphaned).toBe(false);
  });

  it('turns an orphaned buffer dirty only by an edit, and clears the mark once the file is back', async () => {
    const file = write('gone.ts', 'kept');
    const document = await open('gone.ts');
    const watcher = platform.fileWatchers.watcher(path.dirname(file), '*');
    fs.rmSync(file);
    watcher.fireDelete(file);
    await waitFor(() => document.orphaned);
    service.edit(document.id, { version: document.version, seq: 1, text: 'kept!', overReload: false });
    expect(isDocumentDirty(document)).toBe(true);
    fs.writeFileSync(file, 'kept!');
    watcher.fireCreate(file);
    await waitFor(() => !document.orphaned);
    expect(isDocumentDirty(document)).toBe(false);

    write('other.ts', 'x');
    const clean = await open('other.ts');
    const otherWatcher = platform.fileWatchers.watcher(projectDir, '*');
    fs.rmSync(path.join(projectDir, 'other.ts'));
    otherWatcher.fireDelete(path.join(projectDir, 'other.ts'));
    await waitFor(() => clean.orphaned);
    write('other.ts', 'x');
    otherWatcher.fireCreate(path.join(projectDir, 'other.ts'));
    await waitFor(() => !clean.orphaned);
    expect(clean.text).toBe('x');
  });
});

describe('reads of an open document follow no link that leaves the project', () => {
  // Links nothing may follow: a stat, realpath or open at or under one, and any call on a UNC path, is recorded and throws
  // instead of reaching the network (as in confine.test.ts).
  let guarded: string[];
  let followed: string[];
  let fakeTargets: Map<string, string>;

  beforeEach(() => {
    guarded = [];
    followed = [];
    fakeTargets = new Map();
    const follows = (file: string, linksToo: boolean): boolean => {
      const key = folderKey(file);
      if (!/^[\\/]{2}/.test(file) && !(linksToo && guarded.some((link) => key === folderKey(link) || key.startsWith(`${folderKey(link)}${path.sep}`)))) return false;
      followed.push(file);
      return true;
    };
    const guard = <F extends (file: fs.PathLike, ...rest: never[]) => Promise<unknown>>(name: 'stat' | 'realpath' | 'open' | 'lstat', original: F): void => {
      vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: never[]) => {
        if (follows(String(file), name !== 'lstat')) throw new Error(`followed ${String(file)}`);
        return original(file, ...rest);
      }) as never);
    };
    guard('stat', fs.promises.stat.bind(fs.promises));
    guard('realpath', fs.promises.realpath.bind(fs.promises));
    guard('open', fs.promises.open.bind(fs.promises));
    guard('lstat', fs.promises.lstat.bind(fs.promises));
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => fakeTargets.get(folderKey(String(file))) ?? readlink(file)) as typeof fs.promises.readlink);
  });

  // Lets a watcher reload that does nothing visible run to its end.
  const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

  it.runIf(process.platform === 'win32')('a file replaced by a link to a share: the reload, Revert, Save, Overwrite and Compare never touch the share', async () => {
    const file = write('a.ts', 'one');
    const document = await open('a.ts');
    service.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    // A real junction (no privilege needed) whose readlink answers a UNC path.
    fs.mkdirSync(path.join(projectDir, 'real'));
    fs.rmSync(file);
    fs.symlinkSync(path.join(projectDir, 'real'), file, 'junction');
    fakeTargets.set(folderKey(file), '\\\\server\\share\\x');
    guarded.push(file);

    platform.fileWatchers.watcher(projectDir, '*').fireChange(file);
    await settled();
    expect(await service.revert(document.id)).toMatchObject({ ok: false, reason: 'failed' });
    expect(await saveText(document, 'mine')).toMatchObject({ ok: false, reason: 'failed', message: expect.stringContaining('a.ts') });
    answer = 0;
    expect(await service.overwrite(document.id)).toMatchObject({ ok: false, reason: 'failed' });
    expect(await service.diskText(document.id)).toBe('');
    expect(document.text).toBe('mine');
    expect(followed).toEqual([]);
  });

  it('a file replaced by a link to a file outside the project: no read takes its text and no write reaches it', async () => {
    const file = write('a.ts', 'one');
    const document = await open('a.ts');
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'secret');
    fs.rmSync(file);
    fs.symlinkSync(secret, file, 'file');

    platform.fileWatchers.watcher(projectDir, '*').fireChange(file);
    await settled();
    expect(document.text).toBe('one');
    expect(await service.revert(document.id)).toMatchObject({ ok: false, reason: 'failed' });
    expect(await service.diskText(document.id)).toBe('');
    service.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    expect(await saveText(document, 'mine')).toMatchObject({ ok: false, reason: 'failed' });
    expect(document.text).toBe('mine');
    expect(fs.readFileSync(secret, 'utf8')).toBe('secret');
  });
});

describe('a Files rename', () => {
  it('moves every document at or under the renamed path, keeping its id, buffer and backup, and saves to the new file', async () => {
    write('src/notes.txt', 'one');
    write('src/deep/a.ts', 'a');
    write('srcx/b.ts', 'b');
    const notes = await open('src/notes.txt');
    const deep = await open('src/deep/a.ts');
    const sibling = await open('srcx/b.ts');
    service.edit(notes.id, { version: notes.version, seq: 1, text: 'one, edited', overReload: false });
    backups.changed.length = 0;

    expect(await renameOnDisk('src/notes.txt', 'src/renamed.ts')).toEqual({ ok: true, relativePath: 'src/renamed.ts' });
    expect(service.get(notes.id)).toBe(notes);
    expect(notes.location).toMatchObject({ projectKey: project.key, relativePath: 'src/renamed.ts', path: path.join(projectDir, 'src', 'renamed.ts') });
    expect(notes).toMatchObject({ name: 'renamed.ts', languageId: 'typescript', text: 'one, edited', orphaned: false });
    expect(isDocumentDirty(notes)).toBe(true);
    expect(backups.changed).toEqual([notes.backupId]);
    // the old file's delete reaches the watcher late and changes nothing
    platform.fileWatchers.watcher(path.join(projectDir, 'src'), '*').fireDelete(path.join(projectDir, 'src', 'notes.txt'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notes.orphaned).toBe(false);
    expect(await saveText(notes, 'one, edited')).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(projectDir, 'src', 'renamed.ts'), 'utf8')).toBe('one, edited');
    expect(fs.existsSync(path.join(projectDir, 'src', 'notes.txt'))).toBe(false);

    await renameOnDisk('src', 'lib');
    expect(deep.location?.relativePath).toBe('lib/deep/a.ts');
    expect(notes.location?.relativePath).toBe('lib/renamed.ts');
    expect(sibling.location?.relativePath).toBe('srcx/b.ts');
  });

  it.each([
    ['from Files', (file: string) => service.openProjectFile(project.key, path.basename(file))],
    ['by its path', async (file: string) => ({ ok: true as const, document: await service.openPath(file) })],
  ])('waits for a file open %s in flight, so the document that open makes is the one that moves, and an open of the new name finds it', async (_label, openFile) => {
    const fresh = write('fresh.ts', '');
    const stat = holdStat(fresh);
    const opening = openFile(fresh);
    await stat.reached;
    const renaming = renameOnDisk('fresh.ts', 'renamed.ts');
    stat.release();
    const opened = await opening;
    expect(await renaming).toEqual({ ok: true, relativePath: 'renamed.ts' });
    if (!opened.ok) throw new Error('not opened');
    expect(opened.document).toMatchObject({ name: 'renamed.ts', location: { relativePath: 'renamed.ts' }, orphaned: false });
    expect(await service.openProjectFile(project.key, 'renamed.ts')).toEqual({ ok: true, document: opened.document });
    expect(service.all()).toEqual([opened.document]);
  });

  it('holds an open of the new name that starts while the rename runs until the moved document is there', async () => {
    write('notes.ts', 'kept');
    const notes = await open('notes.ts');
    service.edit(notes.id, { version: notes.version, seq: 1, text: 'kept, edited', overReload: false });
    let renamed!: () => void;
    const onDisk = new Promise<void>((resolve) => { renamed = resolve; });
    const renaming = service.rename(project.key, 'notes.ts', async () => {
      fs.renameSync(path.join(projectDir, 'notes.ts'), path.join(projectDir, 'renamed.ts'));
      await onDisk;
      return { ok: true, relativePath: 'renamed.ts' };
    });
    const opening = service.openProjectFile(project.key, 'renamed.ts');
    renamed();
    await renaming;
    expect(await opening).toEqual({ ok: true, document: notes });
    expect(notes).toMatchObject({ name: 'renamed.ts', text: 'kept, edited', orphaned: false });
    expect(isDocumentDirty(notes)).toBe(true);
  });

  it('gives two opens of one file in flight one document', async () => {
    const file = write('twice.ts', 'x');
    const stat = holdStat(file);
    const first = service.openProjectFile(project.key, 'twice.ts');
    await stat.reached;
    const second = service.openProjectFile(project.key, 'twice.ts');
    stat.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok && b.ok && a.document === b.document).toBe(true);
    expect(service.all()).toHaveLength(1);
  });

  it.each([
    ['while the rename is on disk and before the documents move, read to the end', 'settled'],
    ['while the rename is on disk, its read still in flight as the documents move', 'inFlight'],
    ['after the documents moved', 'after'],
  ] as const)('keeps one renamed document with its text and dirty state when the old name\'s delete reaches the watcher %s', async (_label, when) => {
    const old = write('src/old.ts', 'disk');
    const document = await open('src/old.ts');
    service.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    const watcher = platform.fileWatchers.watcher(path.dirname(old), '*');
    await service.rename(project.key, 'src/old.ts', async () => {
      fs.renameSync(old, path.join(projectDir, 'src', 'new.ts'));
      if (when !== 'after') watcher.fireDelete(old);
      if (when === 'settled') await waitFor(() => document.orphaned);
      return { ok: true, relativePath: 'src/new.ts' };
    });
    if (when === 'after') watcher.fireDelete(old);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document).toMatchObject({ name: 'new.ts', location: { relativePath: 'src/new.ts' }, text: 'mine', orphaned: false });
    expect(isDocumentDirty(document)).toBe(true);
    expect(service.all()).toEqual([document]);
  });
});

// A Files rename of `from` to `to` on disk, as the file tree makes it.
function renameOnDisk(from: string, to: string) {
  return service.rename(project.key, from, async () => {
    fs.renameSync(path.join(projectDir, ...from.split('/')), path.join(projectDir, ...to.split('/')));
    return { ok: true, relativePath: to };
  });
}

// Holds the first fs.promises.stat of target until released: a file open in flight.
function holdStat(target: string): { readonly reached: Promise<void>; release(): void } {
  const original = fs.promises.stat.bind(fs.promises);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  let holding = true;
  vi.spyOn(fs.promises, 'stat').mockImplementation(async (file, options) => {
    if (holding && String(file) === target) {
      holding = false;
      reach();
      await held;
    }
    return original(file, options as never) as never;
  });
  return { reached, release };
}

// Runs swap once, right after the nth fs.promises.realpath of target resolves: a racer replacing the file between the
// realpath check and the open.
function swapAfterRealpath(target: string, swap: () => void, nth = 1): void {
  const original = fs.promises.realpath.bind(fs.promises);
  let seen = 0;
  vi.spyOn(fs.promises, 'realpath').mockImplementation(async (file, options) => {
    const resolved = await original(file, options);
    if (String(file) === target && ++seen === nth) swap();
    return resolved;
  });
}

// Runs swap once, right after the exclusive create of target returned its handle.
function swapAfterExclusiveCreate(target: string, swap: () => void): void {
  const original = fs.promises.open.bind(fs.promises);
  let swapped = false;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await original(file, flags, mode);
    if (!swapped && String(file) === target && flags === 'wx') {
      swapped = true;
      swap();
    }
    return handle;
  });
}

describe('writes against a racer', () => {
  it('refuses to write through a link swapped in for the file between the realpath check and the open', async () => {
    const file = write('race2.ts', 'base');
    const secret = path.join(outside, 'secret2.txt');
    fs.writeFileSync(secret, 'secret');
    const document = await open('race2.ts');
    // The save's disk read confines the file first; the second realpath is the write's.
    swapAfterRealpath(file, () => {
      fs.rmSync(file);
      fs.symlinkSync(secret, file, 'file');
    }, 2);
    expect(await saveText(document, 'pwned')).toMatchObject({ ok: false, reason: 'failed' });
    expect(fs.readFileSync(secret, 'utf8')).toBe('secret');
  });

  // Windows cannot rename a folder holding an open file, so the racer is simulated: after the exclusive create the path
  // resolves elsewhere and names another file (what a junction swapped in for the folder would show).
  it('removes a refused new file only while its path still names that file, never another one', async () => {
    const document = service.openMemory('untitled.ts', 'new', { untitled: true });
    const target = path.join(projectDir, 'gen2', 'new.ts');
    fs.mkdirSync(path.dirname(target));
    savePath = target;
    let created = false;
    swapAfterExclusiveCreate(target, () => { created = true; });
    const realpath = fs.promises.realpath.bind(fs.promises);
    vi.spyOn(fs.promises, 'realpath').mockImplementation(async (file, options) => (created && String(file) === target ? path.join(outside, 'new.ts') : realpath(file, options)));
    const stat = fs.promises.stat.bind(fs.promises) as (file: fs.PathLike, options?: fs.StatOptions) => Promise<fs.Stats | fs.BigIntStats>;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
      const real = await stat(file, options);
      return created && String(file) === target ? { ...real, dev: 1n, ino: 2n } : real;
    }) as typeof fs.promises.stat);
    expect(await service.save(document.id, document.version, 'new')).toMatchObject({ ok: false, reason: 'failed' });
    expect(fs.existsSync(target)).toBe(true);
  });

  it('refuses to write through a link swapped in for the file between confinement and the open', async () => {
    const file = write('race.ts', 'base');
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'secret');
    const document = await open('race.ts');
    swapBeforeOpen(file, () => {
      fs.rmSync(file);
      fs.symlinkSync(secret, file, 'file');
    });
    expect(await saveText(document, 'pwned')).toMatchObject({ ok: false, reason: 'failed' });
    expect(fs.readFileSync(secret, 'utf8')).toBe('secret');
  });

  it('removes a new file whose folder became a junction out of the project between confinement and the create', async () => {
    const document = service.openMemory('untitled.ts', 'new', { untitled: true });
    const target = path.join(projectDir, 'gen', 'new.ts');
    fs.mkdirSync(path.dirname(target));
    savePath = target;
    swapBeforeOpen(target, () => {
      fs.rmSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(outside, path.dirname(target), 'junction');
    });
    expect(await service.save(document.id, document.version, 'new')).toMatchObject({ ok: false, reason: 'failed' });
    expect(fs.existsSync(path.join(outside, 'new.ts'))).toBe(false);
  });

  it('keeps a document read-only at its own place when Save As fails, so Ctrl+S never writes the outside file', async () => {
    const file = path.join(outside, 'agent.txt');
    fs.writeFileSync(file, Buffer.from([0x63, 0xe9]));
    const document = (await service.openPath(file)) as TextDocument;
    fs.mkdirSync(path.join(projectDir, 'folder'));
    savePath = path.join(projectDir, 'folder');
    expect(await service.saveAs(document.id, document.version, 'x')).toMatchObject({ ok: false, reason: 'failed' });
    expect(document).toMatchObject({ readOnlyReason: 'outsideProject', encoding: 'utf8', location: { path: file } });
    expect(backups.changed).toEqual([]);
    expect(await service.save(document.id, document.version, 'x')).toEqual({ ok: false, reason: 'readOnly' });
    expect(fs.readFileSync(file)).toEqual(Buffer.from([0x63, 0xe9]));
  });
});

describe('settings files', () => {
  it('opens Edit settings.json as its own document even while Files has the same file open, and saves it through the settings rules', async () => {
    const file = write('.damocles/settings.json', '{}');
    const plain = await open('.damocles/settings.json');
    const settings = (await service.openSettingsFile('project')) as TextDocument;
    expect(settings.id).not.toBe(plain.id);
    expect(settings).toMatchObject({ settingsScope: 'project' });
    expect(await service.save(settings.id, settings.version, '{ "a": 1 }')).toEqual({ ok: true });
    expect(settingsSaves).toEqual([{ scope: 'project', filePath: file, content: '{ "a": 1 }' }]);
  });
});

describe('overwrite sizes the bytes it writes', () => {
  const limit = EDITOR_MAX_DOCUMENT_BYTES;
  // One byte per line in a buffer reported with LF; two per line once written with the file's CRLF.
  const overOnlyAsCrlf = '\n'.repeat(limit / 2 + 1);

  function report(document: TextDocument, text: string): void {
    service.edit(document.id, { version: document.version, seq: document.editSeq + 1, text, overReload: false });
  }

  it('refuses a file whose buffer passes the limit only in the file\'s line endings, and writes those line endings', async () => {
    const file = write('crlf.txt', 'a\r\nb\r\n');
    const document = await open('crlf.txt');
    report(document, overOnlyAsCrlf);
    fs.writeFileSync(file, 'theirs');
    expect(await service.overwrite(document.id)).toMatchObject({ ok: false, reason: 'failed' });
    expect(fs.readFileSync(file, 'utf8')).toBe('theirs');

    report(document, 'mine\n');
    expect(await service.overwrite(document.id)).toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('mine\r\n');
  });

  it('refuses a Search Editor whose header and body together pass the limit', async () => {
    const file = write('found.code-search', '# Query: needle\n\nresults\n');
    const document = await open('found.code-search');
    expect(document.searchEditor).toBeDefined();
    report(document, 'x'.repeat(limit - 4));
    fs.writeFileSync(file, 'theirs');
    expect(await service.overwrite(document.id)).toMatchObject({ ok: false, reason: 'failed' });
    expect(fs.readFileSync(file, 'utf8')).toBe('theirs');
  });

  it('refuses a settings file whose buffer passes the limit only in the file\'s line endings, and saves those line endings', async () => {
    write('.damocles/settings.json', '{\r\n}\r\n');
    const settings = (await service.openSettingsFile('project')) as TextDocument;
    expect(settings.eol).toBe('\r\n');
    report(settings, overOnlyAsCrlf);
    expect(await service.overwrite(settings.id)).toMatchObject({ ok: false, reason: 'failed' });
    expect(settingsSaves).toEqual([]);

    report(settings, '{\n}\n');
    expect(await service.overwrite(settings.id)).toEqual({ ok: true });
    expect(settingsSaves.map((save) => save.content)).toEqual(['{\r\n}\r\n']);
  });

  it.each([
    ['utf16le', [0xff, 0xfe], (text: string) => Buffer.from(text, 'utf16le')],
    ['utf16be', [0xfe, 0xff], (text: string) => Buffer.from(text, 'utf16le').swap16()],
  ] as const)('sizes a %s file in that encoding, not as UTF-8', async (_encoding, bom, encode) => {
    const file = write('wide.txt', Buffer.concat([Buffer.from(bom), encode('x\n')]));
    const document = await open('wide.txt');
    // Under the limit as UTF-8, over it as UTF-16.
    report(document, 'a'.repeat(limit / 2 + 1));
    fs.writeFileSync(file, 'theirs');
    expect(await service.overwrite(document.id)).toMatchObject({ ok: false, reason: 'failed' });
    expect(fs.readFileSync(file, 'utf8')).toBe('theirs');

    // Over the limit as UTF-8, under it as UTF-16.
    const wide = '中'.repeat(limit / 2 - 1);
    report(document, wide);
    expect(await service.overwrite(document.id)).toEqual({ ok: true });
    expect(fs.readFileSync(file).equals(Buffer.concat([Buffer.from(bom), encode(wide)]))).toBe(true);
  });
});

describe('the size limit counts the byte order mark a write adds', () => {
  const limit = EDITOR_MAX_DOCUMENT_BYTES;
  const encodings = [
    ['UTF-8 with a BOM', [0xef, 0xbb, 0xbf], 1, (text: string) => Buffer.from(text, 'utf8')],
    ['UTF-16LE', [0xff, 0xfe], 2, (text: string) => Buffer.from(text, 'utf16le')],
    ['UTF-16BE', [0xfe, 0xff], 2, (text: string) => Buffer.from(text, 'utf16le').swap16()],
  ] as const;
  type Branch = (relativePath: string, text: string) => Promise<{ ok: boolean }>;
  const branches: ReadonlyArray<readonly [string, Branch]> = [
    ['save', async (relativePath, text) => {
      const document = await open(relativePath);
      return saveText(document, text);
    }],
    ['Save As', async (relativePath, text) => {
      const document = await open(relativePath);
      savePath = path.join(projectDir, relativePath);
      return service.saveAs(document.id, document.version, text);
    }],
    ['overwrite', async (relativePath, text) => {
      const document = await open(relativePath);
      service.edit(document.id, { version: document.version, seq: document.editSeq + 1, text, overReload: false });
      return service.overwrite(document.id);
    }],
    ['replace', async (relativePath, text) => {
      const read = await service.readClosedFile(project.key, relativePath);
      if (read.kind !== 'text') throw new Error(`not text: ${read.kind}`);
      return service.writeClosedFile(read, text);
    }],
  ];

  describe.each(encodings)('%s', (_name, bom, unit, encode) => {
    const atLimit = 'a'.repeat((limit - bom.length) / unit);
    const original = Buffer.concat([Buffer.from(bom), encode('x')]);

    it.each(branches)('%s writes exactly the limit and reopens it as text, and refuses one character more', async (_branch, run) => {
      const file = write('bom.txt', original);
      expect(await run('bom.txt', `${atLimit}a`)).toMatchObject({ ok: false });
      expect(fs.readFileSync(file).equals(original)).toBe(true);

      expect(await run('bom.txt', atLimit)).toMatchObject({ ok: true });
      expect(fs.statSync(file).size).toBe(limit);
      expect(await service.readClosedFile(project.key, 'bom.txt')).toMatchObject({ kind: 'text', bom: true, disk: { size: limit } });
    });
  });

  it('saves a settings file with a BOM exactly at the limit, and refuses one character more', async () => {
    write('.damocles/settings.json', Buffer.from('\uFEFF{}', 'utf8'));
    const settings = (await service.openSettingsFile('project')) as TextDocument;
    expect(settings.bom).toBe(true);
    const atLimit = 'a'.repeat(limit - 3);
    expect(await service.save(settings.id, settings.version, `${atLimit}a`)).toMatchObject({ ok: false });
    expect(settingsSaves).toEqual([]);
    expect(await service.save(settings.id, settings.version, atLimit)).toEqual({ ok: true });
    expect(Buffer.byteLength(settingsSaves[0]!.content, 'utf8')).toBe(limit);
  });
});

describe('Save As and untitled', () => {
  it('saves inside an open project only, and the document moves there', async () => {
    const document = service.openMemory('untitled.ts', 'hello', { untitled: true, languageId: 'typescript' });
    savePath = path.join(outside, 'escape.ts');
    expect(await service.save(document.id, document.version, 'hello')).toMatchObject({ ok: false, reason: 'failed' });
    expect(fs.existsSync(savePath)).toBe(false);

    savePath = undefined;
    expect(await service.save(document.id, document.version, 'hello')).toEqual({ ok: false, reason: 'cancelled' });

    savePath = path.join(projectDir, 'src', 'saved.ts');
    expect(await service.save(document.id, document.version, 'hello')).toEqual({ ok: true });
    expect(fs.readFileSync(savePath, 'utf8')).toBe('hello');
    expect(document).toMatchObject({ untitled: false, location: { projectKey: project.key, relativePath: 'src/saved.ts' } });
  });

  it('refuses a Save As target reached through a junction out of the project', async () => {
    fs.symlinkSync(outside, path.join(projectDir, 'junction'), 'junction');
    write('a.ts', 'x');
    const document = await open('a.ts');
    savePath = path.join(projectDir, 'junction', 'copy.ts');
    expect(await service.saveAs(document.id, document.version, 'x')).toMatchObject({ ok: false, reason: 'failed' });
    expect(fs.existsSync(path.join(outside, 'copy.ts'))).toBe(false);
  });
});

// Holds the first in-place write of target at its open until release; opens records every open of target once it is held.
function holdWrite(target: string): { reached: Promise<void>; release: () => void; opens: string[] } {
  const original = fs.promises.open.bind(fs.promises);
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let reach: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const opens: string[] = [];
  let held = false;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
    if (String(file) === target) {
      if (held) opens.push(String(flags));
      else if (flags === 'r+') {
        held = true;
        reach();
        await released;
      }
    }
    return original(file, flags, mode);
  });
  return { reached, release, opens };
}

describe('a save racing edits and other saves', () => {
  it('keeps text typed while the save was being written: the buffer stays dirty with it and its backup is scheduled', async () => {
    const file = write('typing.ts', 'base');
    const document = await open('typing.ts');
    const hold = holdWrite(file);
    const saving = saveText(document, 'one');
    await hold.reached;
    service.edit(document.id, { version: document.version, seq: 1, text: 'one two', overReload: false });
    backups.order.length = 0;
    hold.release();

    expect(await saving).toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('one');
    expect(document).toMatchObject({ text: 'one two', diskText: 'one' });
    expect(isDocumentDirty(document)).toBe(true);
    expect(backups.order).toEqual(['changed:one two']);

    expect(await saveText(document, 'one two')).toEqual({ ok: true });
    expect(isDocumentDirty(document)).toBe(false);
    expect(backups.order.at(-1)).toBe('removed');
  });

  it('keeps a Search Editor dirty when its header changed while it was being written', async () => {
    const file = write('found.code-search', '# Query: needle\n\nresults\n');
    const document = await open('found.code-search');
    const hold = holdWrite(file);
    const saving = saveText(document, 'results!\n');
    await hold.reached;
    service.setSearchEditorConfig(document.id, { ...document.searchEditor!.config, query: 'other' });
    hold.release();
    expect(await saving).toEqual({ ok: true });
    expect(isDocumentDirty(document)).toBe(true);
  });

  it('keeps a settings buffer dirty with text typed while its save was being written, and takes only the written text as on disk', async () => {
    write('.damocles/settings.json', '{}');
    const settings = (await service.openSettingsFile('project')) as TextDocument;
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let reach: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    settingsWriting = async () => {
      reach();
      await released;
    };
    const saving = service.save(settings.id, settings.version, '{ "a": 1 }');
    await reached;
    service.edit(settings.id, { version: settings.version, seq: 1, text: '{ "a": 12 }', overReload: false });
    release();
    expect(await saving).toEqual({ ok: true });
    expect(settings).toMatchObject({ text: '{ "a": 12 }', diskText: '{ "a": 1 }' });
    expect(isDocumentDirty(settings)).toBe(true);
  });

  it('runs one document\'s saves one at a time, so a second save never reads the file the first is writing', async () => {
    const file = write('twice.ts', 'base');
    const document = await open('twice.ts');
    const hold = holdWrite(file);
    const first = saveText(document, 'one');
    await hold.reached;
    const second = saveText(document, 'one two');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hold.opens).toEqual([]);
    hold.release();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('one two');
    expect(document.conflict).toBe(false);
    expect(isDocumentDirty(document)).toBe(false);
  });

  it('writes the backup of a dirty buffer and waits for it to land before it writes the file in place', async () => {
    const file = write('torn.ts', 'base');
    const document = await open('torn.ts');
    const original = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (opened, flags, mode) => {
      if (String(opened) === file && flags === 'r+') backups.order.push('open');
      return original(opened, flags, mode);
    });
    backupLands = () => new Promise((resolve) => setTimeout(() => {
      backups.order.push('landed');
      resolve();
    }, 20));
    service.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    backups.order.length = 0;
    expect(await saveText(document, 'mine')).toEqual({ ok: true });
    expect(backups.order).toEqual(['now:mine', 'landed', 'open', 'removed']);
  });

  it('writes every byte when the disk takes a write in parts', async () => {
    const file = write('short.ts', 'old old old');
    const document = await open('short.ts');
    const original = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (opened, flags, mode) => {
      const handle = await original(opened, flags, mode);
      if (String(opened) === file && flags === 'r+') {
        const write = handle.write.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesWritten: number; buffer: Buffer }>;
        let first = true;
        handle.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
          const part = first ? Math.ceil(length / 2) : length;
          first = false;
          return write(buffer, offset, part, position);
        }) as typeof handle.write;
      }
      return handle;
    });
    expect(await saveText(document, 'new text that is longer')).toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('new text that is longer');
  });
});

describe('save failures', () => {
  it('answers a save and an overwrite whose disk read fails with the reason, never a rejection', async () => {
    const file = write('folder.ts', 'x');
    const document = await open('folder.ts');
    service.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(await saveText(document, 'mine')).toEqual({ ok: false, reason: 'failed', message: 'Failed to save \'folder.ts\': The path is a folder.' });
    answer = 0;
    expect(await service.overwrite(document.id)).toEqual({ ok: false, reason: 'failed', message: 'Failed to save \'folder.ts\': The path is a folder.' });
    expect(logged.some((line) => line.includes(file) && line.includes('is not a file'))).toBe(true);
  });

  it('keeps the buffer, its conflict and its backup when Revert cannot take the file\'s text', async () => {
    const file = write('binary.ts', 'one');
    const document = await open('binary.ts');
    service.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    fs.writeFileSync(file, Buffer.from([1, 0, 2]));
    expect(await saveText(document, 'mine')).toEqual({ ok: false, reason: 'conflict' });
    expect(await service.revert(document.id)).toMatchObject({ ok: false, reason: 'failed', message: expect.stringContaining('binary.ts') });
    expect(document).toMatchObject({ text: 'mine', conflict: true });
    expect(backups.removed).not.toContain(document.backupId);
  });

  it('never puts a buffer with no file in conflict: a Save As over replaced text fails, and keystrokes over a run are taken', async () => {
    const document = service.openSearchEditor(project.key, DEFAULT_SEARCH_EDITOR_CONFIG, 'body', { dirty: false });
    service.setSearchEditorResults(document.id, 'new body');
    savePath = path.join(projectDir, 'q.code-search');
    expect(await service.saveAs(document.id, 1, 'body')).toMatchObject({ ok: false, reason: 'failed', message: expect.any(String) });
    expect(document).toMatchObject({ conflict: false, text: 'new body' });
    expect(fs.existsSync(savePath)).toBe(false);

    service.edit(document.id, { version: document.version, seq: 1, text: 'typed over the run', overReload: true });
    expect(document).toMatchObject({ conflict: false, text: 'typed over the run' });
  });

  it('saves a settings file with mixed line endings against the version of its bytes on disk', async () => {
    const file = write('.damocles/settings.json', '{\r\n"a": 1\n}\r\n');
    const settings = (await service.openSettingsFile('project')) as TextDocument;
    expect(await service.save(settings.id, settings.version, '{}')).toEqual({ ok: true });
    expect(settingsBaseVersions).toEqual([settingsFileVersion(fs.readFileSync(file, 'utf8'))]);
  });
});

// The next in-place write of target lands the first half of its bytes, or none, then fails with code, as a disk that fills up
// or errors mid-write does.
function failWrite(target: string, code: string | undefined, landed: 'half' | 'none'): void {
  const original = fs.promises.open.bind(fs.promises);
  let failed = false;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (opened, flags, mode) => {
    const handle = await original(opened, flags, mode);
    if (failed || String(opened) !== target || flags !== 'r+') return handle;
    failed = true;
    const write = handle.write.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesWritten: number; buffer: Buffer }>;
    handle.write = (async (buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number; buffer: Buffer }> => {
      if (landed === 'half') await write(buffer, offset, Math.ceil(length / 2), position);
      throw Object.assign(new Error(`${code ?? 'EIO'}: raw failure, write '${target}'`), code === undefined ? {} : { code });
    }) as typeof handle.write;
    return handle;
  });
}

describe('a save that fails partway (textFileEditorModel.ts handleSaveError)', () => {
  it('keeps a clean buffer dirty with a backup when half its bytes landed, so the torn file raises the conflict bar instead of loading', async () => {
    // Mixed line endings: the clean buffer is written in its majority LF, shorter than the file, so half of it tears the file.
    const file = write('mixed.ts', 'x\r\ny\r\nz\nw\nv\n');
    const document = await open('mixed.ts');
    const watcher = platform.fileWatchers.watcher(path.dirname(file), '*');
    expect(isDocumentDirty(document)).toBe(false);
    failWrite(file, 'ENOSPC', 'half');
    backups.order.length = 0;
    changes.length = 0;

    expect(await saveText(document, document.text)).toMatchObject({ ok: false, reason: 'failed' });
    expect(fs.readFileSync(file, 'utf8')).toBe('x\ny\nz\nz\nw\nv\n');
    expect(isDocumentDirty(document)).toBe(true);
    expect(changes).toEqual([{ documentId: document.id, content: false }]);
    expect(backups.order).toEqual(['changed:x\ny\nz\nw\nv\n']);

    watcher.fireChange(file);
    await waitFor(() => document.conflict);
    expect(document).toMatchObject({ text: 'x\ny\nz\nw\nv\n', version: 1 });
    expect(backups.removed).not.toContain(document.backupId);
    expect(await saveText(document, document.text)).toEqual({ ok: false, reason: 'conflict' });

    // Revert is the user's choice of the file as it is now, and leaves the buffer clean.
    expect(await service.revert(document.id)).toEqual({ ok: true });
    expect(document.conflict).toBe(false);
    expect(isDocumentDirty(document)).toBe(false);
  });

  it('stays dirty after a failed save until a save lands, even when the buffer is edited back to the text last on disk', async () => {
    const file = write('back.ts', 'base');
    const document = await open('back.ts');
    service.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    failWrite(file, 'EIO', 'none');
    expect(await saveText(document, 'mine')).toMatchObject({ ok: false, reason: 'failed' });

    service.edit(document.id, { version: document.version, seq: 2, text: 'base', overReload: false });
    expect(isDocumentDirty(document)).toBe(true);
    expect(backups.order.at(-1)).toBe('changed:base');

    vi.restoreAllMocks();
    expect(await saveText(document, 'base')).toEqual({ ok: true });
    expect(isDocumentDirty(document)).toBe(false);
    expect(backups.order.at(-1)).toBe('removed');
  });

  it('takes a failed save\'s buffer as clean once the file on disk holds its text', async () => {
    const file = write('equal.ts', 'base');
    const document = await open('equal.ts');
    const watcher = platform.fileWatchers.watcher(path.dirname(file), '*');
    failWrite(file, 'EIO', 'none');
    expect(await saveText(document, 'mine')).toMatchObject({ ok: false, reason: 'failed' });
    fs.writeFileSync(file, 'mine');
    watcher.fireChange(file);
    await waitFor(() => document.diskText === 'mine');
    expect(document.conflict).toBe(false);
    expect(isDocumentDirty(document)).toBe(false);
    expect(backups.order.at(-1)).toBe('removed');
  });
});

describe('Revert of a file deleted on disk (textFileEditorModel.ts revert ignores FILE_NOT_FOUND)', () => {
  it('keeps the text, clears the dirty state and the conflict, and leaves the document deleted until a save writes it back', async () => {
    const file = write('gone.ts', 'base');
    const document = await open('gone.ts');
    const watcher = platform.fileWatchers.watcher(path.dirname(file), '*');
    service.edit(document.id, { version: document.version, seq: 1, text: 'mine', overReload: false });
    fs.writeFileSync(file, 'theirs');
    watcher.fireChange(file);
    await waitFor(() => document.conflict);
    // No watcher event for the delete yet: the Revert itself finds the file gone.
    fs.rmSync(file);
    changes.length = 0;

    expect(await service.revert(document.id)).toEqual({ ok: true });
    expect(document).toMatchObject({ text: 'mine', conflict: false, orphaned: true, version: 1 });
    expect(isDocumentDirty(document)).toBe(false);
    expect(backups.removed).toContain(document.backupId);
    expect(changes).toContainEqual({ documentId: document.id, content: false });
    expect(changes).not.toContainEqual({ documentId: document.id, content: true });

    expect(await saveText(document, 'mine')).toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('mine');
    expect(document.orphaned).toBe(false);
  });
});

describe('save failure messages (textFileSaveErrorHandler.ts genericSaveError)', () => {
  const unexpected = 'An unexpected error occurred. The log has the details.';
  it.each([
    ['ENOSPC', 'There is not enough space on the disk.'],
    ['EACCES', 'Insufficient permissions.'],
    ['EPERM', 'Insufficient permissions.'],
    ['EROFS', 'The file system is read-only.'],
    ['EBUSY', 'The file is in use or locked by another program.'],
    ['EAGAIN', 'The file is in use or locked by another program.'],
    ['EISDIR', 'The path is a folder.'],
    ['ENOENT', 'Its folder no longer exists.'],
    ['ENAMETOOLONG', 'The path is too long.'],
    ['EMFILE', 'Too many files are open.'],
    ['EIO', unexpected],
    [undefined, unexpected],
  ])('names the file by its base name and words %s, and only the log has the raw error and path', async (code, reason) => {
    const file = write('src/named.ts', 'base');
    const document = await open('src/named.ts');
    failWrite(file, code, 'none');
    expect(await saveText(document, 'mine')).toEqual({ ok: false, reason: 'failed', message: `Failed to save 'named.ts': ${reason}` });
    expect(logged.some((line) => line.includes(file) && line.includes('raw failure'))).toBe(true);
  });

  it('names the chosen file when Save As fails, and the document stays where it was', async () => {
    const target = write('src/target.ts', 'other');
    write('src/source.ts', 'base');
    const document = await open('src/source.ts');
    savePath = target;
    failWrite(target, 'EROFS', 'none');
    expect(await service.saveAs(document.id, document.version, 'mine')).toEqual({ ok: false, reason: 'failed', message: 'Failed to save \'target.ts\': The file system is read-only.' });
    expect(document.name).toBe('source.ts');
  });

  it('words an overwrite of a settings file that can no longer be read', async () => {
    const file = write('.damocles/settings.json', '{}');
    const settings = (await service.openSettingsFile('project')) as TextDocument;
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(await service.overwrite(settings.id)).toEqual({ ok: false, reason: 'failed', message: 'Failed to save \'settings.json\': The path is a folder.' });
    expect(logged.some((line) => line.includes(file))).toBe(true);
  });

  it('words a settings file whose write failed by its errno code, and keeps the settings writer\'s own refusals', async () => {
    write('.damocles/settings.json', '{}');
    const settings = (await service.openSettingsFile('project')) as TextDocument;
    settingsOutcome = { ok: false, error: `Could not save ${projectDir}: raw`, conflict: false, cause: Object.assign(new Error('raw'), { code: 'EACCES' }) };
    expect(await service.save(settings.id, settings.version, '{ }')).toEqual({ ok: false, reason: 'failed', message: 'Failed to save \'settings.json\': Insufficient permissions.' });
    settingsOutcome = { ok: false, error: 'Not saved: the text is not valid JSON.', conflict: false };
    expect(await service.save(settings.id, settings.version, '{')).toEqual({ ok: false, reason: 'failed', message: 'Not saved: the text is not valid JSON.' });
  });

  it('words a save it refuses itself by that refusal, not as unexpected', async () => {
    const file = write('src/swapped.ts', 'base');
    const document = await open('src/swapped.ts');
    const original = fs.promises.open.bind(fs.promises);
    // The opened handle is not the file confinement checked, as when the file is replaced between the check and the open.
    vi.spyOn(fs.promises, 'open').mockImplementation(async (opened, flags, mode) => {
      const handle = await original(opened, flags, mode);
      if (String(opened) === file && flags === 'r+') handle.stat = (async () => ({ isFile: () => true, dev: 0n, ino: 0n })) as unknown as typeof handle.stat;
      return handle;
    });
    expect(await saveText(document, 'mine')).toEqual({ ok: false, reason: 'failed', message: 'Failed to save \'swapped.ts\': The file was replaced while it was being saved.' });
    expect(fs.readFileSync(file, 'utf8')).toBe('base');
    expect(logged.some((line) => line.includes(file) && line.includes('changed while it was being saved'))).toBe(true);
  });

  it('words a write the disk takes no bytes of', async () => {
    const file = write('src/full.ts', 'base');
    const document = await open('src/full.ts');
    const original = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (opened, flags, mode) => {
      const handle = await original(opened, flags, mode);
      if (String(opened) === file && flags === 'r+') handle.write = (async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) })) as unknown as typeof handle.write;
      return handle;
    });
    expect(await saveText(document, 'mine')).toEqual({ ok: false, reason: 'failed', message: 'Failed to save \'full.ts\': The disk stopped accepting data.' });
  });

  it('words a Search replace that cannot write the file, and only the log has the raw error', async () => {
    const file = write('src/replaced.ts', 'base');
    const read = await service.readClosedFile(project.key, 'src/replaced.ts');
    if (read.kind !== 'text') throw new Error(`not text: ${read.kind}`);
    failWrite(file, 'ENOSPC', 'none');
    expect(await service.writeClosedFile(read, 'mine')).toEqual({ ok: false, reason: 'failed', message: 'There is not enough space on the disk.' });
    expect(logged.some((line) => line.includes(file) && line.includes('raw failure'))).toBe(true);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition never held');
}
