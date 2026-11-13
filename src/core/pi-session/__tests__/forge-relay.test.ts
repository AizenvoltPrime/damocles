import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { installPlatform } from '../../platform-host';
import type { PanelHost } from '../../../platform/window-service';
import { CLIENT_FEATURE_MISSING, CREDENTIAL_CLIENT_ABSENT } from '../../../shared/remote-user';
import type { ChatRepository, ForgeToolAnswer } from '../../../shared/forge/tools';
import { relayedForgeTools } from '../tools/forge-relay';
import type { ForgeCall } from '../tools/forge-tools';
import { userScopeReach, forgeUnreachableReason } from '../../user-scope';
import { englishText } from '../../../shared/localized-text';

// A daemon's core's GitHub and GitLab tools (docs/invariants.md "Remote daemon and wire", relayed tools): the target's own core
// reads the repository, and the call goes to the device the turn is pinned to, never another; the answer is that device's
// text, the refused notice shown in the chat's views; a detached device or an old one is a reason, never a hang or a throw.

const REPOSITORY: ChatRepository = {
  ok: true,
  repository: { projectPath: '/srv/app', project: 'app', endpoints: [{ remote: 'origin', fetch: { protocol: 'https', host: 'gitlab.com', path: 'grp/app.git', aliasResolved: false } }], pushRemote: 'origin', branch: 'main' },
};
const CALL: ForgeCall = { tool: 'ForgePipelines', input: { limit: 5 }, toolCallId: 'call-1' };
const TARGET = { serverId: 'gitlab.com', repoPath: 'grp/app', accountId: 'gitlab.com|2001' };
const chat = { postMessage: vi.fn() } as unknown as PanelHost;

function relay(repository: ChatRepository = REPOSITORY) {
  const fake = createFakeRemoteHost();
  installPlatform({ ...createFakePlatform(), remote: fake.remote });
  const refused = vi.fn<(call: ForgeCall, answer: ForgeToolAnswer) => void>();
  const port = relayedForgeTools({ remote: fake.remote, chat, folder: () => '/srv/app/.damocles-worktree', repository: async () => repository, refused });
  return { fake, port, refused };
}

afterEach(() => {
  installPlatform(createFakePlatform());
});

describe('relayed GitHub and GitLab tools', () => {
  it('send the target-read repository and the call to the pinned client, naming the project folder the target resolved', async () => {
    const { fake, port, refused } = relay();
    vi.mocked(fake.remote.forgeTool).mockResolvedValue({ text: 'framed text' });
    await expect(port.run(CALL, new AbortController().signal)).resolves.toEqual({ text: 'framed text' });
    expect(fake.remote.forgeTool).toHaveBeenCalledWith('client-a', chat, {
      toolCallId: 'call-1',
      folder: '/srv/app',
      endpoints: REPOSITORY.ok ? REPOSITORY.repository.endpoints : [],
      pushRemote: 'origin',
      branch: 'main',
      tool: 'ForgePipelines',
      input: { limit: 5 },
    }, expect.any(AbortSignal));
    expect(refused).toHaveBeenCalledWith(CALL, { text: 'framed text' });
  });

  it('a target and an approval card come from describe', async () => {
    const { fake, port } = relay();
    vi.mocked(fake.remote.forgeDescribe).mockResolvedValueOnce({ ok: true, project: 'gitlab.com/grp/app', target: TARGET });
    await expect(port.target(CALL, new AbortController().signal)).resolves.toMatchObject({ ok: true, project: 'gitlab.com/grp/app' });
    expect(vi.mocked(fake.remote.forgeDescribe).mock.calls[0]![2]).toMatchObject({ approval: false });
    const suggestion = { type: 'addRules' as const, rules: [{ toolName: 'ForgeComment', ruleContent: 'gitlab.com/grp/app' }], behavior: 'allow' as const, destination: 'localSettings' as const };
    vi.mocked(fake.remote.forgeDescribe).mockResolvedValueOnce({ ok: true, project: 'gitlab.com/grp/app', target: TARGET, detail: { title: { message: 'x' } }, suggestion });
    await expect(port.approval({ ...CALL, tool: 'ForgeComment' }, new AbortController().signal)).resolves.toEqual({ ok: true, project: 'gitlab.com/grp/app', detail: { title: { message: 'x' } }, suggestion, target: TARGET });
    vi.mocked(fake.remote.forgeDescribe).mockResolvedValueOnce({ ok: true, project: 'gitlab.com/grp/app', target: TARGET });
    await expect(port.approval({ ...CALL, tool: 'ForgeComment' }, new AbortController().signal)).resolves.toMatchObject({ ok: false });
  });

  it('runs a call on the target the gate decided for it, once', async () => {
    const { fake, port } = relay();
    vi.mocked(fake.remote.forgeDescribe).mockResolvedValueOnce({ ok: true, project: 'gitlab.com/grp/app', target: { ...TARGET, sourceBranch: 'fix', targetBranch: 'main' } });
    await port.approval({ ...CALL, tool: 'ForgeComment' }, new AbortController().signal);
    await port.run({ ...CALL, tool: 'ForgeComment' }, new AbortController().signal);
    expect(vi.mocked(fake.remote.forgeTool).mock.calls[0]![2]).toMatchObject({ expected: { ...TARGET, sourceBranch: 'fix', targetBranch: 'main' } });
    await port.run({ ...CALL, tool: 'ForgeComment' }, new AbortController().signal);
    expect(vi.mocked(fake.remote.forgeTool).mock.calls[1]![2]).not.toHaveProperty('expected');
  });

  it('a refusal of the device is shown in the chat as its refused notice', async () => {
    const { fake, port, refused } = relay();
    const refusal = { serverId: 'gitlab.com', serverLabel: 'gitlab.com', project: 'app', account: null, reason: 'noAccount' as const };
    vi.mocked(fake.remote.forgeDescribe).mockResolvedValue({ ok: false, answer: { text: 'no account', isError: true, refusal } });
    await expect(port.target(CALL, new AbortController().signal)).resolves.toMatchObject({ ok: false });
    expect(refused).toHaveBeenCalledWith(CALL, { text: 'no account', isError: true, refusal });
  });

  it('with the device detached the call answers the closed reason and nothing is sent', async () => {
    const { fake, port } = relay();
    fake.set('clientAuth', 'client-a', undefined);
    const answer = await port.run(CALL, new AbortController().signal);
    expect(answer).toEqual({ text: 'Your GitHub and GitLab accounts are on your computer, and Damocles is closed.', isError: true });
    expect(fake.remote.forgeTool).not.toHaveBeenCalled();
    expect(englishText(forgeUnreachableReason())).toBe(answer.text);
  });

  it('a device that went away meanwhile, or predates the feature, is a reason', async () => {
    const { fake, port } = relay();
    vi.mocked(fake.remote.forgeTool).mockRejectedValueOnce(new Error(CREDENTIAL_CLIENT_ABSENT));
    expect((await port.run(CALL, new AbortController().signal)).text).toBe('Your GitHub and GitLab accounts are on your computer, and Damocles is closed.');
    vi.mocked(fake.remote.forgeTool).mockRejectedValueOnce(new Error(CLIENT_FEATURE_MISSING));
    expect((await port.run(CALL, new AbortController().signal)).text).toContain('Update Damocles there');
  });

  it("a folder the target cannot read is the answer, and nothing crosses", async () => {
    const { fake, port } = relay({ ok: false, text: "This chat's folder is not in a trusted project." });
    expect(await port.run(CALL, new AbortController().signal)).toEqual({ text: "This chat's folder is not in a trusted project.", isError: true });
    expect(fake.remote.forgeTool).not.toHaveBeenCalled();
  });

  it('the group is loadable only while the pinned device is attached and has an account', () => {
    const { fake } = relay();
    expect(userScopeReach().forge).toBe(false);
    fake.set('clientForges', 'client-a', { servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true }] });
    expect(userScopeReach().forge).toBe(true);
    fake.set('clientForges', 'client-a', { servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: false }] });
    expect(userScopeReach().forge).toBe(false);
  });

  it('the group is not loadable while the pinned device has not read its servers, and is once they arrive with an account', () => {
    const { fake } = relay();
    fake.set('clientForges', 'client-a', { servers: [], pending: true });
    expect(userScopeReach().forge).toBe(false);
    expect(forgeUnreachableReason()).toEqual({ message: 'Damocles has not read the GitHub and GitLab servers of your computer yet. Try again in a moment.' });
    fake.set('clientForges', 'client-a', { servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true }] });
    expect(userScopeReach().forge).toBe(true);
  });
});
