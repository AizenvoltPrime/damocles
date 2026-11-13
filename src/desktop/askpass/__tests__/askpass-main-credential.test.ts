import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAskpassServer, type AskpassServer, type RelayCredential } from '../../../core/scm/askpass/askpass-server';
import { relayVariables, type CredentialRelay } from '../../../core/scm/askpass/credential-relay';
import { createCredentialRelay } from '../../daemon/serve';
import { NOT_CONNECTED_MESSAGE } from '../helper-protocol';

// The helper as git runs it: the bundled askpass-main.js under Node, one JSON line each way with core's askpass server.
describe('askpass-main credential mode', { timeout: 120_000 }, () => {
  let dir: string;
  let main: string;
  let server: AskpassServer;
  let relay: CredentialRelay;
  let daemonRelay: Awaited<ReturnType<typeof createCredentialRelay>>;
  const credential = vi.fn<RelayCredential>();
  const logs: string[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-relay-helper-'));
    main = path.join(dir, 'askpass-main.js');
    await build({ entryPoints: [path.resolve(__dirname, '..', 'askpass-main.ts')], outfile: main, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    daemonRelay = await createCredentialRelay(dir);
    server = createAskpassServer({
      paths: { askpass: '/a.sh', sshAskpass: '/s.sh', node: process.execPath, main, credentialRelay: daemonRelay.identity() },
      prompt: async () => 'a prompt answer',
      credential: (request, origin, signal) => credential(request, origin, signal),
      log: (line) => logs.push(line),
    });
    relay = (await server.relay())!;
  });

  afterAll(async () => {
    await server.dispose();
    await daemonRelay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function helper(args: readonly string[], input: string, env: Readonly<Record<string, string>>, cwd = dir, started?: () => void): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [main, ...args], { env: { ...env, SystemRoot: process.env['SystemRoot'] ?? '' }, cwd, windowsHide: true });
      started?.();
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  it('prints the credential a get is answered with, sending no password and its own folder', async () => {
    credential.mockReset().mockResolvedValue({ kind: 'credential', username: 'ada', password: 'tok' });
    const result = await helper(['credential', 'get'], 'protocol=https\nhost=github.com\nusername=ada\npassword=stale\n\n', relayVariables(relay));
    expect(result).toEqual({ code: 0, stdout: 'username=ada\npassword=tok\n', stderr: '' });
    expect(credential).toHaveBeenCalledWith({ op: 'get', cwd: fs.realpathSync(dir), fields: { protocol: 'https', host: 'github.com', username: 'ada' } }, { kind: 'terminal' }, expect.any(AbortSignal));
  });

  it('prints quit=1 and the reason for a refusal, and nothing for a delegate answer', async () => {
    credential.mockReset().mockResolvedValue({ kind: 'refused', message: 'Turn on "Agent shells may use this account".' });
    await expect(helper(['credential', 'get'], 'protocol=https\nhost=gitlab.com\n\n', relayVariables(relay))).resolves.toEqual({ code: 0, stdout: 'quit=1\n', stderr: 'Turn on "Agent shells may use this account".\n' });
    credential.mockReset().mockResolvedValue({ kind: 'delegate' });
    await expect(helper(['credential', 'get'], 'protocol=https\nhost=gitlab.com\n\n', relayVariables(relay))).resolves.toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('answers nothing, asking no server, inside a delegation to the user\'s own helpers', async () => {
    credential.mockReset().mockResolvedValue({ kind: 'credential', username: 'ada', password: 'tok' });
    await expect(helper(['credential', 'get'], 'protocol=https\nhost=gitlab.com\n\n', { ...relayVariables(relay), DAMOCLES_CREDENTIAL_DELEGATE: '1' })).resolves.toEqual({ code: 0, stdout: '', stderr: '' });
    expect(credential).not.toHaveBeenCalled();
  });

  it('answers a credential nonce by its registration\'s origin, and drops the nonce once the registration ends', async () => {
    credential.mockReset().mockResolvedValue({ kind: 'credential', username: 'oauth2', password: 'glo-tok' });
    const origin = { kind: 'agentShell', panelId: 'p1', sessionId: 's1' } as const;
    const registration = await server.registerCredential(origin);
    await expect(helper(['credential', 'get'], 'protocol=https\nhost=gitlab.com\npath=g/p.git\n\n', registration.env)).resolves.toEqual({ code: 0, stdout: 'username=oauth2\npassword=glo-tok\n', stderr: '' });
    expect(credential).toHaveBeenCalledWith({ op: 'get', cwd: fs.realpathSync(dir), fields: { protocol: 'https', host: 'gitlab.com', path: 'g/p.git' } }, origin, expect.any(AbortSignal));
    registration.dispose();
    await expect(helper(['credential', 'get'], 'protocol=https\nhost=gitlab.com\n\n', registration.env)).resolves.toMatchObject({ code: 1, stderr: 'Damocles could not provide credentials.\n' });
  });

  it('writes exactly the not-connected line on stderr and nothing on stdout when no client is attached', async () => {
    credential.mockReset().mockResolvedValue({ kind: 'notConnected' });
    await expect(helper(['credential', 'get'], 'protocol=https\nhost=github.com\n\n', relayVariables(relay))).resolves.toEqual({ code: 0, stdout: '', stderr: `${NOT_CONNECTED_MESSAGE}\n` });
    expect(NOT_CONNECTED_MESSAGE).toBe('Damocles is not connected. Git credentials from your computer are unavailable.');
  });

  it('sends store and erase with git\'s password and its SHA-256 to the answering process on this machine', async () => {
    credential.mockReset().mockResolvedValue({ kind: 'none' });
    const passwordHash = createHash('sha256').update('tok', 'utf8').digest('hex');
    await expect(helper(['credential', 'store'], 'protocol=https\nhost=github.com\nusername=ada\npassword=tok\n\n', relayVariables(relay))).resolves.toEqual({ code: 0, stdout: '', stderr: '' });
    expect(credential).toHaveBeenLastCalledWith({ op: 'store', cwd: fs.realpathSync(dir), fields: { protocol: 'https', host: 'github.com', username: 'ada' }, password: 'tok', passwordHash }, { kind: 'terminal' }, expect.any(AbortSignal));
    await expect(helper(['credential', 'erase'], 'protocol=https\nhost=github.com\nusername=ada\npassword=tok\n\n', relayVariables(relay))).resolves.toMatchObject({ code: 0, stdout: '' });
    expect(credential).toHaveBeenLastCalledWith({ op: 'erase', cwd: fs.realpathSync(dir), fields: { protocol: 'https', host: 'github.com', username: 'ada' }, password: 'tok', passwordHash }, { kind: 'terminal' }, expect.any(AbortSignal));
    // git before 2.4x may name no password
    await helper(['credential', 'erase'], 'protocol=https\nhost=github.com\n\n', relayVariables(relay));
    expect(credential).toHaveBeenLastCalledWith({ op: 'erase', cwd: fs.realpathSync(dir), fields: { protocol: 'https', host: 'github.com' } }, { kind: 'terminal' }, expect.any(AbortSignal));
  });

  it.runIf(process.platform === 'win32')('runs as the .cmd helper with a ! in its paths under delayed expansion', async () => {
    credential.mockReset().mockResolvedValue({ kind: 'credential', username: 'ada', password: 'tok' });
    const bang = path.join(dir, 'a!b!c');
    fs.mkdirSync(bang, { recursive: true });
    fs.copyFileSync(main, path.join(bang, 'askpass-main.js'));
    const cmd = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe');
    const script = path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'git-credential', 'git-credential-relay.cmd');
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(cmd, ['/d', '/v:on', '/c', script, '--takeover', 'get'], { env: { ...relayVariables(relay), DAMOCLES_ASKPASS_MAIN: path.join(bang, 'askpass-main.js'), SystemRoot: process.env['SystemRoot'] ?? '' }, cwd: dir, windowsHide: true });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end('protocol=https\nhost=github.com\n\n');
    });
    expect(result).toEqual({ code: 0, stdout: 'username=ada\npassword=tok\n' });
  });

  it('fails without the relay nonce, and the server refuses its nonce as a prompt\'s', async () => {
    credential.mockReset();
    const { DAMOCLES_CREDENTIAL_NONCE: nonce, ...withoutNonce } = relayVariables(relay);
    // the takeover's get it cannot ask for stops git there, so no other helper or prompt answers in Damocles' place
    await expect(helper(['credential', '--takeover', 'get'], 'protocol=https\nhost=github.com\n\n', withoutNonce)).resolves.toEqual({ code: 1, stdout: 'quit=1\n', stderr: 'Damocles could not provide credentials.\n' });
    // a terminal's variables used as an askpass helper's: the relay nonce in the prompt nonce's place
    logs.length = 0;
    await expect(helper(['askpass', 'Password: '], '', { ...withoutNonce, DAMOCLES_ASKPASS_NONCE: nonce! })).resolves.toMatchObject({ code: 1, stdout: '' });
    expect(logs).toEqual(['[askpass] dropped a helper connection: a prompt with the credential relay nonce']);
    expect(credential).not.toHaveBeenCalled();
  });

  it('stops git with quit=1 while nothing listens only as the takeover\'s helper; the relay leaves git its other helpers', async () => {
    credential.mockReset();
    const nowhere = process.platform === 'win32' ? `\\\\.\\pipe\\damocles-nowhere-${process.pid}-${Date.now()}` : path.join(dir, 'nowhere.sock');
    const env = { ...relayVariables(relay), DAMOCLES_ASKPASS_HANDLE: nowhere };
    const input = 'protocol=https\nhost=example.com\n\n';
    await expect(helper(['credential', '--takeover', 'get'], input, env)).resolves.toEqual({ code: 1, stdout: 'quit=1\n', stderr: 'Damocles could not provide credentials.\n' });
    await expect(helper(['credential', 'get'], input, env)).resolves.toEqual({ code: 1, stdout: '', stderr: 'Damocles could not provide credentials.\n' });
    expect(credential).not.toHaveBeenCalled();
  });

  it('answers a description without a host, git\'s client-certificate prompt, with nothing and without asking', async () => {
    credential.mockReset();
    await expect(helper(['credential', 'get'], 'protocol=cert\npath=/home/ada/client.p12\n\n', relayVariables(relay))).resolves.toEqual({ code: 0, stdout: '', stderr: '' });
    expect(credential).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'win32')('fails with its one line when its working folder was deleted', async () => {
    credential.mockReset();
    const gone = fs.mkdtempSync(path.join(dir, 'gone-'));
    const result = await helper(['credential', '--takeover', 'get'], 'protocol=https\nhost=github.com\n\n', relayVariables(relay), gone, () => fs.rmSync(gone, { recursive: true }));
    expect(result).toEqual({ code: 1, stdout: 'quit=1\n', stderr: 'Damocles could not provide credentials.\n' });
    expect(credential).not.toHaveBeenCalled();
  });
});
