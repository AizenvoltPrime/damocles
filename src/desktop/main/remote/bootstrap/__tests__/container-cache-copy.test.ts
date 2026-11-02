import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSh, scratchDir, shellPath, stageMessages, withPosixDefinitions } from './shells';

// stage 1's copy in a container: the app's engine cp lands right after the stage made its folder, which a mkdir wrapper stands
// for; the wrapper takes only `-m 700 <folder>` and makes the folder without the mode, which Git for Windows' sh cannot set on NTFS
function copy(dir: string, answer: string, placed: boolean): ReturnType<typeof runSh> {
  const cache = shellPath(path.join(dir, 'cache'));
  const body = `D_CONTAINER_CACHE='${cache}'; package_file=pkg.tar.gz
mkdir() { [ "$#" -eq 3 ] && [ "$1" = -m ] && [ "$2" = 700 ] || return 9; command mkdir "$3" || return 1; ${placed ? `cp '${shellPath(path.join(dir, 'pkg.tar.gz'))}' "$D_CONTAINER_CACHE/pkg.tar.gz"` : ':'}; }
fetch_package '${shellPath(path.join(dir, 'staged.tar.gz'))}' && echo copied`;
  return runSh(withPosixDefinitions(body), answer);
}

describe('stage 1 in a container, in a real sh', { timeout: 120_000 }, () => {
  it('makes its own cache folder, asks the app to copy the package in, takes it, and deletes the folder', async () => {
    const dir = scratchDir('container-cache-');
    writeFileSync(path.join(dir, 'pkg.tar.gz'), 'package bytes');
    const output = await copy(dir, 'ready\n', true);
    expect(stageMessages(output)).toEqual([{ kind: 'cache' }]);
    expect(output.stdout.toString('utf8')).toMatch(/copied\n$/);
    expect(readFileSync(path.join(dir, 'staged.tar.gz'), 'utf8')).toBe('package bytes');
    expect(existsSync(path.join(dir, 'cache'))).toBe(false);
  });

  it('copies nothing on none, reports a copy that failed, and refuses a cache folder that already exists', async () => {
    const dir = scratchDir('container-cache-');
    const none = await copy(dir, 'none\n', false);
    expect(stageMessages(none)).toEqual([{ kind: 'cache' }]);
    expect(none.stdout.toString('utf8')).not.toContain('copied');
    expect(existsSync(path.join(dir, 'cache'))).toBe(false);
    const empty = await copy(dir, 'ready\n', false);
    expect(stageMessages(empty)).toEqual([{ kind: 'cache' }, { kind: 'copyFailed', reason: 'copy' }]);
    // a folder someone made first is never taken as the stage's own
    mkdirSync(path.join(dir, 'cache'));
    const squatted = await copy(dir, 'ready\n', true);
    expect(stageMessages(squatted)).toEqual([{ kind: 'copyFailed', reason: 'cacheFolder' }]);
  });

  // ln is recorded, not run: Git for Windows' sh copies instead of linking
  it('links a home with no ~/.damocles to the data folder, and leaves an existing one or no data folder alone', async () => {
    const dir = scratchDir('container-data-');
    const record = path.join(dir, 'ln-calls');
    const link = (home: string, data: string) => runSh(withPosixDefinitions(`HOME='${shellPath(home)}'; D_DATA_FOLDER='${data}'\nln() { printf '%s\\n' "$*" >> '${shellPath(record)}'; }\nlink_data_folder`), '');
    const fresh = path.join(dir, 'home');
    mkdirSync(fresh);
    await link(fresh, '/var/lib/damocles-data');
    expect(readFileSync(record, 'utf8')).toBe(`-s /var/lib/damocles-data ${shellPath(fresh)}/.damocles\n`);
    const kept = path.join(dir, 'kept');
    mkdirSync(path.join(kept, '.damocles'), { recursive: true });
    await link(kept, '/var/lib/damocles-data');
    await link(fresh, '');
    expect(readFileSync(record, 'utf8')).toBe(`-s /var/lib/damocles-data ${shellPath(fresh)}/.damocles\n`);
  });

  it('fails a home that cannot hold the ~/.damocles link as a folder the install cannot write', async () => {
    const home = path.join(scratchDir('container-data-'), 'home');
    mkdirSync(home);
    const output = await runSh(withPosixDefinitions(`HOME='${shellPath(home)}'; D_DATA_FOLDER='/var/lib/damocles-data'\nln() { return 1; }\nlink_data_folder`), '');
    expect(stageMessages(output)).toEqual([{ kind: 'fail', code: 'noexec', params: { folder: `${shellPath(home)}/.damocles`, reason: 'notWritable' } }]);
  });
});
