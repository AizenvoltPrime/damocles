import { mainLog } from '../desktop/support/app';
import { filesHolding, sendPrompt } from '../desktop/support/loopback-agent';
import { chatRequests } from '../desktop/support/openai-stub';
import { awaitTurnEnd } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { TARGET_HOME, TARGET_USER } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
// A sentinel key only the target's login environment holds.
const HOST_KEY = 'sk-host-env-e2e-7d41a9';
// the session's custom entry naming the providers the run's pinned client held a credential for
const CREDENTIAL_SOURCE_ENTRY = 'damocles-credential-source';

interface SessionLine {
  readonly type: string;
  readonly customType?: string;
  readonly data?: { readonly clientProviders?: readonly string[] };
  readonly message?: { readonly role?: string; readonly provider?: string };
}

test('with no OpenAI credential on this computer, a turn on prod-1 uses its environment\'s key: the menu groups the model under prod-1\'s environment, the stub hears the host\'s key, and the session records the spend as the host\'s', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  // the daemon takes its login shell's environment at start; bash -l reads ~/.profile, as the fixture user has no ~/.bash_profile
  await fixture.sh(`test ! -e ~/.bash_profile && printf 'export OPENAI_API_KEY=%s\\n' '${HOST_KEY}' >> ~/.profile`, TARGET_USER);
  const stub = await startTargetStub(home, fixture, TARGET_USER, false);
  try {
    const desktop = await launch({ env: remoteEnv(ssh, mirror) });
    const { app } = desktop;
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    const key = await openRemoteFolder(app, hostId, APP);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const tab = await newRemoteChat(app, key);

    // The menu: no group of this computer's own, which holds no credential, and the stub model under prod-1's environment.
    await tab.getByTestId('composer-model').click();
    const menu = tab.getByTestId('composer-model-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-testid="composer-model-source"][data-credential-source="client"]')).toHaveCount(0);
    await expect(menu.locator('[data-testid="composer-model-source"][data-credential-source="host"]')).toHaveText("prod-1's environment");
    const model = menu.getByTestId('composer-model-option').filter({ hasText: 'GPT-6 Luna' });
    await expect(model).toHaveCount(1);
    await expect(model).not.toHaveAttribute('data-unavailable');
    await expect(model).not.toHaveAttribute('data-disabled');
    await expect(model.getByTestId('composer-model-hint')).toHaveText("Uses prod-1's OpenAI credentials. Spend counts under prod-1.");
    await model.click();
    await expect(menu).toBeHidden();

    // The turn completes against the stub, every request carrying the key of the host's environment.
    await sendPrompt(tab, 'Run on the host key');
    await expect(tab.getByText('Echo: Run on the host key', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    const requests = chatRequests(stub);
    expect(requests.length).toBeGreaterThan(0);
    expect(new Set(requests.map((request) => request.authorization))).toEqual(new Set([`Bearer ${HOST_KEY}`]));
    // the broker asked this computer first, which held nothing for openai
    expect(mainLog(home)).toContain(`[remote] user.credentials openai for ssh+${hostId}`);

    // The session on the target records that the client held no OpenAI credential before the run's openai reply.
    const sessions = await fixture.sh(`find ${TARGET_HOME}/.damocles/pi/agent/sessions -name '*.jsonl' -exec cat {} +`, TARGET_USER);
    const entries = sessions.split('\n').filter(Boolean).map((line) => JSON.parse(line) as SessionLine);
    const marker = entries.findIndex((entry) => entry.type === 'custom' && entry.customType === CREDENTIAL_SOURCE_ENTRY);
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(entries[marker]!.data?.clientProviders).not.toContain('openai');
    expect(entries.slice(marker + 1).find((entry) => entry.message?.role === 'assistant')?.message?.provider).toBe('openai');

    await shutdownHostDaemon(app, hostId, fixture);
    await desktop.close();
    // this computer never held the host's key: no file under the test's home, its app data included, carries it
    expect(filesHolding(home.root, [HOST_KEY])).toEqual([]);
  } finally {
    await stub.close();
  }
});
