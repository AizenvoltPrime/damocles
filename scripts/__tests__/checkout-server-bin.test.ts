import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs helper, no types
import { CHECKOUT_SERVER_BIN, DESKTOP_BUNDLES, SERVER_BUNDLES, writeCheckoutBrowserHelper, writeCheckoutServerBin } from '../../esbuild.config.mjs';
import { findBash } from '../../src/core/system-tools';
import { terminalBinFolder } from '../../src/desktop/daemon/server-package';

// stands in for dist/cli-remote.js: prints the arguments it got
const ECHO = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n';
const ARGS = ['/srv/a b!.txt', '--wait'];

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A checkout as the desktop build leaves it: dist/cli-remote.js and the scripts in the daemon's bin folder.
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'damocles-checkout-'));
  scratch.push(root);
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'cli-remote.js'), ECHO);
  writeCheckoutServerBin(terminalBinFolder(root, false));
  return root;
}

// the Node on PATH, which the scripts run
const env = (): NodeJS.ProcessEnv => ({ PATH: [dirname(process.execPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(delimiter), SystemRoot: process.env['SystemRoot'] ?? '' });

function run(file: string, args: readonly string[]): { readonly status: number | null; readonly stdout: string } {
  const result = spawnSync(file, args, { env: env(), encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: result.stdout };
}

describe('the loopback daemon in a checkout', () => {
  it('runs from a dist/ the desktop build fills with every bundle a server package carries', () => {
    for (const bundle of SERVER_BUNDLES) expect(DESKTOP_BUNDLES).toContain(bundle);
  });

  it('finds its terminals\' scripts where the desktop build writes them', () => {
    expect(terminalBinFolder('/checkout', false)).toBe(join('/checkout', CHECKOUT_SERVER_BIN));
    expect(terminalBinFolder('/package', true)).toBe(join('/package', 'bin'));
  });

  it.runIf(process.platform !== 'win32')('gives its terminals a damocles and a BROWSER that run the checkout\'s dist/cli-remote.js', () => {
    const bin = terminalBinFolder(checkout(), false);
    for (const script of ['remote-cli/damocles', 'helpers/browser.sh']) expect(statSync(join(bin, script)).mode & 0o777).toBe(0o755);
    expect(run(join(bin, 'remote-cli', 'damocles'), ARGS)).toEqual({ status: 0, stdout: JSON.stringify(ARGS) });
    expect(run(join(bin, 'helpers', 'browser.sh'), ['https://example.test/#!/a'])).toEqual({ status: 0, stdout: JSON.stringify(['--open-external', 'https://example.test/#!/a']) });
  });

  it.runIf(process.platform === 'win32')('gives its Windows terminals a damocles.cmd that runs the checkout\'s dist/cli-remote.js under delayed expansion', () => {
    const bin = terminalBinFolder(checkout(), false);
    const cmd = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe');
    expect(run(cmd, ['/d', '/v:on', '/c', join(bin, 'remote-cli', 'damocles.cmd'), ...ARGS])).toEqual({ status: 0, stdout: JSON.stringify(ARGS) });
    expect(existsSync(join(bin, 'helpers', 'browser.cmd'))).toBe(false);
  });

  // the address reaches the relay through no cmd.exe, so & and % in it stay as typed
  it.runIf(process.platform === 'win32')('gives its Windows terminals a BROWSER browser.exe that runs the checkout\'s dist/cli-remote.js', async () => {
    const bin = terminalBinFolder(checkout(), false);
    await writeCheckoutBrowserHelper(bin, process.arch);
    const url = 'https://example.test/cb?code=a&state=%PATH%^!';
    expect(run(join(bin, 'helpers', 'browser.exe'), [url])).toEqual({ status: 0, stdout: JSON.stringify(['--open-external', url]) });
  }, 600_000);

  // MSYS_NO_PATHCONV and MSYS2_ARG_CONV_EXCL turn off MSYS's own path rewriting, so only the scripts' cygpath names cli-remote.js
  it.runIf(process.platform === 'win32')('gives Git Bash in its Windows terminals a damocles and a BROWSER that run the checkout\'s dist/cli-remote.js', async () => {
    const bash = await findBash();
    if (bash === undefined) throw new Error('This test needs Git for Windows, whose sh runs the extensionless scripts');
    const bin = terminalBinFolder(checkout(), false);
    const args = ['C:\\work\\a b!.txt', '--wait'];
    const sh = (script: string, scriptArgs: readonly string[]) => spawnSync(join(dirname(bash), 'sh.exe'), [join(bin, script).replaceAll('\\', '/'), ...scriptArgs], {
      env: { ...env(), MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' }, encoding: 'utf8', windowsHide: true,
    });
    expect(sh('remote-cli/damocles', args)).toMatchObject({ status: 0, stdout: JSON.stringify(args) });
    expect(sh('helpers/browser.sh', ['https://example.test/?a=1&b=2'])).toMatchObject({ status: 0, stdout: JSON.stringify(['--open-external', 'https://example.test/?a=1&b=2']) });
  });
});
