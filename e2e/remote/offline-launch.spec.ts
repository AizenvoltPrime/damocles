import type { ElectronApplication, Page } from '@playwright/test';
import { codeEditor, DOCUMENT_END, editorShows, editorTab, openInEditor } from '../desktop/support/editor';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { overlayPage, shellPage, shellState } from '../desktop/support/shell';
import { activeTerminal, openTerminal, runInTerminal, terminalText, waitForOutputLine } from '../desktop/support/terminal';
import { writeUserSettings } from '../desktop/support/hermetic';
import { askedDialogs, awaitTurnEnd, chatInput } from '../desktop/support/ui';
import { connectDialog } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, hostState, lastConnectStep, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';

/** The visible chat page that shows `text`: a mirrored transcript has no live session for the shell to name. */
async function chatShowing(app: ElectronApplication, text: string): Promise<Page> {
  let found: Page | undefined;
  await expect.poll(async () => {
    found = undefined;
    for (const page of app.windows().filter((candidate) => !candidate.isClosed() && candidate.url().includes('/panel/'))) {
      if (await page.getByText(text, { exact: true }).isVisible()) found = page;
    }
    return found !== undefined;
  }, { timeout: 60_000 }).toBe(true);
  return found!;
}

test('a launch with the host unreachable connects only hosts with restored views and asks nothing; tabs, terminals and chats wait offline, and Reconnect brings them all back', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  // a second host with a project but nothing restored, which the launch must leave alone
  const idle = await sshd('idle-host');
  await fixture.sh(`printf 'saved text\\n' > ${APP}/saved.md && printf 'draft' > ${APP}/draft.md`, 'dev');
  const stub = await startTargetStub(home, fixture);
  try {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const idleId = await addHost(first.app, { alias: 'idle-host', name: 'idle-host' });
    await openRemoteFolder(first.app, idleId, APP);
    await shutdownHostDaemon(first.app, idleId, idle);
    const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
    const key = await openRemoteFolder(first.app, hostId, APP);
    await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, APP);
    const shell = await shellPage(first.app);

    // Restored views: a saved tab, a dirty tab, a terminal with output, and a chat with one turn.
    expect(await openInEditor(first.app, { projectKey: key, relativePath: 'saved.md' })).toMatchObject({ ok: true });
    await editorShows(shell, 'saved text');
    expect(await openInEditor(first.app, { projectKey: key, relativePath: 'draft.md' })).toMatchObject({ ok: true });
    await editorShows(shell, 'draft');
    await codeEditor(shell).locator('.view-line').first().click();
    await shell.keyboard.press(DOCUMENT_END);
    await shell.keyboard.type(' unsaved-edit');
    const terminalShell = await openTerminal(first.app);
    const terminalId = await activeTerminal(terminalShell).getAttribute('data-terminal-id');
    await runInTerminal(terminalShell, 'echo before-the-outage-7c');
    await waitForOutputLine(terminalShell, 'before-the-outage-7c');
    const tab = await newRemoteChat(first.app, key);
    await sendPrompt(tab, 'Remember this turn');
    await expect(tab.getByText('Echo: Remember this turn', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    await first.close();

    // The host goes away; its daemon and terminal keep running behind the refused port.
    await fixture.stopSshd();
    const second = await launch(env);
    const app = second.app;
    const relaunched = await shellPage(app);
    await expect.poll(async () => (await lastConnectStep(app, hostId))?.step, { timeout: 60_000 }).toBe('failed');
    await expect.poll(() => hostState(app, hostId)).not.toBe('connected');
    // only the host with restored views tried; the idle one was not contacted, and no dialog opened at startup
    expect(await lastConnectStep(app, idleId)).toBeUndefined();
    expect(await hostState(app, idleId)).toBe('offline');
    expect(await idle.userProcesses()).toEqual([]);
    const overlay = await overlayPage(app);
    await expect(connectDialog(overlay)).toHaveCount(0);
    expect(await askedDialogs(app)).toEqual([]);

    await editorTab(relaunched, 'saved.md').click();
    await expect(relaunched.getByTestId('editor-offline')).toContainText('prod-1 is offline.');
    await expect(relaunched.getByTestId('editor-offline').getByRole('button', { name: 'Reconnect' })).toBeVisible();
    // the dirty buffer comes back from its hot-exit backup, not from this computer's disk
    await editorTab(relaunched, 'draft.md').click();
    await editorShows(relaunched, 'draft unsaved-edit');
    await expect(editorTab(relaunched, 'draft.md')).toHaveAttribute('data-dirty', 'true');
    const waiting = relaunched.locator(`[data-testid="terminal-view"][data-terminal-id="${terminalId}"]`);
    await expect(waiting).toHaveAttribute('data-status', 'reconnecting');
    await expect(waiting).toContainText('Reconnecting');
    const transcript = await chatShowing(app, 'Echo: Remember this turn');
    // read-only: a card names the outage in place of the composer
    await expect(transcript.getByTestId('composer-offline')).toContainText('prod-1 is offline');
    await expect(chatInput(transcript)).toHaveCount(0);
    // the outage banner sits under the chat header, which keeps the pane's top; the shell draws none over the chat page
    const banner = transcript.getByTestId('chat-connection-banner');
    // a host with restored views is retried by the reconnect loop, which the banner counts down to
    await expect(banner).toHaveAttribute('data-state', 'reconnecting');
    await expect(banner).toContainText(/Reconnecting to prod-1 in \d+ s/);
    expect((await transcript.getByTestId('chat-header').boundingBox())?.y).toBe(0);
    await expect(relaunched.getByTestId('connection-banner')).toHaveCount(0);
    // the pane's gutter continues the banner level with it, so it spans the whole pane
    const slot = (await relaunched.getByTestId('chat-slot').boundingBox())!;
    const strip = (await banner.boundingBox())!;
    const edge = (await relaunched.getByTestId('connection-banner-edge').boundingBox())!;
    expect([Math.round(edge.y), Math.round(edge.height), Math.round(edge.x + edge.width)]).toEqual([Math.round(slot.y + strip.y), Math.round(strip.height), Math.round(slot.x)]);

    // The host is back: Reconnect restores the file, the same terminal with its screen, and a live chat.
    await fixture.startSshd();
    await banner.getByRole('button', { name: 'Reconnect now' }).click();
    await expect.poll(() => hostState(app, hostId), { timeout: 120_000 }).toBe('connected');
    await editorTab(relaunched, 'saved.md').click();
    await editorShows(relaunched, 'saved text');
    await expect(waiting).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
    await relaunched.evaluate((id) => window.damoclesShell!.terminal.select(id), terminalId!);
    expect((await terminalText(relaunched)).split('\n').filter((row) => row === 'before-the-outage-7c')).toHaveLength(1);
    const live = await chatShowing(app, 'Echo: Remember this turn');
    await expect(chatInput(live)).toBeVisible({ timeout: 60_000 });
    await expect(live.getByTestId('composer-offline')).toHaveCount(0);
    await expect(live.getByTestId('chat-connection-banner')).toHaveCount(0);
    expect((await shellState(app)).projects.find((project) => project.key === key)?.connection).toBe('connected');
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
