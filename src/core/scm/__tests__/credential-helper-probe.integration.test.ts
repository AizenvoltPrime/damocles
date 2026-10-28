import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitRunner, PROJECTS_RESOLVING } from '../git-runner';
import { parseGitVersion } from '../git-version';
import { folder, git, GIT_PATH, harness, HAS_GIT, makeRepo, ready, sandbox, useGitSandbox, write } from './git-harness';

// What the relay's consent reads of the target's own credential helpers, against real git.
useGitSandbox();

describe.skipIf(!HAS_GIT)('the target-helper probe', { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('outside a trusted project, sees a helper the global file only includes', async () => {
    const included = path.join(folder('included'), 'credentials.gitconfig');
    write(included, '[credential]\n\thelper = store\n');
    const global = path.join(folder('global'), '.gitconfig');
    write(global, `[include]\n\tpath = ${included.replace(/\\/g, '/')}\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    const runner = createGitRunner({ git: { path: GIT_PATH!, version: parseGitVersion(git(['--version'], sandbox))! }, log: { appendLine: () => undefined }, isTrusted: () => false });
    await expect(runner.targetHasCredentialHelper(folder('elsewhere'), 'https://github.com/', undefined)).resolves.toBe(true);
  });

  it('warns of a helper, without running git, while a project folder is still resolving', async () => {
    const lines: string[] = [];
    const runner = createGitRunner({ git: { path: path.join(folder('no-git'), 'git'), version: parseGitVersion(git(['--version'], sandbox))! }, log: { appendLine: (line) => lines.push(line) }, isTrusted: () => true });
    await expect(runner.targetHasCredentialHelper(folder('resolving'), 'https://github.com/', PROJECTS_RESOLVING)).resolves.toBe(true);
    expect(lines).toEqual(['[askpass] a project folder is still resolving, so the consent warns of a helper of the target\'s own']);
  });
});

describe.skipIf(!HAS_GIT)('the trusted project a helper\'s folder belongs to', { timeout: 120_000 }, () => {
  it('is the nearest registered project above it, unless that one is untrusted', async () => {
    const project = makeRepo(folder('above'));
    const sub = path.join(project, 'sub');
    fs.mkdirSync(sub);
    const declined = path.join(project, 'declined');
    fs.mkdirSync(declined);
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }, { key: 'd', path: declined }]);
    // a folder outside every project may still lie inside one through a link until the realpaths are known
    expect(h.service.trustedProjectAt(folder('outside-early'))).toBe(PROJECTS_RESOLVING);
    await ready(h);
    expect(h.service.trustedProjectAt(sub)).toBe(project);
    expect(h.service.trustedProjectAt(project)).toBe(project);
    expect(h.service.trustedProjectAt(path.join(declined, 'deeper'))).toBeUndefined();
    expect(h.service.trustedProjectAt(folder('outside'))).toBeUndefined();
    h.service.dispose();
  });

  it('is the project of an open parent repository rooted at it', async () => {
    const parent = makeRepo(folder('parent'));
    const project = path.join(parent, 'inner');
    write(path.join(project, 'x.txt'), 'x\n');
    const h = harness({ trusted: [project] });
    h.noticeAnswers = ['Yes'];
    h.service.setProjects([{ key: 'p', path: project }]);
    await ready(h);
    expect(h.service.trustedProjectAt(parent)).toBe(project);
    h.trust.revoke(project);
    expect(h.service.trustedProjectAt(parent)).toBeUndefined();
    h.service.dispose();
  });
});
