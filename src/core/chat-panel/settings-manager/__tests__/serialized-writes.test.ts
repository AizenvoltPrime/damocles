import { describe, expect, it, vi } from 'vitest';
import { SettingsManager } from '..';
import { installFakePlatform } from '../../../../__mocks__/fake-platform';
import type { FolderTarget } from '../../../workspace-folders/folder-registry';

const home: FolderTarget = { key: '~', fsPath: '/home/me', name: 'me', label: 'me', projectScope: false };

// The desktop and VS Code stores change what get() reads only once a write has landed, a tick or more later.
function setup(user: Record<string, unknown>) {
  const platform = installFakePlatform({ settings: { user } });
  const update = platform.settings.update.bind(platform.settings);
  vi.spyOn(platform.settings, 'update').mockImplementation(async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await update(...args);
  });
  const settings = new SettingsManager({ postMessage: () => undefined, platform, folders: () => [] });
  return { platform, settings };
}

describe('setters that read a list or object setting and write it back', () => {
  it('land every one of several concurrent tool toggles', async () => {
    const { platform, settings } = setup({ 'damocles.tools.disabled': ['Glob'] });
    await Promise.all([settings.setToolDisabled('Read', true), settings.setToolDisabled('Grep', true), settings.setToolDisabled('Glob', false)]);
    expect(platform.settings.get('damocles.tools.disabled')).toEqual(['Read', 'Grep']);
  });

  it('land concurrent default efforts for two models', async () => {
    const { platform, settings } = setup({});
    await Promise.all([settings.handleSetDefaultEffort('high', 'claude-opus-5-5', home), settings.handleSetDefaultEffort('low', 'claude-sonnet-5-5', home)]);
    expect(platform.settings.get('damocles.effortByModel')).toEqual({ 'claude-opus-5-5': 'high', 'claude-sonnet-5-5': 'low' });
  });
});
