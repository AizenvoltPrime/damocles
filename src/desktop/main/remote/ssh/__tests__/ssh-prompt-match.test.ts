import { describe, expect, it, vi } from 'vitest';
import { createFakeSecretsStore } from '../../../../../__mocks__/fake-platform';
import { PROMPT_CANCELLED, type CredentialPrompt } from '../../../../../core/scm/askpass/askpass-server';
import type { SecretsStore } from '../../../../../platform/secrets-store';
import type { SshPrompt, SshPromptAnswer } from '../../../../preload/overlay-channels';
import { createRememberedSecrets, type RememberedTarget } from '../remembered-secrets';
import { attemptPrompt, rememberedAttempt, type AttemptPromptState } from '../ssh-askpass';
import type { SshHop } from '../ssh-config';
import { matchHopPrompt } from '../ssh-prompt-match';

const HOME = '/home/ada';
const JUMP: SshHop = { alias: 'bastion', hostname: 'bastion.example.com', port: 22, user: 'ada', identityFiles: ['~/.ssh/id_ed25519'] };
const TARGET: SshHop = { alias: 'prod-1', hostname: '10.0.0.5', port: 2222, user: 'deploy', identityFiles: ['~/.ssh/id_ed25519', '/keys/prod'] };
const TARGET_PASSWORD: RememberedTarget = { hop: TARGET, kind: 'password' };
const DEFAULT_KEY_PROMPT = "Enter passphrase for key '/home/ada/.ssh/id_ed25519':";

describe('matchHopPrompt', () => {
  it('binds both OpenSSH password forms, by alias or by HostName', () => {
    for (const text of ["deploy@prod-1's password:", "deploy@10.0.0.5's password:", '(deploy@prod-1) Password:', '(deploy@10.0.0.5) Password:']) {
      expect(matchHopPrompt(text, [JUMP, TARGET], HOME)).toEqual({ hop: TARGET, kind: 'password' });
    }
    expect(matchHopPrompt("ada@bastion.example.com's password:", [JUMP, TARGET], HOME)).toEqual({ hop: JUMP, kind: 'password' });
  });

  it('names the host by its HostKeyAlias alone when one is set, as ssh does', () => {
    const aliased: SshHop = { ...TARGET, hostKeyAlias: 'prod-key' };
    expect(matchHopPrompt("deploy@prod-key's password:", [aliased], HOME)).toEqual({ hop: aliased, kind: 'password' });
    expect(matchHopPrompt('(deploy@prod-key) Password:', [aliased], HOME)).toEqual({ hop: aliased, kind: 'password' });
    expect(matchHopPrompt("deploy@prod-1's password:", [aliased], HOME)).toBeUndefined();
  });

  it('binds a passphrase prompt to the one hop and key file configured, as ssh prints it', () => {
    expect(matchHopPrompt("Enter passphrase for key '/keys/prod':", [JUMP, TARGET], HOME)).toEqual({ hop: TARGET, kind: 'passphrase', identityFile: '/keys/prod' });
    expect(matchHopPrompt(DEFAULT_KEY_PROMPT, [TARGET], HOME)).toEqual({ hop: TARGET, kind: 'passphrase', identityFile: '~/.ssh/id_ed25519' });
  });

  it('reads a Windows home joined to a `~/` path with mixed separators, as Win32-OpenSSH prints it', () => {
    const hop: SshHop = { ...TARGET, identityFiles: ['~/.ssh/id_ed25519'] };
    expect(matchHopPrompt("Enter passphrase for key 'C:\\Users\\ada/.ssh/id_ed25519':", [hop], 'C:\\Users\\ada')).toEqual({ hop, kind: 'passphrase', identityFile: '~/.ssh/id_ed25519' });
  });

  it('asks a prompt two hops match, or none', () => {
    // both hops use the same key
    expect(matchHopPrompt(DEFAULT_KEY_PROMPT, [JUMP, TARGET], HOME)).toBeUndefined();
    expect(matchHopPrompt("deploy@prod-1's password:", [TARGET, { ...TARGET, port: 22 }], HOME)).toBeUndefined();
    for (const text of ['Verification code:', 'Password:', "deploy@prod-2's password:", "root@prod-1's password:", "deploy@prod-1's password: x", '(deploy@prod-1) Verification code:', "Enter passphrase for key '/keys/other':"]) {
      expect(matchHopPrompt(text, [JUMP, TARGET], HOME)).toBeUndefined();
    }
  });
});

describe('remembered answers in an attempt', () => {
  const password = (text: string): CredentialPrompt => ({ kind: 'password', text });
  const passphrase = (text: string): CredentialPrompt => ({ kind: 'passphrase', text });
  const signal = new AbortController().signal;

  interface AttemptOptions {
    readonly offer?: boolean;
    readonly answers?: Array<SshPromptAnswer | undefined>;
    readonly hops?: readonly SshHop[];
    readonly sshVersion?: readonly [number, number] | undefined;
    readonly store?: SecretsStore & { readonly entries: ReadonlyMap<string, string> };
  }

  function attempt(options: AttemptOptions = {}) {
    const store = options.store ?? createFakeSecretsStore();
    const remembered = createRememberedSecrets(store);
    const secrets = remembered.forHost('h1');
    const asked: SshPrompt[] = [];
    const logs: string[] = [];
    const answers = [...(options.answers ?? [])];
    const hops = options.hops ?? [JUMP, TARGET];
    const memory = rememberedAttempt({
      offer: options.offer ?? true,
      secrets,
      hops: async () => hops,
      home: HOME,
      sshVersion: 'sshVersion' in options ? options.sshVersion : [9, 6],
      log: (line) => logs.push(line),
    });
    const state: AttemptPromptState = { hostKeyRefused: false, cancelled: false };
    const prompt = attemptPrompt(async (question) => {
      asked.push(question);
      return answers.shift();
    }, state, (line) => logs.push(line), memory);
    return { store, remembered, secrets, asked, logs, memory, prompt };
  }

  it('answers the target\'s prompt from the store, and never offers it to the jump host', async () => {
    const run = attempt({ answers: [{ answer: 'jump-secret', remember: false }] });
    await run.secrets.store(TARGET_PASSWORD, 'target-secret');
    await expect(run.prompt(password("ada@bastion.example.com's password:"), signal)).resolves.toBe('jump-secret');
    await expect(run.prompt(password('(deploy@prod-1) Password:'), signal)).resolves.toBe('target-secret');
    expect(run.asked).toEqual([{ kind: 'secret', secretKind: 'password', text: "ada@bastion.example.com's password:", offerRemember: true }]);
  });

  it('deletes a stored answer whose prompt repeats and asks; a new remembered one is stored once ssh authenticated', async () => {
    const run = attempt({ answers: [{ answer: 'new-secret', remember: true }] });
    await run.secrets.store(TARGET_PASSWORD, 'old-secret');
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('old-secret');
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('new-secret');
    await expect(run.secrets.get(TARGET_PASSWORD)).resolves.toBeUndefined();
    run.memory.authenticated();
    await vi.waitFor(() => expect(run.store.entries.size).toBe(1));
    await expect(run.secrets.get(TARGET_PASSWORD)).resolves.toBe('new-secret');
  });

  it('answers a second ssh of the attempt with the answer typed for the first, without taking it for a refusal, and stores it', async () => {
    // a first connection without a master runs the detection and the bridge as two ssh processes, each authenticating
    const run = attempt({ answers: [{ answer: 'typed-secret', remember: true }] });
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('typed-secret');
    run.memory.authenticated();
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('typed-secret');
    expect(run.asked).toHaveLength(1);
    run.memory.authenticated();
    // a stored answer given to the second ssh is refused only if that ssh asks again before it authenticated
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('typed-secret');
    await expect(run.secrets.get(TARGET_PASSWORD)).resolves.toBe('typed-secret');
  });

  it('gives a stored answer to the next ssh after authenticating as a new question, not a refusal', async () => {
    const run = attempt();
    await run.secrets.store(TARGET_PASSWORD, 'stored-secret');
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('stored-secret');
    run.memory.authenticated();
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('stored-secret');
    expect(run.asked).toEqual([]);
    await expect(run.secrets.get(TARGET_PASSWORD)).resolves.toBe('stored-secret');
  });

  it('stores nothing the user typed without Remember, nor a refused typed answer', async () => {
    const run = attempt({ answers: [{ answer: 'wrong', remember: true }, { answer: 'right', remember: false }] });
    await run.prompt(password("deploy@prod-1's password:"), signal);
    await run.prompt(password("deploy@prod-1's password:"), signal);
    run.memory.authenticated();
    await new Promise((resolve) => setImmediate(resolve));
    expect(run.store.entries.size).toBe(0);
  });

  it('drops every prompt text\'s typed answer of a binding once one of them is refused', async () => {
    const run = attempt({ offer: false, answers: [{ answer: 'kbd', remember: false }, { answer: 'pw', remember: false }, { answer: 'asked', remember: false }] });
    await run.prompt(password('(deploy@prod-1) Password:'), signal);
    run.memory.authenticated();
    // the next ssh: the keyboard-interactive answer is given and refused, then ssh moves to the password method
    await expect(run.prompt(password('(deploy@prod-1) Password:'), signal)).resolves.toBe('kbd');
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('pw');
    run.memory.authenticated();
    // the refused keyboard-interactive answer is never given to a later ssh
    await expect(run.prompt(password('(deploy@prod-1) Password:'), signal)).resolves.toBe('asked');
  });

  it('always asks a code or an unknown prompt, never offering Remember, and offers it only with the host setting on', async () => {
    const run = attempt({ answers: [{ answer: '123456', remember: true }, { answer: 'x', remember: true }] });
    await run.prompt(password('Verification code:'), signal);
    await run.prompt(password('(deploy@prod-1) Enter your token:'), signal);
    run.memory.authenticated();
    await new Promise((resolve) => setImmediate(resolve));
    expect(run.asked.every((question) => question.kind === 'secret' && question.offerRemember === undefined)).toBe(true);
    expect(run.store.entries.size).toBe(0);
    expect(run.logs).toContain('prompt "Verification code:" is bound to no hop (no hop or more than one hop asks with this text), so it is asked and never answered for the user');

    const off = attempt({ offer: false, answers: [{ answer: 's', remember: true }] });
    await off.prompt(password("deploy@prod-1's password:"), signal);
    off.memory.authenticated();
    await new Promise((resolve) => setImmediate(resolve));
    expect(off.asked[0]).not.toHaveProperty('offerRemember');
    expect(off.store.entries.size).toBe(0);
  });

  it('answers a later ssh of the attempt with what the user typed, with Remember off and no store', async () => {
    const asked: SshPrompt[] = [];
    const answers = [{ answer: 'wrong', remember: false }, { answer: 'right', remember: false }];
    const memory = rememberedAttempt({ offer: false, hops: async () => [JUMP, TARGET], home: HOME, sshVersion: [9, 6], log: () => undefined });
    const prompt = attemptPrompt(async (question) => {
      asked.push(question);
      return answers.shift();
    }, { hostKeyRefused: false, cancelled: false }, () => undefined, memory);
    // the detection's ssh: a wrong password, its second ask, the right one
    await expect(prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('wrong');
    await expect(prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('right');
    memory.authenticated();
    // stage 0's ssh gets the corrected one, and the jump host's prompt is never given the target's answer
    await expect(prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('right');
    await expect(prompt(password("ada@bastion.example.com's password:"), signal)).resolves.toBe(PROMPT_CANCELLED);
    expect(asked.map((question) => question.kind === 'secret' && question.text)).toEqual(["deploy@prod-1's password:", "deploy@prod-1's password:", "ada@bastion.example.com's password:"]);
  });

  it('forgets every typed answer when the attempt ends, and never reuses a code', async () => {
    const run = attempt({ offer: false, answers: [{ answer: 'typed', remember: false }, { answer: '111111', remember: false }, { answer: '222222', remember: false }, { answer: 'again', remember: false }] });
    await run.prompt(password("deploy@prod-1's password:"), signal);
    await run.prompt(password('Verification code:'), signal);
    run.memory.authenticated();
    await expect(run.prompt(password('Verification code:'), signal)).resolves.toBe('222222');
    run.memory.end();
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('again');
    expect(run.asked).toHaveLength(4);
    expect(run.store.entries.size).toBe(0);
  });

  it('gives up a prompt ssh withdraws while its hops resolve, asking nothing, and binds the next one once they resolve', async () => {
    const asked: SshPrompt[] = [];
    let resolveHops!: (hops: readonly SshHop[]) => void;
    const memory = rememberedAttempt({ offer: false, hops: () => new Promise((resolve) => { resolveHops = resolve; }), home: HOME, sshVersion: [9, 6], log: () => undefined });
    const prompt = attemptPrompt(async (question) => {
      asked.push(question);
      return { answer: 'typed', remember: false };
    }, { hostKeyRefused: false, cancelled: false }, () => undefined, memory);
    const withdrawn = new AbortController();
    const first = prompt(password("deploy@prod-1's password:"), withdrawn.signal);
    withdrawn.abort();
    await expect(first).resolves.toBe(PROMPT_CANCELLED);
    expect(asked).toHaveLength(0);
    const second = prompt(password("deploy@prod-1's password:"), signal);
    resolveHops([JUMP, TARGET]);
    await expect(second).resolves.toBe('typed');
    expect(asked).toEqual([{ kind: 'secret', secretKind: 'password', text: "deploy@prod-1's password:" }]);
  });

  it('asks every prompt when the hops cannot be resolved', async () => {
    const secrets = createRememberedSecrets(createFakeSecretsStore()).forHost('h1');
    await secrets.store(TARGET_PASSWORD, 'target-secret');
    const memory = rememberedAttempt({ offer: true, secrets, hops: () => Promise.reject(new Error('ssh -G failed')), home: HOME, sshVersion: [9, 6], log: () => undefined });
    const asked: SshPrompt[] = [];
    const prompt = attemptPrompt(async (question) => {
      asked.push(question);
      return undefined;
    }, { hostKeyRefused: false, cancelled: false }, () => undefined, memory);
    await expect(prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe(PROMPT_CANCELLED);
    expect(asked).toHaveLength(1);
  });

  describe('on an OpenSSH client older than 8.4, whose prompts carry no (user@host) prefix', () => {
    for (const sshVersion of [[8, 1], [8, 3], undefined] as const) {
      it(`never gives a jump host the target's password when the jump sends the target's prompt text (${String(sshVersion)})`, async () => {
        const run = attempt({ sshVersion, answers: [{ answer: 'typed-to-the-bastion', remember: true }, { answer: 'typed-again', remember: false }] });
        await run.secrets.store(TARGET_PASSWORD, 'target-secret');
        // the bastion's keyboard-interactive prompt forging the target's password prompt
        await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('typed-to-the-bastion');
        expect(run.asked).toEqual([{ kind: 'secret', secretKind: 'password', text: "deploy@prod-1's password:" }]);
        run.memory.authenticated();
        await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('typed-again');
        await new Promise((resolve) => setImmediate(resolve));
        await expect(run.secrets.get(TARGET_PASSWORD)).resolves.toBe('target-secret');
        expect(run.logs.some((line) => line.includes('OpenSSH before 8.4 lets a jump host send another hop\'s prompt'))).toBe(true);
      });

      it(`never gives a single-hop target the local key's passphrase when it sends a passphrase prompt (${String(sshVersion)})`, async () => {
        const run = attempt({ sshVersion, hops: [TARGET], answers: [{ answer: 'typed-passphrase', remember: true }, { answer: 'typed-again', remember: false }] });
        await run.secrets.store({ hop: TARGET, kind: 'passphrase', identityFile: '~/.ssh/id_ed25519' }, 'key-passphrase');
        await expect(run.prompt(passphrase(DEFAULT_KEY_PROMPT), signal)).resolves.toBe('typed-passphrase');
        expect(run.asked).toEqual([{ kind: 'secret', secretKind: 'passphrase', text: DEFAULT_KEY_PROMPT }]);
        run.memory.authenticated();
        // never reused within the attempt either
        await expect(run.prompt(passphrase(DEFAULT_KEY_PROMPT), signal)).resolves.toBe('typed-again');
        await new Promise((resolve) => setImmediate(resolve));
        expect([...run.store.entries.values()]).toEqual(['key-passphrase']);
      });
    }

    it('still answers and remembers the password of a single hop', async () => {
      const run = attempt({ sshVersion: [8, 1], hops: [TARGET], answers: [{ answer: 'pw', remember: true }] });
      await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('pw');
      expect(run.asked).toEqual([{ kind: 'secret', secretKind: 'password', text: "deploy@prod-1's password:", offerRemember: true }]);
      run.memory.authenticated();
      await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('pw');
      await vi.waitFor(() => expect([...run.store.entries.values()]).toEqual(['pw']));
    });
  });

  it('binds per hop from OpenSSH 8.4 on, through a jump host too', async () => {
    const run = attempt({ sshVersion: [8, 4] });
    await run.secrets.store(TARGET_PASSWORD, 'target-secret');
    await expect(run.prompt(password('(deploy@prod-1) Password:'), signal)).resolves.toBe('target-secret');
  });

  it('binds nothing on any version when a hop connects through a ProxyCommand', async () => {
    const run = attempt({ sshVersion: [9, 6], hops: [{ ...TARGET, proxyCommand: true }], answers: [{ answer: 'pw', remember: true }, { answer: 'pw-again', remember: false }] });
    await run.secrets.store(TARGET_PASSWORD, 'stored');
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('pw');
    expect(run.asked[0]).not.toHaveProperty('offerRemember');
    run.memory.authenticated();
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('pw-again');
  });

  it('keeps each key file\'s passphrase apart, so a hop\'s second key prompt is no refusal of the first', async () => {
    const run = attempt({ hops: [TARGET] });
    await run.secrets.store({ hop: TARGET, kind: 'passphrase', identityFile: '~/.ssh/id_ed25519' }, 'default-key');
    await run.secrets.store({ hop: TARGET, kind: 'passphrase', identityFile: '/keys/prod' }, 'prod-key');
    await expect(run.prompt(passphrase(DEFAULT_KEY_PROMPT), signal)).resolves.toBe('default-key');
    await expect(run.prompt(passphrase("Enter passphrase for key '/keys/prod':"), signal)).resolves.toBe('prod-key');
    expect(run.asked).toEqual([]);
    await expect(run.secrets.get({ hop: TARGET, kind: 'passphrase', identityFile: '~/.ssh/id_ed25519' })).resolves.toBe('default-key');
  });

  it('asks the user when the keychain cannot be read, logging no value', async () => {
    const store = createFakeSecretsStore({});
    const run = attempt({ store: { ...store, entries: store.entries, get: () => Promise.reject(new Error('the keyring is locked')) }, answers: [{ answer: 'typed', remember: false }] });
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('typed');
    expect(run.logs).toContain('reading the remembered password for prod-1 failed, so it is asked: the keyring is locked');
  });

  it('never offers a refused stored answer again in the attempt, even when deleting it failed', async () => {
    const store = createFakeSecretsStore({});
    const failingDelete = { ...store, entries: store.entries, delete: () => Promise.reject(new Error('the secrets file is read-only')) };
    const run = attempt({ store: failingDelete, answers: [{ answer: 'typed', remember: false }, { answer: 'typed-next', remember: false }] });
    await run.secrets.store(TARGET_PASSWORD, 'stale');
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('stale');
    await expect(run.prompt(password("deploy@prod-1's password:"), signal)).resolves.toBe('typed');
    run.memory.authenticated();
    // another prompt form of the same hop, whose typed answer is not held: still asked, the stale value never given again
    await expect(run.prompt(password('(deploy@prod-1) Password:'), signal)).resolves.toBe('typed-next');
    expect(run.logs).toContain('deleting the refused password for prod-1 failed: the secrets file is read-only');
    expect(run.logs.join('\n')).not.toContain('stale');
  });

  it('stores nothing typed with Remember when the host\'s answers were deleted during the sign-in', async () => {
    const run = attempt({ answers: [{ answer: 'pw', remember: true }] });
    await run.prompt(password("deploy@prod-1's password:"), signal);
    await run.remembered.deleteAllForHost('h1');
    run.memory.authenticated();
    await vi.waitFor(() => expect(run.logs).toContain('the password for prod-1 was not remembered: the host\'s remembered answers were deleted during the sign-in'));
    expect(run.store.entries.size).toBe(0);
  });
});
