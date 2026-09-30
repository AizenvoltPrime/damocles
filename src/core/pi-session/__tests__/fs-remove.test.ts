import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { forceRemoveDir } from '../fs-remove';

describe('forceRemoveDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-remove-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('removes a nested tree containing read-only files (git pack layout)', async () => {
    const clone = path.join(tmp, 'pi-anthropic-oauth');
    const pack = path.join(clone, '.git', 'objects', 'pack');
    fs.mkdirSync(pack, { recursive: true });
    const packFile = path.join(pack, 'pack-abc.pack');
    fs.writeFileSync(packFile, 'data');
    fs.writeFileSync(path.join(clone, 'package.json'), '{}');
    // git marks pack files read-only; mirror that so we exercise the chmod-on-removal path.
    fs.chmodSync(packFile, 0o444);

    await forceRemoveDir(clone);

    expect(fs.existsSync(clone)).toBe(false);
  });

  it('resolves without error when the directory is already absent', async () => {
    const missing = path.join(tmp, 'never-existed');
    await expect(forceRemoveDir(missing)).resolves.toBeUndefined();
  });
});
