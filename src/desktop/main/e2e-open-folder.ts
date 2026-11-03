import type { Authorities } from './remote/authorities';
import type { RemoteConnections } from './remote/connections';

// what the spec keeps of its timeout after a stuck connect, to fail with the connect's cause before Playwright's timeout
const OPEN_FOLDER_MARGIN_MS = 60_000;
const POLL_MS = 100;

/** The openFolder connect's deadline in a test of testTimeoutMs: the margin under it, or half a timeout under twice the margin; none for no timeout (0). */
export function openFolderDeadlineMs(testTimeoutMs: number): number {
  if (testTimeoutMs <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(testTimeoutMs - OPEN_FOLDER_MARGIN_MS, testTimeoutMs / 2);
}

/**
 * The e2e hooks' openFolder connect: starts or joins the host's attempt, unwatched, and settles once that attempt connected
 * and its connection is usable. Rejects, naming the cause and the last step seen, on a prompt (the attempt is cancelled), a
 * failure, the attempt gone or replaced, the connection lost after connecting, or deadlineMs passing.
 */
export async function waitForRemoteFolderConnection(
  connections: Pick<RemoteConnections, 'connect' | 'attempt' | 'cancel'>,
  authorities: Pick<Authorities, 'state' | 'connection'>,
  hostId: string,
  authorityKey: string,
  deadlineMs: number,
): Promise<void> {
  if (Number.isNaN(deadlineMs) || deadlineMs <= 0) throw new Error(`the connect deadline must be a positive number of ms, not ${deadlineMs}`);
  const attemptId = connections.connect(hostId, false);
  const deadline = Date.now() + deadlineMs;
  let lastStep = 'connecting';
  for (;;) {
    const attempt = connections.attempt(hostId);
    if (attempt?.attemptId !== attemptId) {
      throw new Error(attempt ? `connecting ended: attempt ${attemptId} was replaced at step ${lastStep}, the new one is at ${attempt.step}` : `connecting ended: attempt ${attemptId} is gone, last step ${lastStep}`);
    }
    lastStep = attempt.step;
    if (attempt.prompt) {
      connections.cancel(attemptId);
      throw new Error(`connecting asked: ${attempt.prompt.kind}`);
    }
    if (attempt.step === 'failed') throw new Error(`connecting failed: ${attempt.failure?.code ?? 'unknown'}`);
    if (attempt.step === 'connected') {
      if (authorities.connection(authorityKey)) return;
      const state = authorities.state(authorityKey);
      // 'connecting' is a suspect connection, which the keepalive either clears or drops
      if (state !== 'connecting') throw new Error(`connecting lost: the attempt connected, then ${authorityKey} went ${state}`);
    }
    if (Date.now() >= deadline) throw new Error(`connecting timed out after ${deadlineMs} ms at step ${lastStep}${lastStep === 'connected' ? ` with ${authorityKey} ${authorities.state(authorityKey)}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
