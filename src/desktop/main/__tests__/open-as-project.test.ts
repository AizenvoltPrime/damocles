import { describe, expect, it } from 'vitest';
import { openAsProject, openFolderAsProject, type OpenAsProjectDeps } from '../open-as-project';
import type { RootProject } from '../worktrees/roots';

type Root = RootProject & { readonly os: NodeJS.Platform };

const LOCAL: Root = { key: 'c:\\work\\app', fsPath: 'C:\\work\\app', name: 'app', root: { projectKey: 'c:\\work\\app' }, os: 'win32' };
const REMOTE: Root = { key: 'ssh+h1|/srv/app', fsPath: '/srv/app', name: 'app', root: { projectKey: 'ssh+h1|/srv/app' }, os: 'linux' };
const WIN_REMOTE: Root = { key: 'ssh+h2|c:\\srv\\app', fsPath: 'C:\\srv\\app', name: 'app', root: { projectKey: 'ssh+h2|c:\\srv\\app' }, os: 'win32' };
// a chat worktree of the local project, shown in Files in its place
const WORKTREE: Root = { ...LOCAL, key: 'c:\\work\\app', fsPath: 'C:\\wt\\app-1', root: { projectKey: 'c:\\work\\app', worktreeId: 'abcd1234' } };

function fake(options: { roots?: Record<string, Root>; served?: (authority: string) => boolean; projects?: string[]; directories?: string[] } = {}) {
  const calls: string[] = [];
  const projects = new Set(options.projects ?? []);
  const deps: OpenAsProjectDeps = {
    resolve: (key) => (options.roots ?? { [LOCAL.key]: LOCAL, [REMOTE.key]: REMOTE, [WIN_REMOTE.key]: WIN_REMOTE, 'c:\\work\\app#abcd1234': WORKTREE })[key],
    served: options.served ?? (() => true),
    isDirectory: async (authority, folder) => {
      calls.push(`isDirectory ${authority} ${folder}`);
      return options.directories === undefined || options.directories.includes(folder);
    },
    projectKeyOf: async (authority, folder) => (authority === 'local' ? folder.toLowerCase() : `${authority}|${folder.toLowerCase()}`),
    isProject: (key) => projects.has(key),
    add: async (authority, folder, key, after) => {
      calls.push(`add ${authority} ${folder} ${key} after ${after ?? '-'}`);
      projects.add(key);
    },
    requestTrust: async (key) => { calls.push(`trust ${key}`); },
    select: async (key) => { calls.push(`select ${key}`); },
    notFolder: (authority, folder) => new Error(`${folder} is no folder on ${authority}`),
  };
  return { deps, calls };
}

describe('openAsProject', () => {
  it('adds a local folder right after its project, asks the trust question, then selects it', async () => {
    const { deps, calls } = fake();
    expect(await openAsProject(deps, { projectKey: LOCAL.key, relativePath: 'src/packages/api' })).toEqual({ projectKey: 'c:\\work\\app\\src\\packages\\api', added: true });
    expect(calls).toEqual([
      'isDirectory local C:\\work\\app\\src\\packages\\api',
      'add local C:\\work\\app\\src\\packages\\api c:\\work\\app\\src\\packages\\api after c:\\work\\app',
      'trust c:\\work\\app\\src\\packages\\api',
      'select c:\\work\\app\\src\\packages\\api',
    ]);
  });

  it('opens local folders while the remote gate is closed, and refuses remote ones', async () => {
    const { deps, calls } = fake({ served: (authority) => authority === 'local' });
    await expect(openAsProject(deps, { projectKey: LOCAL.key, relativePath: 'src' })).resolves.toMatchObject({ added: true });
    await expect(openAsProject(deps, { projectKey: REMOTE.key, relativePath: 'src' })).rejects.toThrow('not enabled');
    expect(calls.filter((call) => call.includes('ssh+'))).toEqual([]);
  });

  it('joins a remote folder in the target\'s own path flavor and places it after its project on that host', async () => {
    const { deps, calls } = fake();
    expect(await openAsProject(deps, { projectKey: REMOTE.key, relativePath: 'src/packages/api' })).toEqual({ projectKey: 'ssh+h1|/srv/app/src/packages/api', added: true });
    expect(calls[1]).toBe('add ssh+h1 /srv/app/src/packages/api ssh+h1|/srv/app/src/packages/api after ssh+h1|/srv/app');
    await openAsProject(deps, { projectKey: WIN_REMOTE.key, relativePath: 'src/api' });
    expect(calls).toContain('isDirectory ssh+h2 C:\\srv\\app\\src\\api');
  });

  it('selects a folder that is a project already, adding nothing and asking nothing', async () => {
    const { deps, calls } = fake({ projects: ['ssh+h1|/srv/app/src'] });
    expect(await openAsProject(deps, { projectKey: REMOTE.key, relativePath: 'src' })).toEqual({ projectKey: 'ssh+h1|/srv/app/src', added: false });
    expect(calls).toEqual(['isDirectory ssh+h1 /srv/app/src', 'select ssh+h1|/srv/app/src']);
  });

  it('opens a folder of a shown worktree after the project the worktree belongs to', async () => {
    const { deps, calls } = fake();
    await openAsProject(deps, { projectKey: 'c:\\work\\app#abcd1234', relativePath: 'lib' });
    expect(calls[1]).toBe('add local C:\\wt\\app-1\\lib c:\\wt\\app-1\\lib after c:\\work\\app');
  });

  it('refuses an unknown project, a name Windows would resolve to the parent, and a file', async () => {
    const { deps, calls } = fake({ directories: [] });
    await expect(openAsProject(deps, { projectKey: 'c:\\other', relativePath: 'src' })).rejects.toThrow('no longer in the project list');
    await expect(openAsProject(deps, { projectKey: LOCAL.key, relativePath: '.. ' })).rejects.toThrow('Windows');
    await expect(openAsProject(deps, { projectKey: WIN_REMOTE.key, relativePath: 'src/..  ' })).rejects.toThrow('Windows');
    // the shell's validator refuses these too; the action refuses them on its own
    await expect(openAsProject(deps, { projectKey: REMOTE.key, relativePath: '../../etc' })).rejects.toThrow('not inside the project');
    await expect(openAsProject(deps, { projectKey: REMOTE.key, relativePath: 'src/../../../other' })).rejects.toThrow('not inside the project');
    expect(calls).toEqual([]);
    await expect(openAsProject(deps, { projectKey: REMOTE.key, relativePath: 'README.md' })).rejects.toThrow('/srv/app/README.md is no folder on ssh+h1');
    expect(calls).toEqual(['isDirectory ssh+h1 /srv/app/README.md']);
  });
});

describe('openFolderAsProject', () => {
  it('adds a picked folder last when no project comes before it', async () => {
    const { deps, calls } = fake();
    await openFolderAsProject(deps, 'ssh+h1', '/srv/billing');
    expect(calls[1]).toBe('add ssh+h1 /srv/billing ssh+h1|/srv/billing after -');
  });
});
