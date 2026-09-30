import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createVsCodeAppPaths } from '../app-paths';
import { createVsCodePlatform } from '../index';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const EXT = path.join(REPO_ROOT, 'fixture-extension-root');

describe('VS Code AppPaths resolves the paths the extension used before AppPaths existed', () => {
  const paths = createVsCodeAppPaths(EXT);

  it('roots resources and unpacked files at the extension directory', () => {
    expect(paths.resourceRoot).toBe(EXT);
    expect(paths.unpackedRoot).toBe(EXT);
  });

  it('compass worker: compass/index.ts joined extensionPath, dist, compass-worker.js', () => {
    expect(paths.workerEntry('compass')).toBe(path.join(EXT, 'dist', 'compass-worker.js'));
  });

  it('usage stats worker: chat-panel/index.ts joined extensionUri.fsPath, dist, usage-stats-worker.js', () => {
    expect(paths.workerEntry('usageStats')).toBe(path.join(EXT, 'dist', 'usage-stats-worker.js'));
  });

  it('sentinel: the sibling of dist/extension.js when packaged, and <repo>/dist/sentinel.js from source', () => {
    const packagedDirname = path.join(EXT, 'dist');
    expect(paths.workerEntry('sentinel')).toBe(path.join(packagedDirname, 'sentinel.js'));
    const sourceDirname = path.join(REPO_ROOT, 'src', 'extension', 'pi-session', 'tools');
    expect(createVsCodeAppPaths(REPO_ROOT).workerEntry('sentinel')).toBe(
      path.join(sourceDirname, '..', '..', '..', '..', 'dist', 'sentinel.js'),
    );
  });

  it('every worker entry is an outfile esbuild.config.mjs writes', () => {
    const outfiles = [...readFileSync(path.join(REPO_ROOT, 'esbuild.config.mjs'), 'utf8').matchAll(/outfile: '([^']+)'/g)].map((m) => m[1]);
    for (const name of ['compass', 'usageStats', 'sentinel'] as const) {
      expect(outfiles).toContain(path.relative(EXT, paths.workerEntry(name)).split(path.sep).join('/'));
    }
  });

  it('createVsCodePlatform roots AppPaths at context.extensionUri.fsPath', () => {
    const context = {
      extensionUri: { fsPath: EXT },
      subscriptions: [],
      secrets: {},
      globalState: {},
      workspaceState: {},
      extension: { packageJSON: { version: '9.9.9' } },
    } as unknown as vscode.ExtensionContext;
    expect(createVsCodePlatform(context).paths.workerEntry('compass')).toBe(paths.workerEntry('compass'));
  });

  it('the fake platform resolves the same layout for the same root', () => {
    const fake = createFakePlatform({ appRoot: EXT }).paths;
    for (const name of ['compass', 'usageStats', 'sentinel'] as const) {
      expect(fake.workerEntry(name)).toBe(paths.workerEntry(name));
    }
    expect([fake.resourceRoot, fake.unpackedRoot]).toEqual([paths.resourceRoot, paths.unpackedRoot]);
  });
});
