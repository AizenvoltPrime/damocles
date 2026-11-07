import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVsCodeFileConfinement } from '../../../vscode/platform/file-confinement';
import { AssetRefusedError, importAsset, MAX_ASSET_BYTES } from '../assets';
import { ProjectFiles } from '../citations';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
function setUp(): { project: string; folder: string; files: ProjectFiles } {
  const project = tempDir('design-assets-project-');
  return { project, folder: tempDir('design-assets-folder-'), files: new ProjectFiles(project, createVsCodeFileConfinement()) };
}

describe('ImportAsset (PD-46)', () => {
  it('copies a project font or image into assets/, reusing an identical copy and numbering a different one', async () => {
    const { project, folder, files } = setUp();
    fs.mkdirSync(path.join(project, 'img'));
    fs.writeFileSync(path.join(project, 'img', 'logo.png'), 'png-1');
    fs.mkdirSync(path.join(project, 'other'));
    fs.writeFileSync(path.join(project, 'other', 'logo.png'), 'png-2');
    expect(await importAsset(files, 'img/logo.png', folder)).toEqual({ asset: 'assets/logo.png', bytes: 5 });
    expect(await importAsset(files, 'img\\logo.png', folder)).toEqual({ asset: 'assets/logo.png', bytes: 5 });
    expect(await importAsset(files, 'other/logo.png', folder)).toEqual({ asset: 'assets/logo-2.png', bytes: 5 });
    expect(fs.readFileSync(path.join(folder, 'assets', 'logo-2.png'), 'utf8')).toBe('png-2');
  });

  it('refuses a path outside the working folder, a missing file, a type it does not copy and a folder', async () => {
    const { project, folder, files } = setUp();
    fs.writeFileSync(path.join(project, 'run.sh'), 'x');
    fs.mkdirSync(path.join(project, 'dir.png'));
    for (const [file, reason] of [['../x.png', /does not exist|outside/], [path.join(project, 'a.png'), /not a path relative/], ['missing.png', /does not exist/], ['run.sh', /not a font or image/], ['dir.png', /not a regular file|could not be read/]] as const) {
      const refused = importAsset(files, file, folder);
      await expect(refused).rejects.toBeInstanceOf(AssetRefusedError);
      await expect(refused).rejects.toThrow(reason);
    }
    expect(fs.existsSync(path.join(folder, 'assets'))).toBe(false);
  });

  it('refuses a file past 5 MiB and a hard link', async () => {
    const { project, folder, files } = setUp();
    fs.writeFileSync(path.join(project, 'big.png'), Buffer.alloc(MAX_ASSET_BYTES + 1));
    await expect(importAsset(files, 'big.png', folder)).rejects.toThrow(/larger than 5 MiB/);
    fs.writeFileSync(path.join(project, 'a.png'), 'x');
    fs.linkSync(path.join(project, 'a.png'), path.join(project, 'b.png'));
    await expect(importAsset(files, 'b.png', folder)).rejects.toThrow(/more than one hard link/);
  });
});
