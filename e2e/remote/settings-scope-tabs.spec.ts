import type { Page } from '@playwright/test';
import { closeSettingsModal, openSettingsModal } from '../desktop/support/settings';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, SSH_TAG, test } from './support/remote';
import { newRemoteChat } from './support/target-agent';

const APP = '/srv/app';

// A tab is loaded once the remote core answered it: its banner replaces the loading line.
async function expectTabLoaded(overlay: Page, tab: 'host' | 'project'): Promise<void> {
  await expect(overlay.getByTestId(`settings-scope-${tab}`)).toHaveAttribute('aria-selected', 'true');
  await expect(overlay.getByTestId('settings-scope-loading')).toHaveCount(0);
  // the banner names the file the tab writes: the host's own, or the project's
  await expect(overlay.getByTestId('settings-scope-banner')).toContainText(tab === 'host' ? '~/.damocles/settings.json' : `${APP}/.damocles/settings.json`);
}

test('a remote chat\'s settings load on the host tab, the Project tab and the host tab again', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(300_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await newRemoteChat(app, key);

  const overlay = await openSettingsModal(app, 'defaults');
  await expectTabLoaded(overlay, 'host');
  // each switch attaches over the wire; what the modal asks meanwhile must reach the tab it asked for
  for (const tab of ['project', 'host', 'project', 'host'] as const) {
    await overlay.getByTestId(`settings-scope-${tab}`).click();
    await expectTabLoaded(overlay, tab);
  }
  await closeSettingsModal(overlay);

  await shutdownHostDaemon(app, hostId, fixture);
});
