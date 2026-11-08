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
// the paths the Reveal check refused with their reasons, and its verdict on the next
let refused: string[];
let revealable: true | 'share' | 'name';
// the paths the check was asked about
let checked: string[];
// what the check rejects with, as one that could not walk the path does
let checkError: Error | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-shell-'));
  lines = [];
  refused = [];
  revealable = true;
  checked = [];
  checkError = undefined;
  shell.showItemInFolder.mockReset();
  shell.openExternal.mockReset().mockResolvedValue(undefined);
  shell.openPath.mockReset().mockResolvedValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const service = () => createDesktopShellService((line) => lines.push(line), async (absolutePath) => {
  checked.push(absolutePath);
  if (checkError) throw checkError;
  return revealable;
}, (absolutePath, reason) => refused.push(`${absolutePath} ${reason}`));

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

  it('logs only the origin of a link it could not open, never a token in its path or query', async () => {
    shell.openExternal.mockRejectedValue(new Error('xdg-open not found'));
    const token = 'Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWo';
    await service().openExternal(`http://127.0.0.1:51234/__damocles_preview/open?t=${token}&p=index.html`);
    await service().openExternal(`http://127.0.0.1:51235/d/${token}/screens/S1.html`);
    expect(lines.join('\n')).not.toContain(token);
    expect(lines).toContain('[shell] could not open a link to "http://127.0.0.1:51234": xdg-open not found');
  });

  it('opens a folder but never launches a file', async () => {
    const script = path.join(dir, 'run.command');
    fs.writeFileSync(script, 'echo hi');

    await expect(service().openFolder(dir)).resolves.toBe(true);
    await expect(service().openFolder(script)).resolves.toBe(false);
    await expect(service().openFolder(path.join(dir, 'missing'))).resolves.toBe(false);

    expect(shell.openPath.mock.calls).toEqual([[dir]]);
    expect(checked).toEqual([dir, script, path.join(dir, 'missing')]);
    expect(lines.some((line) => line.includes('not a folder'))).toBe(true);
  });

  it('reveals a path the Reveal check allows', async () => {
    await expect(service().revealPath('C:\\work\\a.ts')).resolves.toBeUndefined();
    expect(shell.showItemInFolder.mock.calls).toEqual([['C:\\work\\a.ts']]);
    expect(checked).toEqual(['C:\\work\\a.ts']);
    expect(refused).toEqual([]);
  });

  it('refuses a path the Reveal check refuses: logs it, tells the user and never asks the OS, resolving all the same', async () => {
    revealable = 'share';
    const share = '\\\\server\\share\\a.ts';
    await expect(service().revealPath(share)).resolves.toBeUndefined();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(refused).toEqual([`${share} share`]);
    expect(lines).toEqual([`[shell] refused to show ${share}: the Reveal check refused it (share)`]);
  });

  it('opens no folder the Reveal check refuses, before any stat of it, telling the user', async () => {
    revealable = 'share';
    const share = '\\\\server\\share\\models';
    const stat = vi.spyOn(fs.promises, 'stat');
    await expect(service().openFolder(share)).resolves.toBe(false);
    expect(stat).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(refused).toEqual([`${share} share`]);
    expect(lines).toEqual([`[shell] refused to show ${share}: the Reveal check refused it (share)`]);
  });

  it('rejects a reveal or folder open whose check could not run, asking the OS nothing', async () => {
    checkError = new Error('EACCES: permission denied');
    const stat = vi.spyOn(fs.promises, 'stat');
    await expect(service().revealPath('C:\\locked\\a.ts')).rejects.toBe(checkError);
    await expect(service().openFolder(dir)).rejects.toBe(checkError);
    expect(stat).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(refused).toEqual([]);
  });

  it('reveals a path below a folder the user chose without the Reveal check', async () => {
    revealable = 'share';
    const download = '\\\\server\\share\\downloads\\a.zip';
    await service().revealChosenPath(download);
    expect(shell.showItemInFolder.mock.calls).toEqual([[download]]);
    expect(refused).toEqual([]);
  });

  it('reports a folder the OS could not open', async () => {
    shell.openPath.mockResolvedValue('Failed to open path');
    await expect(service().openFolder(dir)).resolves.toBe(false);
    expect(lines).toContain(`[shell] could not open ${dir}: Failed to open path`);
  });
});
