import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeLinkPath, FROZEN_THROUGH_ACTIVE_LINK, pointActiveLink, throughActiveLink } from '../active-link';

let base: string;
let runDir: string;
const log = vi.fn();

// a package root holding one file, so a removal through the link would show
function packageRoot(name: string): string {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'version.txt'), name);
  return root;
}

const shown = (): string => fs.readFileSync(path.join(activeLinkPath(runDir), 'dist', 'version.txt'), 'utf8');
// what pointActiveLink leaves beside the link besides the link itself
const leftovers = (): string[] => fs.readdirSync(runDir).filter((name) => name !== 'active');

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'active-link-'));
  runDir = path.join(base, 'run-0123456789abcdef');
  fs.mkdirSync(runDir);
  log.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('a path through the active link', () => {
  it('names a file under the root through the link, and any other file as it is', () => {
    const root = path.join(base, '3.8.0-linux-x64');
    const active = activeLinkPath(runDir);
    expect(throughActiveLink(root, active, path.join(root, 'dist', 'askpass-main.js'))).toBe(path.join(active, 'dist', 'askpass-main.js'));
    expect(throughActiveLink(root, active, path.join(root, '..node', 'node'))).toBe(path.join(active, '..node', 'node'));
    expect(throughActiveLink(root, active, path.join(base, 'node', 'node'))).toBe(path.join(base, 'node', 'node'));
    expect(throughActiveLink(root, active, `${root}-old${path.sep}node`)).toBe(`${root}-old${path.sep}node`);
    expect(throughActiveLink(root, active, root)).toBe(root);
  });
});

describe('what a shell started by one server version names through the active link', () => {
  // A later package behind the link serves every shell an earlier one started, so each entry stays once released; a rename
  // edits this pin, the list and docs/invariants.md "The damocles command" together.
  it('is the frozen list', () => {
    expect(FROZEN_THROUGH_ACTIVE_LINK).toEqual({
      paths: {
        all: [
          'bin/remote-cli/damocles',
          'dist/askpass-main.js',
          'resources/shell-integration/shellIntegration-bash.sh',
          'resources/shell-integration/shellIntegration-env.zsh',
          'resources/shell-integration/shellIntegration-login.zsh',
          'resources/shell-integration/shellIntegration-profile.zsh',
          'resources/shell-integration/shellIntegration-rc.zsh',
          'resources/shell-integration/shellIntegration.fish',
          'resources/shell-integration/shellIntegration.ps1',
        ],
        posix: ['bin/helpers/browser.sh', 'dist/git-credential/git-credential-relay.sh', 'node/node'],
        win32: ['bin/remote-cli/damocles.cmd', 'bin/helpers/browser.exe', 'dist/git-credential/git-credential-relay.cmd', 'node/node.exe'],
      },
      reads: [
        { names: ['DAMOCLES_ASKPASS_NODE', 'DAMOCLES_ASKPASS_MAIN'], by: ['dist/git-credential/git-credential-relay.sh', 'dist/git-credential/git-credential-relay.cmd'] },
        { names: ['DAMOCLES_ASKPASS_HANDLE', 'DAMOCLES_CREDENTIAL_NONCE', '--takeover'], by: ['dist/askpass-main.js'] },
        { names: ['DAMOCLES_CLI_HOOK'], by: ['dist/cli-remote.js'] },
      ],
    });
  });
});

describe('the leftovers of a start that ended between the steps', () => {
  it('are unlinked as links before the link is pointed, the package they name kept, and anything else at such a name left', async () => {
    const first = packageRoot('3.7.0');
    const second = packageRoot('3.8.0');
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(first, path.join(runDir, 'active.4242.0123456789ab.new'), type);
    fs.symlinkSync(first, path.join(runDir, 'active.4242.0123456789ab.old'), type);
    fs.mkdirSync(path.join(runDir, 'active.4243.0123456789ab.old'));
    await pointActiveLink(runDir, second, log);
    expect(leftovers()).toEqual(['active.4243.0123456789ab.old']);
    expect(shown()).toBe('3.8.0');
    expect(fs.readFileSync(path.join(first, 'dist', 'version.txt'), 'utf8')).toBe('3.7.0');
  });
});

describe('the active link', () => {
  it('refuses to replace a real folder at the link\'s name, moves nothing and leaves no temporary link', async () => {
    fs.mkdirSync(path.join(activeLinkPath(runDir), 'dist'), { recursive: true });
    await expect(pointActiveLink(runDir, packageRoot('3.8.0'), log)).rejects.toThrow(`${activeLinkPath(runDir)} is not a link`);
    expect(leftovers()).toEqual([]);
    expect(fs.lstatSync(activeLinkPath(runDir)).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(activeLinkPath(runDir), 'dist'))).toBe(true);
  });
});

describe.runIf(process.platform !== 'win32')('the active link on POSIX', () => {
  it('is a symlink to the daemon\'s root, which the next daemon replaces in one rename', async () => {
    const first = packageRoot('3.7.0-linux-x64');
    const second = packageRoot('3.8.0-linux-x64');
    await pointActiveLink(runDir, first, log);
    expect(fs.lstatSync(activeLinkPath(runDir)).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(activeLinkPath(runDir))).toBe(first);
    expect(shown()).toBe('3.7.0-linux-x64');
    // a reader never finds the link missing while it is replaced
    let reading = true;
    const misses: string[] = [];
    const reader = (async () => {
      while (reading) {
        try {
          fs.readlinkSync(activeLinkPath(runDir));
        } catch (err) {
          misses.push((err as NodeJS.ErrnoException).code ?? 'unknown');
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    for (let round = 0; round < 50; round++) await pointActiveLink(runDir, round % 2 === 0 ? second : first, log);
    reading = false;
    await reader;
    expect(misses).toEqual([]);
    expect(fs.readlinkSync(activeLinkPath(runDir))).toBe(first);
    await pointActiveLink(runDir, second, log);
    expect(shown()).toBe('3.8.0-linux-x64');
    expect(leftovers()).toEqual([]);
    // the earlier package is untouched
    expect(fs.readFileSync(path.join(first, 'dist', 'version.txt'), 'utf8')).toBe('3.7.0-linux-x64');
  });
});

describe.runIf(process.platform === 'win32')('the active link on Windows', () => {
  it('is a junction to the daemon\'s root; the next daemon swaps it in two renames and unlinks the old one, whose package stays', async () => {
    const first = packageRoot('3.7.0-win32-x64');
    const second = packageRoot('3.8.0-win32-x64');
    await pointActiveLink(runDir, first, log);
    expect(fs.lstatSync(activeLinkPath(runDir)).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(activeLinkPath(runDir))).toBe(fs.realpathSync(first));
    expect(shown()).toBe('3.7.0-win32-x64');
    await pointActiveLink(runDir, second, log);
    expect(fs.realpathSync(activeLinkPath(runDir))).toBe(fs.realpathSync(second));
    expect(shown()).toBe('3.8.0-win32-x64');
    expect(leftovers()).toEqual([]);
    expect(fs.readFileSync(path.join(first, 'dist', 'version.txt'), 'utf8')).toBe('3.7.0-win32-x64');
    await pointActiveLink(runDir, first, log);
    expect(shown()).toBe('3.7.0-win32-x64');
    expect(fs.readFileSync(path.join(second, 'dist', 'version.txt'), 'utf8')).toBe('3.8.0-win32-x64');
    expect(leftovers()).toEqual([]);
  });

  it('counts a swap whose old junction cannot be unlinked as done, logging the leftover the next start sweeps', async () => {
    await pointActiveLink(runDir, packageRoot('3.7.0-win32-x64'), log);
    const unlink = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async (file) => {
      if (String(file).endsWith('.old')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return unlink(file);
    });
    await pointActiveLink(runDir, packageRoot('3.8.0-win32-x64'), log);
    expect(shown()).toBe('3.8.0-win32-x64');
    const [left] = leftovers();
    expect(left).toMatch(/^active\.[0-9]+\.[0-9a-f]{12}\.old$/);
    expect(log).toHaveBeenCalledWith(`[daemon] could not unlink ${path.join(runDir, left!)}, which the next start removes: EPERM: operation not permitted`);
    vi.restoreAllMocks();
    await pointActiveLink(runDir, packageRoot('3.9.0-win32-x64'), log);
    expect(leftovers()).toEqual([]);
    expect(fs.readFileSync(path.join(base, '3.7.0-win32-x64', 'dist', 'version.txt'), 'utf8')).toBe('3.7.0-win32-x64');
  });
});
