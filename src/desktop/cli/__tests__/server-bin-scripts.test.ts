import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBash } from '../../../core/system-tools';

// resources/server-bin's sh scripts in a server package's layout, run by a POSIX sh (Git for Windows' on Windows), with this
// Node as the package's node/node or node/node.exe and a dist/cli-remote.js that prints the arguments it got.
const SERVER_BIN = path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'server-bin');
const ECHO = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n';
const windows = process.platform === 'win32';

let root: string;
let sh: string;

beforeAll(async () => {
  if (windows) {
    const bash = await findBash();
    if (bash === undefined) throw new Error('Git for Windows\' sh is needed for this test');
    sh = path.join(path.dirname(bash), 'sh.exe');
  } else {
    sh = '/bin/sh';
  }
  // a space in the package's folder, as under C:\Program Files or a user name with one
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles server-bin-'));
  const place = (relative: string, from: string): void => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);
    fs.chmodSync(target, 0o755);
  };
  place(windows ? 'node/node.exe' : 'node/node', process.execPath);
  place('bin/remote-cli/damocles', path.join(SERVER_BIN, 'remote-cli', 'damocles'));
  place('bin/helpers/browser.sh', path.join(SERVER_BIN, 'helpers', 'browser.sh'));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'cli-remote.js'), ECHO);
});

afterAll(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

// MSYS_NO_PATHCONV and MSYS2_ARG_CONV_EXCL turn off MSYS's own rewriting of POSIX paths in arguments, so on Windows only the
// scripts' cygpath gives Windows Node a path it can open
function run(script: string, args: readonly string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
  const result = spawnSync(sh, [path.join(root, script).replaceAll('\\', '/'), ...args], { env, encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('a server package\'s sh scripts', () => {
  it('run the package\'s own Node with dist/cli-remote.js and the arguments as typed', () => {
    const args = [windows ? 'C:\\work\\a b!.txt' : '/srv/a b!.txt', '--wait', ''];
    expect(run('bin/remote-cli/damocles', args)).toEqual({ status: 0, stdout: JSON.stringify(args), stderr: '' });
  });

  it('send BROWSER\'s address with --open-external, & and % included', () => {
    const url = 'https://idp.test/authorize?client_id=a&state=%PATH%#!/x';
    expect(run('bin/helpers/browser.sh', [url])).toEqual({ status: 0, stdout: JSON.stringify(['--open-external', url]), stderr: '' });
  });
});
