import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SPAWN_TEST_TIMEOUT_MS } from '../../../__mocks__/spawn-budget';
import { isInsideFolder } from '../../../shared/project-location';
import { processLauncher, whenProcessesClosed, type LaunchedProcess } from '../index';

const started: LaunchedProcess[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) {
    child.kill();
    await child.closed.catch(() => undefined);
  }
});

/** A node process that runs until killed, in `cwd`. */
async function runIn(cwd: string): Promise<LaunchedProcess> {
  const child = processLauncher().launch({ file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  started.push(child);
  await child.pid;
  return child;
}

function scratchFolder(): { readonly folder: string; readonly inFolder: (cwd: string) => boolean } {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-folder-processes-'));
  return { folder, inFolder: (cwd) => isInsideFolder({ os: process.platform }, folder, cwd) };
}

describe('whenProcessesClosed', () => {
  it('settles once a process started below the folder closed, and at once for a folder none runs in', async () => {
    const { folder, inFolder } = scratchFolder();
    const below = path.join(folder, 'src');
    fs.mkdirSync(below);
    const child = await runIn(below);
    let settled = false;
    const closed = whenProcessesClosed(inFolder, 60_000).then((left) => {
      settled = true;
      return left;
    });
    expect(await whenProcessesClosed((cwd) => isInsideFolder({ os: process.platform }, path.join(folder, 'other'), cwd), 60_000)).toEqual([]);
    expect(settled).toBe(false);
    child.kill();
    expect(await closed).toEqual([]);
  }, SPAWN_TEST_TIMEOUT_MS);

  it('answers the working folders still running once the time is up', async () => {
    const { folder, inFolder } = scratchFolder();
    await runIn(folder);
    expect(await whenProcessesClosed(inFolder, 50)).toEqual([folder]);
  }, SPAWN_TEST_TIMEOUT_MS);
});
