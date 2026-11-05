import { describe, expect, it } from 'vitest';
import type { ProcessExit } from '../../../../../core/process-launcher';
import { CONTAINER_DATA_FOLDER, execStageArgs } from '../../../../daemon/container-commands';
import type { ServerManifest } from '../../server-manifest-format';
import { SshConnectError, type StageProcess } from '../../ssh/ssh-transport';
import type { ContainerSide, CopyResult } from '../container-side';
import { startContainerTransport, type ContainerTransportOptions } from '../container-transport';

const ID = '28f4e6f33d7eb0c2fa0a1a525fdb39d5ef72c206dbca3f397ed48e8b10aa3a24';
const manifest: ServerManifest = {
  version: '3.7.0',
  packages: { 'alpine-x64': { file: 'damocles-server-3.7.0-alpine-x64.tar.gz', sha256: 'a'.repeat(64), size: 10, serverVersion: '3.7.0+0123456789ab' } },
} as unknown as ServerManifest;

// stage 0 under exec: what reached its stdin, and the status lines it answers with
function fakeExec(answer: (stdin: string, emit: (line: string) => void, exit: (code: number) => void) => void): { readonly process: StageProcess; readonly stdin: () => string } {
  const listeners: Array<(chunk: Buffer) => void> = [];
  let written = '';
  let finish = (_exit: ProcessExit): void => undefined;
  const exited = new Promise<ProcessExit>((resolve) => {
    finish = resolve;
  });
  const emit = (line: string): void => {
    for (const listener of listeners) listener(Buffer.from(`${line}\n`));
  };
  return {
    process: {
      onData: (stream, listener) => {
        if (stream === 'stdout') listeners.push(listener);
      },
      write: async (chunk) => {
        written += Buffer.from(chunk).toString('utf8');
        answer(written, emit, (code) => finish({ code, signal: null }));
      },
      end: () => undefined,
      exited,
      closed: exited.then(() => undefined),
      kill: () => finish({ code: null, signal: 'SIGTERM' }),
    },
    stdin: () => written,
  };
}

function side(exec: StageProcess | 'engineMissing', copied: CopyResult, calls: unknown[][]): ContainerSide {
  const unused = (): never => {
    throw new Error('not used by the transport');
  };
  return {
    via: undefined,
    config: unused,
    up: unused,
    prepareData: unused,
    readConfiguration: unused,
    list: unused,
    inspect: unused,
    exec: async (...args) => {
      calls.push(['exec', ...args]);
      return exec;
    },
    copyPackage: async (...args) => {
      calls.push(['copyPackage', ...args]);
      return copied;
    },
  };
}

function options(containerSide: ContainerSide, overrides: Partial<ContainerTransportOptions> = {}): ContainerTransportOptions {
  return {
    side: containerSide,
    engine: 'docker',
    containerId: ID,
    user: 'node',
    dataFolder: true,
    signal: new AbortController().signal,
    hooks: { step: () => undefined, progress: () => undefined, notice: () => undefined },
    installFolderSettled: async () => undefined,
    manifest,
    releasesUrl: 'https://example.invalid/releases',
    artifacts: { packageFolder: () => 'C:\\cache', packagePath: async () => 'C:\\cache\\damocles-server-3.7.0-alpine-x64.tar.gz' },
    log: () => undefined,
    ...overrides,
  };
}

// a stage that names the Alpine target, asks for the cache, and starts the bridge once answered
const alpineStage = (answers: string[]) => (stdin: string, emit: (line: string) => void): void => {
  if (!stdin.includes('BEGIN MAIN')) return;
  if (answers.length === 0) {
    answers.push('asked');
    emit('@@DAMOCLES {"kind":"probe","target":"alpine-x64","install":"/home/node/.damocles/server"}');
    emit('@@DAMOCLES {"kind":"cache"}');
    return;
  }
  const answer = stdin.slice(stdin.lastIndexOf('# END PARAMETERS')).match(/\n(ready|none)\n$/)?.[1];
  if (answer && answers.length === 1) {
    answers.push(answer);
    emit('@@DAMOCLES {"kind":"bridge"}');
  }
};

describe('the container transport', () => {
  it('runs stage 0 under exec as the user, gives stage 1 a private cache folder and the data folder, and copies the probed target\'s package into it', async () => {
    const calls: unknown[][] = [];
    const answers: string[] = [];
    const exec = fakeExec(alpineStage(answers));
    const result = await startContainerTransport(options(side(exec.process, 'copied', calls)));
    expect(calls[0]).toEqual(['exec', 'docker', ID, 'node']);
    const folder = /D_CONTAINER_CACHE='(\/tmp\/damocles-cache-[0-9a-f]{24})'/.exec(exec.stdin())?.[1];
    expect(folder).toBeDefined();
    expect(exec.stdin()).toContain(`D_DATA_FOLDER='${CONTAINER_DATA_FOLDER}'`);
    // the Alpine probe's target, into the folder the stage was given
    expect(calls[1]).toEqual(['copyPackage', 'docker', ID, folder, 'alpine-x64']);
    expect(answers).toEqual(['asked', 'ready']);
    expect(result.probe.target).toBe('alpine-x64');
    result.dispose();
  });

  it('answers none when the copy fails, so the stage asks for the upload, and gives an attached container no data folder', async () => {
    const answers: string[] = [];
    const exec = fakeExec(alpineStage(answers));
    const result = await startContainerTransport(options(side(exec.process, 'notCopied', []), { dataFolder: false }));
    expect(answers).toEqual(['asked', 'none']);
    expect(exec.stdin()).toContain("D_DATA_FOLDER=''");
    result.dispose();
  });

  it('fails with containerEngineMissing when no engine is found, and with execExited when stage 0 ends first', async () => {
    const missing = await startContainerTransport(options(side('engineMissing', 'copied', []))).catch((err: unknown) => err);
    expect(missing).toBeInstanceOf(SshConnectError);
    expect((missing as SshConnectError).code).toBe('containerEngineMissing');
    const ended = fakeExec((_stdin, _emit, exit) => exit(126));
    const failed = await startContainerTransport(options(side(ended.process, 'copied', []))).catch((err: unknown) => err);
    expect((failed as SshConnectError).params).toEqual({ reason: 'execExited', exitCode: 126 });
  });

  it('ends the exec and fails as cancelled when the user cancelled while the exec started, writing no stage', async () => {
    const controller = new AbortController();
    let killed = false;
    const exec = fakeExec(() => undefined);
    const process: StageProcess = { ...exec.process, kill: () => { killed = true; exec.process.kill(); } };
    const cancelling: ContainerSide = { ...side(process, 'copied', []), exec: async () => { controller.abort(); return process; } };
    const failed = await startContainerTransport(options(cancelling, { signal: controller.signal })).catch((err: unknown) => err);
    expect(failed).toMatchObject({ code: 'cancelled' });
    expect(killed).toBe(true);
    expect(exec.stdin()).toBe('');
  });

  it('execs stage 0 with /bin/sh as a checked user and container id only', () => {
    expect(execStageArgs(ID, 'node')).toEqual(['exec', '-i', '-u', 'node', '-e', 'SSH_AUTH_SOCK=', ID, '/bin/sh', '-c', 'IFS= read -r n; s=$(dd bs=1 count="$n" 2>/dev/null); eval "$s"']);
    expect(() => execStageArgs(ID, '-uroot')).toThrow(RangeError);
    expect(() => execStageArgs('--privileged', 'node')).toThrow(RangeError);
  });
});
