import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPlatform } from '../../../core/platform-host';
import { withUrlWatch } from '../../../core/pi-session/tools/shell-url-watch';
import type { Platform } from '../../../platform/platform';
import type { ClientSnapshots } from '../../../platform/remote-host';
import { createCoreEndpoint, createLoopback, createMainEndpoint } from '../../core-protocol';
import type { CoreInit } from '../../core-protocol/messages';
import { createRemoteHost } from '../platform/clients';

const quiet = (): void => undefined;
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  installPlatform(undefined as unknown as Platform);
  vi.restoreAllMocks();
});

// a daemon's core with its remote host installed, and the URLs its daemon hears
function daemonCore(): { readonly seen: Array<{ readonly host: string; readonly port: number }> } {
  const loop = createLoopback();
  const daemon = createMainEndpoint(loop.main, quiet);
  const core = createCoreEndpoint(loop.core, quiet);
  const seen: Array<{ readonly host: string; readonly port: number }> = [];
  daemon.onEvent('ports.urlSeen', (hit) => seen.push(hit));
  const remote = createRemoteHost(core, { remote: { hostId: 'h' } } as unknown as CoreInit & { readonly remote: { readonly hostId: string } }, {} as ClientSnapshots, () => undefined);
  installPlatform({ remote } as unknown as Platform);
  return { seen };
}

describe('an agent shell\'s output on a daemon\'s core', () => {
  it('reports a printed URL to the daemon once, a last line without a newline included, and makes no timer', async () => {
    const { seen } = daemonCore();
    const shown: Buffer[] = [];
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const stdout = withUrlWatch((data) => shown.push(data));
    const stderr = withUrlWatch((data) => shown.push(data));
    // a URL split across chunks, inside a multi-byte character's split too
    stdout.onData(Buffer.from('➜ Local: http://local'));
    stdout.onData(Buffer.from('host:5173/\n'));
    const arrow = Buffer.from('➜');
    stderr.onData(arrow.subarray(0, 1));
    stderr.onData(Buffer.concat([arrow.subarray(1), Buffer.from(' ready on http://127.0.0.1:8000')]));
    stdout.end();
    stderr.end();
    expect(timeouts).not.toHaveBeenCalled();
    expect(intervals).not.toHaveBeenCalled();
    expect(Buffer.concat(shown).toString('utf8')).toBe('➜ Local: http://localhost:5173/\n➜ ready on http://127.0.0.1:8000');
    await flush();
    expect(seen).toEqual([{ host: 'localhost', port: 5173 }, { host: '127.0.0.1', port: 8000 }]);
  });
});
