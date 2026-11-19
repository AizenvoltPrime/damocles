import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const { tmpRoot, home } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-worktree-rules-')));
  return { tmpRoot: root, home: nodePath.join(root, 'home') };
});

// the user's own home files must not answer for the project's
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { EvaluatorManager } from '../managers/evaluator-manager';
import { PermissionState } from '../state';
import { folderKey } from '../../workspace-folders/folder-key';
import { installWorktreeProjectLookup } from '../../worktrees/personal-config';

// docs/invariants.md "Worktree chats", Personal files: a chat worktree's settings.local.json files are its project's and
// apply only while the working folder and the project are both trusted.
const project = path.join(tmpRoot, 'project');
const worktree = path.join(tmpRoot, 'worktrees', 'project-abcdef', 'aaaaaaaa');
const disposables: { dispose(): void }[] = [];

function personalFile(dir: '.damocles' | '.claude', allow: string[]): void {
  const file = path.join(project, dir, 'settings.local.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow } }));
}

/** An evaluator whose trust answers from `trusted`, for a worktree open as a project of its own. */
function evaluatorFor(trusted: Set<string>): EvaluatorManager {
  const platform = createFakePlatform();
  const trust = { ...platform.trust, isTrusted: (folder: string) => trusted.has(folderKey(folder)) };
  const state = new PermissionState();
  state.cwd = worktree;
  const evaluator = new EvaluatorManager(state, { ...platform, trust });
  disposables.push(evaluator);
  return evaluator;
}

afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('a chat worktree trusted on its own', () => {
  it('applies its project\u2019s personal allow rules only while the project is trusted too, and drops them on its revoke', async () => {
    fs.mkdirSync(worktree, { recursive: true });
    personalFile('.damocles', ['WebFetch']);
    personalFile('.claude', ['WebSearch']);
    disposables.push(installWorktreeProjectLookup({
      projectOf: (folder) => (folderKey(folder) === folderKey(worktree) ? project : undefined),
      recordsOfProject: () => [],
      get: () => undefined,
      chatRecordFor: () => undefined,
    }));
    const trusted = new Set([folderKey(worktree)]);
    const evaluator = evaluatorFor(trusted);
    const rules = async () => [await evaluator.matchRule('WebFetch', { url: 'https://example.com' }, worktree), await evaluator.matchRule('WebSearch', { query: 'x' }, worktree)];

    expect(await rules()).toEqual([null, null]);

    trusted.add(folderKey(project));
    expect(await rules()).toEqual(['allow', 'allow']);

    trusted.delete(folderKey(project));
    expect(await rules()).toEqual([null, null]);
  });
});
