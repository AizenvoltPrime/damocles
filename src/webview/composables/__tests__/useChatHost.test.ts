// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

type HostListener = (host: { hostId: string; name: string }) => void;

afterEach(() => {
  delete window.damoclesBridge;
  vi.resetModules();
});

function bridge(initial: { hostId: string; name: string } | undefined) {
  let listener: HostListener | undefined;
  window.damoclesBridge = {
    postMessage: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    getState: vi.fn(),
    setState: vi.fn(),
    getHost: vi.fn(() => initial),
    onHost: vi.fn((next: HostListener) => {
      listener = next;
      return () => {};
    }),
  };
  return { answer: (host: { hostId: string; name: string }) => listener?.(host) };
}

describe('useChatHost', () => {
  it('learns a remote chat\'s host when main answers the page\'s init after the first read', async () => {
    const page = bridge(undefined);
    const { useChatHost } = await import('../useChatHost');
    const host = useChatHost();
    expect(host.value).toBeUndefined();
    page.answer({ hostId: 'h1', name: 'prod-1' });
    expect(host.value).toEqual({ name: 'prod-1' });
  });

  it('reads the host main already answered', async () => {
    bridge({ hostId: 'h1', name: 'prod-1' });
    const { useChatHost } = await import('../useChatHost');
    expect(useChatHost().value).toEqual({ name: 'prod-1' });
  });
});
