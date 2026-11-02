import type { Locator, Page } from '@playwright/test';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { closeSettingsModal, openSettingsModal, settingsRow } from '../desktop/support/settings';
import { overlayPage } from '../desktop/support/shell';
import { awaitTurnEnd, hostMessages, recordHostMessages } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { openRemoteHostSettings, setHostSwitch, storedHost } from './support/host-settings-ui';
import { addHost, expect, openRemoteFolder, remoteEnv, SSH_TAG, test } from './support/remote';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
const NAME = 'prod-1';
// AllowYoloDialog.vue INPUT_PROTECTION_MS: Allow ignores input this long after the question shows
const INPUT_PROTECTION_MS = 500;
// placement.ts PANEL_GAP_REM at 16 px per rem
const PANEL_GAP_PX = 6;
const permissionCard = (tab: Page): Locator => tab.locator('section[role="region"][aria-label="Permission request"]:not([class*="-leave-"])');

// The box once its entrance has played: the zoom-in scales it until then.
async function settledBox(element: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await element.evaluate(async (node) => {
    await Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  const box = await element.boundingBox();
  if (!box) throw new Error('The element has no box');
  return box;
}

test('a locked YOLO and Start in YOLO mode ask to allow YOLO beside the control, and turn it on only once allowed', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const stub = await startTargetStub(home, fixture);
  try {
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    const hostId = await addHost(app, { alias: 'prod-1', name: NAME });
    const key = await openRemoteFolder(app, hostId, APP);

    // The composer: locked while the host refuses YOLO; Cancel changes nothing.
    const tab = await newRemoteChat(app, key);
    await recordHostMessages(tab);
    const yolo = tab.getByTestId('composer-yolo');
    await expect(yolo).toHaveAttribute('data-locked', '');
    await yolo.click();
    const overlay = await overlayPage(app);
    const ask = overlay.getByTestId('allow-yolo');
    await expect(ask).toContainText(`Allow YOLO on ${NAME}?`);
    await expect(overlay.getByTestId('allow-yolo-cancel')).toBeFocused();
    await overlay.getByTestId('allow-yolo-cancel').click();
    await expect(ask).toHaveCount(0);
    await expect(yolo).toHaveAttribute('data-locked', '');
    expect(storedHost(home, hostId)?.settings['allowBypass']).not.toBe(true);

    // Allow and turn on: the host allows YOLO, the chat turns it on, and core takes it (a command runs unasked).
    await yolo.click();
    await expect(ask).toBeVisible();
    await overlay.waitForTimeout(INPUT_PROTECTION_MS);
    await overlay.getByTestId('allow-yolo-accept').click();
    await expect(yolo).toHaveAttribute('aria-pressed', 'true');
    await expect(yolo).not.toHaveAttribute('data-locked');
    expect(storedHost(home, hostId)?.settings['allowBypass']).toBe(true);
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'echo yolo-allowed' } }] }, { chunks: ['Ran unasked.'] });
    await sendPrompt(tab, 'Run it with YOLO');
    await expect(tab.getByText('Ran unasked.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    await expect(permissionCard(tab)).toHaveCount(0);
    expect(await hostMessages(tab, 'permissionModeRefused')).toEqual([]);

    // Settings: with Allow YOLO off again, the host tab's Start in YOLO mode says so and asks beside its switch, above the modal.
    const hostSettings = await openRemoteHostSettings(app, hostId);
    await setHostSwitch(hostSettings.block, 'Allow YOLO', false);
    await closeSettingsModal(hostSettings.overlay);
    const settings = await openSettingsModal(app, 'defaults');
    await expect(settings.getByTestId('settings-scope-host')).toHaveAttribute('aria-selected', 'true');
    const row = settingsRow(settings, 'damocles.dangerouslySkipPermissions');
    await expect(row.getByTestId('default-yolo-refused')).toContainText(`YOLO is off for your chats on ${NAME}.`);
    const toggle = row.getByRole('switch');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    // measured first: the question's modal layer hides the rows from the accessibility tree
    const toggleBox = await settledBox(toggle);
    await toggle.click();
    const question = settings.getByTestId('allow-yolo');
    // hung from the switch: its end lined up with the switch's, just above or below it
    const questionBox = await settledBox(question);
    expect(Math.abs(questionBox.x + questionBox.width - (toggleBox.x + toggleBox.width))).toBeLessThanOrEqual(1);
    const above = Math.abs(questionBox.y + questionBox.height + PANEL_GAP_PX - toggleBox.y);
    const below = Math.abs(questionBox.y - (toggleBox.y + toggleBox.height + PANEL_GAP_PX));
    expect(Math.min(above, below)).toBeLessThanOrEqual(1);
    await settings.waitForTimeout(INPUT_PROTECTION_MS);
    await settings.getByTestId('allow-yolo-accept').click();
    // core's refusal of the write would revert the switch before the host's new capability clears the note
    await expect(row.getByTestId('default-yolo-refused')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(storedHost(home, hostId)?.settings['allowBypass']).toBe(true);
    // the host tab writes the host's own file
    await expect.poll(async () => {
      const file = await fixture.sh('cat ~/.damocles/settings.json 2>/dev/null || echo {}', 'dev');
      return (JSON.parse(file) as Record<string, unknown>)['damocles.dangerouslySkipPermissions'];
    }).toBe(true);
    await closeSettingsModal(settings);

    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
