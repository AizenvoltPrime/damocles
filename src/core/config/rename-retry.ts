// A rename for an atomic replace that a reader or an indexer on Windows may hold open; Node built-ins only, so a bundle without
// the config stack can import it.
import { promises as fs } from 'node:fs';

const RENAME_RETRY_BUDGET_MS = 10_000;
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * A rename retried for a bounded time while Windows refuses it because another process (an editor, an indexer, antivirus) has the
 * target open. before runs ahead of every attempt, so a precondition that a wait can break is checked again; its throw ends the retries.
 */
export async function renameWithRetry(from: string, to: string, before?: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + RENAME_RETRY_BUDGET_MS;
  let delay = 10;
  for (;;) {
    await before?.();
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || code === undefined || !RETRYABLE_RENAME_CODES.has(code) || Date.now() >= deadline) {
        throw err;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay + 10, 100);
    }
  }
}
