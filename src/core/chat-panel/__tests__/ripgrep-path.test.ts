import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { listWorkspaceFiles, unpackedExecutable } from '../ripgrep';

const rgRelative = path.join('node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg');

describe('unpackedExecutable', () => {
  it('moves a binary inside the packaged app.asar to the app.asar.unpacked copy', () => {
    const asar = path.resolve('/opt/Damocles/resources/app.asar');
    const paths = { resourceRoot: asar, unpackedRoot: `${asar}.unpacked` };
    expect(unpackedExecutable(path.join(asar, rgRelative), paths)).toBe(path.join(`${asar}.unpacked`, rgRelative));
  });

  it('leaves the path alone when both roots are the same directory (VS Code, unpackaged desktop)', () => {
    const root = path.resolve('/ext/damocles');
    const file = path.join(root, rgRelative);
    expect(unpackedExecutable(file, { resourceRoot: root, unpackedRoot: root })).toBe(file);
  });

  it('leaves a path outside resourceRoot alone', () => {
    const asar = path.resolve('/opt/Damocles/resources/app.asar');
    const outside = path.resolve('/usr/bin/rg');
    expect(unpackedExecutable(outside, { resourceRoot: asar, unpackedRoot: `${asar}.unpacked` })).toBe(outside);
  });
});

describe('listWorkspaceFiles', () => {
  it("runs the ripgrep binary resolved through the caller's AppPaths", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'damocles-rg-'));
    try {
      writeFileSync(path.join(workspace, 'a.txt'), 'x');
      const host = createFakePlatform({ appRoot: path.resolve(__dirname, '..', '..', '..', '..') });
      expect(await listWorkspaceFiles(host, workspace)).toEqual([{ relativePath: 'a.txt', isDirectory: false }]);

      // An unpacked root with no ripgrep copy proves the binary path came from these AppPaths.
      const noUnpackedCopy = { settings: host.settings, paths: { ...host.paths, unpackedRoot: path.join(workspace, 'unpacked') } };
      await expect(listWorkspaceFiles(noUnpackedCopy, workspace)).rejects.toThrow(/ripgrep process error/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('ignores a ripgrep config file', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'damocles-rg-'));
    const config = `${workspace}.rgrc`;
    try {
      mkdirSync(path.join(workspace, 'nested'));
      writeFileSync(path.join(workspace, 'nested', 'b.txt'), 'x');
      writeFileSync(config, '--max-depth=1\n');
      vi.stubEnv('RIPGREP_CONFIG_PATH', config);
      const host = createFakePlatform({ appRoot: path.resolve(__dirname, '..', '..', '..', '..') });
      expect(await listWorkspaceFiles(host, workspace)).toContainEqual({ relativePath: 'nested/b.txt', isDirectory: false });
    } finally {
      vi.unstubAllEnvs();
      rmSync(config, { force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
