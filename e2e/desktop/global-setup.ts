import * as fs from 'node:fs';
import * as path from 'node:path';
import { build } from 'esbuild';
import { EXTENSION_EXTERNALS } from '../../scripts/extension-externals.mjs';
import { REPO_ROOT } from './support/hermetic';
import { PACKAGED_APP_ENV, packagedAppPath } from './support/packaged-app';
import { SECOND_PROCESS_BUNDLE } from './support/second-process';

export default async function globalSetup(): Promise<void> {
  const packaged = packagedAppPath();
  if (packaged !== undefined) {
    if (!fs.existsSync(packaged)) throw new Error(`${PACKAGED_APP_ENV} names ${packaged}, which does not exist; build the app with \`npm run dist\` first`);
  } else {
    for (const built of ['dist/desktop/main.js', 'dist/desktop/preload-panel.js', 'dist/webview/index.html']) {
      if (!fs.existsSync(path.join(REPO_ROOT, built))) {
        throw new Error(`${built} is missing; run the suite through \`npm run test:desktop\`, which builds it first`);
      }
    }
  }
  // The bundle lives under the repo so its externals (pi is ESM, loaded by import()) resolve from node_modules.
  await build({
    entryPoints: [path.join(REPO_ROOT, 'e2e', 'desktop', 'second-process', 'child.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: SECOND_PROCESS_BUNDLE,
    external: EXTENSION_EXTERNALS.filter((name) => name !== 'vscode'),
    logLevel: 'warning',
  });
}
