import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

// `paths.ts` resolves `homedir()` at import time, so these must exist before any import runs.
const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-evaluator-'));
  return {
    tmpRoot: root,
    fakeHome: nodePath.join(root, 'home'),
    fakeWorkspace: nodePath.join(root, 'workspace'),
  };
});

// Redirects `~` at the settings paths so the precedence tests read fixtures rather than the real
// user's `.claude`/`.damocles` files.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

import * as vscode from 'vscode';
import { EvaluatorManager } from '../evaluator-manager';
import { PermissionState } from '../../state';
import { DAMOCLES_PLANS_DIR } from '../../../paths';
import type { PermissionMode } from '../../types';

/**
 * Every evaluator built by a test, disposed afterwards. Each one registers two watchers with the
 * vscode mock’s module-level registry; leaving them behind would order-poison any future test that
 * asserts on it.
 */
const evaluators: EvaluatorManager[] = [];

const buildEvaluator = (overrides: Partial<Pick<PermissionState, 'permissionMode' | 'dangerouslySkipPermissions'>> = {}) => {
  const state = new PermissionState();
  state.permissionMode = overrides.permissionMode ?? 'default';
  state.dangerouslySkipPermissions = overrides.dangerouslySkipPermissions ?? false;
  const evaluator = new EvaluatorManager(state);
  evaluators.push(evaluator);
  return evaluator;
};

afterEach(() => {
  while (evaluators.length) evaluators.pop()!.dispose();
});

const planFile = (name: string) => path.join(DAMOCLES_PLANS_DIR, name);

function writeSettings(
  root: string,
  dir: '.damocles' | '.claude',
  file: 'settings.json' | 'settings.local.json',
  permissions: Record<string, string[]>,
): void {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, file), JSON.stringify({ permissions }), 'utf-8');
}

beforeEach(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(fakeWorkspace, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('EvaluatorManager.evaluate — DAMOCLES_PLANS_DIR auto-allow', () => {
  const modes: PermissionMode[] = ['default', 'plan', 'acceptEdits'];

  for (const mode of modes) {
    it(`allows Write to <DAMOCLES_PLANS_DIR>/<slug>.md in ${mode} mode`, async () => {
      const evaluator = buildEvaluator({ permissionMode: mode });
      const result = await evaluator.evaluate('Write', { file_path: planFile('foo.md') }, null);
      expect(result).toBe('allow');
    });
  }

  it('allows Edit to <DAMOCLES_PLANS_DIR>/<slug>.md', async () => {
    const evaluator = buildEvaluator();
    const result = await evaluator.evaluate('Edit', { file_path: planFile('foo.md') }, null);
    expect(result).toBe('allow');
  });

  it('asks for Write to a workspace-relative .md file', async () => {
    const evaluator = buildEvaluator();
    const workspaceFile = path.resolve('foo.md');
    const result = await evaluator.evaluate('Write', { file_path: workspaceFile }, null);
    expect(result).toBe('ask');
  });

  it('asks for Write that uses .. traversal to escape DAMOCLES_PLANS_DIR (path.resolve neutralizes ..)', async () => {
    const evaluator = buildEvaluator();
    const traversal = path.join(DAMOCLES_PLANS_DIR, '..', '.credentials.json');
    const result = await evaluator.evaluate('Write', { file_path: traversal }, null);
    expect(result).toBe('ask');
  });

  it('asks for Write to <DAMOCLES_PLANS_DIR>/<slug>.txt (non-.md extension)', async () => {
    const evaluator = buildEvaluator();
    const result = await evaluator.evaluate('Write', { file_path: planFile('foo.txt') }, null);
    expect(result).toBe('ask');
  });

  it('asks for Write to a sibling directory whose name shares the plans/ prefix', async () => {
    const evaluator = buildEvaluator();
    const lookalike = `${path.resolve(DAMOCLES_PLANS_DIR)}-evil${path.sep}foo.md`;
    const result = await evaluator.evaluate('Write', { file_path: lookalike }, null);
    expect(result).toBe('ask');
  });

  it('does not affect Bash commands that mention plan files', async () => {
    const evaluator = buildEvaluator();
    const result = await evaluator.evaluate(
      'Bash',
      { command: `rm ${planFile('foo.md')}` },
      null,
    );
    expect(result).toBe('ask');
  });
});

describe('EvaluatorManager.evaluate — settings-file precedence', () => {
  const pushCommand = { command: 'git push origin main' };

  it('honours a rule in ~/.damocles/settings.json with no .claude file present', async () => {
    writeSettings(fakeHome, '.damocles', 'settings.json', { allow: ['Bash(git push:*)'] });
    const evaluator = buildEvaluator();
    expect(await evaluator.evaluate('Bash', pushCommand, fakeWorkspace)).toBe('allow');
  });

  it('still honours a rule in ~/.claude/settings.json', async () => {
    writeSettings(fakeHome, '.claude', 'settings.json', { allow: ['Bash(git push:*)'] });
    const evaluator = buildEvaluator();
    expect(await evaluator.evaluate('Bash', pushCommand, fakeWorkspace)).toBe('allow');
  });

  it('lets a workspace .damocles/settings.json deny beat a ~/.damocles/settings.json allow', async () => {
    writeSettings(fakeWorkspace, '.damocles', 'settings.json', { deny: ['Bash(git push:*)'] });
    writeSettings(fakeHome, '.damocles', 'settings.json', { allow: ['Bash(git push:*)'] });
    const evaluator = buildEvaluator();
    expect(await evaluator.evaluate('Bash', pushCommand, fakeWorkspace)).toBe('deny');
  });

  it('lets a workspace .damocles/settings.local.json allow beat both the project deny and the home rule', async () => {
    writeSettings(fakeWorkspace, '.damocles', 'settings.local.json', { allow: ['Bash(git push:*)'] });
    writeSettings(fakeWorkspace, '.damocles', 'settings.json', { deny: ['Bash(git push:*)'] });
    writeSettings(fakeHome, '.damocles', 'settings.json', { deny: ['Bash(git push:*)'] });
    const evaluator = buildEvaluator();
    expect(await evaluator.evaluate('Bash', pushCommand, fakeWorkspace)).toBe('allow');
  });

  it('lets a workspace .damocles/settings.local.json allow beat a .claude/settings.local.json deny in the same tier', async () => {
    writeSettings(fakeWorkspace, '.damocles', 'settings.local.json', { allow: ['Bash(git push:*)'] });
    writeSettings(fakeWorkspace, '.claude', 'settings.local.json', { deny: ['Bash(git push:*)'] });
    const evaluator = buildEvaluator();
    expect(await evaluator.evaluate('Bash', pushCommand, fakeWorkspace)).toBe('allow');
  });

  it('produces the pre-change result when only .claude files are present', async () => {
    writeSettings(fakeWorkspace, '.claude', 'settings.local.json', { allow: ['Bash(git push:*)'] });
    writeSettings(fakeWorkspace, '.claude', 'settings.json', { deny: ['Bash(git push:*)'] });
    const evaluator = buildEvaluator();
    expect(await evaluator.evaluate('Bash', pushCommand, fakeWorkspace)).toBe('allow');
  });
});

describe('EvaluatorManager settings watchers', () => {
  it('watches both .claude and .damocles settings files and disposes both', () => {
    const createWatcher = vi.spyOn(vscode.workspace, 'createFileSystemWatcher');
    const evaluator = buildEvaluator();

    expect(createWatcher.mock.calls.map(call => call[0])).toEqual([
      '**/.claude/settings*.json',
      '**/.damocles/settings*.json',
    ]);

    const watchers = createWatcher.mock.results.map(result => result.value as { disposed: boolean });
    expect(watchers).toHaveLength(2);
    expect(watchers.map(watcher => watcher.disposed)).toEqual([false, false]);

    evaluator.dispose();
    expect(watchers.map(watcher => watcher.disposed)).toEqual([true, true]);
    createWatcher.mockRestore();
  });

  it('drops the cached permissions when a watched settings file changes', async () => {
    const createWatcher = vi.spyOn(vscode.workspace, 'createFileSystemWatcher');
    const evaluator = buildEvaluator();
    const damoclesWatcher = createWatcher.mock.results[1]?.value as { emitChange: (p: string) => void };

    expect(await evaluator.evaluate('Bash', { command: 'git push origin main' }, fakeWorkspace)).toBe('ask');

    writeSettings(fakeWorkspace, '.damocles', 'settings.local.json', { allow: ['Bash(git push:*)'] });
    damoclesWatcher.emitChange(path.join(fakeWorkspace, '.damocles', 'settings.local.json'));

    expect(await evaluator.evaluate('Bash', { command: 'git push origin main' }, fakeWorkspace)).toBe('allow');
    evaluator.dispose();
    createWatcher.mockRestore();
  });
});
