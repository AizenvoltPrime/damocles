// A chat's repository for the GitHub and GitLab tools, read where its folder is; its project must be trusted, as git reads its config.
import * as path from 'node:path';
import type { ChatRepository } from '../../shared/forge/tools';
import { gitSshOf, hostGitSshSources, readRemoteEndpoints } from '../../core/scm/remote-endpoints';
import { samePath } from '../../core/scm/discovery';
import { PROJECTS_RESOLVING } from '../../core/scm/git-runner';
import { parseRemotes } from '../../core/scm/remotes';
import { resolveSshExecutable } from '../../core/system-tools';
import { identityFolder } from '../../core/worktrees/personal-config';
import type { CoreScm } from './scm';

export function createChatRepositories(scm: CoreScm, log: (line: string) => void): (folder: string) => Promise<ChatRepository> {
  return async (folder) => {
    const runner = scm.runner;
    if (!runner) return { ok: false, text: 'Git is not installed where this chat runs, so the GitHub and GitLab tools cannot read its repository.' };
    const project = scm.service.trustedProjectAt(identityFolder(folder));
    if (project === PROJECTS_RESOLVING) return { ok: false, text: 'The projects are still loading. Try again in a moment.' };
    if (project === undefined) return { ok: false, text: "This chat's folder is not in a trusted project, so the GitHub and GitLab tools do not read its repository." };
    const read = async (args: readonly string[]): Promise<{ readonly code: number | null; readonly stdout: string }> => {
      const result = await runner.run({ project, cwd: folder, args, kind: 'read', parsed: true, allowFailure: true, maxOutputBytes: 1024 * 1024 });
      return { code: result.exitCode, stdout: result.stdout.toString('utf8') };
    };
    const head = await read(['symbolic-ref', '-q', '--short', 'HEAD']);
    const branch = head.code === 0 ? head.stdout.trim() : undefined;
    let pushRemote: string | undefined;
    if (branch !== undefined && branch !== '') {
      const upstream = await read(['for-each-ref', '--format=%(refname)%00%(upstream:remotename)', `refs/heads/${branch}`]);
      const line = upstream.stdout.split('\n').find((entry) => entry.startsWith(`refs/heads/${branch}\0`));
      const remote = line?.split('\0')[1]?.trim();
      if (remote) pushRemote = remote;
    }
    // exit 1: no such key
    const configValue = async (args: readonly string[]): Promise<string | undefined> => {
      const answer = await read(['config', ...args]);
      if (answer.code === 1) return undefined;
      if (answer.code !== 0) throw new Error(`git config ${args[0]} exited ${String(answer.code)}`);
      return answer.stdout.replace(/\r?\n$/, '');
    };
    const endpoints = await readRemoteEndpoints({
      remotes: async () => {
        const remotes = await read(['remote', '--verbose']);
        if (remotes.code !== 0) throw new Error(`git remote --verbose exited ${String(remotes.code)}`);
        return parseRemotes(remotes.stdout);
      },
      credentialUsername: async (url) => (await configValue(['--get-urlmatch', 'credential.username', url]))?.trim() || undefined,
      trusted: () => true,
      gitSsh: () => gitSshOf(hostGitSshSources(() => configValue(['--get', 'core.sshCommand']), () => resolveSshExecutable()), log),
      sshAnswers: scm.service.sshAnswers,
      log,
    });
    const projectKey = [...scm.projectFolders()].find(([, projectPath]) => samePath(projectPath, project))?.[0];
    return {
      ok: true,
      ...(projectKey !== undefined ? { projectKey } : {}),
      repository: {
        projectPath: project,
        project: path.basename(project),
        endpoints,
        ...(pushRemote !== undefined ? { pushRemote } : {}),
        ...(branch !== undefined && branch !== '' ? { branch } : {}),
      },
    };
  };
}
