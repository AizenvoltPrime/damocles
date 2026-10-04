import { describe, it, expect, onTestFinished } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OWNER_FILE, ROOT_PREFIX, removeAbandonedRoots } from '../../__mocks__/test-home.global-setup';

function root(parent: string, name: string, owner?: number): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, 'h-home'), { recursive: true });
  if (owner !== undefined) fs.writeFileSync(path.join(dir, OWNER_FILE), String(owner));
  return dir;
}

describe('removeAbandonedRoots', () => {
  it('removes only run roots whose owning process has exited', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-'));
    onTestFinished(() => fs.rmSync(parent, { recursive: true, force: true }));
    const exited = spawnSync(process.execPath, ['-e', '']).pid!;

    const abandoned = root(parent, `${ROOT_PREFIX}dead`, exited);
    const live = root(parent, `${ROOT_PREFIX}live`, process.pid);
    const unowned = root(parent, `${ROOT_PREFIX}new`);
    const unrelated = root(parent, 'other-dead', exited);

    removeAbandonedRoots(parent);

    expect(fs.existsSync(abandoned)).toBe(false);
    expect([live, unowned, unrelated].filter((dir) => fs.existsSync(dir))).toEqual([live, unowned, unrelated]);
  });
});
