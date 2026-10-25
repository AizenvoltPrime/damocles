import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { installPlatform } from '../../platform-host';
import { USER_SCOPE_UNAVAILABLE } from '../../../shared/remote-user';
import { POLICY_BLOCK_MARKER } from '../../../shared/types/constants';
import { runPermissionGate, type GatePermissionContext } from '../permission-gate';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import { BROWSER_PI_TOOL_NAMES } from '../tools/browser-tools';
import { COMPASS_PI_TOOL_NAMES } from '../tools/compass-tools';
import { deferredToolNames, initialActiveToolNames, loadableToolNames, resolveToolSearchEntries, userScopeToolNames } from '../tools/deferred-tools';
import { isLoopbackEndpoint, markLoopbackEndpoints } from '../pi-models';
import type { ModelInfo } from '../../../shared/types/settings';
import { DEFAULT_MODELS } from '../../../shared/types/constants';
import type { OpenAIAuthStatus } from '../openai-auth';

describe('deferred tools whose user-scope service a daemon\'s core cannot reach', () => {
  const eligible = ['Read', ...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES];
  const deferred = deferredToolNames(eligible, []);

  it('stay eligible and deferred, so none becomes active, but leave the loadable snapshot', () => {
    expect(deferred).toEqual(expect.arrayContaining([...BROWSER_PI_TOOL_NAMES]));
    expect(initialActiveToolNames(eligible, deferred, new Set())).toEqual(['Read']);
    const loadable = loadableToolNames(deferred, false);
    expect(loadable).toEqual([...COMPASS_PI_TOOL_NAMES]);
    expect(resolveToolSearchEntries(['browser'], loadable, new Map()).matches).toEqual([]);
  });

  it('are loadable on this computer\'s core', () => {
    expect(loadableToolNames(deferred, true)).toEqual(deferred);
    expect(userScopeToolNames(true).size).toBe(0);
    expect([...userScopeToolNames(false)].sort()).toEqual([...BROWSER_PI_TOOL_NAMES].sort());
  });
});

describe('loopback provider endpoints in a remote chat\'s model list', () => {
  it('recognises loopback hosts only', () => {
    for (const url of ['http://127.0.0.1:8080/v1', 'http://localhost:1234', 'http://[::1]:9/v1', 'https://api.localhost/x']) expect(isLoopbackEndpoint(url), url).toBe(true);
    for (const url of ['http://0.0.0.0:11434', 'http://localhost.:1234', 'http://api.localhost./x', 'http://[::ffff:127.0.0.1]:8080', 'http://[::ffff:7f00:1]/v1', 'http://[::]:9', 'http://127.1:8080', 'http://0x7f000001/v1', 'http://[0:0:0:0:0:0:0:1]/v1']) expect(isLoopbackEndpoint(url), url).toBe(true);
    for (const url of ['https://api.anthropic.com', 'http://10.0.0.5:8080', 'http://128.0.0.1', 'http://[::ffff:a00:5]/v1', 'http://localhost.example.com', 'not a url']) expect(isLoopbackEndpoint(url), url).toBe(false);
  });

  it('marks a model whose provider endpoint is loopback unavailable, keeping it in the list', () => {
    const models: ModelInfo[] = [DEFAULT_MODELS.find((m) => m.backend === undefined && m.piProvider === undefined)!, DEFAULT_MODELS.find((m) => m.piProvider === 'deepseek')!];
    const registry = {
      getModel: (provider: string) => ({ provider, baseUrl: provider === 'deepseek' ? 'http://127.0.0.1:4000/v1' : 'https://api.anthropic.com' }),
      hasConfiguredAuth: () => true,
    };
    const openai: OpenAIAuthStatus = { apiKey: false, chatgpt: false, codex: false };
    const marked = markLoopbackEndpoints(models, registry as never, openai, false, false);
    expect(marked[0]).toEqual(models[0]);
    expect(marked[1]).toEqual({ ...models[1], unavailable: { reason: 'loopback-endpoint', endpoint: 'http://127.0.0.1:4000/v1' } });
    // a target on the client's own machine reaches its loopback
    expect(markLoopbackEndpoints(models, registry as never, openai, false, true)).toEqual(models);
  });
});

describe('a direct call of a tool whose user-scope service is unavailable', () => {
  afterEach(() => installPlatform(createFakePlatform()));

  const call = async (): Promise<{ result: Awaited<ReturnType<typeof runPermissionGate>>; asked: ReturnType<typeof vi.fn> }> => {
    const asked = vi.fn();
    const panel = {
      permissionHandler: { canUseTool: asked, decide: () => 'allow', matchRule: async () => null, isPlanFile: () => false },
      isPlanMode: () => false,
      shellCancel: new ShellCancelStore().forContext(() => undefined),
    } as unknown as GatePermissionContext;
    const event = { type: 'tool_call', toolName: BROWSER_PI_TOOL_NAMES[0], toolCallId: 't1', input: { url: 'https://example.com' } } as unknown as ToolCallEvent;
    return { result: await runPermissionGate(event, panel, undefined), asked };
  };

  it('is blocked with the user-scope reason on a daemon core, before any approval or hook', async () => {
    installPlatform({ ...createFakePlatform(), remote: createFakeRemoteHost().remote });
    const { result, asked } = await call();
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result?.reason).toContain(USER_SCOPE_UNAVAILABLE);
    expect(asked).not.toHaveBeenCalled();
  });

  it('runs on this computer core', async () => {
    const { result } = await call();
    expect(result?.reason ?? '').not.toContain(USER_SCOPE_UNAVAILABLE);
  });
});
