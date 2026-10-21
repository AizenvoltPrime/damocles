import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
// Must equal sessionMetaIndexWorkerOptions.entryPoints in esbuild.config.mjs.
const ENTRY = 'src/core/pi-session/session-store/meta-index/worker.ts';

// A worker thread never has the host's platform installed, so platform() throws there (src/core/platform-host.ts).
it('the session meta index worker bundle does not include src/core/platform-host.ts', async () => {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, ENTRY)],
    absWorkingDir: ROOT,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    metafile: true,
    packages: 'external',
    logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs).map((file) => file.replaceAll('\\', '/'));
  expect(inputs).toContain(ENTRY);
  expect(inputs).not.toContain('src/core/platform-host.ts');
}, 60_000);
