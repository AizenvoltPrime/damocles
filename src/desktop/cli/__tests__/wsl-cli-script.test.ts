import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findBash } from '../../../core/system-tools';

// resources/bin/damocles run by a POSIX sh (Git for Windows' on Windows) inside a copy of the app's layout, where
// Damocles.exe, the app's Linux binary, wslpath and uname are stand-ins that print what reached them.
const SCRIPT = path.join(__dirname, '..', '..', '..', '..', 'resources', 'bin', 'damocles');
const PRINT_ARGS = '#!/bin/sh\nfor arg do printf \'%s\\n\' "$arg"; done\nprintf \'ELECTRON_RUN_AS_NODE=%s\\nWSLENV=%s\\n\' "${ELECTRON_RUN_AS_NODE:-}" "${WSLENV:-}"\n';

let sh: string;
beforeAll(async () => {
  if (process.platform !== 'win32') {
    sh = '/bin/sh';
    return;
  }
  const bash = await findBash();
  if (bash === undefined) throw new Error('Git for Windows\' sh is needed for this test');
  // Git\bin\sh.exe puts Git's own tools first on PATH; usr\bin\sh.exe runs with the PATH it is given
  sh = path.join(path.dirname(path.dirname(bash)), 'usr', 'bin', 'sh.exe');
});

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })));
});

// windowsApp: the layout holds Damocles.exe, as the Windows app's does; the Linux package's has only its own binary
async function layout(uname: { readonly r: string; readonly s: string }, windowsApp = true): Promise<{ readonly app: string; readonly cwd: string; readonly env: NodeJS.ProcessEnv }> {
  const app = await fs.mkdtemp(path.join(os.tmpdir(), 'damocles-cli-script-'));
  folders.push(app);
  const bin = path.join(app, 'resources', 'bin');
  const fakes = path.join(app, 'fakes');
  const cwd = path.join(app, 'notes');
  await Promise.all([fs.mkdir(bin, { recursive: true }), fs.mkdir(fakes), fs.mkdir(cwd)]);
  const write = async (file: string, text: string): Promise<void> => {
    await fs.writeFile(file, text);
    await fs.chmod(file, 0o755);
  };
  await fs.copyFile(SCRIPT, path.join(bin, 'damocles'));
  await fs.chmod(path.join(bin, 'damocles'), 0o755);
  if (windowsApp) await write(path.join(app, 'Damocles.exe'), PRINT_ARGS);
  await write(path.join(app, 'damocles'), PRINT_ARGS);
  await write(path.join(fakes, 'wslpath'), '#!/bin/sh\n[ "$1" = -w ] || exit 9\nprintf \'C:\\\\Damocles\\\\resources\\\\app.asar.unpacked\\\\dist\\\\cli.js\\n\'\n');
  await write(path.join(fakes, 'uname'), `#!/bin/sh\ncase $1 in -r) echo '${uname.r}' ;; -s) echo '${uname.s}' ;; esac\n`);
  // Git for Windows has cygpath; elsewhere a stand-in maps /x/y to C:/x/y as -m would
  if (process.platform !== 'win32') await write(path.join(fakes, 'cygpath'), '#!/bin/sh\n[ "$1" = -m ] || exit 9\nprintf \'C:%s\\n\' "$2"\n');
  // Windows names PATH in any case; sh's own folder holds dirname and readlink
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [fakes, path.dirname(sh), env[pathKey] ?? ''].join(path.delimiter);
  for (const key of Object.keys(env)) if (/^(WSL_DISTRO_NAME|WSLENV|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
  return { app, cwd, env };
}

const run = (app: string, cwd: string, env: NodeJS.ProcessEnv, args: readonly string[]) => spawnSync(sh, [path.join(app, 'resources', 'bin', 'damocles'), ...args], { cwd, env, encoding: 'utf8' });
// the working folder as sh names it, which may map a Windows temp folder to /tmp
const shPwd = (cwd: string, env: NodeJS.ProcessEnv): string => execFileSync(sh, ['-c', 'printf %s "$PWD"'], { cwd, env, encoding: 'utf8' });

describe('resources/bin/damocles in a WSL shell', () => {
  it('runs Damocles.exe as Node with cli.js, --remote wsl+<distro>, absolute Linux paths and ELECTRON_RUN_AS_NODE crossing through WSLENV', async () => {
    const { app, cwd, env } = await layout({ r: '5.15.167.4-microsoft-standard-WSL2', s: 'Linux' });
    const pwd = shPwd(cwd, env);
    const result = run(app, cwd, { ...env, WSL_DISTRO_NAME: 'Ubuntu-24.04', WSLENV: 'USERPROFILE/p' }, ['--user-data-dir', 'C:\\Users\\ada\\profile', '.', '--wait', 'README.md:12', '/etc/hosts', '--remote', 'ssh+prod', '', '--diff', 'a b.txt', '--', '-dash', '']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')).toEqual([
      'C:\\Damocles\\resources\\app.asar.unpacked\\dist\\cli.js',
      '--remote',
      'wsl+Ubuntu-24.04',
      // the app's own folder on this computer, passed as typed
      '--user-data-dir',
      'C:\\Users\\ada\\profile',
      `${pwd}/.`,
      '--wait',
      `${pwd}/README.md:12`,
      '/etc/hosts',
      // an option's value and an empty argument are passed as typed
      '--remote',
      'ssh+prod',
      '',
      '--diff',
      `${pwd}/a b.txt`,
      '--',
      `${pwd}/-dash`,
      '',
      'ELECTRON_RUN_AS_NODE=1',
      'WSLENV=ELECTRON_RUN_AS_NODE/w:USERPROFILE/p',
      '',
    ]);
  });

  // a Windows process started in a distro folder works in its \\wsl.localhost path, whose connection keeps the distro running
  it('starts Damocles.exe in the app\'s own folder, never the distro folder it was run in', async () => {
    const { app, cwd, env } = await layout({ r: '5.15.167.4-microsoft-standard-WSL2', s: 'Linux' });
    await fs.writeFile(path.join(app, 'Damocles.exe'), '#!/bin/sh\npwd -P\n');
    const result = run(app, cwd, { ...env, WSL_DISTRO_NAME: 'Ubuntu-24.04' }, ['.']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${execFileSync(sh, ['-c', 'cd "$1" && pwd -P', 'sh', app], { env, encoding: 'utf8' }).trim()}\n`);
  });

  it('detects WSL from uname -r when WSL_DISTRO_NAME is unset, and refuses since the distro is then unknown', async () => {
    const { app, cwd, env } = await layout({ r: '4.4.0-19041-Microsoft', s: 'Linux' });
    const result = run(app, cwd, env, ['.']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('damocles: WSL_DISTRO_NAME is not set, so the distro to open in is unknown.\n');
  });

  it('runs the Linux package\'s own binary inside WSL, where no Damocles.exe sits beside it', async () => {
    const { app, cwd, env } = await layout({ r: '5.15.167.4-microsoft-standard-WSL2', s: 'Linux' }, false);
    const result = run(app, cwd, { ...env, WSL_DISTRO_NAME: 'Ubuntu-24.04' }, ['README.md']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const resources = execFileSync(sh, ['-c', 'cd "$1" && pwd -P', 'sh', path.join(app, 'resources')], { env, encoding: 'utf8' }).trim();
    expect(result.stdout.split('\n')).toEqual([`${resources}/app.asar.unpacked/dist/cli.js`, 'README.md', 'ELECTRON_RUN_AS_NODE=1', 'WSLENV=', '']);
  });

  it('runs Damocles.exe with cli.js\'s Windows path from Git Bash, MSYS2 or Cygwin, as VS Code\'s code.sh does', async () => {
    for (const s of ['MINGW64_NT-10.0-26100', 'MSYS_NT-10.0-26100', 'CYGWIN_NT-10.0-26100']) {
      const { app, cwd, env } = await layout({ r: '3.5.4-0bc1222b.x86_64', s });
      const result = run(app, cwd, env, ['README.md', '--wait']);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const resources = execFileSync(sh, ['-c', 'cd "$1" && pwd -P', 'sh', path.join(app, 'resources')], { env, encoding: 'utf8' }).trim();
      const cli = process.platform === 'win32' ? execFileSync(path.join(path.dirname(sh), 'cygpath.exe'), ['-m', `${resources}/app.asar.unpacked/dist/cli.js`], { env, encoding: 'utf8' }).trim() : `C:${resources}/app.asar.unpacked/dist/cli.js`;
      expect(cli).toMatch(/^[A-Za-z]:\//);
      // Damocles.exe is the stand-in that prints, where the Linux binary would print the same lines
      await fs.rm(path.join(app, 'damocles'));
      expect(run(app, cwd, env, ['README.md', '--wait']).stdout.split('\n')).toEqual([cli, 'README.md', '--wait', 'ELECTRON_RUN_AS_NODE=1', 'WSLENV=', '']);
    }
  });

  it('runs the app\'s own binary with cli.js and the arguments as given outside WSL', async () => {
    const { app, cwd, env } = await layout({ r: '6.8.0-45-generic', s: 'Linux' });
    const result = run(app, cwd, env, ['README.md', '--wait']);
    expect(result.status).toBe(0);
    const resources = execFileSync(sh, ['-c', 'cd "$1" && pwd -P', 'sh', path.join(app, 'resources')], { env, encoding: 'utf8' }).trim();
    expect(result.stdout.split('\n')).toEqual([`${resources}/app.asar.unpacked/dist/cli.js`, 'README.md', '--wait', 'ELECTRON_RUN_AS_NODE=1', 'WSLENV=', '']);
  });
});
