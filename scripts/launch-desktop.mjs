import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devElectronDist } from './dev-electron-binary.mjs';

const require = createRequire(import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// A shell spawned from an editor's extension host inherits ELECTRON_RUN_AS_NODE=1, which would start the binary as plain Node.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.platform === 'win32') {
  process.env.ELECTRON_OVERRIDE_DIST_PATH = devElectronDist(dirname(require.resolve('electron/package.json')));
}
// The electron package's main export is the path of the binary to run.
const electronBinary = require('electron');

const child = spawn(electronBinary, [join(repoRoot, 'dist', 'desktop', 'main.js'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('error', (err) => {
  console.error(`Could not start ${electronBinary}: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
