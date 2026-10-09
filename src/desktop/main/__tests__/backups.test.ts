import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_DIR, BackupStore, parseBackup } from '../documents/backups';
import type { TextDocument } from '../documents/document-service';
import { flushAcrossHeldRename } from '../../../__mocks__/held-rename';

let dir: string;
let lines: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-backups-'));
  lines = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const BACKUP_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function document(overrides: Partial<TextDocument> = {}): TextDocument {
  return {
    id: 'doc-1',
    kind: 'text',
    location: { path: '/p/src/a.ts', projectKey: 'p', relativePath: 'src/a.ts' },
    name: 'a.ts',
    languageId: 'typescript',
    encoding: 'utf16le',
    bom: true,
    eol: '\r\n',
    diskText: 'old',
    text: 'unsaved\r\ntext',
    disk: { exists: true, mtimeMs: 1, size: 3, sha256: 'x' },
    version: 1,
    editSeq: 0,
    readOnlyReason: undefined,
    conflict: false,
    untitled: false,
    orphaned: false,
    saveFailed: false,
    settingsScope: undefined,
    backupId: BACKUP_ID,
    watcher: undefined,
    searchEditor: undefined,
    ...overrides,
  };
}

const file = (): string => path.join(dir, BACKUP_DIR, `${BACKUP_ID}.json`);

describe('hot exit backups', () => {
  it('backs a dirty buffer up a second after its last change, with its place, encoding and line ending', async () => {
    vi.useFakeTimers();
    const store = new BackupStore(dir, (line) => lines.push(line));
    const doc = document();
    store.changed(doc);
    vi.advanceTimersByTime(900);
    doc.text = 'later';
    store.changed(doc);
    vi.advanceTimersByTime(900);
    expect(fs.existsSync(file())).toBe(false);
    vi.advanceTimersByTime(200);
    vi.useRealTimers();
    await store.flush();

    expect(await store.list()).toEqual([{
      backupId: BACKUP_ID,
      name: 'a.ts',
      languageId: 'typescript',
      encoding: 'utf16le',
      bom: true,
      eol: '\r\n',
      text: 'later',
      target: { kind: 'project', projectKey: 'p', relativePath: 'src/a.ts' },
    }]);
  });

  it('writes pending backups at once on flush, and leaves no temp file behind', async () => {
    const store = new BackupStore(dir, (line) => lines.push(line), 60_000);
    store.changed(document());
    await store.flush();
    expect(fs.readdirSync(path.join(dir, BACKUP_DIR))).toEqual([`${BACKUP_ID}.json`]);
  });

  it('deletes the backup on save or revert, after any write still in flight', async () => {
    const store = new BackupStore(dir, (line) => lines.push(line), 0);
    store.changed(document());
    await store.flush();
    store.changed(document());
    store.remove(BACKUP_ID);
    await store.flush();
    expect(fs.existsSync(file())).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('backs up untitled and settings buffers, and nothing for a file outside every project', async () => {
    const store = new BackupStore(dir, (line) => lines.push(line), 60_000);
    store.changed(document({ backupId: '1f8fad5b-d9cb-469f-a165-70867728950e', untitled: true, location: undefined }));
    store.changed(document({ backupId: '2f8fad5b-d9cb-469f-a165-70867728950e', settingsScope: 'user', location: { path: '/home/.damocles/settings.json' } }));
    store.changed(document({ backupId: '3f8fad5b-d9cb-469f-a165-70867728950e', location: { path: '/elsewhere/x.ts' } }));
    await store.flush();
    expect((await store.list()).map((record) => record.target).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([{ kind: 'settings', scope: 'user', path: '/home/.damocles/settings.json' }, { kind: 'untitled' }]);
  });

  it('flush waits for a write in flight and for a removal queued while it waits', async () => {
    const store = new BackupStore(dir, (line) => lines.push(line), 0);
    const onDisk = await flushAcrossHeldRename(file(), {
      first: () => store.changed(document()),
      flush: () => store.flush(),
      second: () => store.remove(BACKUP_ID),
      onDisk: () => fs.existsSync(file()),
    });
    expect(onDisk).toBe(false);
  });

  it('backs up a buffer whose text equals the disk text when asked, as a failed save asks, since the file may be torn', async () => {
    const store = new BackupStore(dir, (line) => lines.push(line), 60_000);
    store.changed(document({ text: 'old', diskText: 'old', saveFailed: true }), true);
    await store.flush();
    expect((await store.list()).map((record) => record.text)).toEqual(['old']);
  });

  it('writes at once on request and settles once the backup landed', async () => {
    const store = new BackupStore(dir, (line) => lines.push(line), 60_000);
    await store.writeNow(document());
    expect(fs.readdirSync(path.join(dir, BACKUP_DIR))).toEqual([`${BACKUP_ID}.json`]);
  });

  it('retries a rename Windows refuses while another process has the backup open', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const rename = fs.promises.rename.bind(fs.promises);
      const spy = vi.spyOn(fs.promises, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EPERM' }))
        .mockImplementation(rename);
      const store = new BackupStore(dir, (line) => lines.push(line), 0);
      store.changed(document(), true);
      await store.flush();
      expect(spy).toHaveBeenCalledTimes(2);
      expect((await store.list()).map((record) => record.text)).toEqual(['unsaved\r\ntext']);
      expect(lines).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('drops a temp file a crash left, and logs and ignores a malformed backup', async () => {
    fs.mkdirSync(path.join(dir, BACKUP_DIR));
    fs.writeFileSync(path.join(dir, BACKUP_DIR, `${BACKUP_ID}.abc123.tmp`), '{"torn');
    fs.writeFileSync(file(), '{"version":1}');
    fs.writeFileSync(path.join(dir, BACKUP_DIR, 'notes.txt'), 'x');
    const store = new BackupStore(dir, (line) => lines.push(line));
    expect(await store.list()).toEqual([]);
    expect(fs.readdirSync(path.join(dir, BACKUP_DIR)).sort()).toEqual([`${BACKUP_ID}.json`, 'notes.txt']);
    expect(lines).toEqual([`[backups] ignoring malformed ${BACKUP_ID}.json`]);
  });
});

describe('parseBackup', () => {
  const valid = {
    version: 1,
    backupId: BACKUP_ID,
    name: 'a.ts',
    languageId: 'typescript',
    encoding: 'utf8',
    bom: false,
    eol: '\n',
    text: 'x',
    target: { kind: 'project', projectKey: 'p', relativePath: 'src/a.ts' },
  };

  it('accepts a complete record whose id is its file name', () => {
    expect(parseBackup(JSON.stringify(valid), BACKUP_ID)).toMatchObject({ text: 'x' });
    expect(parseBackup(JSON.stringify(valid), '1f8fad5b-d9cb-469f-a165-70867728950e')).toBeUndefined();
  });

  it.each([
    ['an escaping relative path', { target: { kind: 'project', projectKey: 'p', relativePath: '../x' } }],
    ['an absolute path', { target: { kind: 'project', projectKey: 'p', relativePath: 'C:/x' } }],
    ['an unknown settings scope', { target: { kind: 'settings', scope: 'workspace', path: '/home/.damocles/settings.json' } }],
    ['a settings backup without its file', { target: { kind: 'settings', scope: 'user' } }],
    ['a settings backup with a relative file', { target: { kind: 'settings', scope: 'user', path: 'settings.json' } }],
    ['an unknown encoding', { encoding: 'latin1' }],
    ['a lone CR line ending', { eol: '\r' }],
    ['another schema', { version: 2 }],
  ])('rejects %s', (_name, patch) => {
    expect(parseBackup(JSON.stringify({ ...valid, ...patch }), BACKUP_ID)).toBeUndefined();
  });
});

describe('Search Editor backups', () => {
  const config = { query: 'q', isRegex: false, matchCase: true, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false, contextLines: 0, showIncludesExcludes: false };

  it('backs an untitled Search Editor up in the .code-search form with its project', async () => {
    const store = new BackupStore(dir, (line) => lines.push(line), 60_000);
    store.changed(document({ untitled: true, location: undefined, eol: '\n', text: 'body', searchEditor: { config, dirty: true, projectKey: 'p', running: false, message: undefined } }));
    await store.flush();
    const [record] = await store.list();
    expect(record).toMatchObject({ text: '# Query: q\n# Flags: CaseSensitive\n\nbody', target: { kind: 'searchEditor', projectKey: 'p' } });
  });

  it('reads a Search Editor target with or without its project, and refuses a malformed project key', () => {
    const valid = { version: 1, backupId: BACKUP_ID, name: 'q.code-search', languageId: 'search-result', encoding: 'utf8', bom: false, eol: '\n', text: 'x' };
    expect(parseBackup(JSON.stringify({ ...valid, target: { kind: 'searchEditor', projectKey: 'p' } }), BACKUP_ID)?.target).toEqual({ kind: 'searchEditor', projectKey: 'p' });
    expect(parseBackup(JSON.stringify({ ...valid, target: { kind: 'searchEditor' } }), BACKUP_ID)?.target).toEqual({ kind: 'searchEditor' });
    expect(parseBackup(JSON.stringify({ ...valid, target: { kind: 'searchEditor', projectKey: 'x'.repeat(201) } }), BACKUP_ID)).toBeUndefined();
    expect(parseBackup(JSON.stringify({ ...valid, target: { kind: 'searchEditor', projectKey: 7 } }), BACKUP_ID)).toBeUndefined();
  });
});
