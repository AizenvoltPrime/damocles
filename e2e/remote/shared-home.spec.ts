import { expectNoAxeViolations } from '../desktop/support/axe';
import { answerToast, overlayPage, recordedPopupToasts, recordToasts } from '../desktop/support/shell';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { TARGET_HOME, TARGET_USER } from './support/sshd';

const TITLE = 'lab-03 also runs Damocles in this home';
const CARD_TEXT = 'lab-03 also runs Damocles in this home. Chats and memories are shared between them.';

test('a daemon of another machine in the target\'s home shows one notification per connection, whose Show host opens the card\'s notice', { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1');
  // as lab-03's daemon leaves its run folder in a home it shares with prod-1, touched just now
  const record = JSON.stringify({ version: '3.7.0', pid: 4242, hostname: 'lab-03', endpoint: '/tmp/damocles-lab03/daemon.sock', socketFolder: '/tmp/damocles-lab03', updatedAt: Date.now() });
  await fixture.sh(`mkdir -p ${TARGET_HOME}/.damocles/server/run-0123456789abcdef && cat > ${TARGET_HOME}/.damocles/server/run-0123456789abcdef/daemon.pid`, TARGET_USER, `${record}\n`);
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await recordToasts(app);
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, '/srv/app');
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, '/srv/app');

  const shared = async () => (await recordedPopupToasts(app)).filter((toast) => toast.body.kind === 'notice' && toast.body.title === TITLE);
  await expect.poll(async () => (await shared()).length, { timeout: 60_000 }).toBe(1);
  const [toast] = await shared();
  expect(toast!.body).toMatchObject({
    kind: 'notice',
    severity: 'warning',
    title: TITLE,
    message: 'Your home is shared, so chats and memories there are shared between prod-1 and lab-03. Each machine keeps its own logs and server state.',
    actions: ['Show host'],
    host: 'prod-1',
  });

  await answerToast(app, toast!.id, 'Show host');
  const overlay = await overlayPage(app);
  const card = overlay.getByTestId('host-card');
  await expect(card.getByRole('heading', { name: 'prod-1', exact: true })).toBeVisible();
  const notice = card.locator('[data-testid="host-notice"][data-code="sharedHome"]');
  await expect(notice).toHaveText(CARD_TEXT);
  await expectNoAxeViolations(overlay, '[data-testid="host-card"]');
  // the same connection never asks again
  expect(await shared()).toHaveLength(1);
  await overlay.keyboard.press('Escape');
  await shutdownHostDaemon(app, hostId, fixture);
});
