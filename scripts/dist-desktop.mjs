import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Packages the already built desktop app (npm run build + build:desktop) for this machine with electron-builder.
// Extra arguments pass through, e.g. `--dir` or `-c.directories.output=<dir>`.

const PLATFORM_FLAGS = { win32: '--win', darwin: '--mac', linux: '--linux' };
const ARCHES = ['x64', 'arm64'];

const platformFlag = PLATFORM_FLAGS[process.platform];
if (!platformFlag) {
  console.error(`ERROR: no desktop build for ${process.platform}`);
  process.exit(1);
}
if (!ARCHES.includes(process.arch)) {
  console.error(`ERROR: no desktop build for ${process.arch}; the desktop app is 64-bit only`);
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// --publish never: without it electron-builder publishes on its own when it detects a CI tag build.
const args = [join(repoRoot, 'node_modules', 'electron-builder', 'cli.js'), platformFlag, `--${process.arch}`, '--publish', 'never'];
// Windows x64 and arm64 would both write latest.yml; each arch gets its own feed, which the updater requests by process.arch.
if (process.platform === 'win32') args.push(`-c.publish.channel=latest-${process.arch}`);
args.push(...process.argv.slice(2));

console.log(`electron-builder ${args.slice(1).join(' ')}`);
const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
if (result.error) {
  console.error(`ERROR: could not run electron-builder: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
