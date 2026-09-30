import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelPendingCallback,
  ensureCallbackServer,
  getOAuthCallbackPath,
  getOAuthCallbackPort,
  isCallbackServerRunning,
  releaseCallbackServer,
  stopCallbackServer,
  waitForCallback,
} from '../mcp-callback-server';

/** Whether this process can bind `port` on loopback, i.e. nothing listens there any more. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** Holds `port` on loopback, as another Damocles window mid-login would. */
function occupy(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const holder = net.createServer();
    holder.once('error', reject);
    holder.listen(0, '127.0.0.1', () => {
      const address = holder.address() as net.AddressInfo;
      resolve({ port: address.port, close: () => new Promise((done) => holder.close(() => done())) });
    });
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await stopCallbackServer();
});

describe('MCP OAuth callback server lifetime', () => {
  it('stays up while any flow is pending or reserved, and stops listening when the last one settles', async () => {
    await ensureCallbackServer({ oauthState: 'first', reserveState: true });
    const code = waitForCallback('first');
    await ensureCallbackServer({ oauthState: 'second', reserveState: true });
    const port = getOAuthCallbackPort();

    const ok = await fetch(`http://127.0.0.1:${port}/callback?code=c1&state=first`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toMatch(/no-store/);
    expect(await code).toBe('c1');
    expect(isCallbackServerRunning()).toBe(true);

    releaseCallbackServer('second');
    expect(isCallbackServerRunning()).toBe(false);
    expect(await portIsFree(port)).toBe(true);
    // The settled flow's token exchange still names the redirect URI it was authorized with.
    expect(getOAuthCallbackPort()).toBe(port);
    expect(getOAuthCallbackPath()).toBe('/callback');
  });

  it('closes after an error redirect, a cancel, and the callback timeout', async () => {
    await ensureCallbackServer({ oauthState: 'denied', reserveState: true });
    const denied = waitForCallback('denied');
    const deniedRejection = expect(denied).rejects.toThrow(/access_denied/);
    const port = getOAuthCallbackPort();
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=denied`);
    await deniedRejection;
    expect(isCallbackServerRunning()).toBe(false);
    expect(await portIsFree(port)).toBe(true);

    await ensureCallbackServer({ oauthState: 'cancelled', reserveState: true });
    const cancelled = waitForCallback('cancelled');
    cancelPendingCallback('cancelled');
    await expect(cancelled).rejects.toThrow(/cancelled/);
    expect(isCallbackServerRunning()).toBe(false);

    await ensureCallbackServer({ oauthState: 'slow', reserveState: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const slow = waitForCallback('slow');
    const slowRejection = expect(slow).rejects.toThrow(/timeout/);
    vi.advanceTimersByTime(5 * 60 * 1000);
    await slowRejection;
    expect(isCallbackServerRunning()).toBe(false);
  });

  it('keeps the server when an unknown state is sent, since nothing settled', async () => {
    await ensureCallbackServer({ oauthState: 'kept', reserveState: true });
    const port = getOAuthCallbackPort();
    const forged = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=forged`);
    expect(forged.status).toBe(400);
    expect(isCallbackServerRunning()).toBe(true);
    releaseCallbackServer('kept');
    expect(isCallbackServerRunning()).toBe(false);
  });

  it('names another Damocles window mid-login when the strict port is taken, and holds nothing after', async () => {
    const other = await occupy();
    try {
      await expect(
        ensureCallbackServer({ strictPort: true, port: other.port, oauthState: 'strict', reserveState: true }),
      ).rejects.toThrow(/already in use, possibly by another Damocles window completing a login for this server.*MCP_OAUTH_CALLBACK_PORT/);
      expect(isCallbackServerRunning()).toBe(false);
    } finally {
      await other.close();
    }
    // The failed flow's reservation is gone, so a later flow's settle can close the server again.
    await ensureCallbackServer({ oauthState: 'later', reserveState: true });
    releaseCallbackServer('later');
    expect(isCallbackServerRunning()).toBe(false);
  });
});

describe('MCP OAuth callback port of non-strict flows', () => {
  const redirectUri = (): string => `http://127.0.0.1:${getOAuthCallbackPort()}${getOAuthCallbackPath()}`;

  function hold(port: number): Promise<() => Promise<void>> {
    return new Promise((resolve, reject) => {
      const holder = net.createServer();
      holder.once('error', reject);
      holder.listen(port, '127.0.0.1', () => resolve(() => new Promise((done) => holder.close(() => done()))));
    });
  }

  it('keeps one redirect URI across flows in the process, so a registered client stays valid', async () => {
    await ensureCallbackServer({ oauthState: 'first', reserveState: true });
    const first = redirectUri();
    releaseCallbackServer('first');
    expect(isCallbackServerRunning()).toBe(false);

    await ensureCallbackServer({ oauthState: 'second', reserveState: true });
    expect(redirectUri()).toBe(first);
    releaseCallbackServer('second');

    await stopCallbackServer();
    await ensureCallbackServer({ oauthState: 'third', reserveState: true });
    expect(redirectUri()).toBe(first);
    releaseCallbackServer('third');
  });

  it('binds another port when the previous one is taken', async () => {
    await ensureCallbackServer({ oauthState: 'first', reserveState: true });
    const previous = getOAuthCallbackPort();
    releaseCallbackServer('first');
    const release = await hold(previous);
    try {
      await ensureCallbackServer({ oauthState: 'second', reserveState: true });
      expect(isCallbackServerRunning()).toBe(true);
      expect(getOAuthCallbackPort()).not.toBe(previous);
      releaseCallbackServer('second');
    } finally {
      await release();
    }
  });
});
