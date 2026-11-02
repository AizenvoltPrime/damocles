import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSh, scratchDir, shellPath, stageMessages, withPosixDefinitions } from './shells';

// stage 1's copy from the app's cache on WSL, with wslpath replaced by a function that answers as the test says
function copy(dir: string, wslpath: string, answer: string): ReturnType<typeof runSh> {
  const body = `D_WSL_CACHE='C:\\cache'; package_file=pkg.tar.gz
wslpath() { ${wslpath}; }
fetch_package '${shellPath(path.join(dir, 'staged.tar.gz'))}' && echo copied`;
  return runSh(withPosixDefinitions(body), answer);
}

describe('stage 1 copying the package from the app\'s cache in a real sh', { timeout: 120_000 }, () => {
  it('asks the app to fill its cache, then copies the package from the cache folder\'s wslpath', async () => {
    const dir = scratchDir('wsl-cache-');
    writeFileSync(path.join(dir, 'pkg.tar.gz'), 'package bytes');
    // the folder as sh names it absolutely (Git for Windows' sh writes /c/... for C:\)
    const output = await copy(dir, `[ "$1" = -u ] && [ "$2" = 'C:\\cache' ] && (cd '${shellPath(dir)}' && pwd)`, 'ready\n');
    expect(stageMessages(output)).toEqual([{ kind: 'cache' }]);
    expect(output.stdout.toString('utf8')).toMatch(/copied\n$/);
    expect(readFileSync(path.join(dir, 'staged.tar.gz'), 'utf8')).toBe('package bytes');
  });

  it('copies nothing when the app answers that its cache lacks the package', async () => {
    const dir = scratchDir('wsl-cache-');
    const output = await copy(dir, `printf '%s\\n' '${shellPath(dir)}'`, 'none\n');
    expect(stageMessages(output)).toEqual([{ kind: 'cache' }]);
    expect(output.stdout.toString('utf8')).not.toContain('copied');
    expect(existsSync(path.join(dir, 'staged.tar.gz'))).toBe(false);
  });

  it('takes wslpath\'s answer only as one absolute line, and reports where the copy failed', async () => {
    const dir = scratchDir('wsl-cache-');
    writeFileSync(path.join(dir, 'pkg.tar.gz'), 'package bytes');
    for (const answer of [`printf 'relative/cache\\n'`, `printf '/one\\n/two\\n'`, 'return 1']) {
      const output = await copy(dir, answer, 'ready\n');
      expect(stageMessages(output), answer).toEqual([{ kind: 'cache' }, { kind: 'copyFailed', reason: 'wslpath' }]);
      expect(output.stdout.toString('utf8')).not.toContain('copied');
    }
    const missing = await copy(dir, `printf '%s/nowhere\\n' "$(cd '${shellPath(dir)}' && pwd)"`, 'ready\n');
    expect(stageMessages(missing)).toEqual([{ kind: 'cache' }, { kind: 'copyFailed', reason: 'copy' }]);
  });
});
