import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GitCredentialOrigin, GitCredentialRequest } from '../../../shared/git-credential';
import type { BindingStore } from '../bindings/binding-store';
import { createCredentialPolicy, serverOfRequest, type AccessPick, type CredentialChoice, type CredentialPolicy, type CredentialPolicyDeps, type CredentialResult, type ShellRefusal } from '../credentials';
import type { Delegator } from '../delegate';
import { createKnownSecrets, MASK } from '../known-secrets';
import type { AccountRecord, ForgeServer, TokenSet } from '../types';

const server = (id: string, kind: 'github' | 'gitlab', gitHosts: string[] = [id.split('/')[0]!]): ForgeServer => ({
  id, kind, flavor: kind === 'github' ? 'github.com' : 'gitlab.com', builtIn: false, webUrl: `https://${id}`, apiUrl: `https://${id}/api`, origins: new Set(), record: { id, kind, flavor: kind === 'github' ? 'github.com' : 'gitlab.com', gitHosts, addedAt: 0 },
} as unknown as ForgeServer);

const GITLAB = server('gitlab.com', 'gitlab');
const GITHUB = server('github.com', 'github');
const PREFIXED = server('example.com/gl', 'gitlab', ['example.com', 'git.example.com']);

const account = (serverId: string, login: string, agentShells = true): AccountRecord => ({ id: `${serverId}|${login}`, serverId, userId: login, login, auth: 'browser', scopes: [], agentShells, addedAt: 0 });

const WORK = account('gitlab.com', 'work-alexios');
const OFF = account('gitlab.com', 'astef-admin', false);
const HUB = account('github.com', 'astefanopoulos');

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const get = (host: string, path = 'grp/proj.git', extra: Partial<GitCredentialRequest['fields']> = {}): GitCredentialRequest => ({ op: 'get', cwd: '/w/proj', fields: { protocol: 'https', host, path, ...extra } });
const ENGINE: GitCredentialOrigin = { kind: 'engine', projectKey: '/w/proj', interactive: true };
const BACKGROUND: GitCredentialOrigin = { kind: 'engine', projectKey: '/w/proj', interactive: false };
const SHELL: GitCredentialOrigin = { kind: 'agentShell', panelId: 'p1', sessionId: 's1' };
const TERMINAL: GitCredentialOrigin = { kind: 'terminal' };
const LOCAL = { authorityKey: 'local' };

interface Options {
  readonly accounts?: readonly AccountRecord[];
  readonly bindings?: Record<string, Record<string, string | null>>;
  readonly hostDefaults?: Record<string, Record<string, string>>;
  readonly picked?: AccessPick;
  readonly choice?: CredentialChoice;
  readonly tokens?: Record<string, TokenSet>;
  readonly byRemote?: string;
  readonly filled?: { username: string; password: string };
}

function world(options: Options = {}) {
  const refusals: ShellRefusal[] = [];
  const delegated: Array<{ op: string; interactive: boolean; password?: string }> = [];
  const delegatedFromShell: boolean[] = [];
  const lookups: Array<{ readonly dep: 'projectByRemote' | 'pickByAccess'; readonly signal: AbortSignal }> = [];
  const asked: unknown[] = [];
  const verified: string[] = [];
  const tokensRead: string[] = [];
  const secrets = createKnownSecrets(() => 0);
  const bindings = {
    binding: (projectKey: string, serverId: string) => {
      const bound = options.bindings?.[projectKey]?.[serverId];
      return bound === undefined ? undefined : { account: bound, at: 0 };
    },
    hostDefaults: (authorityKey: string) => options.hostDefaults?.[authorityKey] ?? {},
  } as unknown as BindingStore;
  const delegator: Delegator = {
    run: vi.fn(async (request) => {
      delegated.push({ op: request.op, interactive: request.interactive, ...(request.password !== undefined ? { password: request.password } : {}) });
      delegatedFromShell.push(request.agentShell);
      return request.op === 'get' ? options.filled : undefined;
    }),
  };
  const deps: CredentialPolicyDeps = {
    servers: () => [GITLAB, GITHUB, PREFIXED],
    accounts: () => options.accounts ?? [WORK, HUB],
    bindings,
    pickByAccess: async (_accounts, _server, _repoPath, signal) => {
      lookups.push({ dep: 'pickByAccess', signal });
      return options.picked;
    },
    ask: async (input) => {
      asked.push(input);
      return options.choice ?? { kind: 'cancelled' };
    },
    token: async (record) => {
      tokensRead.push(record.id);
      const held = options.tokens?.[record.id] ?? { access: `access-of-${record.login}`, refresh: `refresh-of-${record.login}`, tokenType: 'oauth' };
      if (held.access === 'gone') throw new Error('sign in again');
      return held;
    },
    verify: async (record) => {
      verified.push(record.id);
    },
    delegator,
    projectByRemote: async (_authorityKey, _server, _repoPath, _cwd, signal) => {
      lookups.push({ dep: 'projectByRemote', signal });
      return options.byRemote;
    },
    projectHolding: () => undefined,
    refused: (refusal) => refusals.push(refusal),
    secrets,
    log: () => undefined,
    now: () => 0,
  };
  const raw = createCredentialPolicy(deps);
  // an answer for git; a request that asks for a relay consent fails the test here, and only `raw` shows that step
  const policy = {
    answer: async (...args: Parameters<CredentialPolicy['answer']>): Promise<Exclude<CredentialResult, { readonly consent: unknown }>> => {
      const result = await raw.answer(...args);
      if ('consent' in result) throw new Error(`asked for consent to ${result.consent.accountId}`);
      return result;
    },
  };
  return { policy, raw, refusals, delegated, delegatedFromShell, lookups, asked, verified, secrets, tokensRead };
}

const signal = new AbortController().signal;

describe('the answer policy for get', () => {
  it('maps a request to a server by host, port and path prefix, and LFS paths to their repository', () => {
    expect(serverOfRequest({ protocol: 'https', host: 'gitlab.com', path: 'g/sub/p.git/info/lfs/objects/batch' }, [GITLAB])).toEqual({ server: GITLAB, repoPath: 'g/sub/p' });
    expect(serverOfRequest({ protocol: 'https', host: 'example.com', path: 'gl/team/p.git' }, [PREFIXED])).toEqual({ server: PREFIXED, repoPath: 'team/p' });
    expect(serverOfRequest({ protocol: 'https', host: 'example.com', path: 'other/p.git' }, [PREFIXED])).toBeUndefined();
    expect(serverOfRequest({ protocol: 'https', host: 'git.example.com' }, [PREFIXED])).toEqual({ server: PREFIXED });
    // the prefix scopes the web host only: a separate git host names the repository with or without it
    expect(serverOfRequest({ protocol: 'https', host: 'git.example.com', path: 'team/p.git' }, [PREFIXED])).toEqual({ server: PREFIXED, repoPath: 'team/p' });
    expect(serverOfRequest({ protocol: 'https', host: 'git.example.com', path: 'gl/team/p.git' }, [PREFIXED])).toEqual({ server: PREFIXED, repoPath: 'team/p' });
    expect(serverOfRequest({ protocol: 'http', host: 'gitlab.com', path: 'g/p.git' }, [GITLAB])).toBeUndefined();
    expect(serverOfRequest({ protocol: 'https', host: 'gitlab.com:8443', path: 'g/p.git' }, [GITLAB])).toBeUndefined();
  });

  it('answers the only account\'s access token, never the refresh token, as oauth2 for a GitLab OAuth token, and masks it', async () => {
    const w = world({ accounts: [WORK, HUB] });
    const result = await w.policy.answer(get('gitlab.com'), ENGINE, LOCAL, signal);
    expect(result).toEqual({ answer: { kind: 'credential', username: 'oauth2', password: 'access-of-work-alexios' }, account: { serverId: 'gitlab.com', accountId: WORK.id, login: 'work-alexios', how: 'onlyAccount' } });
    expect(JSON.stringify(result)).not.toContain('refresh-of');
    expect(w.secrets.mask('x access-of-work-alexios')).toBe(`x ${MASK}`);
    expect(w.delegated).toEqual([]);
  });

  it('answers a personal token and a GitHub token with the login', async () => {
    const w = world({ tokens: { [WORK.id]: { access: 'glpat-personal-token', tokenType: 'personal' } } });
    expect((await w.policy.answer(get('gitlab.com'), ENGINE, LOCAL, signal)).answer).toEqual({ kind: 'credential', username: 'work-alexios', password: 'glpat-personal-token' });
    expect((await w.policy.answer(get('github.com', 'o/r.git'), ENGINE, LOCAL, signal)).answer).toEqual({ kind: 'credential', username: 'astefanopoulos', password: 'access-of-astefanopoulos' });
  });

  it('delegates a server it does not manage, or one without accounts: run here locally, answered delegate to another computer', async () => {
    const w = world({ accounts: [HUB], filled: { username: 'ada', password: 'from-gcm' } });
    expect((await w.policy.answer(get('bitbucket.org'), ENGINE, LOCAL, signal)).answer).toEqual({ kind: 'credential', username: 'ada', password: 'from-gcm' });
    expect((await w.policy.answer(get('gitlab.com'), BACKGROUND, LOCAL, signal)).answer).toEqual({ kind: 'credential', username: 'ada', password: 'from-gcm' });
    expect(w.delegated).toEqual([{ op: 'get', interactive: true }, { op: 'get', interactive: false }]);
    expect((await w.policy.answer(get('bitbucket.org'), ENGINE, { authorityKey: 'ssh+h1' }, signal)).answer).toEqual({ kind: 'delegate' });
    expect(w.delegated).toHaveLength(2);
  });

  it('delegates for every origin when the project chose Git\'s own credentials, an agent shell included', async () => {
    const w = world({ bindings: { '/w/proj': { 'gitlab.com': null } }, filled: { username: 'ada', password: 'from-gcm' } });
    // an agent shell names no project; its git runs in the project's folder, which the remote URL maps
    const shell = world({ byRemote: '/w/proj', bindings: { '/w/proj': { 'gitlab.com': null } }, filled: { username: 'ada', password: 'from-gcm' } });
    for (const origin of [ENGINE, BACKGROUND, { kind: 'terminal', projectKey: '/w/proj' } as const]) {
      expect((await w.policy.answer(get('gitlab.com'), origin, LOCAL, signal)).answer).toEqual({ kind: 'credential', username: 'ada', password: 'from-gcm' });
    }
    expect((await shell.policy.answer(get('gitlab.com'), SHELL, LOCAL, signal)).answer).toEqual({ kind: 'credential', username: 'ada', password: 'from-gcm' });
    expect(w.delegated.map((entry) => entry.interactive)).toEqual([true, false, true]);
    // an agent shell's delegation never shows the manager's own sign-in
    expect(shell.delegated.map((entry) => entry.interactive)).toEqual([false]);
    expect(shell.refusals).toEqual([]);
  });

  it('refuses an agent shell whose account\'s switch is off, naming the switch, posting the notice and never delegating', async () => {
    const w = world({ accounts: [OFF] });
    const result = await w.policy.answer(get('gitlab.com'), SHELL, LOCAL, signal);
    expect(result.answer.kind).toBe('refused');
    expect(result.answer.kind === 'refused' && result.answer.message).toContain('Agent shells may use this account');
    expect(w.refusals).toEqual([{ origin: SHELL, server: GITLAB, account: OFF, reason: 'agentShellsOff' }]);
    expect(w.delegated).toEqual([]);
    // the same account answers Damocles' own call
    expect((await w.policy.answer(get('gitlab.com'), ENGINE, LOCAL, signal)).answer.kind).toBe('credential');
  });

  it('refuses a target\'s agent shell without raising a notice in this computer\'s chats', async () => {
    const w = world({ accounts: [OFF] });
    expect((await w.policy.answer(get('gitlab.com'), SHELL, { authorityKey: 'ssh+h1' }, signal)).answer.kind).toBe('refused');
    expect(w.refusals).toEqual([]);
  });

  it('answers an agent shell whose account\'s switch is on', async () => {
    const w = world({ accounts: [WORK] });
    expect((await w.policy.answer(get('gitlab.com'), SHELL, LOCAL, signal)).answer).toEqual({ kind: 'credential', username: 'oauth2', password: 'access-of-work-alexios' });
    expect(w.refusals).toEqual([]);
  });

  it('when nothing resolves: refuses an agent shell with the notice, delegates a background call, asks Damocles\' own call and a terminal', async () => {
    const two = [WORK, OFF];
    const shell = world({ accounts: two });
    expect((await shell.policy.answer(get('gitlab.com'), SHELL, LOCAL, signal)).answer.kind).toBe('refused');
    expect(shell.refusals).toEqual([{ origin: SHELL, server: GITLAB, reason: 'noAccount' }]);
    expect(shell.asked).toEqual([]);
    expect(shell.delegated).toEqual([]);

    const background = world({ accounts: two });
    await background.policy.answer(get('gitlab.com'), BACKGROUND, LOCAL, signal);
    expect(background.delegated).toEqual([{ op: 'get', interactive: false }]);
    expect(background.asked).toEqual([]);

    const chosen = world({ accounts: two, choice: { kind: 'account', account: OFF } });
    expect(await chosen.policy.answer(get('gitlab.com'), ENGINE, LOCAL, signal)).toMatchObject({ answer: { kind: 'credential', password: 'access-of-astef-admin' }, account: { how: 'choice' } });
    expect(chosen.asked).toEqual([expect.objectContaining({ projectKey: '/w/proj', server: GITLAB, repoPath: 'grp/proj' })]);

    const terminal = world({ accounts: two, choice: { kind: 'own' } });
    await terminal.policy.answer(get('gitlab.com'), TERMINAL, LOCAL, signal);
    expect(terminal.asked).toHaveLength(1);
    expect(terminal.delegated).toEqual([{ op: 'get', interactive: true }]);

    const cancelled = world({ accounts: two });
    expect((await cancelled.policy.answer(get('gitlab.com'), TERMINAL, LOCAL, signal)).answer.kind).toBe('refused');
  });

  it('settles by the access check\'s pick, the clone\'s chosen account, a host default and the project the remote URL names', async () => {
    const two = [WORK, OFF];
    expect((await world({ accounts: two, picked: { account: WORK, canPush: true } }).policy.answer(get('gitlab.com'), BACKGROUND, LOCAL, signal)).account).toEqual({ serverId: 'gitlab.com', accountId: WORK.id, login: 'work-alexios', how: 'access', canPush: true });
    expect((await world({ accounts: two }).policy.answer(get('gitlab.com'), { kind: 'engine', interactive: true, presetAccountId: OFF.id }, LOCAL, signal)).account?.login).toBe('astef-admin');
    expect((await world({ accounts: two, hostDefaults: { 'ssh+h1': { 'gitlab.com': OFF.id } } }).policy.answer(get('gitlab.com'), { kind: 'engine', projectKey: 'ssh+h1|/p', interactive: true }, { authorityKey: 'ssh+h1' }, signal)).account).toEqual({ serverId: 'gitlab.com', accountId: OFF.id, login: 'astef-admin', how: 'hostDefault' });
    const byRemote = world({ accounts: two, byRemote: '/other', bindings: { '/other': { 'gitlab.com': WORK.id }, '/w/proj': { 'gitlab.com': OFF.id } } });
    expect((await byRemote.policy.answer(get('gitlab.com'), TERMINAL, LOCAL, signal)).account).toEqual({ serverId: 'gitlab.com', accountId: WORK.id, login: 'work-alexios', how: 'bound' });
  });

  it('masks a credential the user\'s helpers gave an agent shell, and delegates it as an agent shell; a terminal\'s is not masked', async () => {
    const shell = world({ byRemote: '/w/proj', bindings: { '/w/proj': { 'gitlab.com': null } }, filled: { username: 'ada', password: 'shell-pat-77' } });
    expect((await shell.policy.answer(get('gitlab.com'), SHELL, LOCAL, signal)).answer).toEqual({ kind: 'credential', username: 'ada', password: 'shell-pat-77' });
    expect(shell.delegatedFromShell).toEqual([true]);
    expect(shell.secrets.mask('x shell-pat-77')).toBe(`x ${MASK}`);
    const terminal = world({ bindings: { '/w/proj': { 'gitlab.com': null } }, filled: { username: 'ada', password: 'terminal-pat-78' } });
    await terminal.policy.answer(get('gitlab.com'), { kind: 'terminal', projectKey: '/w/proj' }, LOCAL, signal);
    expect(terminal.delegatedFromShell).toEqual([false]);
    expect(terminal.secrets.mask('x terminal-pat-78')).toBe('x terminal-pat-78');
  });

  it('honours a preset account only from this computer, so a target\'s preset never skips the consent as bound', async () => {
    const preset: GitCredentialOrigin = { kind: 'engine', interactive: true, presetAccountId: OFF.id };
    const remote = world({ accounts: [WORK, OFF] });
    const result = await remote.policy.answer(get('gitlab.com'), preset, { authorityKey: 'ssh+h1' }, signal);
    expect(result.account).toBeUndefined();
    expect(remote.asked).toHaveLength(1);
    const local = world({ accounts: [WORK, OFF] });
    expect((await local.policy.answer(get('gitlab.com'), preset, LOCAL, signal)).account).toEqual({ serverId: 'gitlab.com', accountId: OFF.id, login: 'astef-admin', how: 'bound' });
  });

  it('names a target\'s automatic pick for consent without reading its token, and answers only once that account was agreed to', async () => {
    const remote = { authorityKey: 'ssh+h1' };
    const w = world({ accounts: [WORK] });
    expect(await w.raw.answer(get('gitlab.com'), TERMINAL, remote, signal)).toEqual({ consent: { serverId: 'gitlab.com', accountId: WORK.id, login: 'work-alexios', how: 'onlyAccount' } });
    // denied: main asks nothing more, so no token was read and nothing is masked
    expect(w.tokensRead).toEqual([]);
    expect(w.secrets.mask('x access-of-work-alexios')).toBe('x access-of-work-alexios');
    expect(await w.raw.answer(get('gitlab.com'), TERMINAL, { ...remote, consentedAccountId: 'gitlab.com|someone-else' }, signal)).toEqual({ consent: expect.objectContaining({ accountId: WORK.id }) });
    expect(w.tokensRead).toEqual([]);
    expect(await w.raw.answer(get('gitlab.com'), TERMINAL, { ...remote, consentedAccountId: WORK.id }, signal)).toEqual({ answer: { kind: 'credential', username: 'oauth2', password: 'access-of-work-alexios' }, account: { serverId: 'gitlab.com', accountId: WORK.id, login: 'work-alexios', how: 'onlyAccount' } });
    expect(w.tokensRead).toEqual([WORK.id]);
  });

  it('says whether an access pick for a target can push, so the consent can say read', async () => {
    const reader = world({ accounts: [WORK, OFF], picked: { account: WORK, canPush: false } });
    expect(await reader.raw.answer(get('gitlab.com'), TERMINAL, { authorityKey: 'ssh+h1' }, signal)).toEqual({ consent: { serverId: 'gitlab.com', accountId: WORK.id, login: 'work-alexios', how: 'access', canPush: false } });
  });

  it('needs no consent for a target\'s binding or host default, which the user chose', async () => {
    const bound = world({ accounts: [WORK, OFF], bindings: { 'ssh+h1|/p': { 'gitlab.com': OFF.id } } });
    expect((await bound.policy.answer(get('gitlab.com'), { kind: 'engine', interactive: true }, { authorityKey: 'ssh+h1', projectKey: 'ssh+h1|/p' }, signal)).account?.how).toBe('bound');
    const local = world({ accounts: [WORK] });
    expect((await local.policy.answer(get('gitlab.com'), TERMINAL, LOCAL, signal)).account?.how).toBe('onlyAccount');
  });

  it('takes an engine call\'s own project, or the relayed request\'s, before reading any remote; a terminal maps by the remote first', async () => {
    const bindings = { '/other': { 'gitlab.com': WORK.id }, '/w/proj': { 'gitlab.com': OFF.id } };
    const engine = world({ accounts: [WORK, OFF], byRemote: '/other', bindings });
    expect((await engine.policy.answer(get('gitlab.com'), ENGINE, LOCAL, signal)).account?.login).toBe('astef-admin');
    const relayed = world({ accounts: [WORK, OFF], byRemote: '/other', bindings: { 'ssh+h1|/p': { 'gitlab.com': OFF.id } } });
    expect((await relayed.policy.answer(get('gitlab.com'), { kind: 'engine', interactive: false }, { authorityKey: 'ssh+h1', projectKey: 'ssh+h1|/p' }, signal)).account?.login).toBe('astef-admin');
    expect([...engine.lookups, ...relayed.lookups].filter((lookup) => lookup.dep === 'projectByRemote')).toEqual([]);
    const terminal = world({ accounts: [WORK, OFF], byRemote: '/other', bindings });
    expect((await terminal.policy.answer(get('gitlab.com'), { kind: 'terminal', projectKey: '/w/proj' }, LOCAL, signal)).account?.login).toBe('work-alexios');
  });

  it('hands the request\'s signal to the remote lookup and the access check', async () => {
    const w = world({ accounts: [WORK, OFF], picked: { account: WORK, canPush: true } });
    const own = new AbortController().signal;
    await w.policy.answer(get('gitlab.com'), TERMINAL, LOCAL, own);
    expect(w.lookups.map((lookup) => lookup.dep)).toEqual(['projectByRemote', 'pickByAccess']);
    expect(w.lookups.every((lookup) => lookup.signal === own)).toBe(true);
  });

  it('refuses when the account must sign in again', async () => {
    const w = world({ accounts: [WORK], tokens: { [WORK.id]: { access: 'gone', tokenType: 'oauth' } } });
    const result = await w.policy.answer(get('gitlab.com'), ENGINE, LOCAL, signal);
    expect(result.answer.kind === 'refused' && result.answer.message).toContain('must sign in again');
  });
});

describe('the answer policy for store and erase', () => {
  it('drops a store of a token Damocles answered and delegates one of a credential the user\'s helpers gave', async () => {
    const w = world({ accounts: [WORK, HUB], filled: { username: 'ada', password: 'from-gcm' } });
    await w.policy.answer(get('gitlab.com'), ENGINE, LOCAL, signal);
    await w.policy.answer(get('bitbucket.org'), ENGINE, LOCAL, signal);
    const store = (host: string, password: string): GitCredentialRequest => ({ ...get(host), op: 'store', password, passwordHash: sha(password) });
    expect((await w.policy.answer(store('gitlab.com', 'access-of-work-alexios'), ENGINE, LOCAL, signal)).answer).toEqual({ kind: 'none' });
    expect((await w.policy.answer(store('bitbucket.org', 'from-gcm'), ENGINE, LOCAL, signal)).answer).toEqual({ kind: 'none' });
    expect((await w.policy.answer(store('bitbucket.org', 'typed-by-hand'), ENGINE, LOCAL, signal)).answer).toEqual({ kind: 'none' });
    expect(w.delegated).toEqual([{ op: 'get', interactive: true }, { op: 'store', interactive: true, password: 'from-gcm' }]);
  });

  it('checks the account when git erases a Damocles token, and delegates the erase of a delegated credential', async () => {
    const w = world({ accounts: [WORK], filled: { username: 'ada', password: 'from-gcm' } });
    await w.policy.answer(get('gitlab.com'), ENGINE, LOCAL, signal);
    await w.policy.answer(get('bitbucket.org'), ENGINE, LOCAL, signal);
    const erase = (host: string, password: string): GitCredentialRequest => ({ ...get(host), op: 'erase', password, passwordHash: sha(password) });
    expect((await w.policy.answer(erase('gitlab.com', 'access-of-work-alexios'), ENGINE, LOCAL, signal)).answer).toEqual({ kind: 'none' });
    expect(w.verified).toEqual([WORK.id]);
    await w.policy.answer(erase('bitbucket.org', 'from-gcm'), ENGINE, LOCAL, signal);
    expect(w.delegated).toEqual([{ op: 'get', interactive: true }, { op: 'erase', interactive: true, password: 'from-gcm' }]);
    // an erase of anything else reaches no helper
    await w.policy.answer(erase('bitbucket.org', 'other'), ENGINE, LOCAL, signal);
    expect(w.delegated).toHaveLength(2);
  });

  it('never delegates a store or erase from another computer', async () => {
    const w = world({ accounts: [WORK] });
    const remote = { authorityKey: 'ssh+h1' };
    expect((await w.policy.answer(get('bitbucket.org'), ENGINE, remote, signal)).answer).toEqual({ kind: 'delegate' });
    expect((await w.policy.answer({ ...get('bitbucket.org'), op: 'store', passwordHash: sha('x') }, ENGINE, remote, signal)).answer).toEqual({ kind: 'none' });
    expect((await w.policy.answer({ ...get('bitbucket.org'), op: 'erase', passwordHash: sha('x') }, ENGINE, remote, signal)).answer).toEqual({ kind: 'none' });
    expect(w.delegated).toEqual([]);
  });
});
