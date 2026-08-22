import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withRepoLock } from '../lock';

let repoDir: string;

/** Poll until `predicate` holds, so no assertion rides on a fixed wall-clock wait. */
async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('withRepoLock', () => {
  beforeEach(async () => {
    repoDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-lock-'));
  });

  afterEach(async () => {
    await fs.promises.rm(repoDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('runs the function and returns its value', async () => {
    const value = await withRepoLock(repoDir, async () => 42);
    expect(value).toBe(42);
  });

  it('serializes concurrent holders (mutual exclusion, no interleaving)', async () => {
    const order: string[] = [];
    const section = (tag: string): Promise<void> =>
      withRepoLock(repoDir, async () => {
        order.push(`${tag}-start`);
        await new Promise((r) => setTimeout(r, 40));
        order.push(`${tag}-end`);
      });
    await Promise.all([section('a'), section('b')]);
    // Acquisition order is not guaranteed under contention, but the two critical sections must run
    // to completion one after the other — never interleaved.
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(`${order[0]?.split('-')[0]}-end`);
    expect(order[3]).toBe(`${order[2]?.split('-')[0]}-end`);
    expect(order[0]).not.toBe(order[2]);
  });

  it('releases the lock even when the function throws', async () => {
    await expect(withRepoLock(repoDir, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    const after = await withRepoLock(repoDir, async () => 'recovered');
    expect(after).toBe('recovered');
  });

  it('breaks a stale lock left by a crashed holder', async () => {
    const lockDir = path.join(repoDir, '.checkpoint-lock');
    await fs.promises.mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await fs.promises.utimes(lockDir, old, old);

    const value = await withRepoLock(repoDir, async () => 'after-break');
    expect(value).toBe('after-break');
  });

  it('creates the repo directory if it is missing', async () => {
    const nested = path.join(repoDir, 'deep', 'nested');
    const value = await withRepoLock(nested, async () => 'ok');
    expect(value).toBe('ok');
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('does NOT break a stale-by-mtime lock whose owner process is still alive', async () => {
    const lockDir = path.join(repoDir, '.checkpoint-lock');
    await fs.promises.mkdir(lockDir, { recursive: true });
    // Owner = this (alive) process, but the mtime looks long-stale. The PID-liveness gate must keep
    // the lock from being broken, else two gits would race the shared index.
    await fs.promises.writeFile(path.join(lockDir, 'owner.pid'), String(process.pid), 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fs.promises.utimes(lockDir, old, old);

    let acquired = false;
    const attempt = withRepoLock(repoDir, async () => { acquired = true; }, { staleLockMs: 10, pollMs: 5 });
    await new Promise((r) => setTimeout(r, 150));
    expect(acquired).toBe(false);

    // Clear the simulated lock so the pending attempt can finally acquire (no dangling promise).
    await fs.promises.rm(lockDir, { recursive: true, force: true });
    await attempt;
    expect(acquired).toBe(true);
  });

  it('heartbeats the held lock’s mtime so a long-running holder is never declared stale', async () => {
    const lockDir = path.join(repoDir, '.checkpoint-lock');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = withRepoLock(repoDir, () => held, { heartbeatMs: 20 });
    await waitFor(() => fs.existsSync(lockDir), 'the lock to be acquired');

    // Back-date the held lock by a minute, far past the mtime resolution of any filesystem, so the
    // refresh is a jump no coarse-grained mtime can round away. A heartbeat can land between the write
    // and the read, so keep writing until the back-date is what stat reports.
    const backdateMs = 60_000;
    let backdatedTo = 0;
    await waitFor(async () => {
      const stale = new Date(Date.now() - backdateMs);
      await fs.promises.utimes(lockDir, stale, stale);
      backdatedTo = (await fs.promises.stat(lockDir)).mtimeMs;
      return Date.now() - backdatedTo > backdateMs / 2;
    }, 'the back-dated lock mtime to read back');

    await waitFor(
      async () => (await fs.promises.stat(lockDir)).mtimeMs > backdatedTo + backdateMs / 2,
      'the heartbeat to refresh the lock mtime',
    );
    expect(Date.now() - (await fs.promises.stat(lockDir)).mtimeMs).toBeLessThan(backdateMs / 2);

    release();
    await holder;
  });
});
