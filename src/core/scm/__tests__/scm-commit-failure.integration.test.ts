import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRunner, type GitCloner, type GitRunner } from '../git-runner';
import { parseGitVersion } from '../git-version';
import { GitError } from '../errors';
import { PLAIN_COMMIT } from '../repository';
import { folder, git, GIT_PATH, harness, HAS_GIT, makeRepo, ready, sandbox, statusOf, useGitSandbox, waitFor, write, type Harness } from './git-harness';

/**
 * A failed commit's reason comes from the repository, never from git's or a hook's words, against real git: commit runs in the
 * user's locale, so the same reasons must come out of a German git and of hooks that print anything at all.
 */
useGitSandbox();

let savedLang: string | undefined;
beforeEach(() => {
  savedLang = process.env['LANG'];
  process.env['LANG'] = 'de_DE.UTF-8';
});
afterEach(() => {
  if (savedLang === undefined) delete process.env['LANG'];
  else process.env['LANG'] = savedLang;
});

// git as a German install prints it: a failed commit's output in German, everything else untouched
function germanGit(): GitRunner & GitCloner {
  const plain = createGitRunner({ git: { path: GIT_PATH!, version: parseGitVersion(git(['--version'], sandbox))! }, log: { appendLine: () => undefined }, isTrusted: () => true });
  return {
    ...plain,
    run: async (call) => {
      try {
        return await plain.run(call);
      } catch (err) {
        if (!(err instanceof GitError) || !call.args.includes('commit')) throw err;
        throw new GitError(err.message, err.exitCode, 'Auf Branch main\nnichts zu committen, Arbeitsverzeichnis unverändert\n', 'Fehler: Commit fehlgeschlagen\n');
      }
    },
  };
}

async function open(project: string, runner?: GitRunner & GitCloner): Promise<{ h: Harness; repoId: string }> {
  const h = harness({ trusted: [project], ...(runner ? { runner } : {}) });
  h.service.setProjects([{ key: 'p', path: project }]);
  const repoId = (await ready(h)).repos[0]!.repoId;
  await waitFor(() => statusOf(h, repoId), 'a first status');
  return { h, repoId };
}

function hook(project: string, name: string, script: string): void {
  const file = path.join(project, '.git', 'hooks', name);
  write(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
}

describe.skipIf(!HAS_GIT)('the reason a commit failed', { timeout: 120_000 }, () => {
  it('says there is nothing to commit from the index, whatever language git answers in', async () => {
    const project = makeRepo(folder('german-nothing'));
    const { h, repoId } = await open(project, germanGit());
    expect(await h.service.repository(repoId)!.repo.commit('Nichts', PLAIN_COMMIT)).toMatchObject({ ok: false, reason: 'nothingToCommit' });
    h.service.dispose();
  });

  it('reports a hook that fails with staged changes as failed, with its own words, whatever it claims', async () => {
    const project = makeRepo(folder('hook-words'));
    hook(project, 'pre-commit', "echo 'nothing to commit, working tree clean'\necho 'Fehler: Prüfung fehlgeschlagen' >&2\nexit 1");
    write(path.join(project, 'a.txt'), 'staged\n');
    git(['add', 'a.txt'], project);
    const { h, repoId } = await open(project);
    const outcome = await h.service.repository(repoId)!.repo.commit('Staged', PLAIN_COMMIT);
    expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
    expect(outcome.ok === false && (outcome.error as GitError).stderr).toContain('Fehler: Prüfung fehlgeschlagen');
    h.service.dispose();
  });

  it('says the identity is missing when git var cannot form one, an empty user.name included', async () => {
    const project = makeRepo(folder('empty-name'));
    git(['config', 'user.name', ''], project);
    write(path.join(project, 'a.txt'), 'staged\n');
    git(['add', 'a.txt'], project);
    const { h, repoId } = await open(project, germanGit());
    expect(await h.service.repository(repoId)!.repo.commit('Staged', PLAIN_COMMIT)).toMatchObject({ ok: false, reason: 'missingUserConfig' });
    h.service.dispose();
  });

  it('counts a staged submodule commit as something to commit whatever diff.ignoreSubmodules says, as commit does', async () => {
    const project = makeRepo(folder('staged-gitlink'));
    const seed = ['-c', 'user.name=Seed', '-c', 'user.email=seed@damocles.invalid'];
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', makeRepo(folder('staged-gitlink-upstream')), 'sub'], project);
    git([...seed, 'commit', '--quiet', '-m', 'sub'], project);
    git([...seed, 'commit', '--quiet', '--allow-empty', '-m', 'bump'], path.join(project, 'sub'));
    git(['add', 'sub'], project);
    git(['config', 'diff.ignoreSubmodules', 'all'], project);
    hook(project, 'pre-commit', 'exit 1');
    const { h, repoId } = await open(project, germanGit());
    expect(await h.service.repository(repoId)!.repo.commit('Bump', PLAIN_COMMIT)).toMatchObject({ ok: false, reason: 'failed' });
    h.service.dispose();
  });

  it('never calls a failed amend or empty commit nothing to commit', async () => {
    const project = makeRepo(folder('amend-fails'));
    hook(project, 'pre-commit', 'exit 1');
    const { h, repoId } = await open(project, germanGit());
    const repo = h.service.repository(repoId)!.repo;
    expect(await repo.commit('Amend', { ...PLAIN_COMMIT, amend: true })).toMatchObject({ ok: false, reason: 'failed' });
    expect(await repo.commit('Empty', { ...PLAIN_COMMIT, empty: true })).toMatchObject({ ok: false, reason: 'failed' });
    h.service.dispose();
  });
});
