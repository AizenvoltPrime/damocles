import { describe, expect, it } from 'vitest';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import { allowYoloAsker, type AllowHostYoloDeps } from '../allow-host-yolo';

const ANCHOR = { x: 10, y: 20, width: 30, height: 40 };

interface Host {
  readonly hostId: string;
  readonly name: string;
  readonly color?: 'danger';
  allowBypass: boolean;
}

function harness(hosts: Record<string, Host>) {
  const asked: Array<{ request: Extract<OverlayRequest, { kind: 'allowYolo' }>; signal: AbortSignal | undefined; answer: (answer: OverlayAnswer) => void; fail: (err: Error) => void }> = [];
  const written: string[] = [];
  const failures: Array<{ hostName: string; message: string }> = [];
  const deps: AllowHostYoloDeps = {
    savedHost: (authority) => hosts[authority],
    request: (request, signal) => new Promise<OverlayAnswer>((resolve, reject) => {
      const entry = { request, signal, answer: resolve, fail: reject };
      asked.push(entry);
      signal?.addEventListener('abort', () => resolve({ kind: 'dismissed' }), { once: true });
    }),
    allow: async (hostId) => {
      const host = Object.values(hosts).find((candidate) => candidate.hostId === hostId);
      if (!host) throw new Error(`No host ${hostId}`);
      host.allowBypass = true;
      written.push(hostId);
    },
    failed: (hostName, err) => failures.push({ hostName, message: err instanceof Error ? err.message : String(err) }),
  };
  return { ask: allowYoloAsker(deps), asked, written, failures };
}

describe('allowYoloAsker', () => {
  it('never asks about an authority without a saved host, and answers false', async () => {
    const h = harness({});
    await expect(h.ask('loopback', ANCHOR)).resolves.toBe(false);
    expect(h.asked).toEqual([]);
  });

  it('answers true at once for a host that already allows YOLO', async () => {
    const h = harness({ 'ssh+h1': { hostId: 'h1', name: 'prod', allowBypass: true } });
    await expect(h.ask('ssh+h1', ANCHOR)).resolves.toBe(true);
    expect(h.asked).toEqual([]);
  });

  it("names the host and its color, and writes the resolved host's switch only on an accept", async () => {
    const h = harness({ 'ssh+h1': { hostId: 'h1', name: 'prod', color: 'danger', allowBypass: false } });
    const asking = h.ask('ssh+h1', ANCHOR);
    await Promise.resolve();
    expect(h.asked.map((entry) => entry.request)).toEqual([{ kind: 'allowYolo', hostName: 'prod', hostColor: 'danger', anchor: ANCHOR }]);
    h.asked[0]!.answer({ kind: 'allowYolo', allow: true });
    await expect(asking).resolves.toBe(true);
    expect(h.written).toEqual(['h1']);
  });

  it('writes nothing when the question is refused or dismissed', async () => {
    const h = harness({ 'ssh+h1': { hostId: 'h1', name: 'prod', allowBypass: false } });
    const refused = h.ask('ssh+h1', ANCHOR);
    await Promise.resolve();
    h.asked[0]!.answer({ kind: 'allowYolo', allow: false });
    await expect(refused).resolves.toBe(false);
    const dismissed = h.ask('ssh+h1', ANCHOR);
    await Promise.resolve();
    h.asked[1]!.answer({ kind: 'dismissed' });
    await expect(dismissed).resolves.toBe(false);
    expect(h.written).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  it('writes nothing for a host forgotten before the accept, and rejects after reporting it', async () => {
    const hosts: Record<string, Host> = { 'ssh+h1': { hostId: 'h1', name: 'prod', allowBypass: false } };
    const h = harness(hosts);
    const asking = h.ask('ssh+h1', ANCHOR);
    await Promise.resolve();
    delete hosts['ssh+h1'];
    h.asked[0]!.answer({ kind: 'allowYolo', allow: true });
    await expect(asking).rejects.toThrow('No host h1');
    expect(h.written).toEqual([]);
    expect(h.failures).toEqual([{ hostName: 'prod', message: 'No host h1' }]);
  });

  it('reports an overlay that could not ask, and rejects', async () => {
    const h = harness({ 'ssh+h1': { hostId: 'h1', name: 'prod', allowBypass: false } });
    const asking = h.ask('ssh+h1', ANCHOR);
    await Promise.resolve();
    h.asked[0]!.fail(new Error('The overlay reloaded'));
    await expect(asking).rejects.toThrow('The overlay reloaded');
    expect(h.failures).toEqual([{ hostName: 'prod', message: 'The overlay reloaded' }]);
  });

  it('joins asks for a host already being asked, and asks again once that question is answered', async () => {
    const h = harness({ 'ssh+h1': { hostId: 'h1', name: 'prod', allowBypass: false }, 'wsl+Ubuntu': { hostId: 'h1', name: 'prod', allowBypass: false } });
    const first = h.ask('ssh+h1', ANCHOR);
    const second = h.ask('wsl+Ubuntu', ANCHOR);
    await Promise.resolve();
    expect(h.asked).toHaveLength(1);
    h.asked[0]!.answer({ kind: 'allowYolo', allow: false });
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    const third = h.ask('ssh+h1', ANCHOR);
    await Promise.resolve();
    expect(h.asked).toHaveLength(2);
    h.asked[1]!.answer({ kind: 'allowYolo', allow: true });
    await expect(third).resolves.toBe(true);
  });

  it('withdraws the question when the asker aborts, which answers every joined ask false', async () => {
    const h = harness({ 'ssh+h1': { hostId: 'h1', name: 'prod', allowBypass: false } });
    const closed = new AbortController();
    const page = h.ask('ssh+h1', ANCHOR, closed.signal);
    const settings = h.ask('ssh+h1', ANCHOR);
    await Promise.resolve();
    expect(h.asked[0]!.signal).toBe(closed.signal);
    closed.abort();
    await expect(page).resolves.toBe(false);
    await expect(settings).resolves.toBe(false);
    expect(h.written).toEqual([]);
  });
});
