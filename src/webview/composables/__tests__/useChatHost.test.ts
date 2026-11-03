// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeHost, BridgeHostName } from '@shared/damocles-bridge';

type Label = { hostId: string; name: string; computer: string; color?: unknown; canAllowYolo?: true };
type HostListener = (host: Label) => void;

afterEach(() => {
  delete window.damoclesBridge;
  vi.resetModules();
});

function bridge(initial: Label | undefined, hostNames?: Record<string, { name: string; color?: unknown }>) {
  let listener: HostListener | undefined;
  window.damoclesBridge = {
    postMessage: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    getState: vi.fn(),
    setState: vi.fn(),
    // what main sends, malformed colors included
    getHost: vi.fn(() => initial as BridgeHost | undefined),
    onHost: vi.fn((next: HostListener) => {
      listener = next;
      return () => {};
    }),
    getHostNames: () => hostNames as Readonly<Record<string, BridgeHostName>> | undefined,
    onHostNames: () => () => undefined,
    getOffline: vi.fn(),
    hostAction: vi.fn(),
    getConnection: vi.fn(),
    onConnection: vi.fn(() => () => {}),
    allowYolo: vi.fn(async () => false),
    queueAction: vi.fn(),
  };
  return { answer: (host: Label) => listener?.(host) };
}

describe('useHostNames', () => {
  it('keeps each host\'s tone or #rrggbbaa color and drops a malformed one', async () => {
    bridge(undefined, {
      h1: { name: 'prod-1', color: '#00809a99' },
      h2: { name: 'lab', color: 'danger' },
      h3: { name: 'dev', color: '#00809a99 ' },
      h4: { name: 'old', color: '#00809a' },
      h5: { name: 'clear', color: '#00809a00' },
    });
    const { useHostNames } = await import('../useHostNames');
    expect([...useHostNames().value!.entries()]).toEqual([
      ['h1', { name: 'prod-1', color: '#00809a99' }],
      ['h2', { name: 'lab', color: 'danger' }],
      ['h3', { name: 'dev' }],
      ['h4', { name: 'old' }],
      ['h5', { name: 'clear' }],
    ]);
  });
});

describe('useChatHost', () => {
  it('learns a remote chat\'s host when main answers the page\'s init after the first read', async () => {
    const page = bridge(undefined);
    const { useChatHost } = await import('../useChatHost');
    const host = useChatHost();
    expect(host.value).toBeUndefined();
    page.answer({ hostId: 'h1', name: 'prod-1', computer: 'ALEXIOS-PC' });
    expect(host.value).toEqual({ name: 'prod-1', computer: 'ALEXIOS-PC' });
  });

  it('reads the host main already answered', async () => {
    bridge({ hostId: 'h1', name: 'prod-1', computer: 'ALEXIOS-PC' });
    const { useChatHost } = await import('../useChatHost');
    expect(useChatHost().value).toEqual({ name: 'prod-1', computer: 'ALEXIOS-PC' });
  });

  // a color reaches inline style, so the page keeps only a tone or an exact #rrggbbaa above zero opacity
  it('keeps a #rrggbbaa color and drops a malformed one', async () => {
    const page = bridge({ hostId: 'h1', name: 'prod-1', computer: 'ALEXIOS-PC', color: '#00809a99' });
    const { useChatHost } = await import('../useChatHost');
    const host = useChatHost();
    expect(host.value).toEqual({ name: 'prod-1', computer: 'ALEXIOS-PC', color: '#00809a99' });
    for (const color of ['#00809A99', '#00809a', '#00809a00', '#00809a99;background:url(x)', 'teal']) {
      page.answer({ hostId: 'h1', name: 'prod-1', computer: 'ALEXIOS-PC', color });
      expect(host.value).toEqual({ name: 'prod-1', computer: 'ALEXIOS-PC' });
    }
  });

  it('says whether main may ask to allow YOLO on the host', async () => {
    bridge({ hostId: 'h1', name: 'prod-1', computer: 'ALEXIOS-PC', canAllowYolo: true });
    const { useChatHost } = await import('../useChatHost');
    expect(useChatHost().value).toEqual({ name: 'prod-1', computer: 'ALEXIOS-PC', canAllowYolo: true });
  });
});
