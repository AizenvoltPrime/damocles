import { describe, expect, it, vi } from 'vitest';
import { relayForgeDescribe, relayForgeTool, type ForgeRelayDeps } from '../forge-relay';
import type { RemoteProject } from '../authorities';
import { FORGE_TOOLS_OFF_HERE, MAX_FORGE_TOOL_TEXT_CHARS, type ForgeToolAnswer } from '../../../../shared/forge/tools';

// A remote chat's GitHub and GitLab tools on this computer (user.forge.*): main runs a call only for a folder of that host's
// projects and only while the group is on here, asks this computer's core with the project it mapped, and sends back the
// answer rebuilt field by field and bounded.

const PROJECT: RemoteProject = { key: 'ssh+prod-1|/srv/app', fsPath: '/srv/app', name: 'app', authorityKey: 'ssh+prod-1', folderKey: '/srv/app', os: 'linux' };
const OTHER_HOST: RemoteProject = { key: 'ssh+other|/srv/app', fsPath: '/srv/app', name: 'app', authorityKey: 'ssh+other', folderKey: '/srv/app', os: 'linux' };
const ENDPOINTS = [{ remote: 'origin', fetch: { protocol: 'https' as const, host: 'gitlab.com', path: 'grp/app.git', aliasResolved: false } }];
const CALL = { toolCallId: 'call-1', folder: '/srv/app', endpoints: ENDPOINTS, branch: 'main', tool: 'ForgePipelines', input: {} };

function deps(overrides: Partial<ForgeRelayDeps> = {}): ForgeRelayDeps & { tool: ReturnType<typeof vi.fn>; describe: ReturnType<typeof vi.fn> } {
  return {
    authority: 'ssh+prod-1',
    projects: () => [OTHER_HOST, PROJECT],
    os: () => 'linux',
    enabled: () => true,
    attachView: vi.fn(async (viewId: string) => viewId === 'view-1'),
    tool: vi.fn(async (): Promise<ForgeToolAnswer> => ({ text: 'framed' })),
    describe: vi.fn(async () => ({ ok: true as const, project: 'gitlab.com/grp/app', target: { serverId: 'gitlab.com', repoPath: 'grp/app', accountId: 'a' } })),
    log: () => undefined,
    ...overrides,
  } as ForgeRelayDeps & { tool: ReturnType<typeof vi.fn>; describe: ReturnType<typeof vi.fn> };
}

describe('relayForgeTool', () => {
  it("runs on this computer's core for the host project holding the folder, with the view whose notice it raises", async () => {
    const relay = deps();
    await expect(relayForgeTool(relay, { ...CALL, folder: '/srv/app/packages/web', viewId: 'view-1' }, new AbortController().signal)).resolves.toEqual({ text: 'framed' });
    expect(relay.tool).toHaveBeenCalledWith({
      request: { tool: 'ForgePipelines', input: {}, authorityKey: 'ssh+prod-1', projectKey: 'ssh+prod-1|/srv/app', project: 'app', endpoints: ENDPOINTS, branch: 'main' },
      viewId: 'view-1',
      toolCallId: 'call-1',
    }, expect.any(AbortSignal));
  });

  it('a view no chat of this host shows is dropped, and the call still runs', async () => {
    const relay = deps();
    await relayForgeTool(relay, { ...CALL, viewId: 'someone-else' }, new AbortController().signal);
    expect(relay.tool.mock.calls[0]![0]).not.toHaveProperty('viewId');
  });

  it('refuses a folder outside the host projects, another host\'s project included, before this computer is asked', async () => {
    for (const folder of ['/srv/other', '/srv', '/srv/application', '../srv/app']) {
      const relay = deps();
      const answer = await relayForgeTool(relay, { ...CALL, folder }, new AbortController().signal);
      expect(answer, folder).toMatchObject({ isError: true });
      expect(relay.tool).not.toHaveBeenCalled();
    }
    const elsewhere = deps({ projects: () => [OTHER_HOST] });
    expect(await relayForgeTool(elsewhere, CALL, new AbortController().signal)).toMatchObject({ isError: true });
    expect(elsewhere.tool).not.toHaveBeenCalled();
  });

  it('refuses while the group is off on this computer, with the exact reason', async () => {
    const relay = deps({ enabled: () => false });
    await expect(relayForgeTool(relay, CALL, new AbortController().signal)).resolves.toEqual({ text: FORGE_TOOLS_OFF_HERE, isError: true });
    expect(FORGE_TOOLS_OFF_HERE).toBe('GitHub and GitLab tools are off on the computer that shows this chat.');
    await expect(relayForgeDescribe(relay, { ...CALL, approval: true }, new AbortController().signal)).resolves.toEqual({ ok: false, answer: { text: FORGE_TOOLS_OFF_HERE, isError: true } });
    expect(relay.tool).not.toHaveBeenCalled();
    expect(relay.describe).not.toHaveBeenCalled();
  });

  it('sends back only the answer\'s own fields, bounded', async () => {
    const extra = { text: 'x'.repeat(MAX_FORGE_TOOL_TEXT_CHARS + 10), isError: true, token: 'glpat-leak', refusal: { serverId: 'gitlab.com', serverLabel: 'gitlab.com', project: 'app', account: { id: 'a', login: 'alexios-s', secret: 'refresh' }, reason: 'noAccount', path: '/tmp/x' } };
    const relay = deps({ tool: vi.fn(async () => extra as unknown as ForgeToolAnswer) });
    const answer = await relayForgeTool(relay, CALL, new AbortController().signal);
    expect(answer.text).toHaveLength(MAX_FORGE_TOOL_TEXT_CHARS);
    expect(answer).toEqual({ text: answer.text, isError: true, refusal: { serverId: 'gitlab.com', serverLabel: 'gitlab.com', project: 'app', account: { id: 'a', login: 'alexios-s' }, reason: 'noAccount' } });
  });

  it('describe answers the target and a write\'s card as the core answered them', async () => {
    const relay = deps();
    await expect(relayForgeDescribe(relay, { ...CALL, approval: false }, new AbortController().signal)).resolves.toEqual({ ok: true, project: 'gitlab.com/grp/app', target: { serverId: 'gitlab.com', repoPath: 'grp/app', accountId: 'a' } });
    expect(relay.describe).toHaveBeenCalledWith(expect.objectContaining({ approval: false, toolCallId: 'call-1' }), expect.any(AbortSignal));
  });

  it('refuses a tool that is no GitHub or GitLab tool before it logs or asks anything', async () => {
    const lines: string[] = [];
    const relay = deps({ log: (line) => lines.push(line) });
    const answer = await relayForgeTool(relay, { ...CALL, tool: 'ForgePipelines\n[remote] forged line' }, new AbortController().signal);
    expect(answer).toEqual({ text: 'This is not a GitHub or GitLab tool.', isError: true });
    expect(relay.tool).not.toHaveBeenCalled();
    expect(relay.attachView).not.toHaveBeenCalled();
    expect(lines).toEqual(['[remote] user.forge refused for ssh+prod-1: not a GitHub or GitLab tool']);
  });

  it('never cuts the answer between the halves of a surrogate pair', async () => {
    const text = `${'x'.repeat(MAX_FORGE_TOOL_TEXT_CHARS - 1)}😀tail`;
    const relay = deps({ tool: vi.fn(async (): Promise<ForgeToolAnswer> => ({ text })) });
    const answer = await relayForgeTool(relay, CALL, new AbortController().signal);
    expect(answer.text).toBe('x'.repeat(MAX_FORGE_TOOL_TEXT_CHARS - 1));
  });

  it('maps a Windows host\'s folder to its project whatever the letter case, as Windows does', async () => {
    const windows: RemoteProject = { key: 'ssh+prod-1|c:/src/app', fsPath: 'C:\\src\\app', name: 'app', authorityKey: 'ssh+prod-1', folderKey: 'c:/src/app', os: 'win32' };
    const relay = deps({ projects: () => [windows], os: () => 'win32' });
    await relayForgeTool(relay, { ...CALL, folder: 'c:\\SRC\\App\\web' }, new AbortController().signal);
    await relayForgeTool(relay, { ...CALL, folder: 'C:\\Src\\APP' }, new AbortController().signal);
    expect(relay.tool.mock.calls.map(([params]) => (params as { request: { projectKey: string } }).request.projectKey)).toEqual(['ssh+prod-1|c:/src/app', 'ssh+prod-1|c:/src/app']);
  });

  it('forwards the decided target and the push remote to this computer\'s core', async () => {
    const relay = deps();
    const expected = { serverId: 'gitlab.com', repoPath: 'grp/app', accountId: 'gitlab.com|2001', sourceBranch: 'fix', targetBranch: 'main' };
    await relayForgeTool(relay, { ...CALL, pushRemote: 'fork', expected }, new AbortController().signal);
    expect(relay.tool.mock.calls[0]![0]).toMatchObject({ request: { pushRemote: 'fork', expected } });
    await relayForgeDescribe(relay, { ...CALL, pushRemote: 'fork', approval: true }, new AbortController().signal);
    expect(relay.describe.mock.calls[0]![0]).toMatchObject({ request: { pushRemote: 'fork' }, approval: true });
  });

  it('runs nothing before the host reported its OS', async () => {
    const relay = deps({ os: () => undefined });
    expect(await relayForgeTool(relay, CALL, new AbortController().signal)).toMatchObject({ isError: true });
    expect(relay.tool).not.toHaveBeenCalled();
  });
});
