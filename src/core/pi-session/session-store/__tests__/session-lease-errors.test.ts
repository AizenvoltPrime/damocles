import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import type { ChatSession } from '../../../chat-session';

const LOCK = vi.hoisted(() => ({ error: null as NodeJS.ErrnoException | null, beforeRelease: null as (() => void) | null }));
vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>();
  return {
    ...actual,
    lockSync: (...args: Parameters<typeof actual.lockSync>) => {
      if (LOCK.error) throw LOCK.error;
      const release = actual.lockSync(...args);
      return () => {
        LOCK.beforeRelease?.();
        release();
      };
    },
  };
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SESSION_LEASE_DIR, acquireSessionLease, releaseSessionLease, type SessionLeaseHolder } from '../session-lease';
import { claimStoredSession } from '../../../chat-panel/session-ownership';

const holder: SessionLeaseHolder = { onSessionLeaseLost: () => undefined };
const failWith = (code: string): void => { LOCK.error = Object.assign(new Error(`${code}: lock failed`), { code }); };
const realPlatform = process.platform;
const onPlatform = (value: NodeJS.Platform): void => { Object.defineProperty(process, 'platform', { value, configurable: true }); };

afterEach(() => {
  LOCK.error = null;
  LOCK.beforeRelease = null;
  onPlatform(realPlatform);
});

describe('session lease errors', () => {
  it('removes the owner record before the lock, so no other process writes its own record in between', () => {
    const owner = path.join(SESSION_LEASE_DIR, 'sess-order.owner');
    const ownerAtRelease: boolean[] = [];
    LOCK.beforeRelease = () => ownerAtRelease.push(fs.existsSync(owner));
    expect(acquireSessionLease('sess-order', holder)).toBe(true);
    expect(fs.existsSync(owner)).toBe(true);

    releaseSessionLease('sess-order', holder);

    expect(ownerAtRelease).toEqual([false]);
  });

  it('reads EPERM on Windows as a lease another process is releasing: busy, not an error', () => {
    onPlatform('win32');
    failWith('EPERM');
    expect(acquireSessionLease('sess-eperm-win', holder)).toBe(false);
  });

  it('still throws EPERM elsewhere, where it means a permission problem', () => {
    onPlatform('linux');
    failWith('EPERM');
    expect(() => acquireSessionLease('sess-eperm-linux', holder)).toThrow(/EPERM/);
  });

  it('turns any other lock failure into a refused claim with the reason, never a throw into the handler', () => {
    failWith('EACCES');
    const platform = createFakePlatform();
    const session = { setResumeSession: vi.fn(), onSessionLeaseLost: vi.fn(), holdsSession: () => false } as unknown as ChatSession & { setResumeSession: ReturnType<typeof vi.fn> };

    const refusal = claimStoredSession(platform.notifications, new Map(), { panelId: 'p1', session }, 'sess-eacces');

    expect(refusal).toEqual({ lease: { kind: 'unreadable', reason: 'EACCES: lock failed' } });
    expect(session.setResumeSession).not.toHaveBeenCalled();
    expect(platform.notifications.calls.map((c) => c.message)).toEqual(['This conversation could not be opened: EACCES: lock failed']);
  });
});
