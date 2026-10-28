import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { HermeticHome } from '../../desktop/support/hermetic';
import { settingsModal, settingsNav } from '../../desktop/support/settings';
import { overlayPage, shellPage } from '../../desktop/support/shell';
import { expect, lastConnectStep } from './remote';

// Settings > Remote hosts, the Connect timeline's secret prompt and the dialogs the credential specs answer (en locale).

/** Opens Settings > Remote hosts with `hostId` picked; resolves with the overlay page and the host's block. */
export async function openRemoteHostSettings(app: ElectronApplication, hostId: string): Promise<{ overlay: Page; block: Locator }> {
  // main opens Remote hosts on the User tab whichever chat is selected (a remote chat's gear opens its host tab)
  const shell = await shellPage(app);
  await shell.evaluate(() => {
    void window.damoclesShell!.openSettings('remoteHosts');
  });
  const overlay = await overlayPage(app);
  await expect(settingsModal(overlay)).toBeVisible();
  await expect(settingsNav(overlay, 'remoteHosts')).toHaveAttribute('aria-selected', 'true');
  await overlay.locator(`[data-testid="remote-host-pick"][data-host-id="${hostId}"]`).click();
  const block = overlay.locator(`[data-testid="remote-host"][data-host-id="${hostId}"]`);
  await expect(block).toBeVisible();
  return { overlay, block };
}

/** Turns one of the host block's switches on or off and waits until it shows that state. */
export async function setHostSwitch(block: Locator, name: string, on: boolean): Promise<void> {
  const control = block.getByRole('switch', { name, exact: true });
  if ((await control.getAttribute('aria-checked')) !== String(on)) await control.click();
  await expect(control).toHaveAttribute('aria-checked', String(on));
}

export const secretPrompt = (overlay: Page): Locator => overlay.getByTestId('secret-prompt');
export const rememberBox = (overlay: Page): Locator => secretPrompt(overlay).getByRole('checkbox', { name: 'Remember on this computer' });

export interface SecretAnswer {
  /** A function is called as the prompt is filled, for an answer only valid then, such as a one-time code. */
  readonly answer: string | (() => string);
  /** Remember on this computer: a boolean sets the offered box; undefined means the box must not be offered */
  readonly remember?: boolean;
}

type Attempt = { readonly attemptId: string; readonly step: string; readonly prompt?: { readonly promptId: string; readonly kind: string; readonly text?: string } };

/**
 * Runs `start` (which begins a connection of `hostId`) and answers each secret prompt of that attempt in the Connect timeline
 * from `answers`, by its exact text, until main reports the attempt connected. Resolves with the prompt texts asked, in order;
 * a prompt `answers` does not name, or a failed attempt, fails the test. Each ssh the attempt runs signs in on its own, so
 * a client without a master connection may ask one question more than once.
 */
export async function connectAnswering(app: ElectronApplication, overlay: Page, hostId: string, start: () => Promise<void>, answers: Readonly<Record<string, SecretAnswer>>): Promise<string[]> {
  const step = (): Promise<Attempt | undefined> => lastConnectStep(app, hostId) as Promise<Attempt | undefined>;
  const previous = (await step())?.attemptId;
  await start();
  const asked: string[] = [];
  const answered = new Set<string>();
  for (;;) {
    let attempt: Attempt | undefined;
    await expect.poll(async () => {
      attempt = await step();
      if (attempt === undefined || attempt.attemptId === previous) return false;
      return attempt.step === 'connected' || attempt.step === 'failed' || (attempt.prompt !== undefined && !answered.has(attempt.prompt.promptId));
    }, { timeout: 120_000 }).toBe(true);
    const { prompt } = attempt!;
    if (attempt!.step === 'failed') throw new Error(`connecting failed after asking ${JSON.stringify(asked)}: ${JSON.stringify(attempt)}`);
    if (prompt === undefined || answered.has(prompt.promptId)) return asked;
    const text = prompt.text ?? '';
    const reply = answers[text];
    if (prompt.kind !== 'secret' || reply === undefined) throw new Error(`an unexpected prompt: ${JSON.stringify(prompt)}`);
    const form = secretPrompt(overlay);
    await expect(form.getByText(text, { exact: true })).toBeVisible();
    if (reply.remember === undefined) await expect(rememberBox(overlay)).toHaveCount(0);
    else await rememberBox(overlay).setChecked(reply.remember);
    await form.locator('input:not([type="checkbox"])').fill(typeof reply.answer === 'function' ? reply.answer() : reply.answer);
    await form.getByRole('button', { name: 'Continue', exact: true }).click();
    answered.add(prompt.promptId);
    asked.push(text);
  }
}

export const gitConsent = (overlay: Page): Locator => overlay.getByTestId('git-consent');
export const removeServerDialog = (overlay: Page): Locator => overlay.getByTestId('remove-server-dialog');

interface StoredSshHost {
  readonly color?: string;
  readonly name: string;
  readonly settings: Record<string, unknown>;
  readonly identityFile?: string;
  readonly installedKeyFingerprint?: string;
  readonly lingerEnabledByDamocles?: true;
  readonly alwaysCredentialHosts?: readonly string[];
}

/** The host's record as main last wrote remote-hosts.json. */
export function storedHost(home: Pick<HermeticHome, 'userData'>, hostId: string): StoredSshHost | undefined {
  const file = path.join(home.userData, 'remote-hosts.json');
  if (!fs.existsSync(file)) return undefined;
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { hosts: Record<string, StoredSshHost> }).hosts[hostId];
}

/** ssh's SHA256 fingerprint of a public key line (`ssh-ed25519 AAAA... comment`). */
export function sshFingerprint(publicKeyLine: string): string {
  const blob = Buffer.from(publicKeyLine.trim().split(/\s+/)[1]!, 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}
