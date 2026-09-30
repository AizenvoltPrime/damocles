import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakePlatform, installFakePlatform } from '../../__mocks__/fake-platform';
import { CREDENTIAL_STORAGE_HELP_URL, withVolatileSecretsNotice } from '../volatile-secrets-notice';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('withVolatileSecretsNotice', () => {
  it('tells the user once per run, on the first secret saved, that it lasts only until a restart', async () => {
    const platform = installFakePlatform({ secretsPersistent: false });
    const secrets = withVolatileSecretsNotice(platform.secrets, platform.notifications, platform.shell);
    expect(secrets.isPersistent).toBe(false);
    expect(platform.notifications.calls).toEqual([]);

    await secrets.store('explore.key', 'sk-1');
    await secrets.store('mcp.token', 'tok');
    await flush();

    expect(await secrets.get('explore.key')).toBe('sk-1');
    expect(platform.notifications.calls).toHaveLength(1);
    expect(platform.notifications.calls[0]).toMatchObject({ level: 'warn', message: expect.stringContaining('until Damocles restarts') });
    expect(platform.shell.openedExternal).toEqual([]);
  });

  it('opens the credential storage instructions when the user asks how', async () => {
    const platform = installFakePlatform({ secretsPersistent: false });
    platform.notifications.answerWith((call) => call.actions[0]);
    await withVolatileSecretsNotice(platform.secrets, platform.notifications, platform.shell).store('k', 'v');
    await flush();
    expect(platform.shell.openedExternal).toEqual([CREDENTIAL_STORAGE_HELP_URL]);
  });

  it('leaves a persistent store as it is and says nothing', async () => {
    const platform = createFakePlatform();
    const secrets = withVolatileSecretsNotice(platform.secrets, platform.notifications, platform.shell);
    expect(secrets).toBe(platform.secrets);
    await secrets.store('k', 'v');
    expect(platform.notifications.calls).toEqual([]);
  });

  it('points at a README heading that exists', () => {
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    const anchor = CREDENTIAL_STORAGE_HELP_URL.slice(CREDENTIAL_STORAGE_HELP_URL.indexOf('#') + 1);
    const headings = readme.split(/\r?\n/).filter((line) => /^#{2,4} /.test(line))
      .map((line) => line.replace(/^#+ /, '').trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-'));
    expect(headings).toContain(anchor);
  });
});
