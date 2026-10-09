import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { lockInTurn } from './fair-lock';
import { FOREGROUND_WAIT_MS } from './foreground';

// The OS clipboard is one per machine, so every Playwright worker serializes on one lock in the OS temp folder.
const LOCK_TARGET = path.join(os.tmpdir(), 'damocles-e2e-clipboard');
// A holder waits up to FOREGROUND_WAIT_MS for the foreground lock, then runs the slowest clipboard test (180 s) and its
// teardown, so a waiter outlasts a holder.
export const CLIPBOARD_LOCK_WAIT_MS = FOREGROUND_WAIT_MS + 180_000 + 30_000;

/** The only way an e2e test reads or writes the OS clipboard; it exists only while the test holds the cross-worker lock. */
export interface E2eClipboard {
  readText(app: ElectronApplication): Promise<string>;
  writeText(app: ElectronApplication, text: string): Promise<void>;
  // Linux's primary selection, which a middle click pastes
  writeSelection(app: ElectronApplication, text: string): Promise<void>;
  // navigator.clipboard from a page: how writeText settled, and readText's error name
  probeFromPage(page: Page, text: string): Promise<{ readonly write: string; readonly read: string }>;
}

const access: E2eClipboard = {
  readText: (app) => app.evaluate(({ clipboard }) => clipboard.readText()),
  writeText: (app, text) => app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text),
  writeSelection: (app, text) => app.evaluate(({ clipboard }, value) => {
    if (!clipboard.selection) throw new Error('This platform has no selection clipboard');
    clipboard.selection.writeText(value);
  }, text),
  probeFromPage: (page, text) => page.evaluate(async (value) => {
    const write = await navigator.clipboard.writeText(value).then(
      () => 'resolved',
      (e: unknown) => `${(e as Error).name}: ${(e as Error).message}`,
    );
    const read = await navigator.clipboard.readText().then(
      () => 'resolved',
      (e: unknown) => (e as Error).name,
    );
    return { write, read };
  }, text),
};

/**
 * Holds the clipboard lock while `use` runs. A lock lost meanwhile (not refreshed within LOCK_STALE_MS, so another worker
 * may have taken it) fails the test, since its clipboard reads can no longer be trusted.
 */
export async function withClipboardLock(use: (clipboard: E2eClipboard) => Promise<void>): Promise<void> {
  let compromised: Error | undefined;
  const release = await lockInTurn(LOCK_TARGET, 'clipboard', CLIPBOARD_LOCK_WAIT_MS, (err) => {
    compromised = err;
  });
  // The test's own failure, a failed release and a lost lock are each reported; none hides another.
  const errors: unknown[] = [];
  await use(access).catch((err: unknown) => errors.push(err));
  if (compromised === undefined) await release().catch((err: unknown) => errors.push(new Error(`The clipboard lock could not be released: ${err instanceof Error ? err.message : String(err)}`)));
  else errors.push(new Error(`The clipboard lock was lost during the test: ${compromised.message}`));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, errors.map((err) => (err instanceof Error ? err.message : String(err))).join('\n'));
}
