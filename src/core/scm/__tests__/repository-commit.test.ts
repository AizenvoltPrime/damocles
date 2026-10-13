import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitCall, GitRunner } from '../git-runner';
import { PLAIN_COMMIT, Repository } from '../repository';

const root = path.resolve('/work/repo');

function repository(): { repo: Repository; calls: GitCall[] } {
  const calls: GitCall[] = [];
  const runner: GitRunner = {
    git: { path: 'git', version: { major: 2, minor: 45, patch: 0 } },
    envFor: () => ({}),
    run: async (call) => {
      calls.push(call);
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '' };
    },
  };
  return { repo: new Repository({ root, gitDir: path.join(root, '.git'), commonDir: path.join(root, '.git'), kind: 'root', project: root }, runner), calls };
}

const COMMIT = ['-c', 'user.useConfigOnly=true', 'commit', '--quiet', '--allow-empty-message'];

describe('the commit argv', () => {
  it('passes the message on stdin and nothing else for a plain commit', async () => {
    const { repo, calls } = repository();
    expect(await repo.commit('Subject', PLAIN_COMMIT)).toEqual({ ok: true });
    expect(calls.map((call) => call.args)).toEqual([[...COMMIT, '--file', '-']]);
    expect(calls[0]!.input).toBe('Subject');
  });

  it('adds --amend, --signoff, -S, --allow-empty and --no-verify for the options that ask for them', async () => {
    const { repo, calls } = repository();
    await repo.commit('Subject', { ...PLAIN_COMMIT, amend: true, signoff: true, sign: true, empty: true, noVerify: true });
    expect(calls[0]!.args).toEqual([...COMMIT, '--file', '-', '--amend', '--signoff', '-S', '--allow-empty', '--no-verify']);
  });

  it('keeps HEAD\'s message with --no-edit when an amend has an empty message', async () => {
    const { repo, calls } = repository();
    await repo.commit('  ', { ...PLAIN_COMMIT, amend: true });
    expect(calls[0]!.args).toEqual([...COMMIT, '--no-edit', '--amend']);
    expect(calls[0]!.input).toBeUndefined();
  });

  it('creates the branch, stages and adds the saved files again before the commit, in one mutation', async () => {
    const { repo, calls } = repository();
    await repo.commit('Subject', { ...PLAIN_COMMIT, all: 'tracked', branch: 'feature/x', restage: ['a b.txt'] });
    expect(calls.map((call) => call.args)).toEqual([
      ['checkout', '-q', '-b', 'feature/x'],
      ['add', '-u', '--', '.'],
      ['add', '-A', '--', 'a b.txt'],
      [...COMMIT, '--file', '-'],
    ]);
    await expect(repository().repo.commit('Subject', { ...PLAIN_COMMIT, branch: '--orphan' })).resolves.toMatchObject({ ok: false });
  });

  it('refuses a branch name check-ref-format would read as an option without running git', async () => {
    const { repo, calls } = repository();
    expect(await repo.isValidBranchName('-b')).toBe(false);
    expect(calls).toEqual([]);
  });
});
