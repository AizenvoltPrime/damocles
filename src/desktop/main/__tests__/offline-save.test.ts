import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { projectKeyOf } from '../../../shared/project-location';
import type { Project } from '../../local-services/confine';
import { DocumentService, isDocumentDirty, type Backups, type TextDocument } from '../documents/document-service';
import { NotConnectedError } from '../workspace/workspaces';
import { testRemote, testWorkspaces, type TestRemote } from './test-workspaces';
import { englishText } from '../../../shared/localized-text';

// Offline saves (D13): a remote file saved while its host is away is kept in its backup and uploads on reconnect, written
// only while the target still holds the disk state it was saved over; a changed target opens the three-way merge instead.

const t = (message: string, ...args: Array<string | number>): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]));

let root: string;
let hostDir: string;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-offline-')));
  hostDir = path.join(root, 'host');
  fs.mkdirSync(path.join(hostDir, 'src'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function onHost(relativePath: string, text?: string): string {
  const file = path.join(hostDir, ...relativePath.split('/'));
  if (text !== undefined) fs.writeFileSync(file, text);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '<missing>';
}

// A host whose connection drops and comes back: the same remote (a resume inside the grace), or a new one (a fresh attach).
function host(opts: { backupLands?: boolean } = {}) {
  const platform = createFakePlatform();
  const away: Project = { key: projectKeyOf({ kind: 'loopback' }, folderKey(hostDir)), fsPath: hostDir, name: 'app' };
  let remote: TestRemote | undefined = testRemote({ watchers: platform.fileWatchers });
  let connected = true;
  const backups = { now: [] as string[], changed: [] as string[], removed: [] as string[] };
  const fakeBackups: Backups = {
    changed: (document) => void backups.changed.push(document.text),
    writeNow: async (document) => {
      backups.now.push(document.text);
      return opts.backupLands ?? true;
    },
    remove: (backupId) => void backups.removed.push(backupId),
  };
  const conflicts: Array<{ authority: string; documents: readonly TextDocument[] }> = [];
  const warnings: string[] = [];
  const reopened: TextDocument[] = [];
  const documents = new DocumentService({
    render: englishText,
    projects: () => [away],
    authorityOs: () => process.platform,
    ask: async () => 0,
    t,
    log: () => undefined,
    pickSavePath: async () => undefined,
    backups: fakeBackups,
    hostLabel: (authority) => ({ hostId: authority, name: 'prod-1' }),
    uploadsConflicted: (authority, conflicted) => void conflicts.push({ authority, documents: conflicted }),
    warn: (message) => void warnings.push(message),
    reopen: (document) => void reopened.push(document),
    settings: { locate: () => undefined, save: async () => { throw new Error('no settings file in this test'); } },
    workspaces: testWorkspaces({
      watchers: platform.fileWatchers,
      remote: (authorityKey) => {
        if (!connected || !remote) throw new NotConnectedError(`${authorityKey} is not connected.`);
        return remote.workspace();
      },
    }),
  });
  const open = async (relativePath: string): Promise<TextDocument> => {
    const opened = await documents.openProjectFile(away.key, relativePath);
    if (!opened.ok || opened.document.kind !== 'text') throw new Error('not opened');
    return opened.document;
  };
  return {
    documents,
    backups,
    conflicts,
    warnings,
    reopened,
    open,
    drop: () => {
      connected = false;
      documents.connectionsChanged();
    },
    // resume: the same connection comes back; else a fresh one
    reconnect: (how: 'resume' | 'attach') => {
      if (how === 'attach') {
        remote?.disconnect('dropped');
        remote = testRemote({ watchers: platform.fileWatchers });
      }
      connected = true;
      documents.connectionsChanged();
      documents.hostConnected('loopback');
    },
    end: () => {
      documents.dispose();
      remote?.disconnect('the test ended');
      remote = undefined;
    },
  };
}

const save = (documents: DocumentService, document: TextDocument, text: string) => documents.save(document.id, document.version, text);

describe('offline saves', () => {
  it('keeps a save made while the host is away in its backup, pending, not dirty and not written to the host', async () => {
    onHost('src/a.ts', 'base\n');
    const h = host();
    const document = await h.open('src/a.ts');
    h.drop();
    expect(await save(h.documents, document, 'offline\n')).toEqual({ ok: true });
    expect(document.pendingUpload).toEqual({ text: 'offline\n' });
    expect(h.backups.now).toEqual(['offline\n']);
    expect(isDocumentDirty(document)).toBe(false);
    expect(document.diskText).toBe('base\n');
    expect(onHost('src/a.ts')).toBe('base\n');
    // a later edit is unsaved again, and its backup still holds the buffer
    h.documents.edit(document.id, { version: document.version, seq: 1, text: 'offline\nmore\n', overReload: false });
    expect(isDocumentDirty(document)).toBe(true);
    expect(h.backups.changed.at(-1)).toBe('offline\nmore\n');
    // back to the text saved offline: clean, and the backup stays, the only copy of what uploads
    h.documents.edit(document.id, { version: document.version, seq: 2, text: 'offline\n', overReload: false });
    expect(isDocumentDirty(document)).toBe(false);
    expect(h.backups.changed.at(-1)).toBe('offline\n');
    expect(h.backups.removed).toEqual([]);
    h.end();
  });

  it('fails the save, and marks nothing pending, when its backup cannot be written', async () => {
    onHost('src/a.ts', 'base\n');
    const h = host({ backupLands: false });
    const document = await h.open('src/a.ts');
    h.drop();
    expect(await save(h.documents, document, 'offline\n')).toMatchObject({ ok: false, reason: 'failed' });
    expect(document.pendingUpload).toBeUndefined();
    expect(isDocumentDirty(document)).toBe(true);
    h.end();
  });

  for (const how of ['resume', 'attach'] as const) {
    it(`uploads the saved text on reconnect (${how}) when the target still holds what it was saved over`, async () => {
      onHost('src/a.ts', 'base\n');
      const h = host();
      const document = await h.open('src/a.ts');
      h.drop();
      await save(h.documents, document, 'offline\n');
      h.reconnect(how);
      await vi.waitFor(() => expect(onHost('src/a.ts')).toBe('offline\n'));
      await vi.waitFor(() => expect(document.pendingUpload).toBeUndefined());
      expect(document.diskText).toBe('offline\n');
      expect(isDocumentDirty(document)).toBe(false);
      expect(h.backups.removed).toContain(document.backupId);
      expect(h.conflicts).toEqual([]);
      h.end();
    });
  }

  it('uploads the text saved offline, not edits made after it, which stay unsaved', async () => {
    onHost('src/a.ts', 'base\n');
    const h = host();
    const document = await h.open('src/a.ts');
    h.drop();
    await save(h.documents, document, 'offline\n');
    h.documents.edit(document.id, { version: document.version, seq: 1, text: 'offline\nlater\n', overReload: false });
    h.reconnect('resume');
    await vi.waitFor(() => expect(document.pendingUpload).toBeUndefined());
    expect(onHost('src/a.ts')).toBe('offline\n');
    expect(document.text).toBe('offline\nlater\n');
    expect(isDocumentDirty(document)).toBe(true);
    h.end();
  });

  it('opens a three-way merge for a target that changed meanwhile, reporting every conflict of the pass at once, and writes nothing', async () => {
    onHost('src/a.ts', 'one\ntwo\nthree\n');
    onHost('src/b.ts', 'b\n');
    const h = host();
    const a = await h.open('src/a.ts');
    const b = await h.open('src/b.ts');
    h.drop();
    await save(h.documents, a, 'one\nmine\nthree\n');
    await save(h.documents, b, 'b mine\n');
    onHost('src/a.ts', 'one\ntheirs\nthree\n');
    onHost('src/b.ts', 'b theirs\n');
    h.reconnect('attach');
    await vi.waitFor(() => expect(h.conflicts).toHaveLength(1));
    expect(h.conflicts[0]!.authority).toBe('loopback');
    expect(h.conflicts[0]!.documents.map((document) => document.id).sort()).toEqual([a.id, b.id].sort());
    expect(a.uploadConflict).toEqual({ base: 'one\ntwo\nthree\n', current: 'one\ntheirs\nthree\n', incoming: 'one\nmine\nthree\n' });
    expect(a.pendingUpload).toBeUndefined();
    // the merge is the editor's to resolve, not the conflict bar's: the disk text is the target's, so a save writes over it
    expect(a.conflict).toBe(false);
    expect(a.diskText).toBe('one\ntheirs\nthree\n');
    // the Result starts as Reset Result's: the agreed lines merged, the conflict as markers naming the host and this computer
    expect(a.text).toBe('one\n<<<<<<< prod-1\ntheirs\n=======\nmine\n>>>>>>> Saved on this computer\nthree\n');
    expect(isDocumentDirty(a)).toBe(true);
    expect(onHost('src/a.ts')).toBe('one\ntheirs\nthree\n');
    expect(onHost('src/b.ts')).toBe('b theirs\n');
    // Complete Merge saves the Result over the target's text
    expect(await save(h.documents, a, 'one\nmerged\nthree\n')).toEqual({ ok: true });
    expect(onHost('src/a.ts')).toBe('one\nmerged\nthree\n');
    h.end();
  });

  it('merges against an empty Current when the target deleted the file meanwhile', async () => {
    onHost('src/a.ts', 'base\n');
    const h = host();
    const document = await h.open('src/a.ts');
    h.drop();
    await save(h.documents, document, 'offline\n');
    fs.rmSync(path.join(hostDir, 'src', 'a.ts'));
    h.reconnect('resume');
    await vi.waitFor(() => expect(h.conflicts).toHaveLength(1));
    expect(document.uploadConflict).toEqual({ base: 'base\n', current: '', incoming: 'offline\n' });
    expect(onHost('src/a.ts')).toBe('<missing>');
    h.end();
  });

  it('takes a target that changed to the very text saved offline as the upload, with no merge', async () => {
    onHost('src/a.ts', 'base\n');
    const h = host();
    const document = await h.open('src/a.ts');
    h.drop();
    await save(h.documents, document, 'same\n');
    onHost('src/a.ts', 'same\n');
    h.reconnect('resume');
    await vi.waitFor(() => expect(document.pendingUpload).toBeUndefined());
    expect(document.uploadConflict).toBeUndefined();
    expect(isDocumentDirty(document)).toBe(false);
    expect(h.conflicts).toEqual([]);
    h.end();
  });

  it('never lets a reconnect\'s disk re-read replace a pending buffer, and re-reads the host\'s other files', async () => {
    onHost('src/a.ts', 'base\n');
    onHost('src/clean.ts', 'clean\n');
    const h = host();
    const pending = await h.open('src/a.ts');
    const clean = await h.open('src/clean.ts');
    h.drop();
    await save(h.documents, pending, 'offline\n');
    onHost('src/clean.ts', 'changed while away\n');
    onHost('src/a.ts', 'theirs\n');
    h.reconnect('resume');
    await vi.waitFor(() => expect(clean.text).toBe('changed while away\n'));
    await vi.waitFor(() => expect(h.conflicts).toHaveLength(1));
    expect(pending.uploadConflict?.incoming).toBe('offline\n');
    h.end();
  });

  it('holds a pending upload whose tab closed until it uploads, and Don\'t Save drops only the edits made after it', async () => {
    onHost('src/a.ts', 'base\n');
    const h = host();
    const document = await h.open('src/a.ts');
    h.drop();
    await save(h.documents, document, 'offline\n');
    h.documents.edit(document.id, { version: document.version, seq: 1, text: 'offline\nlater\n', overReload: false });
    h.documents.release(document.id, true);
    expect(h.documents.get(document.id)).toBe(document);
    expect(document.text).toBe('offline\n');
    expect(h.backups.removed).toEqual([]);
    h.reconnect('resume');
    await vi.waitFor(() => expect(onHost('src/a.ts')).toBe('offline\n'));
    // landed, it leaves as a closed clean document does
    await vi.waitFor(() => expect(h.documents.get(document.id)).toBeUndefined());
    expect(h.backups.removed).toContain(document.backupId);
    h.end();
  });

  it('keeps a tab-less pending upload that a reopen shows again, after it uploads', async () => {
    onHost('src/a.ts', 'base\n');
    const h = host();
    const document = await h.open('src/a.ts');
    h.drop();
    await save(h.documents, document, 'offline\n');
    h.documents.release(document.id, false);
    h.reconnect('resume');
    expect(await h.open('src/a.ts')).toBe(document);
    await vi.waitFor(() => expect(document.pendingUpload).toBeUndefined());
    expect(h.documents.get(document.id)).toBe(document);
    h.end();
  });

  it('tells the user an upload that failed, and shows a failed save instead of the pending one, keeping the backup', async () => {
    onHost('src/a.ts', 'base\n');
    const h = host();
    const document = await h.open('src/a.ts');
    h.drop();
    await save(h.documents, document, 'offline\n');
    const file = path.join(hostDir, 'src', 'a.ts');
    const original = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (opened, flags, mode) => {
      if (String(opened) === file && flags === 'r+') throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' });
      return original(opened, flags, mode);
    });
    h.reconnect('resume');
    await vi.waitFor(() => expect(h.warnings).toHaveLength(1));
    expect(h.warnings[0]).toBe('a.ts was saved on this computer while prod-1 was away and could not be uploaded: Failed to save \'a.ts\': Insufficient permissions.');
    expect(document.pendingUpload).toBeUndefined();
    expect(document.saveFailed).toBe(true);
    expect(isDocumentDirty(document)).toBe(true);
    expect(h.backups.removed).not.toContain(document.backupId);
    expect(onHost('src/a.ts')).toBe('base\n');
    expect(h.conflicts).toEqual([]);
    // it had a tab, so nothing reopens it
    expect(h.reopened).toEqual([]);
    h.end();
  });

  it('shows a tab-less pending upload again when its upload fails, since it is dirty again', async () => {
    onHost('src/a.ts', 'base\n');
    const h = host();
    const document = await h.open('src/a.ts');
    h.drop();
    await save(h.documents, document, 'offline\n');
    h.documents.release(document.id, false);
    // the target is no longer text: the upload fails instead of merging
    fs.writeFileSync(path.join(hostDir, 'src', 'a.ts'), Buffer.from([0x61, 0xc3, 0x28, 0x0a]));
    h.reconnect('resume');
    await vi.waitFor(() => expect(h.warnings).toHaveLength(1));
    expect(h.reopened).toEqual([document]);
    expect(h.documents.get(document.id)).toBe(document);
    expect(isDocumentDirty(document)).toBe(true);
    h.end();
  });

  it('sends nothing while the host is still away, and uploads once on each pass however often it is asked', async () => {
    onHost('src/a.ts', 'base\n');
    const h = host();
    const document = await h.open('src/a.ts');
    h.drop();
    await save(h.documents, document, 'offline\n');
    h.documents.hostConnected('loopback');
    expect(document.pendingUpload).toEqual({ text: 'offline\n' });
    const write = vi.spyOn(fs.promises, 'open');
    h.reconnect('resume');
    h.documents.hostConnected('loopback');
    await vi.waitFor(() => expect(document.pendingUpload).toBeUndefined());
    expect(onHost('src/a.ts')).toBe('offline\n');
    expect(write.mock.calls.filter(([file, flags]) => String(file) === path.join(hostDir, 'src', 'a.ts') && flags === 'r+')).toHaveLength(1);
    h.end();
  });
});
