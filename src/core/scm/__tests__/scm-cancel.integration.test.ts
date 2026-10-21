import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { processLauncher } from '../../process-launcher';
import { createGitRunner, GitQueueDisposedError } from '../git-runner';
import { parseGitVersion } from '../git-version';
import { folder, git, GIT_PATH, harness, HAS_GIT, makeRepo, ready, sandbox, statusOf, useGitSandbox, waitFor, write } from './git-harness';

/**
 * Removing a project kills its running reads and status with their whole process tree and rejects its queued work, against
 * real git; an index write that is running is never killed.
 */
useGitSandbox();

const node = process.execPath.replace(/\\/g, '/');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// An fsmonitor hook that starts a grandchild, records both pids in `${pids}.json` and never answers.
function hangingFsmonitor(project: string, pids: string): void {
  const hook = `${pids}-hook.js`;
  fs.writeFileSync(
    hook,
    [
      "const { spawn } = require('child_process');",
      "const fs = require('fs');",
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(`${pids}.json`)}, JSON.stringify({ hook: process.pid, child: child.pid }));`,
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );
  git(['config', 'core.fsmonitor', `"${node}" "${hook.replace(/\\/g, '/')}"`], project);
}

describe.skipIf(!HAS_GIT)('cancelling a repository\'s git', { timeout: 120_000 }, () => {
  it('kills a hung status with the processes its hook started, and rejects the work queued behind it', async () => {
    const project = makeRepo(folder('hung-status'));
    const pids = path.join(sandbox, `hung-${Date.now()}`);
    hangingFsmonitor(project, pids);
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    const started = await waitFor(() => fs.existsSync(`${pids}.json`) && (JSON.parse(fs.readFileSync(`${pids}.json`, 'utf8')) as { hook: number; child: number }), 'the hook');
    expect(alive(started.hook) && alive(started.child)).toBe(true);
    const repo = h.service.repository(repoId)!.repo;
    const queuedStatus = repo.status('mixed');
    const queuedStage = repo.stage(['a.txt']);
    expect(statusOf(h, repoId)).toBeUndefined();

    h.service.setProjects([]);
    await expect(queuedStatus).rejects.toBeInstanceOf(GitQueueDisposedError);
    await expect(queuedStage).rejects.toBeInstanceOf(GitQueueDisposedError);
    await waitFor(() => !alive(started.hook) && !alive(started.child), 'the hook and its child are gone');
    await waitFor(() => h.log.some((line) => line.startsWith('> git status ') && line.endsWith('cancelled')), 'the cancelled status in the Git log');
    h.service.dispose();
  });

  it('kills a hung status and its hook\'s child when the session job closes, as the host\'s death closes it, with the call itself never aborted', async () => {
    const project = makeRepo(folder('session-status'));
    const pids = path.join(sandbox, `session-${Date.now()}`);
    hangingFsmonitor(project, pids);
    const session = processLauncher().createSessionJob();
    const runner = createGitRunner({ git: { path: GIT_PATH!, version: parseGitVersion(git(['--version'], sandbox))! }, log: { appendLine: () => undefined }, isTrusted: () => true });
    const controller = new AbortController();
    let settled = false;
    void runner.run({ project, cwd: project, args: ['status', '--porcelain=v1', '-z'], kind: 'status', parsed: true, signal: controller.signal, session }).finally(() => (settled = true)).catch(() => undefined);
    try {
      const started = await waitFor(() => fs.existsSync(`${pids}.json`) && (JSON.parse(fs.readFileSync(`${pids}.json`, 'utf8')) as { hook: number; child: number }), 'the hook');
      expect(alive(started.hook) && alive(started.child)).toBe(true);

      session.dispose();
      await waitFor(() => !alive(started.hook) && !alive(started.child), 'the hook and its child are gone');
      // git died with them, so the call settles although its signal never fired
      await waitFor(() => settled, 'the status settles');
      expect(controller.signal.aborted).toBe(false);
    } finally {
      // a no-op once the call settled; after a failure the call's own job kills what is left
      controller.abort(new GitQueueDisposedError());
    }
  });

  it('lets a running commit finish when its project is removed', async () => {
    const project = makeRepo(folder('running-commit'));
    const marker = path.join(sandbox, `commit-hook-${Date.now()}`);
    const script = `${marker}.js`;
    fs.writeFileSync(script, `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(`${marker}.started`)}, ''); setTimeout(() => fs.writeFileSync(${JSON.stringify(`${marker}.done`)}, ''), 1500);\n`, 'utf8');
    const hookFile = path.join(project, '.git', 'hooks', 'pre-commit');
    write(hookFile, `#!/bin/sh\n"${node}" "${script.replace(/\\/g, '/')}"\n`);
    fs.chmodSync(hookFile, 0o755);
    const h = harness({ trusted: [project] });
    h.service.setProjects([{ key: 'p', path: project }]);
    const repoId = (await ready(h)).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId), 'a first status');
    write(path.join(project, 'a.txt'), 'edit\n');
    git(['add', 'a.txt'], project);
    const committing = h.service.repository(repoId)!.repo.commit('Survives');
    await waitFor(() => fs.existsSync(`${marker}.started`), 'the hook');
    h.service.setProjects([]);
    expect(await committing).toEqual({ ok: true });
    expect(fs.existsSync(`${marker}.done`)).toBe(true);
    expect(git(['log', '-1', '--format=%s'], project).trim()).toBe('Survives');
    h.service.dispose();
  });
});
