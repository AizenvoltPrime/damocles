import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { takeAgentFile, waitForAgentFile, type AgentFileOwner } from '../agent-file-owner';
import { sessionLeaseBlocker } from '../session-store/session-lease';

/**
 * The one-writer rule for agent session files, at the ownership itself: a second owner in this process waits for the first to let
 * go, a stop cancels that wait, a reopened file is keyed by the pi session id its name carries, and another process holding the
 * lease refuses the open.
 */

let workDir: string;
let childBundle: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-agent-file-owner-'));
  childBundle = path.join(workDir, 'lease-holder-child.cjs');
  // The child runs the real lease module in a plain node process, as another Damocles window would.
  await build({
    entryPoints: [path.join(__dirname, '..', 'session-store', '__tests__', 'fixtures', 'session-lease-holder-child.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: childBundle,
    external: ['@earendil-works/*'],
    logLevel: 'silent',
  });
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
});

const memberId = (): string => `${randomUUID()}.a0`;

const waiter = (signal = new AbortController().signal) => ({ signal, onWindDown: () => undefined });

/** Another process holding `sessionId`'s lease; resolves with its answer and a way to tell it to let go. */
async function otherWindow(sessionId: string): Promise<{ answer: unknown; release: () => Promise<unknown> }> {
  // The child inherits this file's hermetic HOME, so both processes share one ~/.damocles.
  const child = fork(childBundle, [sessionId], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  const next = (): Promise<unknown> => new Promise((resolve) => child.once('message', resolve));
  const answer = await next();
  return { answer, release: () => { const released = next(); child.send('release'); return released; } };
}

/** Where pi puts the file of session `sessionId` (`<timestamp>_<sessionId>.jsonl`). */
const sessionFile = (sessionId: string): string => path.join(workDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);

describe('agent session file ownership', () => {
  it('a second owner in this process waits until the first let go, and a reopen is keyed by the id the file name carries', async () => {
    const id = memberId();
    const first = takeAgentFile({ kind: 'file', dir: workDir, id })!;
    expect(first).not.toBeNull();
    const reopen = { kind: 'reopen', path: sessionFile(id), agentId: 'member' } as const;
    expect(takeAgentFile(reopen)).toBeNull();
    let second: AgentFileOwner | null = null;
    const next = waitForAgentFile(reopen, waiter()).then((owner) => { second = owner; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second).toBeNull();

    first.release();
    await next;
    expect(second).not.toBeNull();
    second!.release();
  });

  it('a stop cancels the wait, and the cancelled waiter never takes the file from the next one', async () => {
    const id = memberId();
    const first = takeAgentFile({ kind: 'file', dir: workDir, id })!;
    const stop = new AbortController();
    const cancelled = waitForAgentFile({ kind: 'file', dir: workDir, id }, waiter(stop.signal));
    stop.abort();
    await expect(cancelled).rejects.toThrow();

    first.release();
    const owner = takeAgentFile({ kind: 'file', dir: workDir, id });
    expect(owner).not.toBeNull();
    owner!.release();
    expect(sessionLeaseBlocker(id)).toBeUndefined();
  });

  it('a file whose lease another Damocles process holds is refused, naming why, and opens once that process let go', async () => {
    const id = memberId();
    const other = await otherWindow(id);
    expect(other.answer).toBe('held');

    expect(() => takeAgentFile({ kind: 'file', dir: workDir, id })).toThrow(
      `Its session file ${id} is still open in another Damocles window, whose stopped run has not finished. Wait for that run to stop or close that window, then try again.`,
    );

    expect(await other.release()).toBe('released');
    const owner = takeAgentFile({ kind: 'reopen', path: sessionFile(id), agentId: 'member' });
    expect(owner).not.toBeNull();
    owner!.release();
  }, 20_000);

  it('a reopen of a file pi did not name is refused before anything owns it', () => {
    const file = path.join(workDir, 'member.jsonl');
    expect(() => takeAgentFile({ kind: 'reopen', path: file, agentId: 'member' })).toThrow(`Agent file ${file} is not named as pi names a session file.`);
  });
});
