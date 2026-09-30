import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pruneOrphanCheckpointRepos } from '../prune';

let baseDir: string;

async function makeRepoDir(name: string): Promise<void> {
  const dir = path.join(baseDir, name);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'marker.txt'), name, 'utf8');
}

describe('pruneOrphanCheckpointRepos', () => {
  beforeEach(async () => {
    baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-prune-'));
  });

  afterEach(async () => {
    await fs.promises.rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('removes repos whose name is not in the live set and keeps the rest', async () => {
    await makeRepoDir('live-1');
    await makeRepoDir('live-2');
    await makeRepoDir('orphan-1');
    await makeRepoDir('orphan-2');

    await pruneOrphanCheckpointRepos(new Set(['live-1', 'live-2']), baseDir);

    const remaining = (await fs.promises.readdir(baseDir)).sort();
    expect(remaining).toEqual(['live-1', 'live-2']);
  });

  it('removes everything when the live set is empty', async () => {
    await makeRepoDir('a');
    await makeRepoDir('b');
    await pruneOrphanCheckpointRepos(new Set(), baseDir);
    expect(await fs.promises.readdir(baseDir)).toEqual([]);
  });

  it('keeps everything when all repos are live', async () => {
    await makeRepoDir('a');
    await makeRepoDir('b');
    await pruneOrphanCheckpointRepos(new Set(['a', 'b']), baseDir);
    expect((await fs.promises.readdir(baseDir)).sort()).toEqual(['a', 'b']);
  });

  it('ignores stray files at the base level (only directories are pruned)', async () => {
    await makeRepoDir('orphan');
    await fs.promises.writeFile(path.join(baseDir, 'README'), 'x', 'utf8');
    await pruneOrphanCheckpointRepos(new Set(), baseDir);
    expect(await fs.promises.readdir(baseDir)).toEqual(['README']);
  });

  it('is a no-op when the base directory does not exist', async () => {
    const missing = path.join(baseDir, 'does', 'not', 'exist');
    await expect(pruneOrphanCheckpointRepos(new Set(), missing)).resolves.toBeUndefined();
  });
});
