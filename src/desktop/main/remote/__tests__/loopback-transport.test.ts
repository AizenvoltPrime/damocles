import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess, type LaunchedProcess } from '../../../../core/process-launcher';
import { posixTool, windowsSystemTool } from '../../../../core/system-tools';
import { bridgeSpec, bridgeStream, unpackServerPackage, type LoopbackTransportOptions } from '../loopback-transport';

const options: LoopbackTransportOptions = {
  execPath: '/opt/Damocles/damocles',
  daemonScript: '/opt/Damocles/resources/app.asar.unpacked/dist/daemon.js',
  home: '/data/loopback-home',
  env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1' },
  log: () => undefined,
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('the loopback bridge', () => {
  it('runs the checkout\'s daemon under this Electron as Node', () => {
    expect(bridgeSpec(options)).toMatchObject({ file: options.execPath, args: [options.daemonScript, 'attach', '--home', options.home], env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' } });
  });

  it('runs a server package with its own Node and no Electron variable', () => {
    const root = path.join(path.sep, 'unpacked', 'abc');
    const spec = bridgeSpec(options, root);
    expect(spec.env).toEqual({ PATH: '/usr/bin' });
    if (process.platform === 'win32') expect(spec).toMatchObject({ file: path.join(root, 'node', 'node.exe'), args: [path.join(root, 'dist', 'daemon.js'), 'attach', '--home', options.home] });
    else expect(spec).toMatchObject({ file: path.join(root, 'bin', 'damocles-server'), args: ['attach', '--home', options.home] });
  });

  it('writes the frames queued behind a write in flight to the bridge as one write', async () => {
    const writes: Buffer[] = [];
    let landed!: () => void;
    const bridge = {
      write: (chunk: Uint8Array) => {
        writes.push(Buffer.from(chunk));
        return writes.length === 1 ? new Promise<void>((resolve) => (landed = resolve)) : Promise.resolve();
      },
      end: () => undefined,
      kill: () => undefined,
      onData: () => undefined,
      exited: new Promise(() => undefined),
      closed: new Promise(() => undefined),
    } as unknown as LaunchedProcess;
    const stream = bridgeStream(bridge, () => undefined);
    stream.write(Buffer.from('a'));
    stream.write(Buffer.from('b'));
    stream.write(Buffer.from('c'));
    landed();
    await new Promise<void>((resolve) => stream.write(Buffer.from('d'), () => resolve()));
    expect(writes.map((chunk) => chunk.toString())).toEqual(['a', 'bcd']);
  });
});

describe('unpackServerPackage', () => {
  async function archive(): Promise<{ readonly file: string; readonly root: string }> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'loopback-package-'));
    dirs.push(base);
    const content = path.join(base, 'content');
    await fs.mkdir(path.join(content, 'dist'), { recursive: true });
    await fs.writeFile(path.join(content, 'dist', 'daemon.js'), 'daemon');
    const file = path.join(base, 'damocles-server.tar.gz');
    const tar = process.platform === 'win32' ? windowsSystemTool('tar') : posixTool('tar');
    const made = await runProcess({ file: tar!, args: ['-czf', file, '-C', content, 'dist'], stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    expect(made.exit?.code).toBe(0);
    return { file, root: path.join(base, 'unpacked') };
  }

  it('unpacks once for starts that ask at the same time, and a later start reuses that folder', async () => {
    const { file, root } = await archive();
    const [first, second] = await Promise.all([unpackServerPackage(file, root), unpackServerPackage(file, root)]);
    expect(second).toBe(first);
    await expect(fs.readFile(path.join(first, 'dist', 'daemon.js'), 'utf8')).resolves.toBe('daemon');
    expect(await fs.readdir(root)).toEqual([path.basename(first)]);
    await fs.writeFile(path.join(first, 'marker'), '');
    await expect(unpackServerPackage(file, root)).resolves.toBe(first);
    await expect(fs.readFile(path.join(first, 'marker'), 'utf8')).resolves.toBe('');
  });
});
