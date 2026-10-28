import type { ElectronApplication, Page } from '@playwright/test';
import { startFlakyProxy, type FlakyProxy } from './flaky-proxy';
import { disposeEach, expect, test as remoteTest } from './remote';
import type { SshdFixture, SshdOptions } from './sshd';

export { expect };

export interface ProxiedHost {
  readonly fixture: SshdFixture;
  readonly proxy: FlakyProxy;
}

export interface FlakyFixtures {
  /** A fixture reached as `alias` only through a flaky proxy (its ProxyCommand); every proxy is closed after the test. */
  proxied: (alias: string, options?: SshdOptions) => Promise<ProxiedHost>;
}

export const test = remoteTest.extend<FlakyFixtures>({
  proxied: async ({ sshd, ssh }, use) => {
    const proxies: FlakyProxy[] = [];
    await use(async (alias, options = {}) => {
      // the container's own block names its port, which the proxy relays to; the app knows the host by alias alone
      const fixture = await sshd(`${alias}-direct`, options);
      const proxy = await startFlakyProxy(fixture.port);
      proxies.push(proxy);
      ssh.addHost(alias, fixture, [`ProxyCommand ${proxy.proxyCommand}`]);
      return { fixture, proxy };
    });
    await disposeEach(proxies, (proxy) => proxy.close());
  },
});

/** The scenario's own clock: a network that stays down this long is what the test is about, not a wait for state. */
export const holdFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A connection-state sighting in a page: what showed, and when by the page's clock (Date.now). */
export interface Sighting {
  readonly what: string;
  readonly at: number;
}

/**
 * Records, from now on, every time a page shows a connection banner (its data-state) or a host status dot in any shape but
 * connected or slow, by a MutationObserver on the page, so a state that showed for one frame is still seen.
 */
export async function watchConnectionUi(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as { __e2eSightings?: Array<{ what: string; at: number }> };
    if (g.__e2eSightings) return;
    const seen: Array<{ what: string; at: number }> = [];
    g.__e2eSightings = seen;
    const look = (): void => {
      for (const banner of document.querySelectorAll('[data-testid="connection-banner"], [data-testid="connection-banner-edge"], [data-testid="chat-connection-banner"]')) {
        seen.push({ what: `banner:${banner.getAttribute('data-state') ?? ''}`, at: Date.now() });
      }
      for (const dot of document.querySelectorAll('[data-testid="host-status-dot"]')) {
        const shape = dot.getAttribute('data-shape') ?? '';
        if (shape !== 'connected' && shape !== 'slow') seen.push({ what: `dot:${shape}`, at: Date.now() });
      }
    };
    look();
    new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'data-shape'] });
  });
}

/** What watchConnectionUi saw, in order, with repeats of one state collapsed. */
export async function sightings(page: Page): Promise<Sighting[]> {
  const all = await page.evaluate(() => (globalThis as unknown as { __e2eSightings?: Array<{ what: string; at: number }> }).__e2eSightings ?? []);
  return all.filter((entry, index) => index === 0 || all[index - 1]!.what !== entry.what);
}

/** The page's clock now, the base of its sightings. */
export const pageNow = (page: Page): Promise<number> => page.evaluate(() => Date.now());

interface ReconnectHooks {
  __damoclesE2e: { remote: { reconnectPhase(authorityKey: string): { phase: string } | undefined } };
}

/** The reconnect loop's phase for an authority; undefined while connected (protocol's C1). */
export const reconnectPhase = (app: ElectronApplication, authorityKey: string): Promise<string | undefined> =>
  app.evaluate((_electron, key) => (globalThis as unknown as ReconnectHooks).__damoclesE2e.remote.reconnectPhase(key)?.phase, authorityKey);
