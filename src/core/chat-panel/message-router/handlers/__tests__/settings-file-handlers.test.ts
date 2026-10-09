import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { createFakePlatform } from '../../../../../__mocks__/fake-platform';
import { createSettingsFileHandlers } from '../settings-file-handlers';
import type { Disposable } from '../../../../../platform/disposable';
import type { HandlerContext, HandlerDependencies } from '../../types';
import type { SettingsFileScope } from '../../../../../shared/types/messages';

vi.mock('../../../../logger', () => ({ log: vi.fn() }));

function handlersFor(settingsSources: boolean) {
  const platform = createFakePlatform({ capabilities: { settingsSources }, settings: { scopeFiles: { user: path.join(os.tmpdir(), 'unused.json') } } });
  const { handlers } = createSettingsFileHandlers({ platform, subscriptions: [], postMessage: () => undefined, getPanels: () => new Map() } as unknown as HandlerDependencies);
  return { platform, open: handlers.openSettingsFileInChat! };
}

describe('settings file handlers', () => {
  const ctx = { host: {}, panelId: 'p1' } as unknown as HandlerContext;

  it('open Edit settings.json in the host editor, at a setting key when the modal names one', async () => {
    const { platform, open } = handlersFor(true);
    await open({ type: 'openSettingsFileInChat', scope: 'user' }, ctx);
    await open({ type: 'openSettingsFileInChat', scope: 'project', key: 'damocles.desktop.files.exclude' }, ctx);
    expect(platform.editor.settingsFiles).toEqual([{ scope: 'user' }, { scope: 'project', key: 'damocles.desktop.files.exclude' }]);
  });

  it('refuse an unknown scope, a key that is not a setting key and a host without settings files', async () => {
    const { platform, open } = handlersFor(true);
    await expect(open({ type: 'openSettingsFileInChat', scope: '../x' as SettingsFileScope }, ctx)).rejects.toThrow('unknown settings file scope');
    await expect(open({ type: 'openSettingsFileInChat', scope: 'user', key: '../../etc/passwd' }, ctx)).rejects.toThrow('malformed setting key');
    expect(platform.editor.settingsFiles).toEqual([]);
    await expect(handlersFor(false).open({ type: 'openSettingsFileInChat', scope: 'user' }, ctx)).rejects.toThrow('this host keeps no Damocles settings files');
  });

  it('hold a panel that asked for availability until it closes', () => {
    const platform = createFakePlatform({ capabilities: { settingsSources: true }, trusted: false, settings: { scopeFiles: { user: path.join(os.tmpdir(), 'unused.json') } } });
    const panelDisposables: Disposable[] = [];
    const posted: unknown[] = [];
    const { postAvailability } = createSettingsFileHandlers({
      platform,
      subscriptions: [],
      postMessage: (_host: unknown, message: unknown) => { posted.push(message); },
      getPanels: () => new Map([['p1', { disposables: panelDisposables }]]),
    } as unknown as HandlerDependencies);

    postAvailability(ctx);
    postAvailability(ctx);
    expect(panelDisposables).toHaveLength(1);

    panelDisposables[0]!.dispose();
    platform.trust.grantTrust();

    expect(posted).toHaveLength(2);
  });
});
