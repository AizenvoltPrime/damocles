import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { installPlatform } from '../../platform-host';
import { PiRuntime } from '../pi-runtime';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await PiRuntime.disposeInstance();
  installPlatform(createFakePlatform());
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('an acting client change on a daemon\'s core', () => {
  it('republishes once, after the latest change\'s refresh, never from a refresh a newer change overtook', async () => {
    const host = createFakeRemoteHost();
    host.set('clientAuth', 'client-b', { providers: {} });
    installPlatform({ ...createFakePlatform(), remote: host.remote });
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-acting-')));
    dirs.push(dir);
    const runtime = PiRuntime.get(dir);
    await runtime.init();
    const refreshes: Array<() => void> = [];
    vi.spyOn(runtime.modelRuntime!, 'refresh').mockImplementation(() => new Promise((resolve) => refreshes.push(() => resolve({ errors: new Map() } as never))));
    const republished = vi.fn();
    const stop = PiRuntime.onActingClientRefreshed(republished);
    try {
      host.setActing('client-b');
      host.setActing('client-a');
      expect(refreshes).toHaveLength(2);
      refreshes[1]!();
      await vi.waitFor(() => expect(republished).toHaveBeenCalledTimes(1));
      refreshes[0]!();
      await new Promise((resolve) => setImmediate(resolve));
      expect(republished).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  }, 60_000);
});
