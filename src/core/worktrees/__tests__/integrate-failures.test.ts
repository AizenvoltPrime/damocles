import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitCall, GitResult, GitRunner } from '../../scm/git-runner';
import { LocalizedError } from '../../../shared/localized-text';
import { apply, branchContained, isRewritten, settlePendingBase } from '../integrate';
import type { ChatWorktreeRecord, WorktreeRegistry } from '../registry';

const PROJECT = path.resolve('/work/app');
const WORKTREE = path.resolve('/worktrees/app/1');
const BASE = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

const record: ChatWorktreeRecord = {
  kind: 'chat',
  id: 'wt-1',
  repositoryRoot: PROJECT,
  worktreeRoot: WORKTREE,
  workingFolder: WORKTREE,
  projectPath: PROJECT,
  branch: 'damocles/chat-1',
  index: 1,
  baseCommit: BASE,
  createdAt: 0,
};

const registry = { get: () => record, update: async () => undefined } as unknown as WorktreeRegistry;

const ok = (stdout = ''): GitResult => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: '' });
const silentFailure = (exitCode: number): GitResult => ({ exitCode, stdout: Buffer.alloc(0), stderr: '' });

// Answers one Apply of a changed text file by argv; `failing` answers the call it matches.
function runner(failing: { readonly matches: (args: readonly string[]) => boolean; readonly result: GitResult }): GitRunner {
  return {
    git: { path: 'git', version: { major: 2, minor: 45, patch: 0 } },
    envFor: () => ({}),
    run: async (call: GitCall) => {
      const { args } = call;
      if (failing.matches(args)) return failing.result;
      if (args[0] === 'write-tree') return ok(`${TREE}\n`);
      if (args[0] === 'diff' && args.includes('--name-status')) return ok('M\0src/a.ts\0');
      if (args[0] === 'diff' && args.includes('--numstat')) return ok('1\t1\tsrc/a.ts\0');
      const output = args.find((arg) => arg.startsWith('--output='));
      if (output !== undefined) await fs.writeFile(output.slice('--output='.length), 'diff --git a/src/a.ts b/src/a.ts\n');
      return ok();
    },
  };
}

const isApplyCheck = (args: readonly string[]): boolean => args[0] === 'apply' && args.includes('--check');
const isApply = (args: readonly string[]): boolean => args[0] === 'apply' && !args.includes('--check');

async function failureOf(work: Promise<unknown>): Promise<LocalizedError> {
  const err: unknown = await work.then(() => undefined, (caught: unknown) => caught);
  expect(err).toBeInstanceOf(LocalizedError);
  return err as LocalizedError;
}

describe('a git call that fails with nothing on stderr', () => {
  it.each([1, 128])('names git apply --check and its exit code %i', async (exitCode) => {
    const err = await failureOf(apply(record, runner({ matches: isApplyCheck, result: silentFailure(exitCode) }), registry));
    expect(err.text).toEqual({ message: '{0} failed with exit code {1}.', args: ['git apply --check', String(exitCode)] });
  });

  it.each([1, 128])('names git apply and its exit code %i when it left no conflict', async (exitCode) => {
    const err = await failureOf(apply(record, runner({ matches: isApply, result: silentFailure(exitCode) }), registry));
    expect(err.text).toEqual({ message: '{0} failed with exit code {1}.', args: ['git apply', String(exitCode)] });
  });

  it('names git merge-base and its exit code', async () => {
    const err = await failureOf(isRewritten(record, runner({ matches: (args) => args[0] === 'merge-base', result: silentFailure(128) }), 'main'));
    expect(err.text).toEqual({ message: '{0} failed with exit code {1}.', args: ['git merge-base', '128'] });
  });

  it('shows git\'s own words as written when it said why', async () => {
    const err = await failureOf(apply(record, runner({ matches: isApplyCheck, result: { exitCode: 1, stdout: Buffer.alloc(0), stderr: 'error: patch failed: src/a.ts:1\n' } }), registry));
    expect(err.text).toEqual({ message: '{0}', args: ['error: patch failed: src/a.ts:1'] });
  });

  it('bounds git\'s own words', async () => {
    const err = await failureOf(apply(record, runner({ matches: isApplyCheck, result: { exitCode: 1, stdout: Buffer.alloc(0), stderr: 'x'.repeat(5000) } }), registry));
    expect(err.text).toEqual({ message: '{0}', args: ['x'.repeat(2000)] });
  });

  it('names git merge-base and its exit code when it checks the branch is contained', async () => {
    const err = await failureOf(branchContained(record, runner({ matches: (args) => args[0] === 'merge-base', result: silentFailure(128) })));
    expect(err.text).toEqual({ message: '{0} failed with exit code {1}.', args: ['git merge-base', '128'] });
  });

  it('names git merge-base and its exit code when it settles a pending base', async () => {
    const pending: ChatWorktreeRecord = { ...record, pendingBase: { commit: 'c'.repeat(40), side: 'project' } };
    const pendingRegistry = { get: () => pending, update: async () => undefined, settlePendingBase: async () => undefined } as unknown as WorktreeRegistry;
    const noOperation = { matches: (args: readonly string[]) => args[0] === 'rev-parse' && args.includes('--git-path'), result: ok(Array.from({ length: 6 }, (_, i) => `no-marker-${i}`).join('\n')) };
    const failing = runner({ matches: (args) => args[0] === 'merge-base', result: silentFailure(128) });
    const git: GitRunner = { ...failing, run: (call) => (noOperation.matches(call.args) ? Promise.resolve(noOperation.result) : failing.run(call)) };
    const err = await failureOf(settlePendingBase(pending, git, pendingRegistry));
    expect(err.text).toEqual({ message: '{0} failed with exit code {1}.', args: ['git merge-base', '128'] });
  });

  it('names git restore and its exit code when the binary files could not be copied', async () => {
    const BLOB = 'd'.repeat(40);
    const base = runner({ matches: (args) => args[0] === 'restore', result: silentFailure(128) });
    const git: GitRunner = {
      ...base,
      run: async (call) => {
        const { args } = call;
        if (args[0] === 'diff' && args.includes('--name-status')) return ok('A\0img.png\0');
        if (args[0] === 'diff' && args.includes('--numstat')) return ok('-\t-\timg.png\0');
        if (args[0] === 'diff' && args.includes('--raw')) return ok(`:000000 100644 ${'0'.repeat(40)} ${BLOB} A\0img.png\0`);
        // the binary file is copied as an object, so the text patch is empty
        const output = args.find((arg) => arg.startsWith('--output='));
        if (output !== undefined) {
          await fs.writeFile(output.slice('--output='.length), '');
          return ok();
        }
        return base.run(call);
      },
    };
    const err = await failureOf(apply(record, git, registry));
    expect(err.text).toMatchObject({
      message: 'The binary files could not all be copied to the project folder ({0}). Already copied: {1}',
      args: [{ message: '{0} failed with exit code {1}.', args: ['git restore', '128'] }, { message: 'none' }],
    });
  });
});
