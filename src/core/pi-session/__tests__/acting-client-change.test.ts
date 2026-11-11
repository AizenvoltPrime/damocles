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
  it('republishes at once for each change and refreshes nothing of pi\'s', async () => {
    const host = createFakeRemoteHost();
    host.set('clientAuth', 'client-b', { providers: {} });
    installPlatform({ ...createFakePlatform(), remote: host.remote });
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-acting-')));
    dirs.push(dir);
    const runtime = PiRuntime.get(dir);
    await runtime.init();
    const refresh = vi.spyOn(runtime.modelRuntime!, 'refresh');
    const republished = vi.fn();
    const stop = PiRuntime.onActingClientChanged(republished);
    try {
      host.setActing('client-b');
      expect(republished).toHaveBeenCalledTimes(1);
      host.setActing('client-a');
      expect(republished).toHaveBeenCalledTimes(2);
      await new Promise((resolve) => setImmediate(resolve));
      expect(republished).toHaveBeenCalledTimes(2);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  }, 60_000);
});
