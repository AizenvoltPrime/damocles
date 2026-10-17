import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempFoldersSettled, removeAbandonedTempFolders, withPatchFile } from '../create';

let temp: string;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-temp-sweep-'));
});

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

const HOUR_MS = 60 * 60 * 1000;
// A process that has exited, so its pid names no running process.
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;

function folder(name: string, ageMs: number): string {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'changes.patch'), 'diff');
  const at = (Date.now() - ageMs) / 1000;
  fs.utimesSync(dir, at, at);
  return dir;
}

describe('worktree temp folders', () => {
  it('names a worktree temp folder after its process, and tempFoldersSettled waits until a use in flight removed it', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let dir = '';
    const use = withPatchFile(async (file) => {
      dir = path.dirname(file);
      await held;
      return 'done';
    });
    while (dir === '') await new Promise((resolve) => setImmediate(resolve));
    expect(path.basename(dir)).toMatch(new RegExp(`^damocles-git-${process.pid}-[A-Za-z0-9]{6}$`));
    let settled = false;
    const settling = tempFoldersSettled().then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await settling;
    expect(fs.existsSync(dir)).toBe(false);
    await expect(use).resolves.toBe('done');
  });

  it('removes only temp folders older than an hour whose creating process is gone', async () => {
    const dead = deadPid();
    const abandoned = folder(`damocles-git-${dead}-aB3dE9`, 2 * HOUR_MS);
    const young = folder(`damocles-git-${dead}-Zz0001`, 10 * 60 * 1000);
    const live = folder(`damocles-git-${process.ppid}-Qw12er`, 2 * HOUR_MS);
    const own = folder(`damocles-git-${process.pid}-Ty34ui`, 2 * HOUR_MS);
    const unnamed = folder('damocles-git-aB3dE9', 2 * HOUR_MS);
    const other = folder(`other-patch-${dead}-aB3dE9`, 2 * HOUR_MS);
    fs.writeFileSync(path.join(temp, `damocles-git-${dead}-file01`), 'x');
    await removeAbandonedTempFolders(temp, Date.now());
    expect(fs.existsSync(abandoned)).toBe(false);
    for (const kept of [young, live, own, unnamed, other, path.join(temp, `damocles-git-${dead}-file01`)]) expect(fs.existsSync(kept)).toBe(true);
  });
});
