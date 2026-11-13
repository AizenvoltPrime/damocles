import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenStore } from '../accounts/token-store';
import { createForgeHttp } from '../http';
import { runDeviceFlow, type DeviceCodeShown } from '../oauth/device-flow';
import { providerFor, type DevicePoll, type ForgeProvider } from '../providers/provider';
import { createServerRegistry, type ServerRegistry } from '../servers';
import { createHarness, type Harness } from './support/harness';

let harness: Harness;
let registry: ServerRegistry;

beforeAll(async () => {
  harness = await createHarness();
  const deps = harness.deps();
  registry = createServerRegistry({ forgeDir: harness.forgeDir, tokens: createTokenStore(harness.secrets, () => undefined), buildOAuth: {}, overrides: deps.overrides!, log: () => undefined });
  await registry.load();
});

afterAll(async () => {
  await harness.close();
});

const http = () => createForgeHttp({ fetch: harness.fetch, userAgent: "Damocles/test", log: () => undefined });

describe('device code sign-in', () => {
  it('shows GitHub\'s code and page, polls while pending and signs in once approved', async () => {
    const server = registry.get('github.com')!;
    const shown: DeviceCodeShown[] = [];
    const sleeps: number[] = [];
    const running = runDeviceFlow({ http: http(), log: () => undefined, sleep: async (ms) => {
      sleeps.push(ms);
      // the user approves after the second poll
      if (sleeps.length === 3) harness.stub.github.approveDevice('astef-admin');
    } }, server, providerFor('github'), { client: server.oauth!, signal: new AbortController().signal, onCode: (code) => shown.push(code) });
    const grant = await running;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ userCode: 'WDJB-MJHT', verificationUri: `${harness.stub.github.webUrl}/login/device` });
    expect(shown[0]!.expiresAt).toBeGreaterThan(Date.now() + 800_000);
    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(grant.tokens.access).toMatch(/^gho_stub/);
  });

  it('uses GitLab\'s /oauth/authorize_device and reports a denial', async () => {
    const server = registry.get('gitlab.com')!;
    const running = runDeviceFlow({ http: http(), log: () => undefined, sleep: async () => harness.stub.gitlab.denyDevice() }, server, providerFor('gitlab'), { client: server.oauth!, signal: new AbortController().signal, onCode: () => undefined });
    await expect(running).rejects.toMatchObject({ kind: 'denied', text: { message: 'The sign-in was denied.' } });
    expect(harness.stub.gitlab.requests.some((request) => request.path === '/oauth/authorize_device')).toBe(true);
  });

  it('cancels while it waits', async () => {
    const server = registry.get('gitlab.com')!;
    const controller = new AbortController();
    const running = runDeviceFlow({ http: http(), log: () => undefined }, server, providerFor('gitlab'), { client: server.oauth!, signal: controller.signal, onCode: () => controller.abort() });
    await expect(running).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('adds 5 s on slow_down, never below the server\'s interval, and waits no longer than the code lives', async () => {
    let now = 1_000_000;
    const polls: DevicePoll[] = [{ kind: 'slowDown' }, { kind: 'slowDown', interval: 30 }, { kind: 'slowDown', interval: 2 }, { kind: 'pending' }];
    const pollDevice = vi.fn(async () => polls.shift()!);
    const provider: ForgeProvider = {
      ...providerFor('github'),
      startDevice: async () => ({ deviceCode: 'dc', userCode: 'ABCD-EFGH', verificationUri: `${harness.stub.github.webUrl}/login/device`, expiresIn: 60, interval: 5 }),
      pollDevice,
    };
    const sleeps: number[] = [];
    const server = registry.get('github.com')!;
    const running = runDeviceFlow({ http: http(), log: () => undefined, now: () => now, sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    } }, server, provider, { client: server.oauth!, signal: new AbortController().signal, onCode: () => undefined });
    await expect(running).rejects.toMatchObject({ kind: 'expired', text: { message: 'Code expired. Start the sign-in again.' } });
    // 5, +5, the server's 30, then 30 + 5 over its smaller 2, cut to the 15 s the code has left, after which nothing polls
    expect(sleeps).toEqual([5000, 10_000, 30_000, 15_000]);
    expect(pollDevice).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['an interval of 0', { expiresIn: 900, interval: 0 }],
    ['an interval over an hour', { expiresIn: 900, interval: 3601 }],
    ['an infinite interval', { expiresIn: 900, interval: Number.POSITIVE_INFINITY }],
    ['a lifetime of 0', { expiresIn: 0, interval: 5 }],
    ['a lifetime over an hour', { expiresIn: 3601, interval: 5 }],
    ['a lifetime that is not a number', { expiresIn: Number.NaN, interval: 5 }],
  ])('refuses a device code with %s before showing it', async (_name, timing) => {
    const server = registry.get('github.com')!;
    const provider: ForgeProvider = { ...providerFor('github'), startDevice: async () => ({ deviceCode: 'dc', userCode: 'X', verificationUri: `${harness.stub.github.webUrl}/login/device`, ...timing }) };
    const onCode = vi.fn();
    await expect(runDeviceFlow({ http: http(), log: () => undefined, sleep: async () => undefined }, server, provider, { client: server.oauth!, signal: new AbortController().signal, onCode }))
      .rejects.toMatchObject({ kind: 'provider', text: { message: 'The server answered with a device code Damocles cannot use. Use the browser or a token.' } });
    expect(onCode).not.toHaveBeenCalled();
  });

  it('dates the granted tokens by the clock it was given', async () => {
    const server = registry.get('gitlab.com')!;
    const at = Date.now() + 3_600_000;
    const grant = await runDeviceFlow({ http: http(), log: () => undefined, now: () => at, sleep: async () => harness.stub.gitlab.approveDevice('work-alexios') }, server, providerFor('gitlab'), { client: server.oauth!, signal: new AbortController().signal, onCode: () => undefined });
    expect(grant.tokens.accessExpiresAt).toBe(at + 7200 * 1000);
  });

  it.each([
    ['gitlab.com', 404, undefined],
    ['gitlab.com', 400, { error: 'unsupported_grant_type' }],
    ['github.com', 200, { error: 'device_flow_disabled' }],
  ] as const)('says %s does not offer device code sign-in on a %i answer without a client refusal', async (id, status, body) => {
    const server = registry.get(id)!;
    const answering = { ...http(), request: async () => ({ status, headers: new Headers(), body, notModified: false }) };
    await expect(runDeviceFlow({ http: answering, log: () => undefined }, server, providerFor(server.kind), { client: server.oauth!, signal: new AbortController().signal, onCode: () => undefined }))
      .rejects.toMatchObject({ kind: 'provider', text: { message: 'This server does not offer device code sign-in. Use the browser or a token.' } });
  });

  it.each(['github.com', 'gitlab.com'] as const)('says %s refused the client id when the device code request names a wrong one', async (id) => {
    const server = registry.get(id)!;
    await expect(runDeviceFlow({ http: http(), log: () => undefined }, server, providerFor(server.kind), { client: { clientId: 'not-the-app' }, signal: new AbortController().signal, onCode: () => undefined }))
      .rejects.toMatchObject({ kind: 'provider', text: { message: "The server refused the OAuth app's client id. Check the client id, or sign in with a token." } });
  });

  it('refuses a server without a device flow, and a sign-in page off the server\'s own origins', async () => {
    const server = registry.get('github.com')!;
    const none: ForgeProvider = { ...providerFor('github'), startDevice: async () => undefined };
    await expect(runDeviceFlow({ http: http(), log: () => undefined }, server, none, { client: server.oauth!, signal: new AbortController().signal, onCode: () => undefined }))
      .rejects.toMatchObject({ text: { message: 'This server does not offer device code sign-in. Use the browser or a token.' } });
    const foreign: ForgeProvider = { ...providerFor('github'), startDevice: async () => ({ deviceCode: 'dc', userCode: 'X', verificationUri: 'https://evil.example/device', expiresIn: 900, interval: 5 }) };
    const onCode = vi.fn();
    await expect(runDeviceFlow({ http: http(), log: () => undefined }, server, foreign, { client: server.oauth!, signal: new AbortController().signal, onCode }))
      .rejects.toMatchObject({ kind: 'provider' });
    expect(onCode).not.toHaveBeenCalled();
  });
});
