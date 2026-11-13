import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeSecretsStore, type FakeSecretsStore } from '../../../__mocks__/fake-platform';
import { createTokenStore, serverSecretKey } from '../accounts/token-store';
import { ForgeFileBrokenError } from '../forge-file';
import { createServerRegistry, parseServersFile, type ServerRegistry } from '../servers';
import type { ForgeBuildOAuth } from '../types';

let dir: string;
let secrets: FakeSecretsStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'damocles-forge-servers-'));
  secrets = createFakeSecretsStore();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function registry(buildOAuth: ForgeBuildOAuth = {}, tokens = createTokenStore(secrets, () => undefined)): Promise<ServerRegistry> {
  const created = createServerRegistry({ forgeDir: dir, tokens, buildOAuth, log: () => undefined });
  await created.load();
  return created;
}

const serversFile = (): { servers: { id: string; pendingGitHosts?: string[] }[] } => JSON.parse(readFileSync(path.join(dir, 'servers.json'), 'utf8'));

describe('server registry', () => {
  it('lists github.com and gitlab.com with their API bases, origins and git hosts', async () => {
    const servers = await registry();
    const [github, gitlab] = servers.list();
    expect(github).toMatchObject({ id: 'github.com', flavor: 'github.com', builtIn: true, webUrl: 'https://github.com', apiUrl: 'https://api.github.com' });
    expect([...github!.origins]).toEqual(['https://github.com', 'https://api.github.com']);
    expect(github!.record.gitHosts).toEqual(['github.com', 'ssh.github.com']);
    expect(gitlab).toMatchObject({ id: 'gitlab.com', apiUrl: 'https://gitlab.com/api/v4' });
    expect(gitlab!.record.gitHosts).toEqual(['gitlab.com', 'altssh.gitlab.com']);
  });

  it('gives the built-ins the build\'s OAuth apps', async () => {
    const servers = await registry({ github: { clientId: 'Ov23gh', clientSecret: 's3cret' }, gitlab: { clientId: 'gl-app' } });
    expect(servers.get('github.com')!.oauth).toEqual({ clientId: 'Ov23gh', clientSecret: 's3cret' });
    expect(servers.routes(servers.get('github.com')!)).toEqual({ browser: {}, device: {}, token: {} });
    expect(servers.get('gitlab.com')!.oauth).toEqual({ clientId: 'gl-app' });
  });

  it('names the missing client secret when the build has a GitHub client id alone, and keeps device code', async () => {
    const servers = await registry({ github: { clientId: 'Ov23gh' } });
    expect(servers.routes(servers.get('github.com')!)).toEqual({
      browser: { reason: { message: 'This build of Damocles has no client secret for {0}, so it cannot sign in with the browser. Use a device code or a token.', args: ['github.com'] } },
      device: {},
      token: {},
    });
  });

  it('turns device code off for a GitLab whose recorded version is below 17.1, and keeps it while the version is unknown', async () => {
    const servers = await registry();
    await servers.add({ url: 'https://gitlab.indigital.gr', kind: 'gitlab', clientId: 'gl-app', gitHosts: [] }, 1);
    expect(servers.routes(servers.get('gitlab.indigital.gr')!).device).toEqual({});
    await servers.recordVersion('gitlab.indigital.gr', { version: '17.0.4-ee' }, 2);
    expect(servers.routes(servers.get('gitlab.indigital.gr')!).device).toEqual({ reason: { message: 'Device code sign-in needs GitLab 17.1 or later. This server runs GitLab {0}.', args: ['17.0.4-ee'] } });
    await servers.recordVersion('gitlab.indigital.gr', { version: '17.1.0' }, 3);
    expect(servers.routes(servers.get('gitlab.indigital.gr')!).device).toEqual({});
  });

  it('derives the API bases of GHES, a ghe.com tenant and a GitLab under a path prefix', async () => {
    const servers = await registry();
    await servers.add({ url: 'https://github.indigital.gr', kind: 'github', gitHosts: [] }, 1);
    await servers.add({ url: 'https://octo.ghe.com', kind: 'github', gitHosts: [] }, 2);
    await servers.add({ url: 'https://example.com/gitlab', kind: 'gitlab', gitHosts: ['git.example.com'] }, 3);
    expect(servers.get('github.indigital.gr')).toMatchObject({ apiUrl: 'https://github.indigital.gr/api/v3' });
    expect(servers.get('octo.ghe.com')).toMatchObject({ apiUrl: 'https://api.octo.ghe.com' });
    expect([...servers.get('octo.ghe.com')!.origins]).toEqual(['https://octo.ghe.com', 'https://api.octo.ghe.com']);
    expect(servers.get('example.com/gitlab')).toMatchObject({ webUrl: 'https://example.com/gitlab', apiUrl: 'https://example.com/gitlab/api/v4' });
    expect(servers.get('example.com/gitlab')!.record.gitHosts).toEqual(['example.com', 'git.example.com']);
    expect(servers.list().map((server) => server.id)).toEqual(['github.com', 'gitlab.com', 'github.indigital.gr', 'octo.ghe.com', 'example.com/gitlab']);
  });

  it('writes servers.json with mode 0600 and no secret, and keeps a GHES secret in SecretsStore', async () => {
    const servers = await registry();
    await servers.add({ url: 'https://github.indigital.gr', kind: 'github', clientId: 'Ov23ghes', clientSecret: 'ghes-secret', gitHosts: [] }, 1);
    const file = path.join(dir, 'servers.json');
    expect(readFileSync(file, 'utf8')).not.toContain('ghes-secret');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(secrets.entries.get(serverSecretKey('github.indigital.gr'))).toBe('ghes-secret');
    const reloaded = await registry();
    expect(reloaded.get('github.indigital.gr')!.oauth).toEqual({ clientId: 'Ov23ghes', clientSecret: 'ghes-secret' });
  });

  it('keeps a stored secret on an edit that sends none, removes it on "", and with the client id', async () => {
    const servers = await registry();
    await servers.add({ url: 'https://github.indigital.gr', kind: 'github', clientId: 'Ov23ghes', clientSecret: 'ghes-secret', gitHosts: [] }, 1);
    await servers.edit('github.indigital.gr', { clientId: 'Ov23ghes', gitHosts: ['git.indigital.gr'] });
    expect(servers.get('github.indigital.gr')!.oauth?.clientSecret).toBe('ghes-secret');
    expect(servers.get('github.indigital.gr')!.record.gitHosts).toEqual(['github.indigital.gr', 'git.indigital.gr']);
    await servers.edit('github.indigital.gr', { clientId: 'Ov23ghes', clientSecret: '', gitHosts: [] });
    expect(servers.get('github.indigital.gr')!.oauth).toEqual({ clientId: 'Ov23ghes' });
    expect(servers.routes(servers.get('github.indigital.gr')!).browser).toEqual({ reason: { message: "Add the OAuth app's client secret in Edit server to sign in with the browser." } });
    await servers.edit('github.indigital.gr', { clientSecret: 'new-secret', clientId: 'Ov23ghes', gitHosts: [] });
    await servers.edit('github.indigital.gr', { gitHosts: [] });
    expect(servers.get('github.indigital.gr')!.oauth).toBeUndefined();
    expect(secrets.entries.has(serverSecretKey('github.indigital.gr'))).toBe(false);
  });

  it('removes the stored secret when an edit names another client id without a new secret', async () => {
    const servers = await registry();
    await servers.add({ url: 'https://github.indigital.gr', kind: 'github', clientId: 'Ov23old', clientSecret: 'old-secret', gitHosts: [] }, 1);
    await servers.edit('github.indigital.gr', { clientId: 'Ov23new', gitHosts: [] });
    expect(servers.get('github.indigital.gr')!.oauth).toEqual({ clientId: 'Ov23new' });
    expect(secrets.entries.has(serverSecretKey('github.indigital.gr'))).toBe(false);
  });

  it('clears a secret left behind for the id when a server is added without one', async () => {
    await secrets.store(serverSecretKey('github.indigital.gr'), 'stale-secret');
    const servers = await registry();
    await servers.add({ url: 'https://github.indigital.gr', kind: 'github', clientId: 'Ov23ghes', gitHosts: [] }, 1);
    expect(secrets.entries.has(serverSecretKey('github.indigital.gr'))).toBe(false);
    expect((await registry()).get('github.indigital.gr')!.oauth).toEqual({ clientId: 'Ov23ghes' });
  });

  it('keeps the server listed when its secret cannot be deleted, so the remove can be tried again', async () => {
    const store = createTokenStore(secrets, () => undefined);
    let failing = false;
    const servers = await registry({}, { ...store, setClientSecret: (serverId, secret) => (failing ? Promise.reject(new Error('locked')) : store.setClientSecret(serverId, secret)) });
    await servers.add({ url: 'https://github.indigital.gr', kind: 'github', clientId: 'Ov23ghes', clientSecret: 'ghes-secret', gitHosts: [] }, 1);
    failing = true;
    await expect(servers.remove('github.indigital.gr')).rejects.toThrow('locked');
    expect(servers.get('github.indigital.gr')).toBeDefined();
    failing = false;
    await servers.remove('github.indigital.gr');
    expect(servers.get('github.indigital.gr')).toBeUndefined();
    expect(secrets.entries.has(serverSecretKey('github.indigital.gr'))).toBe(false);
  });

  it('keeps a learned host pending, never one another server owns, and manages it only once confirmed', async () => {
    const servers = await registry();
    await servers.add({ url: 'https://gitlab.indigital.gr', kind: 'gitlab', gitHosts: [] }, 1);
    await servers.learnGitHosts('gitlab.indigital.gr', ['git.indigital.gr', 'gitlab.com', 'ssh.github.com', 'gitlab.indigital.gr']);
    expect(servers.get('gitlab.indigital.gr')!.record).toMatchObject({ gitHosts: ['gitlab.indigital.gr'], pendingGitHosts: ['git.indigital.gr'] });
    expect(serversFile().servers[0]).toMatchObject({ pendingGitHosts: ['git.indigital.gr'] });

    expect((await servers.confirmGitHost('gitlab.indigital.gr', 'git.indigital.gr')).ok).toBe(true);
    expect(servers.get('gitlab.indigital.gr')!.record.gitHosts).toEqual(['gitlab.indigital.gr', 'git.indigital.gr']);
    expect(servers.get('gitlab.indigital.gr')!.record.pendingGitHosts).toBeUndefined();
    await servers.learnGitHosts('gitlab.indigital.gr', ['git.indigital.gr']);
    expect(servers.get('gitlab.indigital.gr')!.record.pendingGitHosts).toBeUndefined();
  });

  it('remembers a dismissed host, so the same clone URLs do not propose it again', async () => {
    const servers = await registry();
    await servers.add({ url: 'https://gitlab.indigital.gr', kind: 'gitlab', gitHosts: [] }, 1);
    await servers.learnGitHosts('gitlab.indigital.gr', ['git.indigital.gr']);
    expect((await servers.dismissGitHost('gitlab.indigital.gr', 'git.indigital.gr')).ok).toBe(true);
    await servers.learnGitHosts('gitlab.indigital.gr', ['git.indigital.gr']);
    const reloaded = (await registry()).get('gitlab.indigital.gr')!.record;
    expect(reloaded).toMatchObject({ gitHosts: ['gitlab.indigital.gr'], dismissedGitHosts: ['git.indigital.gr'] });
    expect(reloaded.pendingGitHosts).toBeUndefined();
    expect(await servers.confirmGitHost('gitlab.indigital.gr', 'git.indigital.gr')).toMatchObject({ ok: false, field: 'gitHosts' });
  });

  it('refuses to confirm a pending host another server or a built-in claims', async () => {
    writeFileSync(path.join(dir, 'servers.json'), JSON.stringify({
      version: 1,
      servers: [{ id: 'gitlab.indigital.gr', kind: 'gitlab', flavor: 'gitlab', gitHosts: ['gitlab.indigital.gr'], pendingGitHosts: ['ssh.github.com', 'git.indigital.gr'], addedAt: 1 }],
    }));
    const servers = await registry();
    expect(await servers.confirmGitHost('gitlab.indigital.gr', 'ssh.github.com')).toEqual({ ok: false, field: 'gitHosts', message: { message: '{0} belongs to another server in the list, so it cannot be a git host of this one.', args: ['ssh.github.com'] } });
    await servers.add({ url: 'https://code.indigital.gr', kind: 'gitlab', gitHosts: ['git.indigital.gr'] }, 2);
    expect(await servers.confirmGitHost('gitlab.indigital.gr', 'git.indigital.gr')).toMatchObject({ ok: false, field: 'gitHosts' });
    expect(servers.get('gitlab.indigital.gr')!.record.gitHosts).toEqual(['gitlab.indigital.gr']);
  });

  it('refuses a servers.json with a duplicate id or a built-in server\'s id', () => {
    const server = { id: 'gitlab.indigital.gr', kind: 'gitlab', flavor: 'gitlab', gitHosts: [], addedAt: 1 };
    expect(parseServersFile({ version: 1, servers: [server] })).toBeDefined();
    expect(parseServersFile({ version: 1, servers: [server, { ...server, addedAt: 2 }] })).toBeUndefined();
    expect(parseServersFile({ version: 1, servers: [{ ...server, id: 'github.com' }] })).toBeUndefined();
  });

  it('records a version with its check time', async () => {
    const servers = await registry();
    await servers.add({ url: 'https://gitlab.indigital.gr', kind: 'gitlab', gitHosts: [] }, 1);
    await servers.recordVersion('gitlab.indigital.gr', { version: '17.9.1-ee' }, 1234);
    expect(servers.get('gitlab.indigital.gr')!.record).toMatchObject({ version: '17.9.1-ee', versionCheckedAt: 1234 });
  });

  it('keeps the last records of an unparsable servers.json and refuses writes for the run', async () => {
    writeFileSync(path.join(dir, 'servers.json'), JSON.stringify({ version: 1, servers: [{ id: 'gitlab.com', kind: 'gitlab', flavor: 'gitlab', gitHosts: [], addedAt: 1 }] }));
    const servers = await registry();
    expect(servers.file.broken()).toBe(true);
    expect(servers.list().map((server) => server.id)).toEqual(['github.com', 'gitlab.com']);
    await expect(servers.add({ url: 'https://gitlab.indigital.gr', kind: 'gitlab', gitHosts: [] }, 1)).rejects.toBeInstanceOf(ForgeFileBrokenError);
  });
});
