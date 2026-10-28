import { posix, win32 } from 'node:path';

/**
 * npm's own CLI script for this Node, which a caller runs with `process.execPath` so no shell joins the arguments: the one npm
 * started this script with, else the npm bundled beside node.exe on Windows and under lib/ elsewhere.
 */
export function npmCliPath(env = process.env, platform = process.platform, execPath = process.execPath) {
  if (env.npm_execpath) return env.npm_execpath;
  const path = platform === 'win32' ? win32 : posix;
  const nodeDir = path.dirname(execPath);
  return platform === 'win32'
    ? path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}
