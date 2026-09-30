import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shell = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => undefined),
  openPath: vi.fn(async (_path: string) => ''),
  showItemInFolder: vi.fn(),
}));
vi.mock('electron', () => ({ shell }));

import { createDesktopShellService } from '../platform/shell-service';

let dir: string;
let lines: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-shell-'));
  lines = [];
  shell.openExternal.mockReset().mockResolvedValue(undefined);
  shell.openPath.mockReset().mockResolvedValue('');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const service = () => createDesktopShellService((line) => lines.push(line));

describe('desktop shell service', () => {
  it('opens a web URL in the canonical form it checked', async () => {
    await expect(service().openExternal('HTTPS://Example.test/a b?q=1')).resolves.toBe(true);
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.test/a%20b?q=1');
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'damocles://x', 'not a url'])('refuses %s without asking the OS', async (url) => {
    await expect(service().openExternal(url)).resolves.toBe(false);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('resolves false and logs when the OS has no handler, instead of rejecting', async () => {
    shell.openExternal.mockRejectedValue(new Error('xdg-open not found'));
    await expect(service().openExternal('https://example.test/')).resolves.toBe(false);
    expect(lines.some((line) => line.includes('xdg-open not found'))).toBe(true);
  });

  it('opens a folder but never launches a file', async () => {
    const script = path.join(dir, 'run.command');
    fs.writeFileSync(script, 'echo hi');

    await expect(service().openFolder(dir)).resolves.toBe(true);
    await expect(service().openFolder(script)).resolves.toBe(false);
    await expect(service().openFolder(path.join(dir, 'missing'))).resolves.toBe(false);

    expect(shell.openPath.mock.calls).toEqual([[dir]]);
    expect(lines.some((line) => line.includes('not a folder'))).toBe(true);
  });

  it('reports a folder the OS could not open', async () => {
    shell.openPath.mockResolvedValue('Failed to open path');
    await expect(service().openFolder(dir)).resolves.toBe(false);
    expect(lines).toContain(`[shell] could not open ${dir}: Failed to open path`);
  });
});
