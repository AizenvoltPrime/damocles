import type { ElectronApplication } from '@playwright/test';
import { mainLog } from '../desktop/support/app';
import { filesHolding } from '../desktop/support/loopback-agent';
import { closeSettingsModal } from '../desktop/support/settings';
import { answerDialogs } from '../desktop/support/ui';
import { hostCard, openConnect, openInBrowser } from './support/connect-ui';
import { newOtpSecret, newPassword, proxyJumpPair, setPassword, totp, usePasswords } from './support/credentials';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { connectAnswering, openRemoteHostSettings, setHostSwitch, type SecretAnswer } from './support/host-settings-ui';
import { addHost, expect, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import type { SshdFixture } from './support/sshd';

const APP = '/srv/app';

async function rememberPasswords(app: ElectronApplication, hostId: string): Promise<void> {
  const { overlay, block } = await openRemoteHostSettings(app, hostId);
  await setHostSwitch(block, 'Remember password', true);
  await closeSettingsModal(overlay);
}

/** Connects prod-1 from its card in the Connect dialog, answering from `answers`; resolves with the prompts asked. */
async function connectPrompted(app: ElectronApplication, hostId: string, answers: Readonly<Record<string, SecretAnswer>>): Promise<string[]> {
  const overlay = await openConnect(app);
  const asked = await connectAnswering(app, overlay, hostId, () => hostCard(overlay, 'prod-1').click(), answers);
  await overlay.keyboard.press('Escape');
  return asked;
}

/** sshd's results since `from` for one method, as `Accepted <method> dev` / `Failed <method> dev`. */
const since = async (fixture: SshdFixture, from: number, method: string): Promise<string[]> =>
  (await fixture.authentications()).slice(from).filter((line) => line.split(' ')[1] === method);

const unique = (asked: readonly string[]): string[] => [...new Set(asked)];

for (const form of [
  { method: 'password', prompt: "dev@127.0.0.1's password:", logged: 'password', refused: 'Failed password dev' },
  { method: 'keyboard-interactive', prompt: '(dev@127.0.0.1) Password:', logged: 'keyboard-interactive/pam', refused: 'Failed pam dev' },
] as const) {
  test(`a password remembered from the ${form.method} prompt connects without asking; after the password changes it is asked once more and the stored one replaced`, { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
    test.setTimeout(600_000);
    const fixture = await sshd('prod-1', { config: [`PreferredAuthentications ${form.method}`] });
    const first = newPassword();
    await usePasswords(fixture, { dev: first });
    const desktop = await launch({ env: remoteEnv(ssh, mirror) });
    const { app } = desktop;
    await answerDialogs(app, { 'on prod-1?': 'Trust Folder' });
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });

    // With Remember password off (the default), the prompt offers no Remember on this computer.
    const overlay = await openConnect(app);
    expect(unique(await connectAnswering(app, overlay, hostId, () => hostCard(overlay, 'prod-1').click(), { [form.prompt]: { answer: first } }))).toEqual([form.prompt]);
    await openInBrowser(overlay, 'prod-1', APP);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    await shutdownHostDaemon(app, hostId, fixture);

    // On: the prompt offers it; once ssh signed in with the answer, every later sign-in of this connection uses it.
    await rememberPasswords(app, hostId);
    expect(await connectPrompted(app, hostId, { [form.prompt]: { answer: first, remember: true } })).toEqual([form.prompt]);
    await shutdownHostDaemon(app, hostId, fixture);
    let mark = (await fixture.authentications()).length;
    expect(await connectPrompted(app, hostId, {})).toEqual([]);
    expect(unique(await since(fixture, mark, form.logged))).toEqual([`Accepted ${form.logged} dev`]);
    await shutdownHostDaemon(app, hostId, fixture);

    // The password changes: the stored answer is refused once, deleted, and the user asked; the new one replaces it.
    const second = newPassword();
    await setPassword(fixture, 'dev', second);
    mark = (await fixture.authentications()).length;
    expect(await connectPrompted(app, hostId, { [form.prompt]: { answer: second, remember: true } })).toEqual([form.prompt]);
    const changed = (await fixture.authentications()).slice(mark).filter((line) => line === form.refused || line === `Accepted ${form.logged} dev`);
    expect(changed[0]).toBe(form.refused);
    expect(unique(changed.slice(1))).toEqual([`Accepted ${form.logged} dev`]);
    await shutdownHostDaemon(app, hostId, fixture);
    mark = (await fixture.authentications()).length;
    expect(await connectPrompted(app, hostId, {})).toEqual([]);
    expect(unique(await since(fixture, mark, form.logged))).toEqual([`Accepted ${form.logged} dev`]);
    await shutdownHostDaemon(app, hostId, fixture);
    await desktop.close();
    // secrets only in the encrypted store: no file under the test's root holds either password as text
    expect(filesHolding(home.root, [first, second])).toEqual([]);
  });
}

test('with Remember password off, a password-only host asks for its password once on the first connection, and once again on the next', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1', { config: ['PreferredAuthentications password'] });
  const password = newPassword();
  await usePasswords(fixture, { dev: password });
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await answerDialogs(app, { 'on prod-1?': 'Trust Folder' });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const prompt = "dev@127.0.0.1's password:";
  const asks = (): number => mainLog(home).split('\n').filter((line) => line.includes(`[ssh ${hostId}] asking the user: password prompt ${JSON.stringify(prompt)}`)).length;

  // the first connection detects the platform and runs stage 0, each its own ssh, behind one prompt
  const overlay = await openConnect(app);
  expect(await connectAnswering(app, overlay, hostId, () => hostCard(overlay, 'prod-1').click(), { [prompt]: { answer: password } })).toEqual([prompt]);
  await openInBrowser(overlay, 'prod-1', APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  expect(asks()).toBe(1);
  await shutdownHostDaemon(app, hostId, fixture);

  // the answer lived only for that attempt: the next connection asks again, once
  expect(await connectPrompted(app, hostId, { [prompt]: { answer: password } })).toEqual([prompt]);
  expect(asks()).toBe(2);
  await shutdownHostDaemon(app, hostId, fixture);
});

test('a one-time code is asked on every connection while the remembered password is answered, and the code prompt offers no Remember', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1', { config: ['PreferredAuthentications keyboard-interactive'] });
  const password = newPassword();
  const secret = newOtpSecret();
  await usePasswords(fixture, { dev: password }, { otpSecret: secret });
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await answerDialogs(app, { 'on prod-1?': 'Trust Folder' });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await rememberPasswords(app, hostId);
  // one connection signs in more than once, and a code from the first can expire before the last
  const code = (): SecretAnswer => ({ answer: () => totp(secret) });
  const overlay = await openConnect(app);
  const asked = await connectAnswering(app, overlay, hostId, () => hostCard(overlay, 'prod-1').click(), {
    '(dev@127.0.0.1) Password:': { answer: password, remember: true },
    '(dev@127.0.0.1) Verification code:': code(),
  });
  expect(asked.slice(0, 2)).toEqual(['(dev@127.0.0.1) Password:', '(dev@127.0.0.1) Verification code:']);
  await openInBrowser(overlay, 'prod-1', APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  await shutdownHostDaemon(app, hostId, fixture);

  // The next connection answers the password from the store and asks every code again.
  const again = await connectPrompted(app, hostId, { '(dev@127.0.0.1) Verification code:': code() });
  expect(unique(again)).toEqual(['(dev@127.0.0.1) Verification code:']);
  expect((await fixture.authentications()).filter((line) => line.startsWith('Failed '))).toEqual([]);
  await shutdownHostDaemon(app, hostId, fixture);
});

test('through a ProxyJump host the target\'s remembered password is never offered to the jump host\'s prompt', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const jump = await sshd('jump-1', { config: ['PreferredAuthentications password'] });
  const target = await sshd('prod-target-direct');
  const jumpPassword = newPassword();
  const targetPassword = newPassword();
  await usePasswords(jump, { dev: jumpPassword });
  await usePasswords(target, { dev: targetPassword });
  const dropNetwork = await proxyJumpPair(ssh, { alias: 'jump-1', fixture: jump }, { alias: 'prod-1', fixture: target }, 'prod-target', ['PreferredAuthentications password']);
  try {
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    await answerDialogs(app, { 'on prod-1?': 'Trust Folder' });
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    await rememberPasswords(app, hostId);
    const jumpPrompt = "dev@127.0.0.1's password:";
    const targetPrompt = "dev@prod-target's password:";

    // Each hop asks with its own text; only the target's answer is remembered.
    const overlay = await openConnect(app);
    const asked = await connectAnswering(app, overlay, hostId, () => hostCard(overlay, 'prod-1').click(), {
      [jumpPrompt]: { answer: jumpPassword, remember: false },
      [targetPrompt]: { answer: targetPassword, remember: true },
    });
    expect(asked.slice(0, 2)).toEqual([jumpPrompt, targetPrompt]);
    await openInBrowser(overlay, 'prod-1', APP);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    await shutdownHostDaemon(app, hostId, target);

    // The jump host's prompt is asked again and never answered from the store; the target's is answered.
    expect(unique(await connectPrompted(app, hostId, { [jumpPrompt]: { answer: jumpPassword, remember: false } }))).toEqual([jumpPrompt]);
    expect((await jump.authentications()).filter((line) => line.startsWith('Failed password'))).toEqual([]);
    expect(unique((await target.authentications()).filter((line) => line.split(' ')[1] === 'password'))).toEqual(['Accepted password dev']);
    await shutdownHostDaemon(app, hostId, target);
  } finally {
    await dropNetwork();
  }
});
