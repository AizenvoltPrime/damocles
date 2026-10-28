import type { ElectronApplication } from '@playwright/test';
import { closeSettingsModal } from '../desktop/support/settings';
import { answerToast, recordedToasts, recordToasts } from '../desktop/support/shell';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { scmPush } from './support/git-credentials';
import { openRemoteHostSettings, setHostSwitch, storedHost } from './support/host-settings-ui';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { startSshAgentStub } from './support/ssh-agent-stub';
import type { SshdFixture } from './support/sshd';

const APP = '/srv/app';
// an account on the target that accepts only the agent's key: the git-over-ssh remote a forwarded agent reaches
const GIT_USER = 'gitremote';
const BARE = '/srv/git/app.git';
const FORWARD = 'Forward your SSH agent to prod-1';

async function gitOverSshRemote(fixture: SshdFixture, agentKey: string): Promise<void> {
  await fixture.sh([
    `useradd -m -s /bin/sh ${GIT_USER}`,
    `usermod -p '*' ${GIT_USER}`,
    `cat > /etc/ssh/authorized_keys/${GIT_USER}`,
    `chmod 644 /etc/ssh/authorized_keys/${GIT_USER}`,
    `mkdir -p /srv/git`,
    `git init -q --bare -b main ${BARE}`,
    `chown -R ${GIT_USER}:${GIT_USER} /srv/git`,
  ].join(' && '), 'root', `${agentKey}\n`);
  await fixture.sh([
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    'ssh-keyscan -t ed25519 localhost > ~/.ssh/known_hosts 2> /dev/null',
    "git config --global user.name 'E2E Dev'",
    'git config --global user.email dev@prod-1.invalid',
    `git init -q -b main ${APP}`,
    `cd ${APP}`,
    "printf 'forwarded\\n' > README.md",
    'git add -A',
    'git commit -q -m init',
    `git remote add origin ${GIT_USER}@localhost:${BARE}`,
    'git config branch.main.remote origin',
    'git config branch.main.merge refs/heads/main',
  ].join(' && '), 'dev');
}

// sshd's listener socket for each of the account's sessions that forwards an agent
const forwardedAgents = async (fixture: SshdFixture): Promise<string> =>
  (await fixture.sh("find /tmp -maxdepth 2 -path '/tmp/ssh-*/agent.*' -type s -user dev")).trim();

const bareHead = async (fixture: SshdFixture): Promise<string> => (await fixture.sh(`git --git-dir ${BARE} rev-parse --verify --quiet refs/heads/main || true`)).trim();
const targetHead = async (fixture: SshdFixture): Promise<string> => (await fixture.sh(`git -C ${APP} rev-parse HEAD`, 'dev')).trim();

/** The newest notice offering the forwarding action, once one shows. */
async function forwardingOffer(app: ElectronApplication, after: number): Promise<{ id: string }> {
  let found: { id: string } | undefined;
  await expect.poll(async () => (found = (await recordedToasts(app)).slice(after).find((toast) => toast.actions.includes(FORWARD))), { timeout: 60_000 }).toBeDefined();
  return found!;
}

test('a git push over ssh fails with publickey while forwarding is off and offers forwarding; with it on the push succeeds through the agent socket, and is refused again once forwarding is off', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const agent = await startSshAgentStub(home.root);
  try {
    const fixture = await sshd('prod-1', { config: ['IdentityAgent SSH_AUTH_SOCK'] });
    await gitOverSshRemote(fixture, agent.publicKey);
    const { app } = await launch({ env: { ...remoteEnv(ssh, mirror), SSH_AUTH_SOCK: agent.socket } });
    await recordToasts(app);
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    await openRemoteFolder(app, hostId, APP);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);

    // Off (the default): the target never sees the agent, the push is refused, and the notification offers forwarding.
    await scmPush(app, true);
    const offer = await forwardingOffer(app, 0);
    expect(await bareHead(fixture)).toBe('');
    expect(agent.signatures).toBe(0);
    expect(await forwardedAgents(fixture)).toBe('');

    // The action turns the host's setting on and reconnects with the agent forwarded; the push signs with it.
    await answerToast(app, offer.id, FORWARD);
    await expect.poll(() => storedHost(home, hostId)?.settings['forwardAgent']).toBe(true);
    await expect.poll(() => forwardedAgents(fixture), { timeout: 60_000 }).not.toBe('');
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    await scmPush(app, true);
    await expect.poll(() => bareHead(fixture), { timeout: 60_000 }).toBe(await targetHead(fixture));
    expect(agent.signatures).toBeGreaterThan(0);
    // the daemon's proxy socket for this device, in its agent folder
    const socket = (await fixture.sh("find / -xdev -name 'agent-*.sock' -type s -user dev 2> /dev/null; true")).trim();
    expect(socket).not.toBe('');
    expect((await fixture.sh(`stat -c '%a %U' '${socket}'`)).trim()).toBe('600 dev');

    // Off again: a new commit's push is refused, the agent untouched.
    const { overlay, block } = await openRemoteHostSettings(app, hostId);
    await setHostSwitch(block, 'Forward my SSH agent', false);
    await closeSettingsModal(overlay);
    await expect.poll(() => forwardedAgents(fixture), { timeout: 60_000 }).toBe('');
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    await fixture.sh(`cd ${APP} && git commit -q --allow-empty -m second`, 'dev');
    const signed = agent.signatures;
    const toasts = (await recordedToasts(app)).length;
    await scmPush(app, false);
    await forwardingOffer(app, toasts);
    expect(await bareHead(fixture)).not.toBe(await targetHead(fixture));
    expect(agent.signatures).toBe(signed);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await agent.close();
  }
});
