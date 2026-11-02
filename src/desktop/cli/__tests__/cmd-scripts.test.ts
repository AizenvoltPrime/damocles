import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RESOURCES = path.resolve(__dirname, '..', '..', '..', '..', 'resources');
// stands in for dist/cli.js and dist/cli-remote.js: prints the arguments it got, and exits with N for --exit=N
const ECHO = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = Number(/^--exit=(\\d+)$/.exec(process.argv[2] ?? "")?.[1] ?? 0);\n';

let root: string;

// The app's and the server package's layouts, with this Node in place of Damocles.exe and of the package's node.exe.
beforeAll(() => {
  if (process.platform !== 'win32') return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-cmd-'));
  const place = (relative: string, from: string | Buffer): void => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof from === 'string') fs.copyFileSync(from, target);
    else fs.writeFileSync(target, from);
  };
  place('app/Damocles.exe', process.execPath);
  place('app/resources/bin/damocles.cmd', path.join(RESOURCES, 'bin', 'damocles.cmd'));
  place('app/resources/app.asar.unpacked/dist/cli.js', Buffer.from(ECHO));
  place('server/node/node.exe', process.execPath);
  place('server/bin/remote-cli/damocles.cmd', path.join(RESOURCES, 'server-bin', 'remote-cli', 'damocles.cmd'));
  place('server/dist/cli-remote.js', Buffer.from(ECHO));
});

afterAll(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

// cmd.exe with delayed expansion on, as a registry DelayedExpansion=1 turns it on for every cmd
function run(script: string, args: readonly string[]): Promise<{ readonly code: number | null; readonly stdout: string }> {
  const cmd = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, ['/d', '/v:on', '/c', path.join(root, script), ...args], { env: { SystemRoot: process.env['SystemRoot'] ?? '' }, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

describe.runIf(process.platform === 'win32')('the damocles command\'s .cmd scripts under delayed expansion', () => {
  it('pass a ! in an argument through unchanged', async () => {
    expect(await run('app/resources/bin/damocles.cmd', ['C:\\work\\a!b!.txt'])).toEqual({ code: 0, stdout: JSON.stringify(['C:\\work\\a!b!.txt']) });
    expect(await run('server/bin/remote-cli/damocles.cmd', ['C:\\srv\\x!y!'])).toEqual({ code: 0, stdout: JSON.stringify(['C:\\srv\\x!y!']) });
  });

  it('end the setlocal and exit with Node\'s exit code', async () => {
    for (const script of ['app/resources/bin/damocles.cmd', 'server/bin/remote-cli/damocles.cmd']) {
      expect(fs.readFileSync(path.join(root, script), 'utf8').trimEnd().split('\r\n').at(-1), script).toBe('endlocal & exit /b %ERRORLEVEL%');
      expect(await run(script, ['--exit=3']), script).toEqual({ code: 3, stdout: JSON.stringify(['--exit=3']) });
    }
  });
});
