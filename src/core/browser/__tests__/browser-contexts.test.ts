import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { fakeHome: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-browser-contexts-')) };
});

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), homedir: () => fakeHome }));
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), homedir: () => fakeHome }));
// no Chromium starts: each launch records its options and stops there
vi.mock('../launcher', () => ({ launchBrowserContext: vi.fn(async () => { throw new Error('no browser in this test'); }) }));

import { mkdirSync, promises as fsp, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserService, BrowserServices } from '../index';
import { launchBrowserContext, type LaunchBrowserOptions } from '../launcher';
import { REMOTE_CONTEXT_CHROME_ARGS, type ClientNetworkProxy } from '../client-network-proxy';
import type { ClientNetworkPolicy } from '../client-network-policy';
import { installFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { LocalizedError } from '../../../shared/localized-text';

let platform: FakePlatform;

beforeEach(() => {
  vi.mocked(launchBrowserContext).mockClear();
  platform = installFakePlatform({ chatBrowserPane: true, settings: { user: { 'damocles.browser.enabled': true } } });
});

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

function proxies() {
  const started: Array<{ readonly policy: ClientNetworkPolicy; readonly updates: ClientNetworkPolicy[]; closed: boolean }> = [];
  const start = vi.fn(async (policy: ClientNetworkPolicy): Promise<ClientNetworkProxy> => {
    const entry = { policy, updates: [] as ClientNetworkPolicy[], closed: false };
    started.push(entry);
    return { url: `http://127.0.0.1:${40000 + started.length}`, update: (next) => entry.updates.push(next), close: async () => { entry.closed = true; } };
  });
  return { started, start };
}

function opening(service: BrowserService): Promise<void> {
  return service.openNewPageForChat(platform.window.createPanel({ kind: 'chat', title: 'chat', localResourceRoots: [] }));
}

// a launch of the service's context, which the mocked launcher refuses after recording what it was given
async function launch(service: BrowserService): Promise<LaunchBrowserOptions> {
  await expect(opening(service)).rejects.toThrow();
  return vi.mocked(launchBrowserContext).mock.calls.at(-1)![0];
}

describe('one browser context and profile per authority', () => {
  it('gives local chats the local service and each remote authority a service of its own', () => {
    const local = new BrowserService(platform);
    const services = new BrowserServices(platform, local, proxies().start);
    expect(services.forAuthority('local')).toBe(local);
    const first = services.forAuthority('ssh+host-a');
    expect(first).not.toBe(local);
    expect(services.forAuthority('ssh+host-a')).toBe(first);
    expect(services.forAuthority('ssh+host-b')).not.toBe(first);
    expect(() => services.forAuthority('../escape')).toThrow('is not an authority');
  });

  it('refuses an authority ending in a dot, which Windows would give the profile folder of the one without it', () => {
    const services = new BrowserServices(platform, new BrowserService(platform), proxies().start);
    expect(() => services.forAuthority('wsl+foo.')).toThrow('is not an authority');
    expect(() => services.forAuthority('ssh+.')).toThrow('is not an authority');
    expect(() => services.forAuthority('wsl+Ubuntu-24.04')).not.toThrow();
  });

  it('launches local chats in ~/.damocles/browser-profile with no proxy, and each host in its own profile behind its proxy', async () => {
    const { started, start } = proxies();
    const local = new BrowserService(platform);
    const services = new BrowserServices(platform, local, start);
    services.setClientNetwork('ssh+host-a', { allowedPorts: [5174], allowLocalNetwork: false });

    const localLaunch = await launch(local);
    expect(localLaunch.userDataDir).toBe(join(fakeHome, '.damocles', 'browser-profile'));
    expect(localLaunch.network).toBeUndefined();

    const remoteLaunch = await launch(services.forAuthority('ssh+host-a'));
    expect(remoteLaunch.userDataDir).toBe(join(fakeHome, '.damocles', 'browser-profiles', 'ssh+host-a'));
    expect(remoteLaunch.network).toEqual({ server: 'http://127.0.0.1:40001', args: REMOTE_CONTEXT_CHROME_ARGS });
    expect(started[0]?.policy).toEqual({ allowedPorts: [5174], allowLocalNetwork: false });

    const otherLaunch = await launch(services.forAuthority('ssh+host-b'));
    expect(otherLaunch.userDataDir).toBe(join(fakeHome, '.damocles', 'browser-profiles', 'ssh+host-b'));
    expect(otherLaunch.network?.server).toBe('http://127.0.0.1:40002');
    expect(started[1]?.policy).toEqual({ allowedPorts: [], allowLocalNetwork: false });
  });

  it('starts one proxy per authority across launches, keeps it current, and closes it with the authority', async () => {
    const { started, start } = proxies();
    const services = new BrowserServices(platform, new BrowserService(platform), start);
    await launch(services.forAuthority('ssh+host-a'));
    await launch(services.forAuthority('ssh+host-a'));
    expect(start).toHaveBeenCalledTimes(1);
    services.setClientNetwork('ssh+host-a', { allowedPorts: [5174, 9100], allowLocalNetwork: true });
    await vi.waitFor(() => expect(started[0]?.updates).toEqual([{ allowedPorts: [5174, 9100], allowLocalNetwork: true }]));
    const before = services.forAuthority('ssh+host-a');
    await services.release('ssh+host-a');
    expect(started[0]?.closed).toBe(true);
    expect(services.forAuthority('ssh+host-a')).not.toBe(before);
  });
});

describe('releasing an authority while its browser starts', () => {
  it('closes a context that arrives after the release, and uses it for nothing else, before the release settles', async () => {
    const { start } = proxies();
    const services = new BrowserServices(platform, new BrowserService(platform), start);
    let arrive!: (context: unknown) => void;
    vi.mocked(launchBrowserContext).mockReturnValueOnce(new Promise((resolve) => (arrive = resolve as (context: unknown) => void)) as never);
    const opened = opening(services.forAuthority('ssh+host-a'));
    await vi.waitFor(() => expect(launchBrowserContext).toHaveBeenCalledTimes(1));
    let released = false;
    const release = services.release('ssh+host-a').then(() => (released = true));
    await new Promise((settle) => setTimeout(settle, 0));
    expect(released).toBe(false);
    const close = vi.fn(async () => {});
    const used: string[] = [];
    arrive(new Proxy({}, {
      get: (_target, name) => {
        if (name === 'close') return close;
        if (name === 'then') return undefined;
        return () => {
          used.push(String(name));
          throw new Error(`${String(name)} on a context its release closed`);
        };
      },
    }));
    await release;
    expect(close).toHaveBeenCalledTimes(1);
    expect(used).toEqual([]);
    await expect(opened).rejects.toThrow();
  });

  it('starts no proxy for a launch the release overtook while its profile folder was being made', async () => {
    const { start } = proxies();
    const services = new BrowserServices(platform, new BrowserService(platform), start);
    let entered!: () => void;
    const making = new Promise<void>((resolve) => (entered = resolve));
    let proceed!: () => void;
    const held = new Promise<void>((resolve) => (proceed = resolve));
    const mkdir = fsp.mkdir.bind(fsp);
    const spy = vi.spyOn(fsp, 'mkdir').mockImplementationOnce(async (...args: Parameters<typeof fsp.mkdir>) => {
      entered();
      await held;
      return mkdir(...args);
    });
    try {
      const opened = opening(services.forAuthority('ssh+host-a'));
      await making;
      const release = services.release('ssh+host-a');
      proceed();
      await release;
      await expect(opened).rejects.toThrow();
      expect(start).not.toHaveBeenCalled();
      expect(launchBrowserContext).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the newer proxy when the one a released launch started fails afterwards', async () => {
    const updates: ClientNetworkPolicy[] = [];
    let fail!: (err: Error) => void;
    const start = vi.fn()
      .mockReturnValueOnce(new Promise<ClientNetworkProxy>((_resolve, reject) => (fail = reject)))
      .mockResolvedValueOnce({ url: 'http://127.0.0.1:40002', update: (next: ClientNetworkPolicy) => updates.push(next), close: async () => {} });
    const services = new BrowserServices(platform, new BrowserService(platform), start);
    const first = opening(services.forAuthority('ssh+host-a'));
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const release = services.release('ssh+host-a');
    await launch(services.forAuthority('ssh+host-a'));
    expect(start).toHaveBeenCalledTimes(2);
    fail(new Error('listen failed'));
    await expect(first).rejects.toThrow();
    await release;
    services.setClientNetwork('ssh+host-a', { allowedPorts: [5174], allowLocalNetwork: false });
    await vi.waitFor(() => expect(updates).toEqual([{ allowedPorts: [5174], allowLocalNetwork: false }]));
  });
});

describe('a remote context\'s launch errors', () => {
  it('reach the target without this computer\'s paths: a profile folder that cannot be made', async () => {
    const profiles = join(fakeHome, '.damocles', 'browser-profiles');
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, 'ssh+blocked'), 'a file where the profile folder goes');
    const services = new BrowserServices(platform, new BrowserService(platform), proxies().start);
    const failure = await opening(services.forAuthority('ssh+blocked')).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(LocalizedError);
    expect((failure as LocalizedError).text).toEqual({ message: "The browser could not start on the computer that shows this chat. Damocles' log there has the details." });
    expect(String((failure as Error).message)).not.toContain(fakeHome);
    expect(launchBrowserContext).not.toHaveBeenCalled();
  });

  it('reach the target without this computer\'s paths: a launch that fails naming one', async () => {
    vi.mocked(launchBrowserContext).mockRejectedValueOnce(new Error(`EACCES: permission denied, open '${join(fakeHome, '.damocles', 'browser-profiles', 'ssh+host-a', 'SingletonLock')}'`));
    const services = new BrowserServices(platform, new BrowserService(platform), proxies().start);
    const failure = await opening(services.forAuthority('ssh+host-a')).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(LocalizedError);
    expect(String((failure as Error).message)).not.toContain(fakeHome);
  });

  it('stay as they are for a local context', async () => {
    await expect(opening(new BrowserService(platform))).rejects.toThrow('no browser in this test');
  });
});
