import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'vitest';

/**
 * Makes `at` a folder symlink onto a fresh temp folder spelled through this computer's own admin share
 * (`\\localhost\C$\...`), as a store folder the user moved onto a NAS, and returns the temp folder's local path, which the
 * caller removes. Windows only; skips the test where the admin share or a folder symlink is not available to this user.
 */
export function folderOnAdminShare(ctx: TestContext, at: string): string {
  const real = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-admin-share-')));
  const unc = `\\\\localhost\\${real[0]}$${real.slice(2)}`;
  try {
    fs.readdirSync(unc);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(unc, at, 'dir');
  } catch {
    fs.rmSync(real, { recursive: true, force: true });
    ctx.skip('this user cannot reach \\\\localhost\\C$ or make a folder symlink');
  }
  return real;
}

/** Makes `at` a file symlink onto the NUL device, a target the network rule refuses unread; skips where file symlinks need elevation. */
export function fileLinkedOntoDevice(ctx: TestContext, at: string): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  try {
    fs.symlinkSync('\\\\.\\NUL', at, 'file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip('file symlinks need Developer Mode or an elevated process');
    throw err;
  }
}
