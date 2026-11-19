import * as path from 'node:path';
import { build } from 'esbuild';
import { diffWorkerOptions } from '../../../../esbuild.config.ts';
import { REPO_ROOT } from '../../../__mocks__/source-tree';

/** Bundles the diff worker into `dir` with the shipped build options (dist/diff-worker.js), and returns its path. */
export async function buildDiffWorker(dir: string): Promise<string> {
  const bundle = path.join(dir, 'diff-worker.js');
  await build({ ...diffWorkerOptions, absWorkingDir: REPO_ROOT, outfile: bundle, logLevel: 'silent' });
  return bundle;
}
