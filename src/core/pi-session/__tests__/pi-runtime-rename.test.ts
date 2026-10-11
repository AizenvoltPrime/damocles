import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiRuntime } from '../pi-runtime';
import { ensurePiSessionDir } from '../session-store/session-dir';
import { DAMOCLES_USER_RENAMED_ENTRY } from '../session-store/constants';
import { acquireSessionLease, releaseSessionLease, sessionLeasePath, type SessionLeaseHolder } from '../session-store/session-lease';
import { getPiCodingAgent, initPiLoader } from '../pi-loader';

afterEach(async () => {
  await PiRuntime.disposeInstance();
});

const cwd = path.join(os.homedir(), 'hook-rename');

type Message = Parameters<SessionManager['appendMessage']>[0];

async function storedSession(): Promise<{ id: string; file: string }> {
  await initPiLoader();
  const pi = getPiCodingAgent();
  if (!pi) throw new Error('pi coding-agent failed to load');
  const sm = pi.SessionManager.create(cwd, ensurePiSessionDir(cwd));
  sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'fix the parser' }], timestamp: Date.now() } as Message);
  return { id: sm.getSessionId(), file: sm.getSessionFile()! };
}

function reopen(file: string): SessionManager {
  return getPiCodingAgent()!.SessionManager.open(file, ensurePiSessionDir(cwd));
}

describe("PiRuntime.renameSession, a configured hook's sessionTitle rename", () => {
  it('with no live holder, renames the stored file under the lease and releases it', async () => {
    const { id, file } = await storedSession();

    await PiRuntime.get().renameSession(id, cwd, 'Hook Title');

    expect(reopen(file).getSessionName()).toBe('Hook Title');
    expect(reopen(file).getEntries().some((e) => e.type === 'custom' && e.customType === DAMOCLES_USER_RENAMED_ENTRY)).toBe(true);
    expect(fs.existsSync(sessionLeasePath(id))).toBe(false);
  });

  it('rejects and writes nothing while a panel of this process holds the session with no live session to write through', async () => {
    const { id, file } = await storedSession();
    const before = fs.readFileSync(file, 'utf8');
    const opening: SessionLeaseHolder = { onSessionLeaseLost: () => undefined };
    expect(acquireSessionLease(id, opening)).toBe(true);
    try {
      await expect(PiRuntime.get().renameSession(id, cwd, 'Hook Title')).rejects.toThrow(/not renamed/);
    } finally {
      releaseSessionLease(id, opening);
    }

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('rejects and writes nothing while a write of this process, such as a delete, holds the lease', async () => {
    const { id, file } = await storedSession();
    const before = fs.readFileSync(file, 'utf8');
    const deleting: SessionLeaseHolder = { onSessionLeaseLost: () => undefined };
    expect(acquireSessionLease(id, deleting, { writer: true })).toBe(true);
    try {
      await expect(PiRuntime.get().renameSession(id, cwd, 'Hook Title')).rejects.toThrow(/not renamed/);
    } finally {
      releaseSessionLease(id, deleting);
    }

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('rejects and writes nothing while another process holds the lease', async () => {
    const { id, file } = await storedSession();
    const before = fs.readFileSync(file, 'utf8');
    // proper-lockfile's lock is this directory; a fresh one is another process's live lease.
    fs.mkdirSync(sessionLeasePath(id), { recursive: true });
    try {
      await expect(PiRuntime.get().renameSession(id, cwd, 'Hook Title')).rejects.toThrow(/not renamed/);
    } finally {
      fs.rmSync(sessionLeasePath(id), { recursive: true, force: true });
    }

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
