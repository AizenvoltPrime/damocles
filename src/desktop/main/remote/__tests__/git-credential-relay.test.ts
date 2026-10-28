import { spawnSync } from 'node:child_process';
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
import { clientGitCredential, createGitCredentialClient, credentialHostOf, credentialInput, parseFillOutput, type CredentialTargetHost, type GitCredentialClientDeps, type GitCredentialRequest } from '../git-credential-client';

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

  it('is refused at the server unless it is exactly a get or erase with bounded fields; store is never a request', () => {
    const request = (body: unknown): unknown => parseAskpassRequest(Buffer.from(JSON.stringify(body)));
    const base = { nonce: 'c'.repeat(64), kind: 'credential', op: 'get', cwd: '/w', fields: { protocol: 'https', host: 'github.com' } };
    expect(request(base)).toEqual(base);
    expect(request({ ...base, op: 'store' })).toBeUndefined();
    expect(request({ ...base, fields: { ...base.fields, password: 'x' } })).toBeUndefined();
    expect(request({ ...base, fields: { protocol: 'https', host: 'a\nprotocol=http' } })).toBeUndefined();
    expect(request({ ...base, cwd: '/w\n' })).toBeUndefined();
    expect(request({ ...base, extra: 1 })).toBeUndefined();
    // an erase may name its password's SHA-256; a get never does, and nothing else passes for one
    const hash = 'a'.repeat(64);
    expect(request({ ...base, op: 'erase', passwordHash: hash })).toEqual({ ...base, op: 'erase', passwordHash: hash });
    expect(request({ ...base, passwordHash: hash })).toBeUndefined();
    for (const passwordHash of ['tok', 'A'.repeat(64), 'a'.repeat(63), 1]) expect(request({ ...base, op: 'erase', passwordHash })).toBeUndefined();
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

describe('the client side of the relay', () => {
  const TARGET: CredentialTargetHost = { name: 'prod-1', color: 'danger', alwaysCredentialHosts: [] };
  const GET: GitCredentialRequest = { op: 'get', fields: { protocol: 'https', host: 'github.com' }, targetHelper: false };

  function client(options: { readonly target?: CredentialTargetHost; readonly choice?: GitCredentialConsentChoice; readonly notifyChoice?: (action: string) => string | undefined; readonly verifiesErase?: boolean; readonly askConsent?: GitCredentialClientDeps['askConsent']; readonly addAlways?: GitCredentialClientDeps['addAlways']; readonly fill?: string } = {}) {
    const consents: GitCredentialConsent[] = [];
    const git: Array<{ op: 'fill' | 'reject'; input: string }> = [];
    const notices: string[] = [];
    const logs: string[] = [];
    const deps: GitCredentialClientDeps = {
      host: () => options.target ?? TARGET,
      verifiesErase: () => options.verifiesErase ?? true,
      addAlways: vi.fn(options.addAlways ?? (async () => undefined)),
      revokeAlways: vi.fn(async () => undefined),
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
    return { relay: createGitCredentialClient(deps), deps, consents, git, notices, logs };
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
    expect(credential).toHaveBeenCalledWith({ op: 'get', cwd: '/w', fields }, expect.any(AbortSignal));
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
