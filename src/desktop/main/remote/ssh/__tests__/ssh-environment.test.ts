import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuredAliases, sshConfigSourceFor, sshEnvironment } from '../ssh-environment';

describe('the e2e hooks', () => {
  it('honors DAMOCLES_E2E_SSH_CONFIG and DAMOCLES_E2E_RELEASE_URL only in a development build with DAMOCLES_E2E_HOOKS=1', () => {
    const file = path.join(tmpdir(), 'e2e_ssh_config');
    const env = { DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_SSH_CONFIG: file, DAMOCLES_E2E_RELEASE_URL: 'http://host.docker.internal:8080/' };
    expect(sshEnvironment({ packaged: false, env })).toEqual({ configFile: file, releasesUrl: 'http://host.docker.internal:8080' });
    expect(sshEnvironment({ packaged: true, env })).toEqual({});
    expect(sshEnvironment({ packaged: false, env: { ...env, DAMOCLES_E2E_HOOKS: undefined } })).toEqual({});
    expect(() => sshEnvironment({ packaged: false, env: { ...env, DAMOCLES_E2E_SSH_CONFIG: 'relative' } })).toThrow();
  });

  it('reads the hook file alone, as ssh -F does', () => {
    const account = { homedir: '/home/dev', username: 'dev', uid: 1000 };
    expect(sshConfigSourceFor({ configFile: '/e2e/config' }, account, 'linux', {})).toEqual({ userConfig: '/e2e/config', account, platform: 'linux', env: {} });
    expect(sshConfigSourceFor({}, account, 'linux', {}).systemConfig).toBe('/etc/ssh/ssh_config');
  });
});

describe('configuredAliases', () => {
  it('lists the config\'s hosts, and none with a log line for an account without a passwd entry instead of throwing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssh-aliases-'));
    try {
      const configFile = path.join(dir, 'config');
      writeFileSync(configFile, 'Host prod-1\n  HostName prod.lan\n');
      const account = { homedir: dir, username: 'dev', uid: 1000 };
      const logs: string[] = [];
      await expect(configuredAliases({ configFile }, process.platform, {}, (line) => logs.push(line), () => account)).resolves.toEqual(['prod-1']);
      const noPasswd = (): never => { throw new Error('ENOENT: no such file or directory, uv_os_get_passwd'); };
      await expect(configuredAliases({ configFile }, process.platform, {}, (line) => logs.push(line), noPasswd)).resolves.toEqual([]);
      expect(logs).toEqual(['[ssh-config] this account has no passwd entry, so ssh reads no ~/.ssh: ENOENT: no such file or directory, uv_os_get_passwd']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
