import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcess } from '../../../../../core/process-launcher';
import { PROMPT_CANCELLED, type AskpassServer, type CredentialPrompt } from '../../../../../core/scm/askpass/askpass-server';
// @ts-expect-error -- plain .mjs script, no types
import { compileAskpassTrampoline } from '../../../../../../scripts/askpass-trampoline.mjs';
import type { SshPrompt } from '../../../../preload/overlay-channels';
import { attemptPrompt, createMainAskpassServer, mainAskpassPaths, parseHostKeyPrompt, secretKindOf, type AttemptPromptState } from '../ssh-askpass';

const HOST_KEY_PROMPT = [
  "The authenticity of host '[127.0.0.1]:2222 ([127.0.0.1]:2222)' can't be established.",
  'ED25519 key fingerprint is SHA256:2bWvYpQ7cWe0n9sZr3xTkq8Yt1Jm0Xh6Ue5d4c3b2a1.',
  'This key is not known by any other names.',
  'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
].join('\n');

describe('parseHostKeyPrompt', () => {
  it('reads the host as ssh names it, the key type and the fingerprint', () => {
    expect(parseHostKeyPrompt(HOST_KEY_PROMPT)).toEqual({ host: '[127.0.0.1]:2222', keyType: 'ED25519', fingerprint: 'SHA256:2bWvYpQ7cWe0n9sZr3xTkq8Yt1Jm0Xh6Ue5d4c3b2a1' });
    expect(parseHostKeyPrompt("The authenticity of host 'prod (10.0.0.1)' can't be established.\nECDSA key fingerprint is SHA256:abc+/=.\n")).toEqual({ host: 'prod', keyType: 'ECDSA', fingerprint: 'SHA256:abc+/=' });
    // OpenSSH 10's wording
    expect(parseHostKeyPrompt("The authenticity of host '[127.0.0.1]:2222 ([127.0.0.1]:2222)' can't be established.\nED25519 key fingerprint is: SHA256:UY35abc+/=\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?")).toEqual({ host: '[127.0.0.1]:2222', keyType: 'ED25519', fingerprint: 'SHA256:UY35abc+/=' });
    expect(parseHostKeyPrompt('Allow use of key /home/dev/.ssh/id_ed25519?')).toBeUndefined();
  });

  it('reads only ssh\'s own question, never a server\'s keyboard-interactive text quoting it', () => {
    expect(parseHostKeyPrompt(`(dev@prod) ${HOST_KEY_PROMPT}`)).toBeUndefined();
    expect(parseHostKeyPrompt(`Welcome. ${HOST_KEY_PROMPT}`)).toBeUndefined();
  });
});

describe('secretKindOf', () => {
  const kind = (text: string, promptKind: 'password' | 'passphrase' = 'password') => secretKindOf({ kind: promptKind, text });

  it('names a PIN, never a code, for a security key or a PKCS#11 token', () => {
    expect(kind('Enter PIN for ED25519-SK key /home/ada/.ssh/id_ed25519_sk:')).toBe('pin');
    expect(kind("Enter PIN for 'SoftHSM token':")).toBe('pin');
  });

  it('names a code only for word-bounded code wording with no password, PIN, passcode or passphrase in it', () => {
    expect(kind('Verification code:')).toBe('otp');
    expect(kind('(dev@prod) Verification code:')).toBe('otp');
    expect(kind('Enter your token:')).toBe('otp');
    expect(kind('Duo two-factor login for ada')).toBe('otp');
    expect(kind('Password + Token:')).toBe('password');
    expect(kind('One-time password (OATH) for ada:')).toBe('password');
    expect(kind('Enter PASSCODE:')).toBe('other');
    expect(kind('Duo two-factor login for ada\n\nEnter a passcode or select one of the following options:')).toBe('other');
    expect(kind('Respuesta individuo:')).toBe('other');
  });

  it('names a password or passphrase by its word, and anything else, a localized password included, other', () => {
    expect(kind("dev@prod's password:")).toBe('password');
    expect(kind('(dev@prod) Password:')).toBe('password');
    expect(kind("Enter passphrase for key 'id':", 'passphrase')).toBe('passphrase');
    for (const text of ['Passwort:', 'Mot de passe :', 'Contraseña:', 'Пароль:', 'Κωδικός πρόσβασης:', 'Response:', 'Secret:']) expect(kind(text), text).toBe('other');
  });
});

describe('attemptPrompt', () => {
  const answer = async (prompt: CredentialPrompt, reply: string | undefined, signal = new AbortController().signal) => {
    const state: AttemptPromptState = { hostKeyRefused: false, cancelled: false };
    const asked: SshPrompt[] = [];
    const logs: string[] = [];
    const credential = attemptPrompt(async (question) => {
      asked.push(question);
      return reply === undefined ? undefined : { answer: reply, remember: false };
    }, state, (line) => logs.push(line));
    return { result: await credential(prompt, signal), state, asked, logs };
  };

  it('answers ssh\'s own host key question yes only on Connect', async () => {
    expect(await answer({ kind: 'confirm', text: HOST_KEY_PROMPT }, 'connect')).toMatchObject({ result: 'yes', asked: [{ kind: 'hostKey', host: '[127.0.0.1]:2222' }] });
    expect(await answer({ kind: 'confirm', text: HOST_KEY_PROMPT }, 'cancel')).toMatchObject({ result: PROMPT_CANCELLED, state: { hostKeyRefused: true } });
  });

  it('does not take a host key question ssh withdrew for the user\'s refusal', async () => {
    const withdrawn = new AbortController();
    withdrawn.abort();
    expect(await answer({ kind: 'confirm', text: HOST_KEY_PROMPT }, undefined, withdrawn.signal)).toMatchObject({ result: PROMPT_CANCELLED, state: { hostKeyRefused: false } });
  });

  it('never answers a confirmation that is not a host key question, asks nothing for it and logs its text as one line', async () => {
    expect(await answer({ kind: 'confirm', text: 'Allow use of key id_ed25519? (yes/no)' }, 'connect')).toMatchObject({ result: PROMPT_CANCELLED, state: { hostKeyRefused: false, cancelled: false }, asked: [] });
    // a server's text quoting ssh's question opens no host key dialog
    const quoted = await answer({ kind: 'confirm', text: `(dev@prod) ${HOST_KEY_PROMPT}` }, 'connect');
    expect(quoted).toMatchObject({ result: PROMPT_CANCELLED, state: { hostKeyRefused: false }, asked: [] });
    expect(quoted.logs).toEqual([`refused a confirmation that is not a host key question: ${JSON.stringify(`(dev@prod) ${HOST_KEY_PROMPT}`)}`]);
    expect((await answer({ kind: 'notice', text: 'Confirm user presence\n[ssh h2] forged' }, undefined)).logs).toEqual(['ssh notice: "Confirm user presence\\n[ssh h2] forged"']);
  });

  it('asks secrets by kind, and a dismissed one cancels the attempt', async () => {
    expect(await answer({ kind: 'password', text: "dev@prod's password:" }, 'hunter2')).toMatchObject({ result: 'hunter2', asked: [{ kind: 'secret', secretKind: 'password' }] });
    expect(await answer({ kind: 'passphrase', text: "Enter passphrase for key 'id':" }, 'p')).toMatchObject({ asked: [{ secretKind: 'passphrase' }] });
    expect(await answer({ kind: 'password', text: '(dev@prod) Verification code:' }, '123456')).toMatchObject({ asked: [{ secretKind: 'otp' }] });
    expect(await answer({ kind: 'password', text: "dev@prod's password:" }, undefined)).toMatchObject({ result: PROMPT_CANCELLED, state: { cancelled: true } });
  });
});

describe('mainAskpassPaths', () => {
  it('gives Windows ssh the native trampoline and every other platform the sh helper', () => {
    const paths = { askpass: 'C:\\app\\dist\\askpass\\askpass.sh', sshAskpass: 'C:\\app\\dist\\askpass\\ssh-askpass.sh', node: 'C:\\app\\Damocles.exe', main: 'C:\\app\\dist\\askpass-main.js' };
    expect(mainAskpassPaths(paths, 'win32').sshAskpass).toBe('C:\\app\\dist\\askpass\\ssh-askpass.exe');
    expect(mainAskpassPaths(paths, 'linux')).toEqual(paths);
  });
});

describe.skipIf(process.platform !== 'win32')('the Windows askpass trampoline against a real askpass server', () => {
  let dir: string | undefined;
  let server: AskpassServer | undefined;
  let exe = '';
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'trampoline-'));
    exe = compileAskpassTrampoline(dir) as string;
    server = createMainAskpassServer({ paths: { askpass: path.join(dir, 'askpass.sh'), sshAskpass: path.join(dir, 'ssh-askpass.sh'), node: process.execPath, main: path.join(dir, 'unused.js') }, log: () => undefined, platform: 'win32' });
  }, 120_000);
  // beforeAll may have failed before making either
  afterAll(async () => {
    await server?.dispose();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  const ask = async (argv: string[], answer: string | typeof PROMPT_CANCELLED, hint?: 'confirm' | 'none') => {
    const seen: CredentialPrompt[] = [];
    const registration = await server!.register('interactive', 'test', async (prompt) => {
      seen.push(prompt);
      return answer;
    });
    try {
      expect(registration.env['SSH_ASKPASS']).toBe(exe);
      const { exit, stdout } = await runProcess(
        { file: registration.env['SSH_ASKPASS']!, args: argv, env: { ...process.env, ...registration.env, ...(hint !== undefined ? { SSH_ASKPASS_PROMPT: hint } : {}) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        { timeoutMs: 30_000 },
      );
      return { code: exit?.code, stdout: stdout.toString('utf8'), seen };
    } finally {
      registration.dispose();
    }
  };

  it('forwards a prompt holding ", &, % and a newline as exactly that text, and prints the answer', async () => {
    const prompt = 'x" & calc & "y %PATH% ^| (dev@prod)\nVerification code: \u00e9\u2713';
    const { code, stdout, seen } = await ask([prompt], 'an "answer" & 100% \u00fc');
    expect(code).toBe(0);
    expect(seen).toEqual([{ kind: 'password', text: prompt }]);
    expect(stdout).toBe('an "answer" & 100% \u00fc\n');
  });

  it('forwards SSH_ASKPASS_PROMPT, so a hinted permission question is a confirmation', async () => {
    const { seen } = await ask(['Allow use of key id_ed25519?'], 'yes', 'confirm');
    expect(seen.map(({ kind }) => kind)).toEqual(['confirm']);
  });

  it('exits 1 and prints nothing for a cancel', async () => {
    expect(await ask(["dev@prod's password: "], PROMPT_CANCELLED)).toMatchObject({ code: 1, stdout: '' });
  });

  it('decodes an answer holding a backslash, a tab, a control character and a character outside the BMP', async () => {
    const answer = 'a\\b\tc\u0001d\u{1F511}';
    expect(await ask(['Password: '], answer)).toMatchObject({ code: 0, stdout: `${answer}\n` });
  });

  it('exits 1 with its one line, never an unhandled exception, for a handle naming no pipe', async () => {
    const { exit, stdout, stderr } = await runProcess(
      { file: exe, args: ['Password: '], env: { ...process.env, DAMOCLES_ASKPASS_HANDLE: '\\\\.\\pipe\\', DAMOCLES_ASKPASS_NONCE: 'a'.repeat(64) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      { timeoutMs: 30_000 },
    );
    expect({ code: exit?.code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') }).toEqual({ code: 1, stdout: '', stderr: 'Damocles could not provide credentials.\r\n' });
  });
});
