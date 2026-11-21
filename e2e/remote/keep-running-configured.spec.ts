import type { ElectronApplication } from '@playwright/test';
import { activeChat } from '../desktop/support/fixtures';
import { writeUserSettings } from '../desktop/support/hermetic';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { STUB_MODEL_ID, type OpenAIStub } from '../desktop/support/openai-stub';
import { hostMessages, recordHostMessages } from '../desktop/support/ui';
import { customProviderDef } from '../../src/core/pi-session/provider-defs';
import { EXPLORE_MODEL_SETTING } from '../../src/shared/explore-settings';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { closeRemoteDialog, exited, requestQuit, stubOAuth, targetCoreLog, targetSessions } from './support/remote-runs';
import { TARGET_USER, type SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// Keep running pushes the OAuth access tokens of the providers a run's configuration names, not only the ones it used; an
// API key still crosses only when a run asks, so the dialog names the configured key providers that wait for this computer.

const APP = '/srv/app';
// a DeepSeek model the stub answers for on the target, and the key this computer holds for it
const DEEPSEEK_MODEL = 'deepseek-v4-pro';
const DEEPSEEK_KEY = 'sk-e2e-deepseek-configured';
// the stub ChatGPT sign-in outlives the test, so the run never needs a fresh one
const TOKEN_MS = 3_600_000;

async function connect(app: ElectronApplication): Promise<{ hostId: string; key: string }> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  return { hostId, key };
}

/** The target's pi lists the stub as both `openai` and `deepseek`, with no key of its own for either. */
async function stubBothProviders(fixture: Pick<SshdFixture, 'sh'>, stub: OpenAIStub): Promise<void> {
  const models = {
    providers: {
      openai: {
        baseUrl: stub.baseUrl,
        api: 'openai-completions',
        models: [{ id: STUB_MODEL_ID, name: 'Stub model', reasoning: false, input: ['text'], contextWindow: 272000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
      deepseek: { baseUrl: stub.baseUrl },
    },
  };
  const agentDir = `/home/${TARGET_USER}/.damocles/pi/agent`;
  await fixture.sh(`mkdir -p ${agentDir} && cat > ${agentDir}/models.json`, TARGET_USER, JSON.stringify(models, null, 2));
}

/**
 * Saves this computer's DeepSeek key in its secret store, where a saved key lives (an auth.json one is swept at the first start),
 * and waits until core's sync applied it: the account state it publishes then lists DeepSeek, and sign-ins read afterwards hold the key.
 */
async function saveDeepseekKey(app: ElectronApplication): Promise<void> {
  const local = await activeChat(app);
  await recordHostMessages(local);
  await app.evaluate((_electron, [secretKey, key]) => (globalThis as unknown as { __damoclesE2e: { secrets: { store(key: string, value: string): Promise<void> } } }).__damoclesE2e.secrets.store(secretKey, key), [customProviderDef('deepseek').key.secretKey, DEEPSEEK_KEY] as const);
  await expect.poll(async () => ((await hostMessages(local, 'accountInfo')).at(-1)?.['data'] as { pickerProviders?: string[] } | undefined)?.pickerProviders, { timeout: 30_000 }).toContain('deepseek');
}

/** A new chat whose turn streams its first chunk and holds there until the returned release. */
async function heldChat(app: ElectronApplication, key: string, stub: OpenAIStub, prompt: string, chunks: readonly [string, string]): Promise<() => void> {
  let release!: () => void;
  stub.replies.push({ chunks: [...chunks], holdAfterFirst: new Promise<void>((resolve) => (release = resolve)) });
  const tab = await newRemoteChat(app, key);
  await sendPrompt(tab, prompt);
  await expect(tab.getByText(chunks[0], { exact: false })).toBeVisible({ timeout: 60_000 });
  return release;
}

const pushed = (log: string, provider: string): boolean => new RegExp(`\\[credential-broker\\] ${provider}: \\S+ pushed an access token`).test(log);
const answered = (log: string, provider: string, type: string): boolean => new RegExp(`\\[credential-broker\\] ${provider}: \\S+ answered ${type}`).test(log);

test('Keep running pushes the OAuth token of the Explore model\'s provider before the chat has run on it, and never the chat\'s API key', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, TARGET_USER, false);
  try {
    await stubBothProviders(fixture, stub);
    // the chat runs on this computer's DeepSeek key; its Explore profile names the stub ChatGPT sign-in, which no turn has used
    writeUserSettings(home, { 'damocles.model': DEEPSEEK_MODEL, [EXPLORE_MODEL_SETTING]: STUB_MODEL_ID });
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    await stubOAuth(first.app, 'alice', TOKEN_MS);
    await saveDeepseekKey(first.app);
    const { hostId, key } = await connect(first.app);
    const release = await heldChat(first.app, key, stub, 'Run on the key', ['Key part.', ' Key end.']);
    expect(stub.requests.some((request) => request.authorization === `Bearer ${DEEPSEEK_KEY}`)).toBe(true);
    expect(stub.requests.some((request) => request.authorization?.startsWith('Bearer e2e-oauth-alice-'))).toBe(false);

    await requestQuit(first.app);
    const { dialog } = await closeRemoteDialog(first.app);
    await expect(dialog.getByTestId('close-remote-row')).toHaveCount(1);
    // the run already asked for its key, so the row names no provider that waits for this computer
    await expect(dialog.getByTestId('close-remote-key-providers')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(first);

    const log = await targetCoreLog(fixture);
    expect(pushed(log, 'openai')).toBe(true);
    expect(pushed(log, 'deepseek')).toBe(false);
    // the key crossed once, when the run asked for it
    expect(answered(log, 'deepseek', 'api_key')).toBe(true);
    expect(answered(log, 'openai', 'oauth')).toBe(false);
    release();
    await expect.poll(() => targetSessions(fixture), { timeout: 60_000 }).toContain('Key part. Key end.');

    const second = await launch(env);
    await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
    await shutdownHostDaemon(second.app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

test('an Explore model on an API-key provider is named on the Keep running row, and Keep running pushes no key for it', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, TARGET_USER, false);
  try {
    await stubBothProviders(fixture, stub);
    // the chat runs on the stub ChatGPT sign-in; its Explore profile names DeepSeek, whose key only this computer holds
    writeUserSettings(home, { 'damocles.model': STUB_MODEL_ID, [EXPLORE_MODEL_SETTING]: DEEPSEEK_MODEL });
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    await stubOAuth(first.app, 'alice', TOKEN_MS);
    await saveDeepseekKey(first.app);
    const { hostId, key } = await connect(first.app);
    const release = await heldChat(first.app, key, stub, 'Run on the sign-in', ['Sign-in part.', ' Sign-in end.']);
    expect(stub.requests.some((request) => request.authorization?.startsWith('Bearer e2e-oauth-alice-'))).toBe(true);

    await requestQuit(first.app);
    const { dialog } = await closeRemoteDialog(first.app);
    const row = dialog.getByTestId('close-remote-row');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('close-remote-key-providers')).toHaveText(/^DeepSeek uses an API key from this computer, which the host gets only when the chat asks\./, { timeout: 60_000 });
    await expect(row.getByTestId('close-remote-key-providers')).not.toContainText(DEEPSEEK_KEY);
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(first);

    const log = await targetCoreLog(fixture);
    expect(pushed(log, 'openai')).toBe(true);
    expect(pushed(log, 'deepseek')).toBe(false);
    expect(answered(log, 'deepseek', 'api_key')).toBe(false);
    expect(stub.requests.some((request) => request.authorization === `Bearer ${DEEPSEEK_KEY}`)).toBe(false);
    release();
    await expect.poll(() => targetSessions(fixture), { timeout: 60_000 }).toContain('Sign-in part. Sign-in end.');

    const second = await launch(env);
    await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
    await shutdownHostDaemon(second.app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
