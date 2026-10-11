import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';

const { tmpHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { tmpHome: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-title-home-')) };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

// A pass-through, so a case can delete the file between the path lookup and the write.
vi.mock('../reading', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reading')>();
  return { ...actual, resolvePiSessionFile: vi.fn(actual.resolvePiSessionFile) };
});

import { titleStoredPiSession } from '../mutations';
import { ensurePiSessionDir } from '../session-dir';
import { resolvePiSessionFile } from '../reading';
import { acquireSessionLease, releaseSessionLease, sessionLeasePath, type SessionLeaseHolder } from '../session-lease';
import { DAMOCLES_USER_RENAMED_ENTRY } from '../constants';
import { getPiCodingAgent, initPiLoader } from '../../pi-loader';

afterEach(() => {
  vi.mocked(resolvePiSessionFile).mockClear();
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const cwd = path.join(tmpHome, 'workspace');

type Message = Parameters<SessionManager['appendMessage']>[0];
const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }) as Message;

/** A persisted session holding one prompt, named `name` when given. */
async function storedSession(name?: string): Promise<{ id: string; file: string }> {
  await initPiLoader();
  const pi = getPiCodingAgent();
  if (!pi) throw new Error('pi coding-agent failed to load');
  const sm = pi.SessionManager.create(cwd, ensurePiSessionDir(cwd));
  sm.appendMessage(user('fix the parser'));
  if (name) sm.appendSessionInfo(name);
  return { id: sm.getSessionId(), file: sm.getSessionFile()! };
}

function reopen(file: string): SessionManager {
  return getPiCodingAgent()!.SessionManager.open(file, ensurePiSessionDir(cwd));
}

const noLiveHolder = (): null => null;

describe('titleStoredPiSession', () => {
  it('titles an unnamed file as an AI title, without the user-renamed marker, and releases the lease', async () => {
    const { id, file } = await storedSession();

    expect(await titleStoredPiSession(cwd, id, 'Fix The Parser', noLiveHolder)).toBe('titled');

    const entries = reopen(file).getEntries();
    expect(reopen(file).getSessionName()).toBe('Fix The Parser');
    expect(entries.filter((e) => e.type === 'session_info')).toHaveLength(1);
    expect(entries.some((e) => e.type === 'custom' && e.customType === DAMOCLES_USER_RENAMED_ENTRY)).toBe(false);
    expect(fs.existsSync(sessionLeasePath(id))).toBe(false);
  });

  it('skips a file that already has a name', async () => {
    const { id, file } = await storedSession('My Name');
    const before = fs.readFileSync(file, 'utf8');

    expect(await titleStoredPiSession(cwd, id, 'Fix The Parser', noLiveHolder)).toBe('named');

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('writes nothing while another process holds the lease', async () => {
    const { id, file } = await storedSession();
    const before = fs.readFileSync(file, 'utf8');
    // proper-lockfile's lock is this directory; a fresh one is another process's live lease.
    fs.mkdirSync(sessionLeasePath(id), { recursive: true });
    try {
      expect(await titleStoredPiSession(cwd, id, 'Fix The Parser', noLiveHolder)).toBe('leased');
    } finally {
      fs.rmSync(sessionLeasePath(id), { recursive: true, force: true });
    }

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('writes nothing while a write of this process, such as a delete, holds the lease', async () => {
    const { id, file } = await storedSession();
    const before = fs.readFileSync(file, 'utf8');
    const deleting: SessionLeaseHolder = { onSessionLeaseLost: () => undefined };
    expect(acquireSessionLease(id, deleting, { writer: true })).toBe(true);
    try {
      expect(await titleStoredPiSession(cwd, id, 'Fix The Parser', noLiveHolder)).toBe('leased');
    } finally {
      releaseSessionLease(id, deleting);
    }

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('never creates a file deleted after its path was resolved', async () => {
    const { id, file } = await storedSession();
    const resolveReal = vi.mocked(resolvePiSessionFile).getMockImplementation()!;
    vi.mocked(resolvePiSessionFile).mockImplementationOnce(async (dir, sessionId) => {
      const resolved = await resolveReal(dir, sessionId);
      fs.rmSync(file);
      return resolved;
    });

    expect(await titleStoredPiSession(cwd, id, 'Fix The Parser', noLiveHolder)).toBe('missing');

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(sessionLeasePath(id))).toBe(false);
  });

  it('never creates a file for a session that has none', async () => {
    const { id, file } = await storedSession();
    fs.rmSync(file);

    expect(await titleStoredPiSession(cwd, id, 'Fix The Parser', noLiveHolder)).toBe('missing');

    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(id))).toEqual([]);
  });

  it('hands the title to a live holder found at write time and leaves the file alone', async () => {
    const { id, file } = await storedSession();
    const before = fs.readFileSync(file, 'utf8');
    const order: string[] = [];
    const resolveReal = vi.mocked(resolvePiSessionFile).getMockImplementation()!;
    vi.mocked(resolvePiSessionFile).mockImplementationOnce(async (dir, sessionId) => {
      const resolved = await resolveReal(dir, sessionId);
      order.push('resolved');
      return resolved;
    });
    const applyLive = vi.fn(() => {
      order.push('live');
      return 'live' as const;
    });

    expect(await titleStoredPiSession(cwd, id, 'Fix The Parser', applyLive)).toBe('live');

    // Asked after the last await, so a holder that went live during the lookup is the one found.
    expect(order).toEqual(['resolved', 'live']);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('writes nothing while a panel of this process holds the session without a live session to write through', async () => {
    const { id, file } = await storedSession();
    const before = fs.readFileSync(file, 'utf8');
    // A panel opening the conversation (a resume target not started yet, a switch in flight) holds its lease, not a writer.
    const opening: SessionLeaseHolder = { onSessionLeaseLost: () => undefined };
    expect(acquireSessionLease(id, opening)).toBe(true);
    try {
      expect(await titleStoredPiSession(cwd, id, 'Fix The Parser', noLiveHolder)).toBe('held');
    } finally {
      releaseSessionLease(id, opening);
    }

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
