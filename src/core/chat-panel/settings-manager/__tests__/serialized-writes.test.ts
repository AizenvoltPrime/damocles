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

  it('land two concurrent model picker switches, kept beside the values already set', async () => {
    const { platform, settings } = setup({ 'damocles.modelPicker.providers': { xai: true } });
    await Promise.all([settings.handleSetModelPickerProvider('deepseek', true), settings.handleSetModelPickerProvider('anthropic', false)]);
    expect(platform.settings.inspect('damocles.modelPicker.providers').userValue).toEqual({ xai: true, deepseek: true, anthropic: false });
  });

  // A hand-edited array or string is not a vendor map; spreading one would write its indexes or characters as vendors.
  it.each([[['xai']], ['xai'], [null]])('replace a stored model picker value that is not an object (%j) with the one switch', async (stored) => {
    const { platform, settings } = setup({ 'damocles.modelPicker.providers': stored });
    await settings.handleSetModelPickerProvider('deepseek', true);
    expect(platform.settings.inspect('damocles.modelPicker.providers').userValue).toEqual({ deepseek: true });
  });

  it('refuse a model picker switch for a provider without chat models or with a value that is not a switch', async () => {
    const { platform, settings } = setup({});
    await expect(settings.handleSetModelPickerProvider('openrouter', true)).rejects.toThrow('is not a model provider');
    await expect(settings.handleSetModelPickerProvider('deepseek', 'yes' as unknown as boolean)).rejects.toThrow('must be true or false');
    expect(platform.settings.inspect('damocles.modelPicker.providers').userValue).toBeUndefined();
  });
});
