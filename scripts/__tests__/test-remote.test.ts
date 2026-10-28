import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
// @ts-expect-error -- plain .mjs helper, no types
import { fixtureImagesIn, fixturesToRemove, grepOf, playwrightArgs, prebuiltParts, selection, serverPackageTargets, serverTargetsFor, specFilesOf } from '../test-remote.mjs';
// @ts-expect-error -- plain .mjs helper, no types
import { npmCliPath } from '../npm-cli.mjs';

describe('test-remote --grep', () => {
  it('reads every spelling of --grep', () => {
    expect(grepOf(['--grep', '@ssh', '--workers=1'])).toBe('@ssh');
    expect(grepOf(['--grep=@windows-target'])).toBe('@windows-target');
    expect(grepOf(['-g', 'ssh-install'])).toBe('ssh-install');
    expect(grepOf(['e2e/remote/ssh-connect.spec.ts'])).toBeUndefined();
  });

  it('runs a target suite only when --grep names its tag, and the Docker suite unless --grep names only target tags', () => {
    expect(selection(undefined)).toEqual({ targets: [], docker: true });
    expect(selection('@ssh')).toEqual({ targets: [], docker: true });
    expect(selection('@windows-target')).toEqual({ targets: ['@windows-target'], docker: false });
    expect(selection('@darwin-target|@windows-target')).toEqual({ targets: ['@windows-target', '@darwin-target'], docker: false });
    expect(selection('@windows-target|ssh-connect')).toEqual({ targets: ['@windows-target'], docker: true });
    expect(selection('windows')).toEqual({ targets: [], docker: true });
  });
});

describe('the Playwright arguments', () => {
  it('adds the dev project as one token, so a spec after it stays a spec, and leaves a project the caller names alone', () => {
    expect(playwrightArgs(['ssh-connect.spec.ts'])).toEqual(['--config', 'playwright.remote.config.ts', '--project=dev', 'ssh-connect.spec.ts']);
    expect(playwrightArgs(['--project', 'screenshots'])).toEqual(['--config', 'playwright.remote.config.ts', '--project', 'screenshots']);
    expect(playwrightArgs(['--grep', '@packaged'], true)).toEqual(['--config', 'playwright.remote.config.ts', '--grep', '@packaged']);
  });
});

describe('what test-remote builds', () => {
  it('builds the images the selected specs start: ubuntu for any, and alpine or centos7 only where a spec names them', () => {
    expect(fixtureImagesIn([])).toEqual([]);
    expect(fixtureImagesIn(["await sshd('prod-1');"])).toEqual(['ubuntu']);
    expect(fixtureImagesIn(["await sshd('prod-1', { image: 'centos7' });", "await sshd('a', { image:'alpine', noexecHome: true });"])).toEqual(['ubuntu', 'alpine', 'centos7']);
  });

  it('builds the Alpine server package only with the alpine image, and a target suite\'s package only when it runs', () => {
    expect(serverTargetsFor([], [], 'x64')).toEqual([]);
    expect(serverTargetsFor(['ubuntu', 'centos7'], [], 'x64')).toEqual(['linux-x64']);
    expect(serverTargetsFor(['ubuntu', 'alpine'], [], 'arm64')).toEqual(['linux-arm64', 'alpine-arm64']);
    expect(serverTargetsFor([], ['@windows-target'], 'x64')).toEqual(['win32-x64']);
  });

  it('reads the selected spec files from Playwright\'s JSON listing, each once', () => {
    const report = { config: { rootDir: '/repo/e2e/remote' }, suites: [{ file: 'ssh-install.spec.ts' }, { file: 'ssh-install.spec.ts' }, { file: 'reconnect.spec.ts' }] };
    expect(specFilesOf(report)).toEqual([resolve('/repo/e2e/remote', 'ssh-install.spec.ts'), resolve('/repo/e2e/remote', 'reconnect.spec.ts')]);
  });

  it('skips only the parts DAMOCLES_E2E_PREBUILT names, and refuses a name it does not know', () => {
    expect([...prebuiltParts(undefined)]).toEqual([]);
    expect([...prebuiltParts('app, server-packages')]).toEqual(['app', 'server-packages']);
    expect(() => prebuiltParts('server-packages,images')).toThrow('DAMOCLES_E2E_PREBUILT names images; it takes app, server-packages');
  });

  it('builds only the server packages --build-server-packages names, each a server target', () => {
    expect(serverPackageTargets('linux-x64,alpine-x64')).toEqual(['linux-x64', 'alpine-x64']);
    expect(() => serverPackageTargets('linux-x64,linux-s390x')).toThrow('not linux-s390x');
    expect(() => serverPackageTargets(undefined)).toThrow('--build-server-packages takes');
  });
});

describe('the fixtures test-remote removes', () => {
  const listed = ['c-own\t4242', 'c-live\t5151', 'c-dead\t6161', 'c-unlabelled\t', ''].join('\n');
  const alive = (pid: number): boolean => pid === 4242 || pid === 5151;

  it('before a run, removes only fixtures whose run is no live process, so a concurrent run keeps its own', () => {
    expect(fixturesToRemove(listed, { alive })).toEqual(['c-dead', 'c-unlabelled']);
  });

  it('after a run, removes that run\'s fixtures alone', () => {
    expect(fixturesToRemove(listed, { run: '4242', alive })).toEqual(['c-own']);
  });
});

describe('npm\'s CLI script', () => {
  it('is the one npm started the script with, else the npm bundled with this Node on each platform', () => {
    expect(npmCliPath({ npm_execpath: '/opt/npm/bin/npm-cli.js' }, 'linux', '/usr/bin/node')).toBe('/opt/npm/bin/npm-cli.js');
    expect(npmCliPath({}, 'linux', '/usr/local/bin/node')).toBe('/usr/local/lib/node_modules/npm/bin/npm-cli.js');
    expect(npmCliPath({}, 'darwin', '/opt/homebrew/bin/node')).toBe('/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js');
    expect(npmCliPath({}, 'win32', 'C:\\Program Files\\nodejs\\node.exe')).toBe('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js');
  });
});
