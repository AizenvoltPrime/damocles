import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import { openPortProbe, withoutProbe } from '../port-probe';

describe('the daemon\'s WSL port probe', () => {
  it('answers its nonce to every connection on a loopback port, and closes', async () => {
    const probe = openPortProbe(() => undefined);
    const { port, nonce } = await probe.answer;
    expect(probe.port()).toBe(port);
    const read = (): Promise<string> => new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      let text = '';
      socket.on('data', (chunk) => { text += String(chunk); });
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
    expect(await read()).toBe(`${nonce}\n`);
    expect(await read()).toBe(`${nonce}\n`);
    await probe.close();
    await expect(read()).rejects.toThrow('ECONNREFUSED');
  });

  it('keeps its own listener out of the user\'s ports, and no other socket on that port', () => {
    const candidates = [
      { port: 41000, bindAddress: '127.0.0.1', family: 4 as const, host: '127.0.0.1', pid: 7 },
      { port: 41000, bindAddress: '::1', family: 6 as const, host: '::1', pid: 99 },
      { port: 5173, bindAddress: '127.0.0.1', family: 4 as const, host: '127.0.0.1', pid: 7 },
    ];
    expect(withoutProbe(candidates, 41000, 7).map((candidate) => `${candidate.port}/${candidate.pid}`)).toEqual(['41000/99', '5173/7']);
    expect(withoutProbe(candidates, undefined, 7)).toHaveLength(3);
  });
});
