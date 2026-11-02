import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findBash } from '../../src/core/system-tools';

// build/linux/after-remove.sh run by a POSIX sh (Git for Windows' on Windows) against a scratch root: its /usr/bin, /etc and
// /opt paths are moved under the root, and update-alternatives is a stand-in that does nothing, as one whose --install failed
// leaves the plain link after-install.sh then made.
const SCRIPT = path.join(__dirname, '..', '..', 'build', 'linux', 'after-remove.sh');

let sh: string;
beforeAll(async () => {
  if (process.platform !== 'win32') {
    sh = '/bin/sh';
    return;
  }
  const bash = await findBash();
  if (bash === undefined) throw new Error('Git for Windows\' sh is needed for this test');
  sh = path.join(path.dirname(path.dirname(bash)), 'usr', 'bin', 'sh.exe');
});

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })));
});

async function setup(alternatives: boolean): Promise<{ readonly root: string; readonly link: string; readonly remove: () => ReturnType<typeof spawnSync> }> {
  // the long form of the temp folder, since MSYS reads no 8.3 name in a link's target
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'damocles-after-remove-')));
  folders.push(root);
  const fakes = path.join(root, 'fakes');
  await Promise.all([fs.mkdir(path.join(root, 'usr', 'bin'), { recursive: true }), fs.mkdir(fakes), fs.mkdir(path.join(root, 'etc', 'apparmor.d'), { recursive: true })]);
  // the root as sh names it, which may map a Windows temp folder to /tmp
  const shRoot = spawnSync(sh, ['-c', 'cd "$1" && pwd -P', 'sh', root], { encoding: 'utf8' }).stdout.trim();
  const text = (await fs.readFile(SCRIPT, 'utf8'))
    .replaceAll('/opt/${sanitizedProductName}', `${shRoot}/opt/Damocles`)
    .replaceAll('${executable}', 'damocles')
    .replaceAll('"/usr/bin/', `"${shRoot}/usr/bin/`)
    .replaceAll('"/etc/', `"${shRoot}/etc/`);
  const script = path.join(root, 'after-remove.sh');
  await fs.writeFile(script, text);
  if (alternatives) {
    await fs.writeFile(path.join(fakes, 'update-alternatives'), '#!/bin/sh\nexit 0\n');
    await fs.chmod(path.join(fakes, 'update-alternatives'), 0o755);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [fakes, path.dirname(sh)].join(path.delimiter);
  return { root, link: path.join(root, 'usr', 'bin', 'damocles'), remove: () => spawnSync(sh, [script, 'remove'], { env, encoding: 'utf8' }) };
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
};

describe('build/linux/after-remove.sh', () => {
  for (const alternatives of [true, false]) {
    it(`removes the plain /usr/bin/damocles link into the app, dangling once the app is gone, ${alternatives ? 'with' : 'without'} update-alternatives`, async () => {
      const { root, link, remove } = await setup(alternatives);
      await fs.symlink(path.join(root, 'opt', 'Damocles', 'resources', 'bin', 'damocles'), link);
      const result = remove();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(await exists(link)).toBe(false);
    });
  }

  it('leaves a /usr/bin/damocles that is another program\'s: a link elsewhere, or a file', async () => {
    const { root, link, remove } = await setup(true);
    await fs.symlink(path.join(root, 'opt', 'Damocles-other', 'damocles'), link);
    expect(remove().status).toBe(0);
    expect(await exists(link)).toBe(true);
    const without = await setup(false);
    await fs.writeFile(without.link, '#!/bin/sh\n');
    expect(without.remove().status).toBe(0);
    expect(await exists(without.link)).toBe(true);
  });
});
