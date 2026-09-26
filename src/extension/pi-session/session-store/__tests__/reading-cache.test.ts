import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { initPiLoader } from '../../pi-loader';
import { SESSION_META_CACHE_DIR } from '../../../paths';
import { ensurePiSessionDir } from '../session-dir';
import {
  currentCachedRow,
  extractPiPromptHistory,
  forgetSessionMetadata,
  getPiSessionMetadataByFile,
  listPiSessions,
  readLiveSessionMetadata,
  resolvePiSessionFile,
} from '../reading';
import { flushSessionMetaCache, getSessionMeta, resetSessionMetaCacheMemory } from '../session-meta-cache';
import { sessionFileMeta } from '../metadata';
import { DAMOCLES_ORIGINAL_INPUT_ENTRY, DAMOCLES_TAG_ENTRY, DAMOCLES_USER_RENAMED_ENTRY } from '../constants';

const CWD = path.join(os.homedir(), 'reading-cache-workspace');
const SESSION_ID = '01a0e000-0000-7000-8000-000000000001';

function line(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

function userEntry(id: string, parentId: string | null, text: string): string {
  return line({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 } });
}

const isCurrent = async (file: string): Promise<boolean> => (await currentCachedRow(file)) !== undefined;

describe('session metadata cache validity', () => {
  it('treats a same-mtime append as a change, because the size differs', async () => {
    const file = path.join(ensurePiSessionDir(CWD), `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
    fs.writeFileSync(file, line({ type: 'session', version: 3, id: SESSION_ID, timestamp: '2026-01-01T00:00:00.000Z', cwd: CWD }) + userEntry('u1', null, 'first'));
    // Whole milliseconds, which `utimesSync` round-trips exactly.
    const mtime = new Date(1_767_225_600_000);
    fs.utimesSync(file, mtime, mtime);

    expect(await isCurrent(file)).toBe(false);
    const [before] = await listPiSessions(CWD);
    expect(before?.messageCount).toBe(1);
    expect(await isCurrent(file)).toBe(true);

    fs.appendFileSync(file, userEntry('u2', 'u1', 'second'));
    fs.utimesSync(file, mtime, mtime);
    expect(fs.statSync(file).mtimeMs).toBe(mtime.getTime());

    expect(await isCurrent(file)).toBe(false);
    const [after] = await listPiSessions(CWD);
    expect(after?.messageCount).toBe(2);
  });
});

const pi = (await initPiLoader())!;

/** Strictly increasing message times, so the list order never rests on a same-millisecond tie. */
let clock = 1_700_000_000_000;
const user = (text: string): never => ({ role: 'user', content: [{ type: 'text', text }], timestamp: clock++ }) as never;
const reply = (text: string): never => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp: clock++,
}) as never;

function writeSession(cwd: string, sm: SessionManager): string {
  const file = path.join(ensurePiSessionDir(cwd), `${sm.getHeader()!.timestamp.replace(/[:.]/g, '-')}_${sm.getSessionId()}.jsonl`);
  fs.writeFileSync(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

/** Sessions exercising everything the list and the history read: rename, tag, an expanded slash command,
 *  a rewound-away prompt, a synthetic prompt, duplicates within and across sessions, and a header-less file. */
function buildStore(cwd: string): string[] {
  const renamed = pi.SessionManager.inMemory(cwd);
  renamed.appendMessage(user('first question'));
  const replyId = renamed.appendMessage(reply('answer'));
  renamed.appendMessage(user('rewound away'));
  renamed.branch(replyId);
  const expanded = renamed.appendMessage(user('Hello day is Tuesday'));
  renamed.appendCustomEntry(DAMOCLES_ORIGINAL_INPUT_ENTRY, { userEntryId: expanded, original: '/example what is the day' });
  renamed.appendMessage(user('<system-reminder>synthetic</system-reminder>'));
  renamed.appendMessage(user('first question'));
  renamed.appendSessionInfo('My name');
  renamed.appendCustomEntry(DAMOCLES_USER_RENAMED_ENTRY);
  renamed.appendCustomEntry(DAMOCLES_TAG_ENTRY, { tag: 'urgent' });

  const titled = pi.SessionManager.inMemory(cwd);
  titled.appendMessage(user('shared prompt'));
  titled.appendMessage(reply('ok'));
  titled.appendMessage(user('first question'));
  titled.appendSessionInfo('AI title');

  const headerless = path.join(ensurePiSessionDir(cwd), '2026-01-01T00-00-00-000Z_01a0e000-0000-7000-8000-00000000dead.jsonl');
  fs.writeFileSync(headerless, line({ type: 'message', id: 'x', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: user('orphan') }));
  return [writeSession(cwd, renamed), writeSession(cwd, titled), headerless];
}

const idOf = (file: string): string => path.basename(file, '.jsonl').split('_')[1]!;

/** A new window: the in-memory layer is gone, and only the disk cache remains. */
function newWindow(): void {
  flushSessionMetaCache();
  resetSessionMetaCacheMemory();
}

function coldStart(): void {
  resetSessionMetaCacheMemory();
  fs.rmSync(SESSION_META_CACHE_DIR, { recursive: true, force: true });
}

describe('persistent session metadata', () => {
  it('a new window lists and builds the prompt history without opening a file, with the uncached output', async () => {
    const cwd = path.join(os.homedir(), 'persistent-meta-workspace');
    buildStore(cwd);
    const open = vi.spyOn(pi.SessionManager, 'open');
    try {
      coldStart();
      const coldList = await listPiSessions(cwd);
      const coldHistory = await extractPiPromptHistory([cwd], coldList);
      expect(open).toHaveBeenCalledTimes(3);
      expect(coldList.map((s) => [s.customTitle ?? s.aiTitle, s.tag, s.preview])).toEqual([
        ['AI title', undefined, 'shared prompt'],
        ['My name', 'urgent', 'first question'],
      ]);
      expect(coldHistory).toEqual(['first question', 'shared prompt', '/example what is the day']);

      newWindow();
      open.mockClear();
      const warmList = await listPiSessions(cwd);
      const warmHistory = await extractPiPromptHistory([cwd], warmList);

      expect(open).not.toHaveBeenCalled();
      expect(warmList).toEqual(coldList);
      expect(warmHistory).toEqual(coldHistory);
    } finally {
      open.mockRestore();
    }
  });

  it('prompt history opens only the files whose cache entry is stale', async () => {
    const cwd = path.join(os.homedir(), 'stale-history-workspace');
    const [first] = buildStore(cwd);
    coldStart();
    const sessions = await listPiSessions(cwd);
    fs.appendFileSync(first!, '\n');
    const open = vi.spyOn(pi.SessionManager, 'open');
    try {
      await extractPiPromptHistory([cwd], sessions);
      expect(open.mock.calls.map(([file]) => file)).toEqual([first]);
    } finally {
      open.mockRestore();
    }
  });

  it("a live session's metadata equals what reading its file gives, and later lists reuse it", async () => {
    const cwd = path.join(os.homedir(), 'live-meta-workspace');
    const [file] = buildStore(cwd);
    coldStart();
    const fromFile = (await listPiSessions(cwd)).find((s) => s.id === idOf(file!))!;
    const live = pi.SessionManager.open(file!, path.dirname(file!));
    // A leaf moved without a write is not in the file yet, so it must not reach the list.
    live.branch(live.getEntries()[0]!.id);
    coldStart();

    const open = vi.spyOn(pi.SessionManager, 'open');
    try {
      const stored = readLiveSessionMetadata(
        { liveSessionFile: () => live.getSessionFile(), storedMetadata: (mtimeMs) => sessionFileMeta(live, mtimeMs) },
        live.getSessionId(),
      );
      expect(stored).toEqual(fromFile);
      expect(await isCurrent(file!)).toBe(true);
      expect((await listPiSessions(cwd)).find((s) => s.id === fromFile.id)).toEqual(fromFile);
      expect(open.mock.calls.map(([f]) => f)).not.toContain(file);
    } finally {
      open.mockRestore();
    }
  });

  it("a live session's metadata waits for the next flush instead of scheduling one", async () => {
    const cwd = path.join(os.homedir(), 'live-unscheduled-workspace');
    const [file] = buildStore(cwd);
    coldStart();
    const live = pi.SessionManager.open(file!, path.dirname(file!));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      readLiveSessionMetadata(
        { liveSessionFile: () => live.getSessionFile(), storedMetadata: (mtimeMs) => sessionFileMeta(live, mtimeMs) },
        live.getSessionId(),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    newWindow();
    expect(await isCurrent(file!)).toBe(true);
  });

  it('a live snapshot that throws leaves the caller to read the file', async () => {
    const cwd = path.join(os.homedir(), 'live-throws-workspace');
    const [file] = buildStore(cwd);
    const source = { liveSessionFile: () => file, storedMetadata: (): never => { throw new Error('disposed'); } };

    expect(readLiveSessionMetadata(source, idOf(file!))).toBeUndefined();
  });

  it('a live source holding another file is not used', async () => {
    const cwd = path.join(os.homedir(), 'live-mismatch-workspace');
    const [file, other] = buildStore(cwd);
    const source = { liveSessionFile: () => file, storedMetadata: () => ({ stored: null, prompts: [] }) };

    expect(readLiveSessionMetadata(source, idOf(other!))).toBeUndefined();
    expect(readLiveSessionMetadata(source, idOf(file!), other)).toBeUndefined();
  });
});

describe('session file index', () => {
  it('resolves a listed session without a readdir, and falls back to one when the file is gone', async () => {
    const cwd = path.join(os.homedir(), 'resolve-index-workspace');
    const [file] = buildStore(cwd);
    await listPiSessions(cwd);
    const readdir = vi.spyOn(fs.promises, 'readdir');
    try {
      expect(await resolvePiSessionFile(cwd, idOf(file!))).toBe(file);
      expect(readdir).not.toHaveBeenCalled();

      fs.rmSync(file!);
      expect(await resolvePiSessionFile(cwd, idOf(file!))).toBeNull();
      expect(readdir).toHaveBeenCalledTimes(1);
    } finally {
      readdir.mockRestore();
    }
  });

  it("never answers from the index for another workspace's session dir", async () => {
    const cwd = path.join(os.homedir(), 'resolve-index-home');
    const [file] = buildStore(cwd);
    await listPiSessions(cwd);

    expect(await resolvePiSessionFile(path.join(os.homedir(), 'resolve-index-elsewhere'), idOf(file!))).toBeNull();
    expect(await resolvePiSessionFile(cwd, '../../etc/passwd')).toBeNull();
  });

  it('forgetting a deleted file drops it from the disk cache', async () => {
    const cwd = path.join(os.homedir(), 'forget-workspace');
    const [file] = buildStore(cwd);
    coldStart();
    await listPiSessions(cwd);
    newWindow();
    expect(await isCurrent(file!)).toBe(true);

    forgetSessionMetadata(file!);
    newWindow();

    expect(await isCurrent(file!)).toBe(false);
  });

  it('reading a deleted file yields no row, forgets its entry and never recreates it', async () => {
    const cwd = path.join(os.homedir(), 'deleted-read-workspace');
    const [file] = buildStore(cwd);
    coldStart();
    await listPiSessions(cwd);
    fs.rmSync(file!);
    const remaining = fs.readdirSync(path.dirname(file!));

    expect(await getPiSessionMetadataByFile(file!)).toBeNull();
    expect(fs.readdirSync(path.dirname(file!))).toEqual(remaining);
    expect(getSessionMeta(file!)).toBeUndefined();
  });
});
