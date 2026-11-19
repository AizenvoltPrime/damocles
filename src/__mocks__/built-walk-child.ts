import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** dist/walk-child.js as esbuild.config.ts builds it, in a temp folder whose node_modules holds koffi, the bundle's one external. */
export async function buildWalkChild(): Promise<{ readonly entry: string; dispose(): void }> {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-walk-child-')));
  const entry = path.join(dir, 'walk-child.cjs');
  await build({ entryPoints: [path.join(REPO_ROOT, 'src', 'core', 'search-walk', 'walk-child.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: entry, external: ['koffi'], logLevel: 'silent' });
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules', 'koffi'), path.join(dir, 'node_modules', 'koffi'), 'junction');
  return { entry, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
