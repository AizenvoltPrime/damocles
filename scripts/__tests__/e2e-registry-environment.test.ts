import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../e2e/desktop/support/hermetic';
import { loadRegistryTerminalEnvironment } from '../../e2e/desktop/support/registry-environment';

describe.runIf(process.platform === 'win32')("the e2e global setup's registry environment", () => {
  it('loads koffi from its CommonJS bundle and reads the machine and user variables over the env', async () => {
    const outfile = join(REPO_ROOT, 'dist', 'e2e', `registry-environment-${randomBytes(8).toString('hex')}.cjs`);
    try {
      const read = await loadRegistryTerminalEnvironment(outfile);
      // OS is a machine variable every Windows sets
      expect(read({ DAMOCLES_INHERITED: 'kept' })).toMatchObject({ OS: 'Windows_NT', DAMOCLES_INHERITED: 'kept' });
    } finally {
      rmSync(outfile, { force: true });
    }
  }, 60_000);
});
