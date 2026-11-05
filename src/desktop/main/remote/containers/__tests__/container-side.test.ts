import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Launcher } from '../../../../../core/process-launcher';
import type { StreamChannel } from '../../../../../remote/mux';
import type { RemoteConnection } from '../../connection';
import { cliEnvironment, localContainerSide, viaContainerSide } from '../container-side';

// A client-opened stream whose end the test reads.
function stream(): { channel: StreamChannel; ended: () => boolean } {
  let ended = false;
  return {
    channel: {
      id: 5,
      closed: false,
      write: () => true,
      end: () => {
        ended = true;
      },
      onData: () => ({ dispose: () => undefined }),
      onEnd: () => ({ dispose: () => undefined }),
      onDrain: () => ({ dispose: () => undefined }),
      pause: () => undefined,
      resume: () => undefined,
    },
    ended: () => ended,
  };
}

describe('the containers of an SSH host', () => {
  it('ends the stream it named for up when the attempt is cancelled, which ends the CLI on the host', async () => {
    const opened = stream();
    const requests: Array<[string, unknown]> = [];
    let answer = (): void => undefined;
    const connection = {
      features: ['containers'],
      openStream: () => opened.channel,
      control: {
        request: (name: string, params: unknown) => {
          requests.push([name, params]);
          return new Promise((resolve) => {
            answer = () => resolve({ result: 'ran', code: null, stdout: '' });
          });
        },
      },
    } as unknown as RemoteConnection;
    const side = viaContainerSide({ hostId: 'h', hostName: () => 'prod-1', connection: () => connection, manifest: async () => { throw new Error('unused'); } });
    const controller = new AbortController();
    const running = side.up({ engine: 'docker', workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer.json' }, 'c'.repeat(32), false, () => undefined, controller.signal);
    expect(requests[0]).toEqual(['containers.up', { engine: 'docker', workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer.json', dataKey: 'c'.repeat(32), removeExisting: false, stream: 5 }]);
    expect(opened.ended()).toBe(false);
    controller.abort();
    expect(opened.ended()).toBe(true);
    answer();
    expect(await running).toEqual({ result: 'ran', code: null, stdout: '' });
  });

  it('ends the stream it named for read-configuration when the attempt is cancelled', async () => {
    const opened = stream();
    const requests: string[] = [];
    let answer = (): void => undefined;
    const connection = {
      features: ['containers'],
      openStream: () => opened.channel,
      control: {
        request: (name: string) => {
          requests.push(name);
          return new Promise((resolve) => {
            answer = () => resolve({ result: 'ran', code: null, stdout: '' });
          });
        },
      },
    } as unknown as RemoteConnection;
    const side = viaContainerSide({ hostId: 'h', hostName: () => 'prod-1', connection: () => connection, manifest: async () => { throw new Error('unused'); } });
    const controller = new AbortController();
    const running = side.readConfiguration({ engine: 'docker', workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer.json' }, () => undefined, controller.signal);
    expect(requests).toEqual(['containers.readConfiguration']);
    expect(opened.ended()).toBe(false);
    controller.abort();
    expect(opened.ended()).toBe(true);
    answer();
    await running;
  });

  it('has the host\'s package cache download a published build\'s package, and asks nothing for an unpublished one, which the stage uploads', async () => {
    const requests: Array<[string, unknown]> = [];
    const connection = {
      features: ['containers'],
      control: {
        request: async (name: string, params: unknown) => {
          requests.push([name, params]);
          return { result: 'copied' };
        },
      },
    } as unknown as RemoteConnection;
    const pkg = { file: 'damocles-server-3.7.0-linux-x64.tar.gz', sha256: 'a'.repeat(64), size: 10, serverVersion: '3.7.0+0123456789ab' };
    const manifest = { version: '3.7.0', protocolVersion: 1, published: true, packages: { 'linux-x64': pkg } };
    const published = viaContainerSide({ hostId: 'h', hostName: () => 'prod-1', connection: () => connection, manifest: async () => ({ manifest, releasesUrl: 'https://example.invalid/releases' }) });
    expect(await published.copyPackage('docker', 'c'.repeat(64), '/tmp/damocles-cache-0123456789abcdef', 'linux-x64')).toBe('copied');
    expect(requests).toEqual([['containers.copyPackage', { engine: 'docker', containerId: 'c'.repeat(64), folder: '/tmp/damocles-cache-0123456789abcdef', file: pkg.file, sha256: pkg.sha256, size: 10, url: `https://example.invalid/releases/download/v3.7.0/${pkg.file}` }]]);
    const unpublished = viaContainerSide({ hostId: 'h', hostName: () => 'prod-1', connection: () => connection, manifest: async () => ({ manifest: { ...manifest, published: false } }) });
    expect(await unpublished.copyPackage('docker', 'c'.repeat(64), '/tmp/damocles-cache-0123456789abcdef', 'linux-x64')).toBe('notCopied');
    expect(requests).toHaveLength(1);
  });

  it('refuses while the host is away or its server runs no containers, naming the host', async () => {
    const away = viaContainerSide({ hostId: 'h', hostName: () => 'prod-1', connection: () => undefined, manifest: async () => { throw new Error('unused'); } });
    await expect(away.list('docker')).rejects.toMatchObject({ code: 'viaNotConnected', params: { host: 'prod-1' } });
    const old = viaContainerSide({ hostId: 'h', hostName: () => 'prod-1', connection: () => ({ features: [] }) as unknown as RemoteConnection, manifest: async () => { throw new Error('unused'); } });
    await expect(old.list('docker')).rejects.toMatchObject({ code: 'containerFeatureMissing', params: { host: 'prod-1' } });
  });
});

describe('the CLI on this computer', () => {
  it("gives read-configuration the attempt's signal, which kills the CLI's tree", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-engine-'));
    try {
      fs.writeFileSync(path.join(folder, process.platform === 'win32' ? 'docker.exe' : 'docker'), '');
      const signals: Array<AbortSignal | undefined> = [];
      const launcher = {
        launch: (_options: unknown, control: { signal?: AbortSignal } = {}) => {
          signals.push(control.signal);
          return { onData: () => undefined, exited: Promise.resolve({ code: 0, signal: null }), closed: Promise.resolve() };
        },
      } as unknown as Launcher;
      const side = localContainerSide({ launcher: () => launcher, env: { PATH: folder }, execPath: '/app/damocles', cliPath: '/app/cli.js', artifacts: async () => { throw new Error('unused'); } });
      const controller = new AbortController();
      await side.readConfiguration({ engine: 'docker', workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer.json' }, () => undefined, controller.signal);
      expect(signals).toEqual([controller.signal]);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('runs as Node, reads no asar archive as one, and gets no other Electron variable', () => {
    expect(cliEnvironment({ PATH: '/bin', ELECTRON_ENABLE_LOGGING: '1', HOME: '/home/me' })).toEqual({ PATH: '/bin', HOME: '/home/me', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' });
  });
});
