import { describe, expect, it } from 'vitest';
import { e2eManifest, remoteE2eEnvironment } from '../remote-e2e-environment';
import type { ServerManifest } from '../server-manifest-format';

const hooks = (env: Record<string, string>) => remoteE2eEnvironment({ packaged: false, env: { DAMOCLES_E2E_HOOKS: '1', ...env } });

describe('the remote e2e hooks', () => {
  it('take an app version plain or with a 12 hex digit build, and refuse anything else', () => {
    expect(hooks({ DAMOCLES_E2E_APP_VERSION: '3.6.9' })).toEqual({ appVersion: '3.6.9' });
    expect(hooks({ DAMOCLES_E2E_APP_VERSION: '3.7.0+0123456789ab' })).toEqual({ appVersion: '3.7.0+0123456789ab' });
    for (const version of ['3.7.0+local', '3.7.0+0123456789AB', '3.7.0+0123456789a', '3.7', '3.7.0 ']) expect(() => hooks({ DAMOCLES_E2E_APP_VERSION: version }), version).toThrow('DAMOCLES_E2E_APP_VERSION');
  });

  it('are read by no packaged build and without DAMOCLES_E2E_HOOKS', () => {
    expect(remoteE2eEnvironment({ packaged: true, env: { DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_APP_VERSION: '3.6.9' } })).toEqual({});
    expect(remoteE2eEnvironment({ packaged: false, env: { DAMOCLES_E2E_APP_VERSION: '3.6.9' } })).toEqual({});
  });

  it('take a server requirement as the manifest parses it and a drain in ms, under the same gate, and refuse anything else', () => {
    const requirement = { minimumServerVersion: '3.7.0', graceHours: 0.01 };
    expect(hooks({ DAMOCLES_E2E_SERVER_REQUIREMENT: JSON.stringify(requirement), DAMOCLES_E2E_SWITCH_DRAIN_MS: '4000' })).toEqual({ requirement, drainMs: 4000 });
    for (const text of ['', '{', 'null', '{"minimumServerVersion":"3.7.0"}', '{"minimumServerVersion":"3.7.0","graceHours":0}', '{"minimumServerVersion":"3.7.0","graceHours":169}', '{"minimumServerVersion":"3.7","graceHours":1}']) {
      expect(() => hooks({ DAMOCLES_E2E_SERVER_REQUIREMENT: text }), text).toThrow('DAMOCLES_E2E_SERVER_REQUIREMENT');
    }
    for (const text of ['0', '-5', '1.5', 'soon']) expect(() => hooks({ DAMOCLES_E2E_SWITCH_DRAIN_MS: text }), text).toThrow('DAMOCLES_E2E_SWITCH_DRAIN_MS');
    expect(remoteE2eEnvironment({ packaged: true, env: { DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_SERVER_REQUIREMENT: JSON.stringify(requirement), DAMOCLES_E2E_SWITCH_DRAIN_MS: '4000' } })).toEqual({});
    expect(remoteE2eEnvironment({ packaged: false, env: { DAMOCLES_E2E_SERVER_REQUIREMENT: JSON.stringify(requirement) } })).toEqual({});
  });

  it('apply the requirement to the manifest, with or without an e2e version, and refuse a minimum above the app version', () => {
    const pkg = { file: 'damocles-server-3.7.0-linux-x64.tar.gz', sha256: 'a'.repeat(64), size: 10, serverVersion: '3.7.0+0123456789ab' };
    const manifest: ServerManifest = { version: '3.7.0', protocolVersion: 1, published: false, packages: { 'linux-x64': pkg } };
    const requirement = { minimumServerVersion: '3.7.0', graceHours: 0.01 };
    expect(e2eManifest(manifest, undefined, requirement)).toEqual({ ...manifest, requirement });
    expect(e2eManifest(manifest, '3.8.0', requirement)).toEqual({ ...manifest, version: '3.8.0', packages: { 'linux-x64': { ...pkg, serverVersion: '3.8.0' } }, requirement });
    expect(() => e2eManifest(manifest, '3.6.9', requirement)).toThrow('above this app\'s 3.6.9');
  });

  it('install every package as the e2e server version, under its app version', () => {
    const pkg = { file: 'damocles-server-3.7.0-linux-x64.tar.gz', sha256: 'a'.repeat(64), size: 10, serverVersion: '3.7.0+0123456789ab' };
    const manifest: ServerManifest = { version: '3.7.0', protocolVersion: 1, published: false, packages: { 'linux-x64': pkg, 'win32-x64': { ...pkg, file: 'damocles-server-3.7.0-win32-x64.zip' } } };
    expect(e2eManifest(manifest, '3.6.9')).toEqual({ ...manifest, version: '3.6.9', packages: { 'linux-x64': { ...pkg, serverVersion: '3.6.9' }, 'win32-x64': { ...pkg, file: 'damocles-server-3.7.0-win32-x64.zip', serverVersion: '3.6.9' } } });
    expect(e2eManifest(manifest, '3.7.0+fedcba987654').packages['linux-x64']).toEqual({ ...pkg, serverVersion: '3.7.0+fedcba987654' });
    expect(e2eManifest(manifest, '3.7.0+fedcba987654').version).toBe('3.7.0');
  });
});
