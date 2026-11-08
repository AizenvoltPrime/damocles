import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { quickPick } from '../desktop/support/editor';
import { readUserSettings, writeUserSettings } from '../desktop/support/hermetic';
import { overlayMenu, readyOverlay } from '../desktop/support/overlay';
import { shellPage, shellState } from '../desktop/support/shell';
import { projectRow } from '../desktop/support/shell-ui';
import { activeTerminal, openTerminal, TEST_PROFILE } from '../desktop/support/terminal';
import { clickMenu } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { storedHost } from './support/host-settings-ui';
import { addHost, expect, hostNamed, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';

const STAGING_HOST = 'h0e2estaging';
const STAGING_GROUP = `ssh+${STAGING_HOST}`;
const STAGING_KEY = `${STAGING_GROUP}|/srv/web`;

// One local project, and a saved host staging with one project that nothing in the test connects.
function seed(home: { readonly userData: string; readonly project: string }): void {
  fs.writeFileSync(path.join(home.userData, 'projects.json'), `${JSON.stringify({ version: 1, projects: [home.project] }, null, 2)}\n`);
  fs.writeFileSync(path.join(home.userData, 'remote-hosts.json'), JSON.stringify({
    version: 1,
    authorities: { [STAGING_GROUP]: { projects: [{ path: '/srv/web', folderKey: '/srv/web', os: 'linux' }], trusted: ['/srv/web'] } },
    order: [],
    hosts: { [STAGING_HOST]: { id: STAGING_HOST, kind: 'ssh', destination: { kind: 'alias', alias: 'staging' }, name: 'staging', recentFolders: ['/srv/web'], settings: {} } },
    groupOrder: [],
  }, null, 2));
}

const rows = (overlay: Page) => overlay.getByTestId('quick-pick-item');
const row = (overlay: Page, id: string) => overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${id}"]`);

async function activeProfile(shell: Page): Promise<string | undefined> {
  const id = await activeTerminal(shell).getAttribute('data-terminal-id');
  return (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals.find((terminal) => terminal.id === id)?.profileId;
}

test('New Terminal lists every host\'s projects under their headings, an SSH project offers its host\'s shells, and Select Default Profile... sets that host\'s default alone', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  seed(home);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': TEST_PROFILE, 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  // a second shell on prod-1, so its default has a choice: fish on PATH, which runs bash
  await fixture.sh('printf \'#!/bin/sh\\nexec /bin/bash "$@"\\n\' > /usr/local/bin/fish && chmod 755 /usr/local/bin/fish');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const appKey = await openRemoteFolder(app, hostId, '/srv/app');
  const host = await hostNamed(app, 'prod-1');
  await remoteProjectKey(app, host, '/srv/app');
  const shell = await shellPage(app);
  const overlay = await readyOverlay(app);
  const localKey = (await shellState(app)).projects.find((project) => project.fsPath === home.project)!.key;
  await projectRow(shell, localKey).click();
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(localKey);
  await openTerminal(app);

  // Step 1: the sidebar's host groups under their headings, the current project the row Enter takes, staging's disabled.
  await clickMenu(app, 'damocles.terminal.new');
  await expect(quickPick(overlay)).toHaveAttribute('data-step', 'project');
  const names: Record<string, string> = { local: 'This computer', [STAGING_GROUP]: 'staging', [host.authorityKey]: 'prod-1' };
  const groups = (await shellState(app)).projectGroups.order.map((group) => names[group] ?? group);
  await expect(overlay.getByTestId('quick-pick-group')).toHaveText(groups);
  await expect(rows(overlay)).toHaveCount(3);
  await expect(overlay.locator('[data-testid="quick-pick-item"][aria-selected="true"]')).toHaveAttribute('data-item-id', localKey);
  await expect(row(overlay, STAGING_KEY)).toHaveAttribute('aria-disabled', 'true');
  await expect(row(overlay, STAGING_KEY)).toContainText('Not connected');
  await expect(row(overlay, appKey)).not.toHaveAttribute('aria-disabled');

  // Step 2 for prod-1's project: prod-1's shells, never this computer's.
  await row(overlay, appKey).click();
  await expect(quickPick(overlay)).toHaveAttribute('data-step', 'profile');
  await expect(row(overlay, 'bash')).toBeVisible({ timeout: 60_000 });
  await expect(row(overlay, 'fish')).toBeVisible();
  if (process.platform === 'win32') await expect(row(overlay, 'cmd')).toHaveCount(0);
  await expect(overlay.getByTestId('quick-pick-scope')).toHaveAttribute('title', 'app · prod-1');
  await row(overlay, 'fish').click();
  await expect(quickPick(overlay)).toHaveCount(0);
  await expect.poll(() => activeProfile(shell)).toBe('fish');
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });

  // The arrow: one submenu per project with its host, staging's project a disabled row saying why.
  await shell.getByTestId('terminal-new-menu').click();
  await expect(overlayMenu(overlay)).toBeVisible();
  const submenus = overlayMenu(overlay).locator('[data-menu-item][aria-haspopup="menu"]');
  await expect(submenus).toHaveCount(2);
  await expect(submenus.filter({ hasText: 'app' })).toContainText('prod-1');
  await expect(overlayMenu(overlay).locator('[data-menu-item][aria-disabled="true"]', { hasText: 'web' })).toContainText('Not connected');
  await submenus.filter({ hasText: 'app' }).click();
  await expect(overlay.getByTestId('overlay-submenu').getByRole('menuitem')).toHaveText(['bash', 'fish']);
  await overlay.keyboard.press('Escape');
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);

  // Select Default Profile...: the host first, staging disabled; prod-1's default goes into its record alone.
  await clickMenu(app, 'damocles.terminal.selectDefaultProfile');
  await expect(quickPick(overlay)).toHaveAttribute('data-pick', 'list');
  await expect(rows(overlay)).toHaveCount(3);
  await expect(row(overlay, STAGING_GROUP)).toHaveAttribute('aria-disabled', 'true');
  await row(overlay, host.authorityKey).click();
  await expect(row(overlay, 'bash')).toHaveAttribute('aria-checked', 'true');
  await row(overlay, 'fish').click();
  await expect(quickPick(overlay)).toHaveCount(0);
  await expect.poll(() => storedHost(home, hostId)?.settings['defaultTerminalProfile']).toBe('fish');
  expect(readUserSettings(home)['damocles.desktop.terminal.defaultProfile']).toBe(TEST_PROFILE);

  // Shift+click on prod-1's project, and Shift+click on + while it is current, start its default; this computer's stays its own.
  await clickMenu(app, 'damocles.terminal.new');
  await row(overlay, appKey).click({ modifiers: ['Shift'] });
  await expect(quickPick(overlay)).toHaveCount(0);
  await expect.poll(() => activeProfile(shell)).toBe('fish');
  await projectRow(shell, appKey).click();
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(appKey);
  const before = await shell.locator('[data-testid="terminal-view"]').count();
  await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
  await expect(shell.locator('[data-testid="terminal-view"]')).toHaveCount(before + 1);
  await expect.poll(() => activeProfile(shell)).toBe('fish');
  await projectRow(shell, localKey).click();
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(localKey);
  await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
  await expect(shell.locator('[data-testid="terminal-view"]')).toHaveCount(before + 2);
  await expect.poll(() => activeProfile(shell)).toBe(TEST_PROFILE);

  await shutdownHostDaemon(app, hostId, fixture);
});
