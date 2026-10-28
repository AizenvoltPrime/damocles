import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CredentialPrompt, PromptCredential } from '../../../../../core/scm/askpass/askpass-server';
import type { LaunchedProcess, Launcher, SpawnSpec } from '../../../../../core/process-launcher';
import type { SshPrompt, SshPromptAnswer } from '../../../../preload/overlay-channels';
import type { ServerManifest } from '../../server-manifest-format';
import type { SshRun } from '../control-master';
import { startSshTransport, type SshTransportOptions } from '../ssh-transport';

// ssh -V and ssh -G as this client's OpenSSH answers them
const run: SshRun = async (_file, args) => ({
  code: 0,
  stdout: args.includes('-G') ? 'hostname prod-1\nuser deploy\nport 22\n' : '',
  stderr: args.includes('-V') ? 'OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2\n' : '',
});

const PASSWORD_PROMPT: CredentialPrompt = { kind: 'password', text: "deploy@prod-1's password:" };
const manifest: ServerManifest = { version: '3.7.0', protocolVersion: 1, packages: {} };

// A password-only host from a client without a master connection: every ssh process asks askpass for the password, and
// the remote command runs once the answer is right. The stage stops at the probe, which ends the attempt.
function passwordOnlyHost(password: string) {
  let prompt: PromptCredential | undefined;
  const commands: string[] = [];
  const askpass = {
    register: async (_mode: unknown, _label: string, registered: PromptCredential) => {
      prompt = registered;
      return { env: { SSH_ASKPASS: 'ssh-askpass.exe', SSH_ASKPASS_REQUIRE: 'force' }, dispose: () => undefined };
    },
  };
  const launcher = {
    launch: (spec: SpawnSpec): LaunchedProcess => {
      const command = spec.args!.at(-1)!;
      commands.push(command);
      const listeners = { stdout: new Set<(chunk: Buffer) => void>(), stderr: new Set<(chunk: Buffer) => void>() };
      let exit!: (code: number) => void;
      const exited = new Promise<{ code: number; signal: null }>((resolve) => { exit = (code) => resolve({ code, signal: null }); });
      const emit = (stream: 'stdout' | 'stderr', text: string): void => listeners[stream].forEach((listener) => listener(Buffer.from(text)));
      void (async () => {
        await Promise.resolve();
        for (let tries = 0; tries < 3; tries++) {
          const answer = await prompt!(PASSWORD_PROMPT, new AbortController().signal);
          if (answer !== password) continue;
          if (command === 'uname -s') emit('stdout', 'Linux\n');
          else emit('stdout', '@@DAMOCLES {"kind":"fail","code":"kernelTooOld","params":{"found":"3.10","needed":"4.18"}}\n');
          exit(command === 'uname -s' ? 0 : 1);
          return;
        }
        emit('stderr', 'deploy@prod-1: Permission denied (password).\n');
        exit(255);
      })();
      return {
        pid: Promise.resolve(1),
        onData: (stream, listener) => { listeners[stream as 'stdout' | 'stderr'].add(listener); },
        write: async () => undefined,
        end: () => undefined,
        exited,
        closed: exited.then(() => undefined),
        kill: () => exit(255),
      };
    },
  } as unknown as Launcher;
  return { askpass, launcher, commands, prompt: (): PromptCredential => prompt! };
}

function connect(host: ReturnType<typeof passwordOnlyHost>, answers: string[], extra: Partial<SshTransportOptions> = {}) {
  const asked: SshPrompt[] = [];
  const options = {
    hostId: 'h1',
    hostLabel: 'prod-1',
    destination: { kind: 'alias', alias: 'prod-1' },
    forwardAgent: false,
    signal: new AbortController().signal,
    hooks: {
      step: () => undefined,
      progress: () => undefined,
      notice: () => undefined,
      prompt: async (question: SshPrompt): Promise<SshPromptAnswer | undefined> => {
        asked.push(question);
        const answer = answers.shift();
        return answer === undefined ? undefined : { answer, remember: false };
      },
    },
    savePlatform: async () => undefined,
    installFolderSettled: async () => undefined,
    askpass: host.askpass,
    manifest,
    releasesUrl: 'https://example.com/releases',
    artifacts: {},
    log: () => undefined,
    ...extra,
  } as unknown as SshTransportOptions;
  const done = startSshTransport(options, { resolveSsh: async () => 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', launcher: () => host.launcher, run, env: {}, userInfo: () => os.userInfo() });
  return { asked, done };
}

describe('the first connection to a password-only host from a client without a master connection', () => {
  it('asks the password once for the platform detection and stage 0, two ssh processes that each authenticate', async () => {
    const host = passwordOnlyHost('pw');
    const { asked, done } = connect(host, ['pw']);
    await expect(done).rejects.toMatchObject({ code: 'kernelTooOld' });
    expect(host.commands).toHaveLength(2);
    expect(host.commands[0]).toBe('uname -s');
    expect(asked).toEqual([{ kind: 'secret', secretKind: 'password', text: PASSWORD_PROMPT.text }]);
    // the attempt ended: a prompt arriving through its registration now is asked, never answered from the attempt
    await host.prompt()(PASSWORD_PROMPT, new AbortController().signal);
    expect(asked).toHaveLength(2);
  });

  it('reuses the corrected password after a wrong one, and asks the next attempt again', async () => {
    const host = passwordOnlyHost('pw');
    const first = connect(host, ['wrong', 'pw']);
    await expect(first.done).rejects.toMatchObject({ code: 'kernelTooOld' });
    expect(first.asked).toHaveLength(2);
    // the attempt ended: nothing it was told answers the next one
    const second = connect(host, ['pw']);
    await expect(second.done).rejects.toMatchObject({ code: 'kernelTooOld' });
    expect(second.asked).toHaveLength(1);
  });
});
