import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { DamoclesShellApi } from '../shell-channels';

const H = vi.hoisted(() => ({
  exposed: undefined as DamoclesShellApi | undefined,
  // the disk path Electron knows for a File the OS handed the page, '' for one the page made
  diskPaths: new WeakMap<object, string>(),
  getPathForFile: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: DamoclesShellApi) => { H.exposed = api; } },
  ipcRenderer: { invoke: async () => undefined, on: () => undefined, send: () => undefined, removeListener: () => undefined },
  webUtils: { getPathForFile: H.getPathForFile },
}));

let api: DamoclesShellApi;
beforeAll(async () => {
  H.getPathForFile.mockImplementation((file: File) => H.diskPaths.get(file) ?? '');
  await import('../shell');
  api = H.exposed!;
});

function osFile(name: string, path: string): File {
  const file = new File(['x'], name);
  H.diskPaths.set(file, path);
  return file;
}

describe('pathsForFiles', () => {
  it('answers each file\'s disk path in order, as Electron reports it, untouched', () => {
    const files = [osFile('a.png', 'C:\\Users\\me\\Pictures\\a.png'), osFile('b', '/home/me/b/'), osFile('c.txt', 'relative\\..\\c.txt')];
    expect(api.pathsForFiles(files)).toEqual(['C:\\Users\\me\\Pictures\\a.png', '/home/me/b/', 'relative\\..\\c.txt']);
  });

  it('answers \'\' for a File with no disk path, such as an image dragged from a web page, keeping the positions', () => {
    const fromPage = new File(['x'], 'cat.png');
    expect(api.pathsForFiles([osFile('a.png', '/tmp/a.png'), fromPage])).toEqual(['/tmp/a.png', '']);
  });

  it('answers \'\' for anything that is not a File, without asking Electron', () => {
    H.getPathForFile.mockClear();
    const forged = { name: 'a.png', path: '/etc/passwd' };
    expect(api.pathsForFiles([forged as unknown as File, 'x' as unknown as File, null as unknown as File])).toEqual(['', '', '']);
    expect(H.getPathForFile).not.toHaveBeenCalled();
  });
});
