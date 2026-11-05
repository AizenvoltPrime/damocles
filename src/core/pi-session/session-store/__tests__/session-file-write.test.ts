import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionFileOf, writeSessionFile } from '../session-file-write';
import { piSessionsRoot } from '../session-dir';
import { acquireSessionLease, releaseSessionLease, sessionLeaseBlocker, sessionLeasePath, type SessionLeaseHolder } from '../session-lease';
import { takeAgentFile } from '../../agent-file-owner';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const bytes = (text: string): Uint8Array => Buffer.from(text);

let root: string;
let dir: string;

beforeEach(() => {
  fs.mkdirSync(piSessionsRoot(), { recursive: true });
  root = fs.realpathSync.native(piSessionsRoot());
  dir = path.join(root, `--work-${randomUUID()}--`);
  fs.mkdirSync(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function file(relative: string, content: string): string {
  const target = path.join(dir, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

const chatName = (sessionId: string): string => `2026-11-04T10-00-00-000Z_${sessionId}.jsonl`;

describe('sessionFileOf', () => {
  it('classifies this engine\'s files by their canonical path, and no relative path or file outside its session folder', () => {
    const parent = randomUUID();
    expect(sessionFileOf(file(chatName(parent), ''))).toMatchObject({ kind: 'chat', sessionId: parent });
    expect(sessionFileOf(file(`${parent}/subagents/2026-11-04T10-00-00-000Z_agent-1.jsonl`, ''))).toMatchObject({ kind: 'agent', sessionId: 'agent-1' });
    expect(sessionFileOf(path.join(path.dirname(root), chatName(parent)))).toBeUndefined();
    expect(sessionFileOf(chatName(parent))).toBeUndefined();
  });

  it('names a session file reached through a link to the session folder', () => {
    const target = file(chatName(randomUUID()), '');
    const link = path.join(path.dirname(root), `link-${randomUUID()}`);
    fs.symlinkSync(dir, link, 'junction');
    try {
      expect(sessionFileOf(path.join(link, path.basename(target)))).toMatchObject({ kind: 'chat', canonicalPath: target });
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('names a session file spelled in another case', () => {
    const target = file(chatName(randomUUID()), '');
    expect(sessionFileOf(target.toUpperCase())).toMatchObject({ kind: 'chat' });
  });
});

describe('writeSessionFile', () => {
  it('writes a chat file under its session lease, as a writer no panel can join meanwhile', async () => {
    const sessionId = randomUUID();
    const target = file(chatName(sessionId), 'old\n');
    const seen: unknown[] = [];
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      seen.push(sessionLeaseBlocker(sessionId));
      return open(...args);
    });

    expect(await writeSessionFile(target, bytes('new\n'), sha('old\n'))).toMatchObject({ kind: 'written' });

    expect(seen).toEqual([{ kind: 'writing' }]);
    expect(fs.readFileSync(target, 'utf8')).toBe('new\n');
    expect(sessionLeaseBlocker(sessionId)).toBeUndefined();
  });

  it('refuses a chat file a panel of this process holds', async () => {
    const sessionId = randomUUID();
    const target = file(chatName(sessionId), 'old\n');
    const panel: SessionLeaseHolder = { onSessionLeaseLost: () => undefined };
    acquireSessionLease(sessionId, panel);
    try {
      expect(await writeSessionFile(target, bytes('new\n'), sha('old\n'))).toEqual({ kind: 'refused', reason: 'held' });
    } finally {
      releaseSessionLease(sessionId, panel);
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('old\n');
  });

  it('refuses a chat file whose lease another process holds', async () => {
    const sessionId = randomUUID();
    const target = file(chatName(sessionId), 'old\n');
    // a fresh lock is another process's live lease
    fs.mkdirSync(sessionLeasePath(sessionId), { recursive: true });
    try {
      expect(await writeSessionFile(target, bytes('new\n'), sha('old\n'))).toEqual({ kind: 'refused', reason: 'otherProcess' });
    } finally {
      fs.rmSync(sessionLeasePath(sessionId), { recursive: true, force: true });
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('old\n');
  });

  it('answers changed, writing nothing, when the bytes no longer hash to the ones last read or a missing file exists', async () => {
    const target = file(chatName(randomUUID()), 'appended since\n');

    expect(await writeSessionFile(target, bytes('new\n'), sha('old\n'))).toEqual({ kind: 'changed' });
    expect(await writeSessionFile(target, bytes('new\n'), null)).toEqual({ kind: 'changed' });
    expect(fs.readFileSync(target, 'utf8')).toBe('appended since\n');
  });

  it('answers outside for a path that is no longer its own canonical path', async () => {
    const target = file(chatName(randomUUID()), 'old\n');
    const link = path.join(path.dirname(root), `link-${randomUUID()}`);
    fs.symlinkSync(dir, link, 'junction');
    try {
      expect(await writeSessionFile(path.join(link, path.basename(target)), bytes('new\n'), sha('old\n'))).toEqual({ kind: 'outside' });
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('old\n');
  });

  it('refuses an agent file while the run that opened it has not settled, and writes it once that run let go', async () => {
    const target = file(`${randomUUID()}/subagents/2026-11-04T10-00-00-000Z_agent-${randomUUID()}.jsonl`, 'old\n');
    const run = takeAgentFile({ kind: 'reopen', path: target, agentId: 'agent' })!;

    expect(await writeSessionFile(target, bytes('new\n'), sha('old\n'))).toEqual({ kind: 'refused', reason: 'held' });
    expect(fs.readFileSync(target, 'utf8')).toBe('old\n');

    run.release();
    expect(await writeSessionFile(target, bytes('new\n'), sha('old\n'))).toMatchObject({ kind: 'written' });
    expect(fs.readFileSync(target, 'utf8')).toBe('new\n');
    // the write let go of the file too, so the next run takes it at once
    takeAgentFile({ kind: 'reopen', path: target, agentId: 'agent' })!.release();
  });
});
