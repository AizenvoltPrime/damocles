import { describe, expect, it } from 'vitest';
import type { ForgeKind } from '../../../shared/forge/accounts';
import { endpointsFromRemotes, locationOf, matchServer, parseRemoteUrl, usernameHintOf, type MatchableServer } from '../remote-url';

const server = (id: string, kind: ForgeKind, gitHosts: readonly string[] = [id.split('/')[0]!]): MatchableServer => ({ id, kind, webUrl: `https://${id}`, record: { gitHosts } });
const GITLAB = server('gitlab.com', 'gitlab', ['gitlab.com', 'altssh.gitlab.com']);
const GITHUB = server('github.com', 'github', ['github.com', 'ssh.github.com']);

/** The repository path a URL maps to on the servers given, as parseGitLabRemote's namespaceWithPath. */
function repoPath(url: string, servers: readonly MatchableServer[] = [GITLAB]): string | undefined {
  const parsed = parseRemoteUrl(url);
  return parsed ? matchServer(locationOf(parsed), servers)?.repoPath : undefined;
}

describe('parseRemoteUrl and matchServer: GitLab Workflow git_remote_parser.test.ts cases', () => {
  it.each([
    ['git@gitlab.com:fatihacet/gitlab-vscode-extension.git', 'ssh', 'gitlab.com', 'fatihacet/gitlab-vscode-extension'],
    ['ssh://git@gitlab.com/fatihacet/gitlab-vscode-extension.git', 'ssh', 'gitlab.com', 'fatihacet/gitlab-vscode-extension'],
    ['https://git@gitlab.com/fatihacet/gitlab-vscode-extension.git', 'https', 'gitlab.com', 'fatihacet/gitlab-vscode-extension'],
    ['https://gitlab.com/fatihacet/gitlab-vscode-extension.git', 'https', 'gitlab.com', 'fatihacet/gitlab-vscode-extension'],
    ['git@gitlab.com:group/subgroup/gitlab-vscode-extension.git', 'ssh', 'gitlab.com', 'group/subgroup/gitlab-vscode-extension'],
    ['https://gitlab.com/fatihacet/gitlab-vscode-extension', 'https', 'gitlab.com', 'fatihacet/gitlab-vscode-extension'],
    // a trailing slash, as a URL copied from the browser has
    ['https://gitlab.com/fatihacet/gitlab-vscode-extension/', 'https', 'gitlab.com', 'fatihacet/gitlab-vscode-extension'],
    // issue 2164: an absolute ssh path
    ['git@gitlab.com:/gitlab-org/gitlab-vscode-extension.git', 'ssh', 'gitlab.com', 'gitlab-org/gitlab-vscode-extension'],
    ['git@gitlab.com:/group/subgroup/project.git', 'ssh', 'gitlab.com', 'group/subgroup/project'],
    // a project path ending in "git" without .git
    ['https://gitlab.com/group/legit', 'https', 'gitlab.com', 'group/legit'],
    ['https://gitlab.com/group/my-git', 'https', 'gitlab.com', 'group/my-git'],
    ['https://gitlab.com/group/my-git/', 'https', 'gitlab.com', 'group/my-git'],
    ['git@gitlab.com:group/subgroup/my_git', 'ssh', 'gitlab.com', 'group/subgroup/my_git'],
    ['https://gitlab.com/group/my-git.git', 'https', 'gitlab.com', 'group/my-git'],
  ])('maps %s', (url, protocol, host, path) => {
    expect(parseRemoteUrl(url)).toMatchObject({ protocol, host });
    expect(repoPath(url)).toBe(path);
  });

  it('reads a custom ssh user and an https port (gitlab-mydomain.com, gitlab.company.com:8443)', () => {
    expect(parseRemoteUrl('gitlab-ci@gitlab-mydomain.com:fatihacet/gitlab-vscode-extension.git')).toEqual({ protocol: 'ssh', user: 'gitlab-ci', host: 'gitlab-mydomain.com', path: 'fatihacet/gitlab-vscode-extension.git' });
    const company = server('gitlab.company.com:8443', 'gitlab');
    expect(repoPath('https://gitlab.company.com:8443/fatihacet/gitlab-vscode-extension.git', [company])).toBe('fatihacet/gitlab-vscode-extension');
    // the port is part of an https server's host: another port is another server
    expect(repoPath('https://gitlab.company.com/fatihacet/gitlab-vscode-extension.git', [company])).toBeUndefined();
  });

  it('keeps the port of [user@host:port]:path and ssh://user@host:port/path (issues 309 and 644)', () => {
    expect(parseRemoteUrl('[git@example.com:2222]:fatihacet/gitlab-vscode-extension.git')).toEqual({ protocol: 'ssh', user: 'git', host: 'example.com', port: 2222, path: 'fatihacet/gitlab-vscode-extension.git' });
    expect(parseRemoteUrl('ssh://git@example.com:2222/fatihacet/gitlab-vscode-extension.git')).toEqual({ protocol: 'ssh', user: 'git', host: 'example.com', port: 2222, path: 'fatihacet/gitlab-vscode-extension.git' });
    // issue 611: in scp-like syntax 2222 is a path segment, not a port
    expect(parseRemoteUrl('git@example.com:2222/fatihacet/gitlab-vscode-extension.git')).toMatchObject({ host: 'example.com', path: '2222/fatihacet/gitlab-vscode-extension.git' });
  });

  it('supports a self-managed GitLab on a custom path (merge request 11), and an ssh remote without it (issue 103)', () => {
    const custom = [server('example.com/gitlab', 'gitlab', ['example.com'])];
    expect(repoPath('https://example.com/gitlab/fatihacet/gitlab-vscode-extension', custom)).toBe('fatihacet/gitlab-vscode-extension');
    expect(repoPath('git@example.com:fatihacet/gitlab-vscode-extension.git', custom)).toBe('fatihacet/gitlab-vscode-extension');
    // an https remote outside the prefix is not that server's
    expect(repoPath('https://example.com/fatihacet/gitlab-vscode-extension', custom)).toBeUndefined();
  });

  it('maps nothing without a namespace, for a relative path, a drive path, or a scheme it does not read', () => {
    expect(repoPath('git@gitlab.com:no-namespace-repo.git')).toBeUndefined();
    expect(parseRemoteUrl('../relative/path')).toBeUndefined();
    expect(parseRemoteUrl('C:/repos/project')).toBeUndefined();
    expect(parseRemoteUrl('C:\\repos\\project')).toBeUndefined();
    expect(parseRemoteUrl('/srv/git/project.git')).toBeUndefined();
    expect(parseRemoteUrl('file:///srv/git/project.git')).toBeUndefined();
    // plain http and git:// carry no credentials Damocles answers (non-goals)
    expect(parseRemoteUrl('http://gitlab.com/fatihacet/gitlab-vscode-extension.git')).toBeUndefined();
    expect(parseRemoteUrl('git://gitlab.com/fatihacet/gitlab-vscode-extension.git')).toBeUndefined();
  });

  it('never reads the password of a URL', () => {
    const parsed = parseRemoteUrl('https://alice:glpat-secret@gitlab.com/grp/proj.git');
    expect(parsed).toEqual({ protocol: 'https', user: 'alice', host: 'gitlab.com', path: 'grp/proj.git' });
    expect(JSON.stringify(locationOf(parsed!))).not.toContain('glpat-secret');
  });
});

describe('matchServer: VS Code github getRepositoryFromUrl, generalized to every GitHub server', () => {
  it.each([
    ['https://github.com/microsoft/vscode.git', 'microsoft/vscode'],
    ['https://github.com/microsoft/vscode', 'microsoft/vscode'],
    ['git@github.com:microsoft/vscode.git', 'microsoft/vscode'],
    ['git@github.com:microsoft/vscode', 'microsoft/vscode'],
    ['ssh://git@ssh.github.com:443/microsoft/vscode.git', 'microsoft/vscode'],
  ])('maps %s on github.com', (url, path) => {
    expect(repoPath(url, [GITHUB])).toBe(path);
  });

  it('maps a GHES and a ghe.com tenant by their own hosts, and refuses a path that is not owner/repo', () => {
    const ghes = server('github.example.com', 'github');
    const tenant = server('octo.ghe.com', 'github');
    expect(repoPath('https://github.example.com/team/app.git', [GITHUB, ghes, tenant])).toBe('team/app');
    expect(repoPath('git@octo.ghe.com:team/app.git', [GITHUB, ghes, tenant])).toBe('team/app');
    expect(repoPath('https://github.com/a/b/c.git', [GITHUB])).toBeUndefined();
  });
});

describe('matchServer: host and the longest path prefix', () => {
  const a = server('code.example.com/gitlab-a', 'gitlab', ['code.example.com']);
  const b = server('code.example.com/gitlab-b', 'gitlab', ['code.example.com']);

  it('resolves both GitLab servers on one web host under different prefixes', () => {
    const https = (url: string) => {
      const match = matchServer(locationOf(parseRemoteUrl(url)!), [a, b]);
      return match && { server: match.server.id, path: match.repoPath };
    };
    expect(https('https://code.example.com/gitlab-a/grp/proj.git')).toEqual({ server: a.id, path: 'grp/proj' });
    expect(https('https://code.example.com/gitlab-b/grp/sub/proj.git')).toEqual({ server: b.id, path: 'grp/sub/proj' });
    expect(https('git@code.example.com:gitlab-b/grp/proj.git')).toEqual({ server: b.id, path: 'grp/proj' });
    // an ssh path naming neither prefix could be either server's
    expect(https('git@code.example.com:grp/proj.git')).toBeUndefined();
  });

  it('prefers the longest prefix over a server at the host root', () => {
    const root = server('example.org', 'gitlab');
    const nested = server('example.org/sub', 'gitlab', ['example.org']);
    expect(matchServer(locationOf(parseRemoteUrl('https://example.org/sub/grp/proj.git')!), [root, nested])?.server.id).toBe('example.org/sub');
    expect(matchServer(locationOf(parseRemoteUrl('https://example.org/grp/proj.git')!), [root, nested])?.server.id).toBe('example.org');
  });

  it('matches a git host that differs from the web host (git.indigital.gr)', () => {
    const indigital = server('gitlab.indigital.gr', 'gitlab', ['gitlab.indigital.gr', 'git.indigital.gr']);
    expect(repoPath('git@git.indigital.gr:platform/api.git', [indigital])).toBe('platform/api');
    expect(repoPath('https://git.indigital.gr/platform/api.git', [indigital])).toBe('platform/api');
  });

  it('matches an alias only after ssh -G gave its host name', () => {
    const alias = locationOf(parseRemoteUrl('git@gl-work:grp/sub/proj.git')!);
    expect(matchServer(alias, [GITLAB])).toBeUndefined();
    expect(matchServer({ ...alias, host: 'gitlab.com', aliasResolved: true }, [GITLAB])?.repoPath).toBe('grp/sub/proj');
  });

  it('reads an ssh alias with an underscore, which ssh accepts and DNS does not, and keeps https to DNS names', () => {
    expect(parseRemoteUrl('git@github_work:o/r.git')).toEqual({ protocol: 'ssh', user: 'git', host: 'github_work', path: 'o/r.git' });
    expect(parseRemoteUrl('ssh://git@gitlab_personal/g/p.git')).toEqual({ protocol: 'ssh', user: 'git', host: 'gitlab_personal', path: 'g/p.git' });
    const alias = locationOf(parseRemoteUrl('git@github_work:o/r.git')!);
    expect(matchServer({ ...alias, host: 'github.com', aliasResolved: true }, [GITHUB])?.repoPath).toBe('o/r');
    expect(parseRemoteUrl('https://github_work/o/r.git')).toBeUndefined();
  });

  it('takes the prefix as optional on a separate https git host, the longest match winning, and requires it on the web host', () => {
    const prefixed = server('example.com/gl', 'gitlab', ['example.com', 'git.example.com']);
    expect(repoPath('https://git.example.com/team/p.git', [prefixed])).toBe('team/p');
    expect(repoPath('https://git.example.com/gl/team/p.git', [prefixed])).toBe('team/p');
    expect(repoPath('https://example.com/team/p.git', [prefixed])).toBeUndefined();
    // two servers on one git host: only a path naming a prefix tells them apart
    const other = server('example.com/other', 'gitlab', ['example.com', 'git.example.com']);
    expect(matchServer(locationOf(parseRemoteUrl('https://git.example.com/other/team/p.git')!), [prefixed, other])?.server.id).toBe('example.com/other');
    expect(matchServer(locationOf(parseRemoteUrl('https://git.example.com/team/p.git')!), [prefixed, other])).toBeUndefined();
  });
});

describe('username hints', () => {
  it('takes an https user and leaves out placeholder users', () => {
    expect(locationOf(parseRemoteUrl('https://alice@gitlab.com/grp/proj.git')!).usernameHint).toBe('alice');
    for (const user of ['oauth2', 'x-access-token', 'git', 'token', 'OAuth2']) {
      expect(locationOf(parseRemoteUrl(`https://${user}@gitlab.com/grp/proj.git`)!).usernameHint).toBeUndefined();
      expect(usernameHintOf(user)).toBeUndefined();
    }
  });

  it('never takes an ssh user, and falls back to credential.username for https', () => {
    expect(locationOf(parseRemoteUrl('alice@gitlab.com:grp/proj.git')!).usernameHint).toBeUndefined();
    expect(locationOf(parseRemoteUrl('https://gitlab.com/grp/proj.git')!, 'bob').usernameHint).toBe('bob');
    expect(locationOf(parseRemoteUrl('https://gitlab.com/grp/proj.git')!, 'oauth2').usernameHint).toBeUndefined();
  });

  it('builds an older daemon\'s endpoints from remotes without alias resolution', () => {
    expect(endpointsFromRemotes([{ name: 'origin', fetchUrl: 'git@gl-work:grp/proj.git', pushUrl: 'https://alice@gitlab.com/grp/proj.git' }])).toEqual([{
      remote: 'origin',
      fetch: { protocol: 'ssh', host: 'gl-work', path: 'grp/proj.git', aliasResolved: false },
      push: { protocol: 'https', host: 'gitlab.com', path: 'grp/proj.git', usernameHint: 'alice', aliasResolved: false },
    }]);
  });
});
