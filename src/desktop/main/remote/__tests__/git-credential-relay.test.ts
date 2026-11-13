import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Launcher, SpawnSpec } from '../../../../core/process-launcher';
import { createAskpassServer, parseAskpassRequest, type AskpassServer, type RelayCredential } from '../../../../core/scm/askpass/askpass-server';
import { relayHelperConfig, shQuote, spawnCredentialVariables, type CredentialRelay, type RelayIdentity } from '../../../../core/scm/askpass/credential-relay';
import { createCredentialRelay } from '../../../daemon/serve';
import { createGitRunner } from '../../../../core/scm/git-runner';
import { GitError, gitFailureCode } from '../../../../core/scm/errors';
import { resolveGitExecutable } from '../../../../core/git-executable';
import { credentialFields } from '../../../askpass/helper-protocol';
import type { GitCredentialConsent, GitCredentialConsentChoice } from '../../../preload/overlay-channels';
import type { GitCredentialAnswer } from '../../../../shared/git-credential';
import { CONSENTED_HOWS } from '../../../../shared/forge/bindings';
import type { ForgeCredentialAccount } from '../../../core-protocol/messages';
import { clientGitCredential, createGitCredentialClient, credentialHostOf, credentialInput, parseFillOutput, type CredentialDaemon, type CredentialTargetHost, type ForgeCredentialDeps, type GitCredentialClientDeps, type GitCredentialRequest } from '../git-credential-client';

const RELAY: CredentialRelay = { helper: '/srv/dam server/dist/git-credential/git-credential-relay.sh', node: '/srv/node', main: '/srv/dist/askpass-main.js', handle: '/tmp/x/askpass.sock', nonce: 'c'.repeat(64) };
const GIT = { path: '/usr/bin/git', version: { major: 2, minor: 45, patch: 1 } };

// Records each start's spec and answers it with exit 0 and the given stdout.
function recordingLauncher(stdout: (spec: SpawnSpec) => string = () => ''): { specs: SpawnSpec[]; launcher: Launcher } {
  const specs: SpawnSpec[] = [];
  const launcher: Launcher = {
    launch(spec) {
      specs.push(spec);
      const listeners: Array<(chunk: Buffer) => void> = [];
      let exit: (value: { code: number; signal: null }) => void = () => undefined;
      let close: () => void = () => undefined;
      const exited = new Promise<{ code: number; signal: null }>((resolve) => (exit = resolve));
      const closed = new Promise<void>((resolve) => (close = resolve));
      setImmediate(() => {
        const out = stdout(spec);
        if (out !== '') for (const listener of listeners) listener(Buffer.from(out));
        exit({ code: 0, signal: null });
        close();
      });
      return {
        pid: Promise.resolve(1),
        onData: (stream, listener) => {
          if (stream === 'stdout') listeners.push(listener);
        },
        write: () => Promise.resolve(),
        end: () => undefined,
        exited,
        closed,
        leftRunning: closed.then(() => false),
        kill: () => undefined,
      };
    },
    createSessionJob: () => ({ id: 1, dispose: () => undefined }),
    dispose: async () => undefined,
  };
  return { specs, launcher };
}

function relayRunner(options: { readonly relay?: CredentialRelay; readonly agentSocket?: string; readonly stdout?: (spec: SpawnSpec) => string; readonly trusted?: boolean; readonly version?: typeof GIT.version } = {}) {
  const fake = recordingLauncher(options.stdout);
  const runner = createGitRunner({
    git: { ...GIT, ...(options.version ? { version: options.version } : {}) },
    log: { appendLine: () => undefined },
    isTrusted: () => options.trusted ?? true,
    launcher: fake.launcher,
    credentialRelay: () => options.relay,
    agentSocket: () => options.agentSocket,
  });
  return { runner, specs: fake.specs };
}

describe('the relay helper reads git\'s description', () => {
  it('relays protocol, host, path and username, never a password, tells a description without a host apart, and refuses a malformed one', () => {
    expect(credentialFields('protocol=https\nhost=github.com\npath=o/r.git\nusername=ada\npassword=hunter2\n\n')).toEqual({ protocol: 'https', host: 'github.com', path: 'o/r.git', username: 'ada' });
    expect(credentialFields('protocol=https\nhost=github.com\ncapability[]=authtype\nwwwauth[]=Basic\n')).toEqual({ protocol: 'https', host: 'github.com' });
    expect(credentialFields('protocol=https\n')).toBe('noHost');
    expect(credentialFields('protocol=cert\npath=/home/ada/client.p12\n')).toBe('noHost');
    expect(credentialFields('protocol=https\nhost=a\u0000b\n')).toBeUndefined();
    expect(credentialFields('protocol=https\nnot a line\nhost=a\n')).toBeUndefined();
    expect(credentialFields(`protocol=https\nhost=${'h'.repeat(260)}\n`)).toBeUndefined();
  });

  it('is refused at the server unless it is exactly a get, store or erase with bounded fields', () => {
    const request = (body: unknown): unknown => parseAskpassRequest(Buffer.from(JSON.stringify(body)));
    const nonce = 'c'.repeat(64);
    const asked = { op: 'get', cwd: '/w', fields: { protocol: 'https', host: 'github.com' } };
    const base = { nonce, kind: 'credential', ...asked };
    expect(request(base)).toEqual({ nonce, kind: 'credential', request: asked });
    expect(request({ ...base, op: 'fill' })).toBeUndefined();
    expect(request({ ...base, fields: { ...base.fields, password: 'x' } })).toBeUndefined();
    expect(request({ ...base, fields: { protocol: 'https', host: 'a\nprotocol=http' } })).toBeUndefined();
    expect(request({ ...base, cwd: '/w\n' })).toBeUndefined();
    expect(request({ ...base, extra: 1 })).toBeUndefined();
    // a store or erase names git's password, of which the server keeps the SHA-256 for anything leaving this machine
    const hash = createHash('sha256').update('tok', 'utf8').digest('hex');
    expect(request({ ...base, op: 'erase', password: 'tok' })).toEqual({ nonce, kind: 'credential', request: { ...asked, op: 'erase', password: 'tok', passwordHash: hash } });
    expect(request({ ...base, op: 'store', password: 'tok' })).toEqual({ nonce, kind: 'credential', request: { ...asked, op: 'store', password: 'tok', passwordHash: hash } });
    expect(request({ ...base, password: 'tok' })).toBeUndefined();
    expect(request({ ...base, op: 'erase', passwordHash: hash })).toBeUndefined();
    for (const password of ['', 'a\nb', 1]) expect(request({ ...base, op: 'erase', password })).toBeUndefined();
  });
});

describe('main accepts https only, with bounded fields', () => {
  it('takes an https host name or address with a port, lowercased, and refuses anything else', () => {
    expect(credentialHostOf({ protocol: 'https', host: 'GitHub.com' })).toBe('github.com');
    expect(credentialHostOf({ protocol: 'https', host: 'git.example.com:8443' })).toBe('git.example.com:8443');
    expect(credentialHostOf({ protocol: 'http', host: 'github.com' })).toBeUndefined();
    expect(credentialHostOf({ protocol: 'ssh', host: 'github.com' })).toBeUndefined();
    for (const host of ['a/b', 'user@github.com', 'github.com:0', 'github.com:70000', '-x.com', 'a b', '']) expect(credentialHostOf({ protocol: 'https', host })).toBeUndefined();
  });

  it('writes git credential fill one line per field and refuses a line break', () => {
    expect(credentialInput('github.com', { protocol: 'https', host: 'github.com', path: 'o/r', username: 'ada' })).toBe('protocol=https\nhost=github.com\npath=o/r\nusername=ada\n\n');
    expect(() => credentialInput('github.com', { protocol: 'https', host: 'github.com', username: 'ada\npassword=x' })).toThrow(RangeError);
  });

  it('answers only a username and password fill printed within the bounds', () => {
    expect(parseFillOutput('protocol=https\nhost=github.com\nusername=ada\npassword=tok\n')).toEqual({ username: 'ada', password: 'tok' });
    expect(parseFillOutput('protocol=https\r\nhost=github.com\r\nusername=ada\r\npassword=tok\r\n')).toEqual({ username: 'ada', password: 'tok' });
    expect(parseFillOutput('username=ada\n')).toBeUndefined();
    expect(parseFillOutput(`username=ada\npassword=${'x'.repeat(5000)}\n`)).toBeUndefined();
  });
});

const TARGET: CredentialTargetHost = { name: 'prod-1', color: 'danger', alwaysCredentialHosts: [], alwaysForgeAccounts: [] };

interface ClientOptions {
  readonly target?: CredentialTargetHost;
  readonly choice?: GitCredentialConsentChoice;
  readonly notifyChoice?: (action: string) => string | undefined;
  readonly verifiesErase?: boolean;
  readonly askConsent?: GitCredentialClientDeps['askConsent'];
  readonly addAlways?: GitCredentialClientDeps['addAlways'];
  readonly fill?: string;
  readonly forge?: ForgeCredentialDeps['answer'];
  readonly takesForgeAnswers?: boolean;
}

// The relay as one daemon's core reaches it: the daemon's welcome features come from the options, as the attach read them.
function client(options: ClientOptions = {}) {
  const consents: GitCredentialConsent[] = [];
  const forgeAsked: Array<{ request: unknown; origin: unknown; authorityKey: string; projectKey: string | undefined; consentedAccountId: string | undefined }> = [];
  const git: Array<{ op: 'fill' | 'reject'; input: string }> = [];
  const notices: string[] = [];
  const logs: string[] = [];
  const deps: GitCredentialClientDeps = {
    host: () => options.target ?? TARGET,
    forge: {
      answer: async (request, origin, authorityKey, projectKey, consentedAccountId, forgeSignal) => {
        forgeAsked.push({ request, origin, authorityKey, projectKey, consentedAccountId });
        if (!options.forge) throw new Error('no forge answer in this test');
        return options.forge(request, origin, authorityKey, projectKey, consentedAccountId, forgeSignal);
      },
      authorityKey: () => 'ssh+h1',
      projectOf: (_hostId, targetProjectKey, cwd) => (targetProjectKey !== undefined ? `ssh+h1|${targetProjectKey}` : cwd?.startsWith('/srv/app') ? 'ssh+h1|/srv/app' : undefined),
    },
    addAlways: vi.fn(options.addAlways ?? (async () => undefined)),
    revokeAlways: vi.fn(async () => undefined),
    addAlwaysAccount: vi.fn(async () => undefined),
    askConsent: async (consent, consentSignal) => {
      consents.push(consent);
      return options.askConsent ? options.askConsent(consent, consentSignal) : (options.choice ?? 'once');
    },
    gitCredential: async (op, input) => {
      git.push({ op, input });
      return op === 'fill' ? (options.fill ?? 'protocol=https\nhost=github.com\nusername=ada\npassword=tok\n') : '';
    },
    notify: async (message, action) => {
      notices.push(message);
      return options.notifyChoice?.(action);
    },
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)] ?? ''),
    log: (line) => logs.push(line),
  };
  const daemon: CredentialDaemon = { takesForgeAnswers: options.takesForgeAnswers ?? true, verifiesErase: options.verifiesErase ?? true };
  const inner = createGitCredentialClient(deps);
  const relay = { handle: (hostId: string, request: GitCredentialRequest, handleSignal: AbortSignal) => inner.handle(hostId, request, daemon, handleSignal) };
  return { relay, deps, consents, git, notices, logs, forgeAsked };
}

// a consent dialog the test answers, with the signal it was shown with
function heldDialogs() {
  const shown: Array<{ readonly consent: GitCredentialConsent; readonly signal: AbortSignal; readonly answer: (choice: GitCredentialConsentChoice) => void }> = [];
  const askConsent: GitCredentialClientDeps['askConsent'] = (consent, dialogSignal) => new Promise((resolve) => {
    shown.push({ consent, signal: dialogSignal, answer: resolve });
    dialogSignal.addEventListener('abort', () => resolve('deny'), { once: true });
  });
  return { shown, askConsent };
}

describe('the client side of the relay', () => {
  const GET: GitCredentialRequest = { op: 'get', fields: { protocol: 'https', host: 'github.com' }, targetHelper: false };
  const signal = new AbortController().signal;

  it('asks consent naming both hosts and the safety color, then relays get through git credential fill', async () => {
    const { relay, consents, git } = client();
    await expect(relay.handle('h1', GET, signal)).resolves.toEqual({ kind: 'credential', username: 'ada', password: 'tok' });
    expect(consents).toEqual([{ hostName: 'prod-1', hostColor: 'danger', credentialHost: 'github.com', targetHelper: false }]);
    expect(git).toEqual([{ op: 'fill', input: 'protocol=https\nhost=github.com\n\n' }]);
    // Allow once asks again next time
    await relay.handle('h1', GET, signal);
    expect(consents).toHaveLength(2);
  });

  it('warns when the target has a helper of its own', async () => {
    const { relay, consents } = client();
    await relay.handle('h1', { ...GET, targetHelper: true }, signal);
    expect(consents[0]?.targetHelper).toBe(true);
  });

  it('stores Always for the pair, and an Always pair is relayed without asking', async () => {
    const asked = client({ choice: 'always' });
    await asked.relay.handle('h1', GET, signal);
    expect(asked.deps.addAlways).toHaveBeenCalledWith('h1', 'github.com');
    const always = client({ target: { ...TARGET, alwaysCredentialHosts: ['github.com'] } });
    await expect(always.relay.handle('h1', GET, signal)).resolves.toMatchObject({ kind: 'credential' });
    expect(always.consents).toEqual([]);
  });

  it('relays nothing on Deny, for http, or for a malformed host, and asks nothing for the latter two', async () => {
    const denied = client({ choice: 'deny' });
    await expect(denied.relay.handle('h1', GET, signal)).resolves.toEqual({ kind: 'none' });
    expect(denied.git).toEqual([]);
    const refused = client();
    await expect(refused.relay.handle('h1', { ...GET, fields: { protocol: 'http', host: 'github.com' } }, signal)).resolves.toEqual({ kind: 'none' });
    await expect(refused.relay.handle('h1', { ...GET, fields: { protocol: 'https', host: 'evil/path' } }, signal)).resolves.toEqual({ kind: 'none' });
    expect(refused.consents).toEqual([]);
    expect(refused.git).toEqual([]);
  });

  it('shares one dialog between concurrent requests for a pair', async () => {
    const { relay, consents } = client();
    await Promise.all([relay.handle('h1', GET, signal), relay.handle('h1', GET, signal)]);
    expect(consents).toHaveLength(1);
  });

  it('never answers a request that needs the target-helper warning with a dialog shown without it', async () => {
    const dialogs = heldDialogs();
    const { relay } = client({ askConsent: dialogs.askConsent });
    const plain = relay.handle('h1', GET, signal);
    await vi.waitFor(() => expect(dialogs.shown).toHaveLength(1));
    const warned = relay.handle('h1', { ...GET, targetHelper: true }, signal);
    const alsoPlain = relay.handle('h1', GET, signal);
    dialogs.shown[0]!.answer('once');
    await expect(plain).resolves.toMatchObject({ kind: 'credential' });
    await expect(alsoPlain).resolves.toMatchObject({ kind: 'credential' });
    await vi.waitFor(() => expect(dialogs.shown).toHaveLength(2));
    expect(dialogs.shown.map((dialog) => dialog.consent.targetHelper)).toEqual([false, true]);
    // a request without the warning shares a dialog that shows it
    const late = relay.handle('h1', GET, signal);
    dialogs.shown[1]!.answer('deny');
    await expect(warned).resolves.toEqual({ kind: 'none' });
    await expect(late).resolves.toEqual({ kind: 'none' });
    expect(dialogs.shown).toHaveLength(2);
  });

  it('withdraws a shared dialog only once every request waiting on it went away', async () => {
    const dialogs = heldDialogs();
    const { relay } = client({ askConsent: dialogs.askConsent });
    const first = new AbortController();
    const second = new AbortController();
    const answers = [relay.handle('h1', GET, first.signal), relay.handle('h1', GET, second.signal)];
    await vi.waitFor(() => expect(dialogs.shown).toHaveLength(1));
    first.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(dialogs.shown[0]!.signal.aborted).toBe(false);
    second.abort();
    expect(dialogs.shown[0]!.signal.aborted).toBe(true);
    await expect(Promise.all(answers)).resolves.toEqual([{ kind: 'none' }, { kind: 'none' }]);
  });

  it('answers Always as Allow once when it cannot be saved', async () => {
    const { relay, logs } = client({ choice: 'always', addAlways: async () => { throw new Error('the host store is read-only'); } });
    await expect(relay.handle('h1', GET, signal)).resolves.toEqual({ kind: 'credential', username: 'ada', password: 'tok' });
    expect(logs).toContain('[git-credential] Always for github.com on prod-1 could not be saved, so it counts as Allow once: the host store is read-only');
  });

  it('drops a fill output past its byte bound, counted in UTF-8', () => {
    // 40,000 characters, 80,000 bytes
    expect(parseFillOutput(`username=ada\npassword=tok\nnote=${'é'.repeat(40_000)}\n`)).toBeUndefined();
  });

  it('never runs this computer\'s credential manager for an erase: it drops Always, and only the user removes what this run relayed, by the username it relayed', async () => {
    const kept = client({ target: { ...TARGET, alwaysCredentialHosts: ['github.com'] } });
    await kept.relay.handle('h1', GET, signal);
    await expect(kept.relay.handle('h1', { op: 'erase', fields: GET.fields, targetHelper: false }, signal)).resolves.toEqual({ kind: 'none' });
    expect(kept.deps.revokeAlways).toHaveBeenCalledWith('h1', 'github.com');
    expect(kept.notices).toEqual(['prod-1 reported that the credential for github.com was refused.']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(kept.git.map((call) => call.op)).toEqual(['fill']);

    const removed = client({ notifyChoice: (action) => action });
    await removed.relay.handle('h1', { ...GET, fields: { ...GET.fields, path: 'o/r.git' } }, signal);
    await removed.relay.handle('h1', { op: 'erase', fields: { ...GET.fields, username: 'mallory' }, targetHelper: false }, signal);
    await vi.waitFor(() => expect(removed.git.at(-1)).toEqual({ op: 'reject', input: 'protocol=https\nhost=github.com\npath=o/r.git\nusername=ada\n\n' }));
  });

  it('raises no notice for an erase of a pair this run never relayed, Always held or not', async () => {
    const { relay, notices, git, deps } = client({ target: { ...TARGET, alwaysCredentialHosts: ['github.com'] } });
    await relay.handle('h1', { op: 'erase', fields: GET.fields, targetHelper: false }, signal);
    expect(deps.revokeAlways).toHaveBeenCalledWith('h1', 'github.com');
    expect(notices).toEqual([]);
    expect(git).toEqual([]);
  });

  it('ignores an erase from a server that does not check it refuses the relayed credential', async () => {
    const { relay, notices, deps } = client({ target: { ...TARGET, alwaysCredentialHosts: ['github.com'] }, verifiesErase: false });
    await relay.handle('h1', GET, signal);
    await expect(relay.handle('h1', { op: 'erase', fields: GET.fields, targetHelper: false }, signal)).resolves.toEqual({ kind: 'none' });
    expect(deps.revokeAlways).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('passes a target\'s engine request to this computer\'s core without the preset account it named', async () => {
    const { relay, forgeAsked } = client({ forge: async () => ({ answer: { kind: 'none' } }) });
    const origin = { kind: 'engine', interactive: true, presetAccountId: 'gitlab.com|2001' } as const;
    await relay.handle('h1', { op: 'get', fields: { protocol: 'https', host: 'gitlab.com', path: 'g/p.git' }, targetHelper: false, origin, cwd: '/srv/app' }, signal);
    expect(forgeAsked).toHaveLength(1);
    expect(forgeAsked[0]!.origin).toEqual({ kind: 'engine', interactive: true, projectKey: 'ssh+h1|/srv/app' });
    expect(forgeAsked[0]!.origin).not.toHaveProperty('presetAccountId');
  });
});

describe('the relay\'s forge branch: a target\'s takeover request', () => {
  const PLAIN: CredentialTargetHost = { name: 'prod-1', alwaysCredentialHosts: [], alwaysForgeAccounts: [] };
  const TOKEN = { kind: 'credential', username: 'oauth2', password: 'glo-token' } as const;
  const ACCOUNT = 'gitlab.com|2001';
  // cwd null: a request that names no folder
  const takeover = (origin: GitCredentialRequest['origin'], cwd: string | null = '/srv/app/sub', path = 'g/p.git'): GitCredentialRequest => ({ op: 'get', fields: { protocol: 'https', host: 'GitLab.com', path }, targetHelper: false, ...(origin ? { origin } : {}), ...(cwd !== null ? { cwd } : {}) });
  const signal = new AbortController().signal;
  type How = ForgeCredentialAccount['how'];

  // This computer's core as the relay sees it: a pick the user chose answers at once; an automatic one names the account
  // first and answers only on a call that carries that account's consent.
  function core(how: How, options: { readonly answer?: GitCredentialAnswer; readonly canPush?: boolean; readonly accountId?: (call: number) => string } = {}): ForgeCredentialDeps['answer'] {
    let calls = 0;
    return async (_request, _origin, _authorityKey, _projectKey, consentedAccountId) => {
      const accountId = options.accountId?.(++calls) ?? ACCOUNT;
      const account = { serverId: 'gitlab.com', accountId, login: 'alexios-s', how, ...(how === 'access' ? { canPush: options.canPush ?? true } : {}) };
      const answer = options.answer ?? TOKEN;
      if (answer.kind !== 'credential') return { answer };
      if (!CONSENTED_HOWS.has(how) && consentedAccountId !== accountId) return { consent: account };
      return { answer, account };
    };
  }

  function forgeClient(how: How, choice: GitCredentialConsentChoice = 'once', answer: GitCredentialAnswer = TOKEN, takes = true, target: CredentialTargetHost = PLAIN) {
    const made = client({ forge: core(how, { answer }), choice, takesForgeAnswers: takes, target });
    return { ...made, asked: made.forgeAsked };
  }

  it('answers an explicit binding, host default or Choose account answer with no consent dialog', async () => {
    for (const how of ['bound', 'hostDefault', 'choice'] as const) {
      const { relay, consents } = forgeClient(how);
      await expect(relay.handle('h1', takeover({ kind: 'engine', projectKey: '/srv/app', interactive: true }), signal)).resolves.toEqual(TOKEN);
      expect(consents, how).toEqual([]);
    }
  });

  it('asks consent naming the account before the core reads any token, then asks again with that account\'s consent', async () => {
    const { relay, consents, asked } = forgeClient('onlyAccount');
    await expect(relay.handle('h1', takeover({ kind: 'terminal' }), signal)).resolves.toEqual(TOKEN);
    expect(consents).toEqual([{ hostName: 'prod-1', credentialHost: 'gitlab.com', targetHelper: false, forgeAccount: { serverLabel: 'gitlab.com', login: 'alexios-s', reason: 'onlyAccount', repoPath: 'g/p' } }]);
    // the terminal's folder maps to the host's project, and the request reaches this computer's core under the target's authority
    const request = { op: 'get', cwd: '/srv/app/sub', fields: { protocol: 'https', host: 'gitlab.com', path: 'g/p.git' } };
    const first = { request, origin: { kind: 'terminal', projectKey: 'ssh+h1|/srv/app' }, authorityKey: 'ssh+h1', projectKey: 'ssh+h1|/srv/app' };
    expect(asked).toEqual([{ ...first, consentedAccountId: undefined }, { ...first, consentedAccountId: ACCOUNT }]);
  });

  it('on Deny asks the core nothing more, so no token is read and nothing is answered', async () => {
    const denied = forgeClient('access', 'deny');
    await expect(denied.relay.handle('h1', takeover({ kind: 'agentShell', panelId: 'p1', sessionId: 's1', toolCallId: 'call-1', clientId: 'client-1' }), signal)).resolves.toEqual({ kind: 'none' });
    expect(denied.consents[0]?.forgeAccount?.reason).toBe('access');
    expect(denied.asked).toHaveLength(1);
    expect(denied.asked[0]!.consentedAccountId).toBeUndefined();
  });

  it('says an access pick that can only read reads, and one that can push pushes', async () => {
    const reader = client({ forge: core('access', { canPush: false }) });
    await reader.relay.handle('h1', takeover({ kind: 'terminal' }), signal);
    const pusher = client({ forge: core('access', { canPush: true }) });
    await pusher.relay.handle('h1', takeover({ kind: 'terminal' }), signal);
    expect([reader.consents[0]?.forgeAccount?.reason, pusher.consents[0]?.forgeAccount?.reason]).toEqual(['accessRead', 'access']);
  });

  it('answers nothing when the account resolved after consent is another one', async () => {
    const { relay, consents, forgeAsked: asked } = client({ forge: core('onlyAccount', { accountId: (call) => (call === 1 ? ACCOUNT : 'gitlab.com|2002') }) });
    await expect(relay.handle('h1', takeover({ kind: 'terminal' }), signal)).resolves.toEqual({ kind: 'none' });
    expect(consents).toHaveLength(1);
    expect(asked).toHaveLength(2);
  });

  it('answers nothing for a credential whose account no consent covers', async () => {
    const { relay, consents } = client({ forge: async () => ({ answer: TOKEN }) });
    await expect(relay.handle('h1', takeover({ kind: 'terminal' }), signal)).resolves.toEqual({ kind: 'none' });
    expect(consents).toEqual([]);
  });

  it('keeps an account consent\'s Always apart from the credential manager\'s: it remembers the account, never the pair', async () => {
    const { relay, deps } = forgeClient('onlyAccount', 'always');
    await relay.handle('h1', takeover({ kind: 'terminal' }), signal);
    expect(deps.addAlwaysAccount).toHaveBeenCalledWith('h1', { serverId: 'gitlab.com', accountId: ACCOUNT });
    expect(deps.addAlways).not.toHaveBeenCalled();
    // the pair's Always lets the credential manager's password through, and never this account
    const pairOnly = forgeClient('onlyAccount', 'once', TOKEN, true, { ...PLAIN, alwaysCredentialHosts: ['gitlab.com'] });
    await pairOnly.relay.handle('h1', takeover({ kind: 'terminal' }), signal);
    expect(pairOnly.consents).toHaveLength(1);
  });

  it('never shows a dialog for a background call: it gets the target\'s own helpers unless the account is always allowed', async () => {
    const { relay, consents } = forgeClient('onlyAccount');
    await expect(relay.handle('h1', takeover({ kind: 'engine', projectKey: '/srv/app', interactive: false }), signal)).resolves.toEqual({ kind: 'delegate' });
    expect(consents).toEqual([]);
  });

  it('answers a background call with no dialog when the account is always allowed on the host', async () => {
    const always = forgeClient('onlyAccount', 'deny', TOKEN, true, { ...PLAIN, alwaysForgeAccounts: [{ serverId: 'gitlab.com', accountId: ACCOUNT }] });
    await expect(always.relay.handle('h1', takeover({ kind: 'engine', projectKey: '/srv/app', interactive: false }), signal)).resolves.toEqual(TOKEN);
    expect(always.consents).toEqual([]);
    expect(always.asked.map((call) => call.consentedAccountId)).toEqual([undefined, ACCOUNT]);
  });

  it('answers a background call none when the daemon takes no delegate answer', async () => {
    const { relay, consents } = forgeClient('onlyAccount', 'once', TOKEN, false);
    await expect(relay.handle('h1', takeover({ kind: 'engine', projectKey: '/srv/app', interactive: false }), signal)).resolves.toEqual({ kind: 'none' });
    expect(consents).toEqual([]);
  });

  it('refuses a takeover request that names no folder, asking nothing', async () => {
    const { relay, consents, asked } = forgeClient('bound');
    await expect(relay.handle('h1', takeover({ kind: 'terminal' }, null), signal)).resolves.toEqual({ kind: 'none' });
    expect(asked).toEqual([]);
    expect(consents).toEqual([]);
  });

  it('shows one dialog for concurrent requests naming the same account', async () => {
    const dialogs = heldDialogs();
    const { relay, consents } = client({ forge: core('onlyAccount'), askConsent: dialogs.askConsent });
    const both = Promise.all([relay.handle('h1', takeover({ kind: 'terminal' }), signal), relay.handle('h1', takeover({ kind: 'terminal' }), signal)]);
    await vi.waitFor(() => expect(dialogs.shown).toHaveLength(1));
    dialogs.shown[0]!.answer('once');
    await expect(both).resolves.toEqual([TOKEN, TOKEN]);
    expect(consents).toHaveLength(1);
  });

  it('asks a second account on the same pair only once the first dialog closed, in a dialog of its own', async () => {
    const dialogs = heldDialogs();
    const accountOf = (request: unknown): string => ((request as { fields: { path: string } }).fields.path.startsWith('g/') ? ACCOUNT : 'gitlab.com|2002');
    const { relay } = client({
      askConsent: dialogs.askConsent,
      forge: async (request, _origin, _authorityKey, _projectKey, consentedAccountId) => {
        const accountId = accountOf(request);
        const account = { serverId: 'gitlab.com', accountId, login: accountId === ACCOUNT ? 'alexios-s' : 'astef-admin', how: 'onlyAccount' as const };
        return consentedAccountId === accountId ? { answer: TOKEN, account } : { consent: account };
      },
    });
    const first = relay.handle('h1', takeover({ kind: 'terminal' }), signal);
    await vi.waitFor(() => expect(dialogs.shown).toHaveLength(1));
    const second = relay.handle('h1', takeover({ kind: 'terminal' }, '/srv/app/sub', 'other/q.git'), signal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(dialogs.shown).toHaveLength(1);
    dialogs.shown[0]!.answer('once');
    await expect(first).resolves.toEqual(TOKEN);
    await vi.waitFor(() => expect(dialogs.shown).toHaveLength(2));
    expect(dialogs.shown.map((dialog) => dialog.consent.forgeAccount?.login)).toEqual(['alexios-s', 'astef-admin']);
    dialogs.shown[1]!.answer('deny');
    await expect(second).resolves.toEqual({ kind: 'none' });
  });

  it('names a 300-character repository path in the consent and leaves out a 2000-character one, logging it', async () => {
    const shortPath = `grp/${'s'.repeat(296)}`;
    const short = client({ forge: core('onlyAccount') });
    await short.relay.handle('h1', takeover({ kind: 'terminal' }, '/srv/app/sub', `${shortPath}.git`), signal);
    expect(short.consents[0]?.forgeAccount?.repoPath).toBe(shortPath);
    const long = client({ forge: core('onlyAccount') });
    await long.relay.handle('h1', takeover({ kind: 'terminal' }, '/srv/app/sub', `grp/${'s'.repeat(1996)}.git`), signal);
    expect(long.consents[0]?.forgeAccount).not.toHaveProperty('repoPath');
    expect(long.logs).toContain('[git-credential] the consent for prod-1 leaves out a repository path of 2000 characters');
  });

  it('passes delegate to a daemon whose welcome listed the feature when the attach was made, whatever its connection says now', async () => {
    // the attach read the features; a suspect connection reads as none, and the relay never asks it
    const { relay } = forgeClient('bound', 'once', { kind: 'delegate' }, true);
    await expect(relay.handle('h1', takeover({ kind: 'engine', interactive: false }), signal)).resolves.toEqual({ kind: 'delegate' });
  });

  it('passes refused and delegate only to a daemon that takes them, and sends an erase to this computer\'s core only', async () => {
    for (const [answer, takes, expected] of [
      [{ kind: 'refused', message: 'No.' }, true, { kind: 'refused', message: 'No.' }],
      [{ kind: 'delegate' }, true, { kind: 'delegate' }],
      [{ kind: 'refused', message: 'No.' }, false, { kind: 'none' }],
      [{ kind: 'delegate' }, false, { kind: 'none' }],
    ] as const) {
      const { relay } = forgeClient('bound', 'once', answer, takes);
      await expect(relay.handle('h1', takeover({ kind: 'engine', interactive: true }), signal), JSON.stringify([answer, takes])).resolves.toEqual(expected);
    }
    const { relay, git, asked: forgeAsked } = forgeClient('bound', 'once', { kind: 'none' });
    const hash = 'a'.repeat(64);
    await expect(relay.handle('h1', { ...takeover({ kind: 'engine', projectKey: '/srv/app', interactive: true }), op: 'erase', passwordHash: hash }, signal)).resolves.toEqual({ kind: 'none' });
    expect(forgeAsked[0]).toMatchObject({ request: { op: 'erase', passwordHash: hash }, origin: { kind: 'engine', projectKey: 'ssh+h1|/srv/app' } });
    expect(git).toEqual([]);
  });

  it('keeps today\'s relay for a request without an origin, the reference daemon\'s', async () => {
    const { relay, git, asked: forgeAsked, consents } = forgeClient('bound');
    await expect(relay.handle('h1', { op: 'get', fields: { protocol: 'https', host: 'gitlab.com' }, targetHelper: false }, signal)).resolves.toMatchObject({ kind: 'credential' });
    expect(forgeAsked).toEqual([]);
    expect(git.map((call) => call.op)).toEqual(['fill']);
    expect(consents[0]?.forgeAccount).toBeUndefined();
  });
});

describe('git credential on this computer discovers no repository', { timeout: 120_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // A repository whose credential.helper leaves a marker; HOME, the global and system config are empty temp files.
  function setUp() {
    const git = resolveGitExecutable()!;
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-client-git-')));
    dirs.push(base);
    const evil = path.join(base, 'evil');
    fs.mkdirSync(evil);
    const marker = path.join(base, 'marker');
    const helperScript = path.join(base, 'helper.js');
    fs.writeFileSync(helperScript, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.stdout.write('username=evil\\npassword=evil\\n');\n`);
    spawnSync(git, ['init', '-q', evil]);
    spawnSync(git, ['config', 'credential.helper', `!"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`], { cwd: evil });
    const empty = path.join(base, 'empty.gitconfig');
    fs.writeFileSync(empty, '');
    vi.stubEnv('HOME', base);
    vi.stubEnv('XDG_CONFIG_HOME', base);
    vi.stubEnv('GIT_CONFIG_GLOBAL', empty);
    vi.stubEnv('GIT_CONFIG_SYSTEM', empty);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    const specs: Array<{ readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> }> = [];
    const gitCredential = clientGitCredential({
      git: () => git,
      run: async (spec, input) => {
        specs.push(spec);
        expect(fs.readdirSync(spec.cwd)).toEqual([]);
        const result = spawnSync(spec.file, [...spec.args], { cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv, input, encoding: 'utf8' });
        return { code: result.status, stdout: result.stdout };
      },
      askpassEnv: async () => ({ env: { GIT_ASKPASS: '', SSH_ASKPASS: '' }, dispose: () => undefined }),
      tmpdir: () => evil,
    });
    return { evil, marker, specs, gitCredential };
  }

  it('runs in an empty folder git searches no further up from, so a repository around it runs no helper', async () => {
    const { evil, marker, specs, gitCredential } = setUp();
    await expect(gitCredential('fill', 'protocol=https\nhost=example.com\n\n', undefined)).rejects.toThrow(/exited with/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(path.dirname(specs[0]!.cwd)).toBe(evil);
    expect(specs[0]!.env['GIT_CEILING_DIRECTORIES']).toBe(evil);
    expect(specs[0]!.env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(fs.existsSync(specs[0]!.cwd)).toBe(false);
  });

  it('drops a repository-local GIT_DIR this process inherited', async () => {
    const { evil, marker, gitCredential } = setUp();
    vi.stubEnv('GIT_DIR', path.join(evil, '.git'));
    await expect(gitCredential('fill', 'protocol=https\nhost=example.com\n\n', undefined)).rejects.toThrow(/exited with/);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('the relay goes only where credentials may be needed', () => {
  it('a status call carries no relay pairs, variables or agent socket; a push carries them after the engine\'s pairs', async () => {
    const before = { ...process.env };
    const { runner, specs } = relayRunner({ relay: RELAY, agentSocket: '/run/d/agent.sock' });
    await runner.run({ project: '/p', cwd: '/p', args: ['status'], kind: 'status' });
    await runner.run({ project: '/p', cwd: '/p', args: ['push', 'origin'], kind: 'mutation', relayCredentials: true });
    const [status, push] = specs.map((spec) => spec.env!);
    expect(status).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.longpaths' });
    expect(status).not.toHaveProperty('DAMOCLES_CREDENTIAL_NONCE');
    expect(status).not.toHaveProperty('GIT_CONFIG_KEY_1');
    expect(status?.['SSH_AUTH_SOCK']).not.toBe('/run/d/agent.sock');
    expect(push).toMatchObject({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.longpaths',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: "!'/srv/dam server/dist/git-credential/git-credential-relay.sh'",
      DAMOCLES_CREDENTIAL_NONCE: RELAY.nonce,
      DAMOCLES_ASKPASS_HANDLE: RELAY.handle,
      SSH_AUTH_SOCK: '/run/d/agent.sock',
    });
    expect(push).not.toHaveProperty('DAMOCLES_ASKPASS_NONCE');
    expect(process.env).toEqual(before);
  });

  it('gives every network subcommand the relay, also behind -c options, and nothing to the rest', async () => {
    const { runner, specs } = relayRunner({ relay: RELAY });
    for (const args of [['fetch'], ['pull'], ['-c', 'x.y=z', 'push'], ['ls-remote', 'origin'], ['submodule', 'update'], ['log'], ['config', '--get-all', 'credential.helper'], ['diff']]) {
      await runner.run({ project: '/p', cwd: '/p', args, kind: 'read', relayCredentials: true });
    }
    await runner.clone({ cwd: '/w', args: ['clone', 'https://github.com/o/r', 'r'], signal: new AbortController().signal, relayCredentials: true });
    expect(specs.map((spec) => spec.env?.['DAMOCLES_CREDENTIAL_NONCE'] !== undefined)).toEqual([true, true, true, true, true, false, false, false, true]);
  });

  it('gives a background fetch (autofetch) no relay, so it never raises the consent dialog, but keeps the agent socket', async () => {
    const { runner, specs } = relayRunner({ relay: RELAY, agentSocket: '/run/d/agent.sock' });
    await runner.run({ project: '/p', cwd: '/p', args: ['fetch'], kind: 'mutation' });
    await runner.clone({ cwd: '/w', args: ['clone', 'https://github.com/o/r', 'r'], signal: new AbortController().signal });
    for (const spec of specs) {
      expect(spec.env).not.toHaveProperty('DAMOCLES_CREDENTIAL_NONCE');
      expect(spec.env?.['GIT_CONFIG_COUNT']).toBe('1');
      expect(spec.env?.['SSH_AUTH_SOCK']).toBe('/run/d/agent.sock');
    }
  });

  it('passes the helper as -c to a git before 2.31, which ignores GIT_CONFIG_COUNT', async () => {
    const { runner, specs } = relayRunner({ relay: RELAY, version: { major: 2, minor: 30, patch: 0 } });
    await runner.run({ project: '/p', cwd: '/p', args: ['fetch'], kind: 'read', relayCredentials: true });
    await runner.run({ project: '/p', cwd: '/p', args: ['status'], kind: 'status' });
    expect(specs[0]?.args).toEqual(['-c', 'core.longpaths=true', '-c', `credential.helper=!'${RELAY.helper}'`, 'fetch']);
    expect(specs[1]?.args).toEqual(['-c', 'core.longpaths=true', 'status']);
  });

  it('gives shells and terminals the nonce and the pair after the ones they inherit, never the prompt capability', () => {
    const variables = spawnCredentialVariables({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1' }, RELAY, { socket: '/run/d/agent.sock' });
    expect(variables).toEqual({
      SSH_AUTH_SOCK: '/run/d/agent.sock',
      DAMOCLES_ASKPASS_NODE: RELAY.node,
      DAMOCLES_ASKPASS_MAIN: RELAY.main,
      DAMOCLES_ASKPASS_HANDLE: RELAY.handle,
      DAMOCLES_CREDENTIAL_NONCE: RELAY.nonce,
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_2: 'credential.helper',
      GIT_CONFIG_VALUE_2: `!'${RELAY.helper}'`,
    });
    expect(spawnCredentialVariables({}, undefined, undefined)).toEqual({});
  });

  it('on a daemon, removes an inherited SSH_AUTH_SOCK from a shell or terminal whose client does not forward; elsewhere leaves it', () => {
    const inherited = { SSH_AUTH_SOCK: '/tmp/ssh-started-the-daemon/agent.1' };
    const variables = spawnCredentialVariables(inherited, undefined, { socket: undefined });
    expect(variables).toHaveProperty('SSH_AUTH_SOCK', undefined);
    expect({ ...inherited, ...variables }['SSH_AUTH_SOCK']).toBeUndefined();
    expect(spawnCredentialVariables(inherited, undefined, undefined)).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it('on a daemon\'s core, runs no git call with an inherited SSH_AUTH_SOCK while no agent is forwarded', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/ssh-started-the-daemon/agent.1');
    try {
      const { runner, specs } = relayRunner({ relay: RELAY });
      await runner.run({ project: '/p', cwd: '/p', args: ['push', 'origin'], kind: 'mutation', relayCredentials: true });
      await runner.run({ project: '/p', cwd: '/p', args: ['commit', '-m', 'x'], kind: 'mutation' });
      for (const spec of specs) expect(Object.keys(spec.env!).filter((key) => key.toUpperCase() === 'SSH_AUTH_SOCK')).toEqual([]);
      // this computer's core keeps the user's agent
      const local = recordingLauncher();
      await createGitRunner({ git: GIT, log: { appendLine: () => undefined }, isTrusted: () => true, launcher: local.launcher }).run({ project: '/p', cwd: '/p', args: ['push', 'origin'], kind: 'mutation' });
      expect(local.specs[0]?.env?.['SSH_AUTH_SOCK']).toBe('/tmp/ssh-started-the-daemon/agent.1');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports the target\'s own helpers, reading only the system and global files outside a trusted project', async () => {
    const helperOut = (spec: SpawnSpec): string => (spec.args.includes('--get-all') && spec.args.includes('--global') ? 'store\n' : '');
    const untrusted = relayRunner({ trusted: false, stdout: helperOut });
    await expect(untrusted.runner.targetHasCredentialHelper('/w', 'https://github.com/', undefined)).resolves.toBe(true);
    expect(untrusted.specs.every((spec) => spec.args.includes('--system') || spec.args.includes('--global'))).toBe(true);
    // run from an empty folder git searches no further up from, so no repository (a dotfiles home) is discovered
    for (const spec of untrusted.specs) {
      expect(path.basename(spec.cwd!)).toMatch(/^damocles-git-config-/);
      expect(spec.env?.['GIT_CEILING_DIRECTORIES']?.split(path.delimiter)).toContain(path.dirname(spec.cwd!));
      expect(fs.existsSync(spec.cwd!)).toBe(false);
    }
    expect(untrusted.specs.every((spec) => spec.env?.['DAMOCLES_CREDENTIAL_NONCE'] === undefined)).toBe(true);
    const reset = relayRunner({ stdout: (spec) => (spec.args.includes('--get-all') ? 'manager\n\n' : '') });
    await expect(reset.runner.targetHasCredentialHelper('/p', 'https://github.com/', '/p')).resolves.toBe(false);
    const urlOnly = relayRunner({ stdout: (spec) => (spec.args.includes('--get-urlmatch') ? 'cache\n' : '') });
    await expect(urlOnly.runner.targetHasCredentialHelper('/p', 'https://github.com/', '/p')).resolves.toBe(true);
    // a project the runner does not trust reads only the system and global files
    const named = relayRunner({ trusted: false });
    await expect(named.runner.targetHasCredentialHelper('/p/sub', 'https://github.com/', '/p')).resolves.toBe(false);
    expect(named.specs.every((spec) => spec.args.includes('--system') || spec.args.includes('--global'))).toBe(true);
  });
});

describe('the helper path is quoted for git\'s shell', () => {
  it('single-quotes POSIX and Windows paths with spaces and quotes', () => {
    expect(relayHelperConfig({ helper: '/home/a b/.damocles/server/git-credential-relay.sh' })).toEqual(['credential.helper', "!'/home/a b/.damocles/server/git-credential-relay.sh'"]);
    expect(relayHelperConfig({ helper: 'C:\\Users\\Ada Lovelace\\.damocles\\server\\git-credential-relay.cmd' })).toEqual(['credential.helper', "!'C:\\Users\\Ada Lovelace\\.damocles\\server\\git-credential-relay.cmd'"]);
    expect(shQuote("/srv/o'neil/x.sh")).toBe("'/srv/o'\\''neil/x.sh'");
    expect(() => shQuote('/srv/a\nb')).toThrow(RangeError);
  });
});

describe('git runs the quoted helper', { timeout: 120_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('from a folder with a space and a quote, through git\'s shell on this platform', () => {
    const git = resolveGitExecutable();
    expect(git).toBeDefined();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dam relay o'q "));
    dirs.push(dir);
    const windows = process.platform === 'win32';
    const helper = path.join(dir, windows ? 'git-credential-relay.cmd' : 'git-credential-relay.sh');
    fs.writeFileSync(helper, windows ? '@echo off\r\nif not "%1"=="get" exit /b 0\r\necho username=u1\r\necho password=p1\r\n' : '#!/bin/sh\n[ "$1" = get ] || exit 0\necho username=u1\necho password=p1\n', { mode: 0o755 });
    const [key, value] = relayHelperConfig({ helper });
    const result = spawnSync(git!, ['-c', 'credential.helper=', '-c', `${key}=${value}`, 'credential', 'fill'], { input: 'protocol=https\nhost=example.com\n\n', encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('password=p1');
  });
});

describe('the credential-relay nonce', () => {
  const servers: AskpassServer[] = [];
  const relays: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.dispose();
    for (const relay of relays.splice(0)) await relay.close();
  });

  function exchange(handle: string, body: unknown): Promise<string> {
    return new Promise((resolve) => {
      const socket = net.connect(handle);
      let reply = '';
      socket.on('data', (chunk) => (reply += chunk.toString('utf8')));
      socket.on('error', () => undefined);
      socket.on('close', () => resolve(reply));
      socket.write(`${JSON.stringify(body)}\n`);
    });
  }

  async function daemonRelay(): Promise<RelayIdentity> {
    const relay = await createCredentialRelay('/srv/damocles');
    relays.push(relay);
    return relay.identity();
  }

  function start(credential: RelayCredential, identity: RelayIdentity) {
    const prompts: string[] = [];
    const server = createAskpassServer({
      paths: { askpass: '/a.sh', sshAskpass: '/s.sh', node: '/node', main: '/main.js', credentialRelay: identity },
      prompt: async (prompt) => {
        prompts.push(prompt.text);
        return 'prompt-answer';
      },
      credential,
      log: () => undefined,
    });
    servers.push(server);
    return { server, prompts };
  }

  it('is the daemon\'s: the package helper, a fresh nonce and a private handle', async () => {
    const identity = await daemonRelay();
    expect(identity.helper).toBe(path.join('/srv/damocles', 'dist', 'git-credential', process.platform === 'win32' ? 'git-credential-relay.cmd' : 'git-credential-relay.sh'));
    expect(identity.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.nonce).not.toBe((await daemonRelay()).nonce);
    if (process.platform === 'win32') expect(identity.handle).toMatch(/^\\\\\.\\pipe\\damocles-relay-[0-9a-f]{32}$/);
    else expect(fs.statSync(path.dirname(identity.handle)).mode & 0o777).toBe(0o700);
  });

  it('keeps working across a core restart: the next core listens at the same handle and takes the same nonce', async () => {
    const identity = await daemonRelay();
    const fields = { protocol: 'https', host: 'github.com' };
    const first = start(async () => ({ kind: 'none' }), identity);
    await first.server.relay();
    await first.server.dispose();
    // a killed core leaves its socket file behind on POSIX
    if (process.platform !== 'win32') fs.writeFileSync(identity.handle, '');
    const second = start(async () => ({ kind: 'credential', username: 'ada', password: 'tok' }), identity);
    const relay = (await second.server.relay())!;
    expect(relay).toMatchObject({ handle: identity.handle, nonce: identity.nonce });
    await expect(exchange(identity.handle, { nonce: identity.nonce, kind: 'credential', op: 'get', cwd: '/w', fields })).resolves.toBe(`${JSON.stringify({ kind: 'credential', username: 'ada', password: 'tok' })}\n`);
  });

  it('is refused for a prompt, and a prompt registration\'s nonce is refused for a credential', async () => {
    const credential = vi.fn<RelayCredential>(async () => ({ kind: 'credential', username: 'ada', password: 'tok' }));
    const identity = await daemonRelay();
    const { server, prompts } = start(credential, identity);
    const relay = (await server.relay())!;
    expect(relay).toEqual({ ...identity, node: '/node', main: '/main.js' });
    const registration = await server.register('interactive', 'push');
    expect(relay.nonce).not.toBe(registration.env['DAMOCLES_ASKPASS_NONCE']);
    const fields = { protocol: 'https', host: 'github.com' };
    await expect(exchange(relay.handle, { nonce: relay.nonce, kind: 'askpass', argv: ['Password: '] })).resolves.toBe('');
    await expect(exchange(relay.handle, { nonce: relay.nonce, kind: 'ssh', argv: ['Password: '] })).resolves.toBe('');
    await expect(exchange(relay.handle, { nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'credential', op: 'get', cwd: '/w', fields })).resolves.toBe('');
    expect(prompts).toEqual([]);
    expect(credential).not.toHaveBeenCalled();
    await expect(exchange(relay.handle, { nonce: relay.nonce, kind: 'credential', op: 'get', cwd: '/w', fields })).resolves.toBe(`${JSON.stringify({ kind: 'credential', username: 'ada', password: 'tok' })}\n`);
    expect(credential).toHaveBeenCalledWith({ op: 'get', cwd: '/w', fields }, { kind: 'terminal' }, expect.any(AbortSignal));
  });

  it('gives each credential registration its own nonce and origin, which never prompts, and refuses the prompt nonce a credential', async () => {
    const credential = vi.fn<RelayCredential>(async () => ({ kind: 'refused', message: 'No.' }));
    const identity = await daemonRelay();
    const { server, prompts } = start(credential, identity);
    const relay = (await server.relay())!;
    const engine = await server.registerCredential({ kind: 'engine', projectKey: '/p', interactive: true });
    const shell = await server.registerCredential({ kind: 'agentShell', panelId: 'p1', sessionId: 's1' });
    const prompt = await server.register('interactive', 'push');
    const nonces = [relay.nonce, engine.env['DAMOCLES_CREDENTIAL_NONCE'], shell.env['DAMOCLES_CREDENTIAL_NONCE'], prompt.env['DAMOCLES_ASKPASS_NONCE']];
    expect(new Set(nonces).size).toBe(4);
    for (const nonce of nonces) expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(shell.env).sort()).toEqual(['DAMOCLES_ASKPASS_HANDLE', 'DAMOCLES_ASKPASS_MAIN', 'DAMOCLES_ASKPASS_NODE', 'DAMOCLES_CREDENTIAL_NONCE']);
    const fields = { protocol: 'https', host: 'gitlab.com', path: 'g/p.git' };
    await expect(exchange(relay.handle, { nonce: shell.env['DAMOCLES_CREDENTIAL_NONCE'], kind: 'credential', op: 'get', cwd: '/w', fields })).resolves.toBe(`${JSON.stringify({ kind: 'refused', message: 'No.' })}\n`);
    expect(credential).toHaveBeenLastCalledWith({ op: 'get', cwd: '/w', fields }, { kind: 'agentShell', panelId: 'p1', sessionId: 's1' }, expect.any(AbortSignal));
    await exchange(relay.handle, { nonce: engine.env['DAMOCLES_CREDENTIAL_NONCE'], kind: 'credential', op: 'get', cwd: '/w', fields });
    expect(credential).toHaveBeenLastCalledWith({ op: 'get', cwd: '/w', fields }, { kind: 'engine', projectKey: '/p', interactive: true }, expect.any(AbortSignal));
    // a credential nonce never prompts; a prompt nonce never answers a credential; a nonce of another length is unknown
    await expect(exchange(relay.handle, { nonce: shell.env['DAMOCLES_CREDENTIAL_NONCE'], kind: 'askpass', argv: ['Password: '] })).resolves.toBe('');
    await expect(exchange(relay.handle, { nonce: prompt.env['DAMOCLES_ASKPASS_NONCE'], kind: 'credential', op: 'get', cwd: '/w', fields })).resolves.toBe('');
    await expect(exchange(relay.handle, { nonce: 'ab', kind: 'credential', op: 'get', cwd: '/w', fields })).resolves.toBe('');
    expect(prompts).toEqual([]);
    expect(credential).toHaveBeenCalledTimes(2);
    shell.dispose();
    await expect(exchange(relay.handle, { nonce: shell.env['DAMOCLES_CREDENTIAL_NONCE'], kind: 'credential', op: 'get', cwd: '/w', fields })).resolves.toBe('');
    expect(credential).toHaveBeenCalledTimes(2);
  });

  it('exists only on a server given a helper and a relay', async () => {
    const server = createAskpassServer({ paths: { askpass: '/a.sh', sshAskpass: '/s.sh', node: '/node', main: '/main.js' }, prompt: async () => undefined, log: () => undefined });
    servers.push(server);
    await expect(server.relay()).resolves.toBeUndefined();
  });
});

describe('a publickey failure', () => {
  it('is classified from git\'s stderr', () => {
    expect(gitFailureCode(new GitError('git push exited with 128', 128, '', 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'))).toBe('publickeyDenied');
    expect(gitFailureCode(new GitError('x', 128, '', 'u@h: Permission denied (publickey,password).'))).toBe('publickeyDenied');
    expect(gitFailureCode(new GitError('x', 128, '', 'fatal: Authentication failed'))).toBeUndefined();
    expect(gitFailureCode(new Error('Permission denied (publickey).'))).toBeUndefined();
  });
});
