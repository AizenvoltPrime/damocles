import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createFakePlatform } from '../../../../../__mocks__/fake-platform';
import { createSettingsFileHandlers } from '../settings-file-handlers';
import type { Disposable } from '../../../../../platform/disposable';
import type { HandlerContext, HandlerDependencies } from '../../types';

vi.mock('../../../../logger', () => ({ log: vi.fn() }));

describe('settings file handlers', () => {
  it('release the panel watchers with the panel and with the router', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-file-handlers-'));
    try {
      const userFile = path.join(home, 'settings.json');
      const platform = createFakePlatform({ capabilities: { settingsSources: true }, settings: { scopeFiles: { user: userFile } } });
      const panelDisposables: Disposable[] = [];
      const subscriptions: Disposable[] = [];
      const posted: unknown[] = [];
      const handlers = createSettingsFileHandlers({
        platform,
        subscriptions,
        postMessage: (_host: unknown, message: unknown) => { posted.push(message); },
        getPanels: () => new Map([['p1', { disposables: panelDisposables }]]),
      } as unknown as HandlerDependencies);
      const ctx = { host: {}, panelId: 'p1' } as unknown as HandlerContext;

      await handlers.settingsFileLoad!({ type: 'settingsFileLoad', scope: 'user' }, ctx);
      await handlers.settingsFileLoad!({ type: 'settingsFileLoad', scope: 'user' }, ctx);

      expect(posted).toHaveLength(2);
      expect(panelDisposables).toHaveLength(1);
      expect(subscriptions).toHaveLength(1);
      const watcher = platform.fileWatchers.watchers[0];
      expect(platform.fileWatchers.watchers).toHaveLength(1);

      panelDisposables[0]!.dispose();

      expect(watcher?.disposed).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('hold a panel that asked only for availability until it closes', () => {
    const platform = createFakePlatform({ capabilities: { settingsSources: true }, trusted: false, settings: { scopeFiles: { user: path.join(os.tmpdir(), 'unused.json') } } });
    const panelDisposables: Disposable[] = [];
    const posted: unknown[] = [];
    const handlers = createSettingsFileHandlers({
      platform,
      subscriptions: [],
      postMessage: (_host: unknown, message: unknown) => { posted.push(message); },
      getPanels: () => new Map([['p1', { disposables: panelDisposables }]]),
    } as unknown as HandlerDependencies);
    const ctx = { host: {}, panelId: 'p1' } as unknown as HandlerContext;

    void handlers.getSettingsFileAvailability!({ type: 'getSettingsFileAvailability' }, ctx);
    void handlers.getSettingsFileAvailability!({ type: 'getSettingsFileAvailability' }, ctx);
    expect(panelDisposables).toHaveLength(1);

    panelDisposables[0]!.dispose();
    platform.trust.grantTrust();

    expect(posted).toHaveLength(2);
  });
});
