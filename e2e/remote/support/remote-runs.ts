import type { ElectronApplication, Locator, Page, TestInfo } from '@playwright/test';
import type { DesktopApp } from '../../desktop/support/app';
import { overlayPage } from '../../desktop/support/shell';
import { expect } from './remote';
import { TARGET_HOME, TARGET_USER, type SshdFixture } from './sshd';

// What the keep-running, sign-in, several-devices and update specs share: the target's sessions, the quit and its dialog.

/** Signs this computer in to the stub ChatGPT account (tokens `e2e-oauth-<account>-<n>`, each valid `expiresInMs`). */
export async function stubOAuth(app: ElectronApplication, account: string, expiresInMs: number, offline = false): Promise<void> {
  // main installs its e2e hooks during startup
  await expect.poll(() => app.evaluate(() => typeof (globalThis as unknown as { __damoclesE2e?: { stubOAuth?: unknown } }).__damoclesE2e?.stubOAuth), { timeout: 60_000 }).toBe('function');
  await app.evaluate((_electron, args) => (globalThis as unknown as { __damoclesE2e: { stubOAuth(account: string, expiresInMs: number, offline: boolean): Promise<void> } }).__damoclesE2e.stubOAuth(...args), [account, expiresInMs, offline] as const);
}

/** Every pi session file of the target account, concatenated; '' while none exists. */
export async function targetSessions(fixture: Pick<SshdFixture, 'sh'>): Promise<string> {
  return fixture.sh(`d=${TARGET_HOME}/.damocles/pi/agent/sessions; [ -d "$d" ] || exit 0; find "$d" -name '*.jsonl' -exec cat {} +`, TARGET_USER);
}

/** The target's Damocles Core log lines, every rotated file included. */
export async function targetCoreLog(fixture: Pick<SshdFixture, 'sh'>): Promise<string> {
  return fixture.sh(`for f in ${TARGET_HOME}/.damocles/server/run-*/logs/Damocles_Core*.log; do [ -e "$f" ] && cat "$f"; done; true`, TARGET_USER);
}

// A long tool call: a Stop records the turn-stopped entry when it cuts a tool call short, while a turn stopped as only text
// streams ends with an aborted assistant message and no entry.
export const SLEEP = 'sleep 600';

/** Lets every turn on the target run SLEEP unasked (the target account's Claude settings). */
export async function allowSleep(fixture: Pick<SshdFixture, 'sh'>): Promise<void> {
  await fixture.sh(`mkdir -p ${TARGET_HOME}/.claude && cat > ${TARGET_HOME}/.claude/settings.json`, TARGET_USER, JSON.stringify({ permissions: { allow: [`Bash(${SLEEP})`] } }));
}

/** Whether SLEEP runs on the target. */
export async function sleeping(fixture: Pick<SshdFixture, 'sh'>): Promise<boolean> {
  return (await fixture.sh(`pgrep -u ${TARGET_USER} -f '^${SLEEP}$' || true`)).trim() !== '';
}

/** Asks main to quit on its next turn, so the evaluate returns before a dialog holds the quit. */
export async function requestQuit(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    setImmediate(() => electronApp.quit());
  });
}

/** Resolves once the app's main process exited. */
export function exited(desktop: DesktopApp): Promise<void> {
  const proc = desktop.app.process();
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => proc.once('exit', () => resolve()));
}

/** The quit's remote-agents question in the overlay. */
export async function closeRemoteDialog(app: ElectronApplication): Promise<{ overlay: Page; dialog: Locator }> {
  const overlay = await overlayPage(app);
  const dialog = overlay.getByRole('alertdialog', { name: 'Quit Damocles?' });
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  return { overlay, dialog };
}

/** The chat page that shows `text`; a relaunch or a rejoin may have replaced the page a test held. */
export async function chatShowing(app: ElectronApplication, text: string): Promise<Page> {
  let found: Page | undefined;
  await expect.poll(async () => {
    found = undefined;
    for (const page of app.windows().filter((candidate) => !candidate.isClosed() && candidate.url().includes('/panel/'))) {
      // a page a rejoin closes while it is looked at shows nothing
      const shows = await page.getByText(text, { exact: false }).first().isVisible().catch((error: unknown) => {
        if (page.isClosed()) return false;
        throw error;
      });
      if (shows) found = page;
    }
    return found !== undefined;
  }, { timeout: 60_000 }).toBe(true);
  return found!;
}

/** A screenshot of each open chat page of `app`, for a failed test's artifacts. */
export async function attachChatPages(testInfo: TestInfo, name: string, app: ElectronApplication): Promise<void> {
  for (const [index, page] of app.windows().filter((candidate) => !candidate.isClosed() && candidate.url().includes('/panel/')).entries()) {
    await testInfo.attach(`${name}-chat-${index}.png`, { body: await page.screenshot(), contentType: 'image/png' });
  }
}

/** How often `needle` occurs in the page's rendered text: a replay that duplicated or dropped a part shows here. */
export async function occurrences(page: Page, needle: string): Promise<number> {
  return (await page.evaluate(() => document.body.innerText)).split(needle).length - 1;
}
