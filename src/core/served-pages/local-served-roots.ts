// The loopback servers of a chat's roots where the chat's core serves them itself (VS Code; docs/invariants.md "Browser"): one
// PreviewHttpServer per root, with the policy desktop main's ServedRoots serves by, held by the chats that opened a file of it,
// each on a grant host of its own, and closed with the last of them.
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { BrowserServedFiles } from '../../platform/platform';
import type { PanelHost } from '../../platform/window-service';
import { MAX_SERVED_FOLDERS_PER_CHAT, type ServedFile, type ServedFileAnswer } from '../../shared/served-file-url';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';
import type { LinkRule } from '../../platform/file-confinement';
import { readPreviewFile } from '../design/design-preview';
import { followsLocalLinksOnly, realpathOnOwnShare } from '../local-links';
import { folderKey } from '../workspace-folders/folder-key';
import { isInsideRealRoot, linkRootOf } from '../workspace-folders/real-root';
import { linkedPreviewRefused } from './host-data-stores';
import { PreviewHttpServer } from './preview-http-server';
import { answerPreview, type PreviewAnswer, type PreviewRangeRead, type PreviewRequest } from './preview-reader';
import { answerDesign, servedPathRefusal } from './root-files';

const READ_CHUNK_BYTES = 64 * 1024;

export interface LocalServedRootsDeps {
  // read at each request, so a project trusted later runs its pages' scripts at once
  readonly isTrusted: (root: string) => boolean;
  // "Open this preview from Damocles.", in the host's language
  readonly refusalText: () => string;
  readonly log: (line: string) => void;
}

interface Entry {
  readonly holders: Set<PanelHost>;
  readonly server: Promise<PreviewHttpServer>;
  // the server once an open awaited it, so a chat's dispose revokes its grant at once
  started: PreviewHttpServer | undefined;
}

function readFailure(err: unknown): PreviewRangeRead {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
  return { ok: false, reason: 'failed', ...(typeof code === 'string' ? { code } : {}) };
}

// The bytes from start to end of an open file, the handle closed once they are read, on an error, or on return().
function handleChunks(handle: fs.FileHandle, start: number, end: number): AsyncIterable<Uint8Array> {
  let position = start;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  const iterator: AsyncIterator<Uint8Array, undefined> = {
    next: async () => {
      const wanted = Math.min(READ_CHUNK_BYTES, end - position);
      if (closed || wanted <= 0) {
        await close();
        return { done: true, value: undefined };
      }
      const buffer = Buffer.allocUnsafe(wanted);
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, wanted, position));
      } catch (err) {
        await close();
        throw err;
      }
      if (bytesRead === 0) {
        await close();
        return { done: true, value: undefined };
      }
      position += bytesRead;
      return { done: false, value: buffer.subarray(0, bytesRead) };
    },
    return: async () => {
      await close();
      return { done: true, value: undefined };
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

/**
 * length bytes from offset (a negative offset counts from the end) of a granted folder's file, as answerPreview reads them,
 * confined as desktop's `confineEntry` confines (docs/invariants.md "Desktop host", Confinement): no link on the way to its
 * folder leads off this computer's drives (`followsLocalLinksOnly`, by lstat and readlink, before anything is resolved), the
 * folder's real path lies under the root's, and the file itself is a regular file, never followed, opened as the one its lstat
 * found. `pinned`: root is a real path, and a root whose real path is another now (the folder swapped for a link) serves nothing.
 */
export async function confinedRange(root: string, relPath: string, offset: number, length: number, pinned = false): Promise<PreviewRangeRead> {
  if (!isRelativeFilePath(relPath) || (process.platform === 'win32' && hasUnsafeWindowsSegment(relPath))) return { ok: false, reason: 'outside' };
  const segments = relPath.split('/');
  const lexical = path.join(root, ...segments);
  let realRoot: string;
  let entry: string;
  let found;
  try {
    if (!(await followsLocalLinksOnly(root, segments.slice(0, -1)))) return { ok: false, reason: 'outside' };
    let realParent: string;
    [realRoot, realParent] = await Promise.all([fs.realpath(root), fs.realpath(path.dirname(lexical))]);
    if (pinned && folderKey(realRoot) !== folderKey(root)) return { ok: false, reason: 'outside' };
    if (!isInsideRealRoot(realRoot, realParent)) return { ok: false, reason: 'outside' };
    entry = path.join(realParent, path.basename(lexical));
    found = await fs.lstat(entry, { bigint: true });
  } catch (err) {
    return readFailure(err);
  }
  return openedRange(entry, found, realRoot, offset, length);
}

// A project's range, every link followed as desktop's preview read follows them (`confineResolved` under rule, then an lstat of
// the realpath; docs/invariants.md "Desktop host", HTML previews): a realpath outside the root's only under throughLinks.
async function projectRange(root: string, relPath: string, rule: LinkRule, offset: number, length: number, log: (line: string) => void): Promise<PreviewRangeRead> {
  if (!isRelativeFilePath(relPath) || (process.platform === 'win32' && hasUnsafeWindowsSegment(relPath))) return { ok: false, reason: 'outside' };
  const segments = relPath.split('/');
  let base: string;
  let target: string;
  let found;
  try {
    if (!(await followsLocalLinksOnly(root, segments))) return { ok: false, reason: 'outside' };
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(path.join(root, ...segments))]);
    // the link root holds realTarget, so this one check covers it too
    if (!realpathOnOwnShare(root, realRoot, realTarget)) return { ok: false, reason: 'outside' };
    if (isInsideRealRoot(realRoot, realTarget)) {
      base = realRoot;
    } else {
      const via = rule === 'throughLinks' ? await linkRootOf(root, segments, realTarget) : undefined;
      if (via === undefined || (await linkedPreviewRefused(realTarget, via.realRoot, log))) return { ok: false, reason: 'outside' };
      base = via.realRoot;
    }
    target = realTarget;
    found = await fs.lstat(target, { bigint: true });
  } catch (err) {
    return readFailure(err);
  }
  return openedRange(target, found, base, offset, length);
}

// The range of entry, which an lstat found as `found`, opened only while it is still that regular file; resolvedPath is entry
// relative to base.
async function openedRange(entry: string, found: BigIntStats, base: string, offset: number, length: number): Promise<PreviewRangeRead> {
  if (!found.isFile()) return { ok: false, reason: 'notAFile', folder: found.isDirectory() };
  let handle: fs.FileHandle;
  try {
    // O_NONBLOCK keeps a FIFO swapped in after the lstat from holding the open until a writer comes; O_NOFOLLOW is POSIX only,
    // and the identity check below catches a link swapped in on win32
    handle = await fs.open(entry, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    return readFailure(err);
  }
  const opened = await handle.stat({ bigint: true }).catch(async (err: unknown) => {
    await handle.close();
    throw err;
  });
  if (!opened.isFile() || opened.dev !== found.dev || opened.ino !== found.ino) {
    await handle.close();
    return { ok: false, reason: 'failed', code: 'ECHANGED' };
  }
  const size = Number(opened.size);
  const start = offset < 0 ? Math.max(0, size + offset) : Math.min(offset, size);
  const count = Math.min(length, size - start);
  return { ok: true, size, offset: start, length: count, resolvedPath: path.relative(base, entry).split(path.sep).join('/'), chunks: handleChunks(handle, start, start + count) };
}

export class LocalServedRoots implements BrowserServedFiles, Disposable {
  private readonly deps: LocalServedRootsDeps;
  private readonly entries = new Map<string, Entry>();
  // each holding chat's grant holder name and dispose listener, which releases its roots
  private readonly chats = new Map<PanelHost, { readonly holder: string; readonly listener: Disposable }>();
  private chatsSeen = 0;
  private disposed = false;

  constructor(deps: LocalServedRootsDeps) {
    this.deps = deps;
  }

  async url(chat: PanelHost, file: ServedFile, root: string): Promise<ServedFileAnswer> {
    if (this.disposed) throw new Error('The served roots were disposed');
    const refusal = servedPathRefusal(file, file.relPath);
    if (refusal !== undefined) return { refused: refusal };
    const key = file.kind === 'design' ? `design\0${file.designId}\0${folderKey(root)}` : `${file.kind}\0${folderKey(root)}`;
    let entry = this.entries.get(key);
    if (file.kind === 'folder' && !entry?.holders.has(chat)) {
      const held = [...this.entries].filter(([other, { holders }]) => other.startsWith('folder\0') && holders.has(chat)).length;
      if (held >= MAX_SERVED_FOLDERS_PER_CHAT) return { refused: `This chat's browser already serves ${MAX_SERVED_FOLDERS_PER_CHAT} folders outside its project, the most one chat may open.` };
    }
    if (!entry) {
      entry = { holders: new Set(), server: this.start(file, root), started: undefined };
      this.entries.set(key, entry);
    }
    entry.holders.add(chat);
    if (!this.chats.has(chat)) this.chats.set(chat, { holder: `chat:${++this.chatsSeen}`, listener: chat.onDispose(() => this.release(chat)) });
    let server: PreviewHttpServer;
    try {
      server = await entry.server;
    } catch (err) {
      // a port that never opened is dropped, so the next open tries again
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw err;
    }
    const held = this.chats.get(chat);
    if (this.entries.get(key) !== entry || !entry.holders.has(chat) || !held) throw new Error('The served root was released while its server started');
    entry.started = server;
    const grant = server.grant(held.holder, 'own');
    return { url: grant.openUrl(file.relPath), origin: grant.origin };
  }

  dispose(): void {
    this.disposed = true;
    for (const { listener } of this.chats.values()) listener.dispose();
    this.chats.clear();
    for (const entry of this.entries.values()) this.close(entry);
    this.entries.clear();
  }

  private start(file: ServedFile, root: string): Promise<PreviewHttpServer> {
    const { log } = this.deps;
    // a granted folder has no trust of its own, the window's trust being the project's, so its pages run no script
    const trusted = (): boolean => file.kind === 'project' && this.deps.isTrusted(root);
    const serve = file.kind === 'design'
      ? (request: Pick<PreviewRequest, 'method' | 'pathname'>): Promise<PreviewAnswer> => answerDesign(request, (relPath) => readPreviewFile(root, file.designId, relPath), log)
      : (request: Pick<PreviewRequest, 'method' | 'pathname' | 'range' | 'ifRange'>): Promise<PreviewAnswer> => {
        // one look at trust per request, so the response's CSP and its read's link rule agree
        const linked = trusted();
        const range = file.kind === 'folder'
          ? (relPath: string, offset: number, length: number): Promise<PreviewRangeRead> => confinedRange(root, relPath, offset, length, true)
          : (relPath: string, offset: number, length: number): Promise<PreviewRangeRead> => projectRange(root, relPath, linked ? 'throughLinks' : 'withinProject', offset, length, log);
        return answerPreview({ ...request, trusted: linked, target: 'browser' }, { range }, log);
      };
    return PreviewHttpServer.start({
      serve,
      // a design server's own refusals are text and run nothing, so they carry the untrusted policy
      trusted,
      refusalText: this.deps.refusalText,
      log,
    });
  }

  private release(chat: PanelHost): void {
    const held = this.chats.get(chat);
    held?.listener.dispose();
    this.chats.delete(chat);
    for (const [key, entry] of [...this.entries]) {
      if (!entry.holders.delete(chat)) continue;
      if (entry.holders.size > 0) {
        if (held) entry.started?.revoke(held.holder);
        continue;
      }
      this.entries.delete(key);
      this.close(entry);
    }
  }

  private close(entry: Entry): void {
    // a start that failed is reported by the open that awaited it
    entry.server.then((server) => server.close().catch((err: unknown) => this.deps.log(`[served-roots] closing a served root's port failed: ${err instanceof Error ? err.message : String(err)}`)), () => undefined);
  }
}
