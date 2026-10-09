import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeLeftovers, fileHolders } from '../../e2e/desktop/support/file-holders';

// e2e/desktop/support/hermetic.ts reports these when it cannot delete a test's temporary home.
describe('e2e file holders', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(process.platform === 'win32')('names the process that holds a file open, through Windows\' Restart Manager', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holders-'));
    dirs.push(dir);
    const file = path.join(dir, 'held.txt');
    fs.writeFileSync(file, 'x');
    const holder = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(file)}, 'r'); console.log('open'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
      expect(fileHolders([file]).map((entry) => entry.pid)).toContain(holder.pid);
      expect(describeLeftovers(dir)).toContain(`pid ${holder.pid}`);
    } finally {
      holder.kill();
      await new Promise((resolve) => holder.once('exit', resolve));
    }
    expect(fileHolders([file])).toEqual([]);
  });

  it('lists what is left under the folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holders-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'a'));
    fs.writeFileSync(path.join(dir, 'a', 'left.txt'), 'x');
    expect(describeLeftovers(dir)).toContain(`1 files left under ${dir}\n  ${path.join('a', 'left.txt')}`);
  });
});
