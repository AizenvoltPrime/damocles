import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __config, __configEmitter } from 'vscode';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { VsCodeSettingsStore } from '../settings-store';
import { createVsCodeWalkSettings } from '../walk-settings';

beforeEach(() => {
  __config.reset();
});

afterEach(() => {
  __configEmitter.clear();
});

describe('createVsCodeWalkSettings', () => {
  it('reads VS Code\'s own search settings, each on unless set to false', async () => {
    const walkSettings = createVsCodeWalkSettings(new VsCodeSettingsStore());
    expect(walkSettings.read()).toEqual({ ignore: { files: true, global: true, parents: true }, followLinks: true });
    const settings = new VsCodeSettingsStore();
    await settings.update('search.followSymlinks', false, 'user');
    await settings.update('search.useGlobalIgnoreFiles', false, 'user');
    expect(walkSettings.read()).toEqual({ ignore: { files: true, global: false, parents: true }, followLinks: false });
    await settings.update('search.useIgnoreFiles', false, 'user');
    await settings.update('search.useParentIgnoreFiles', false, 'user');
    expect(walkSettings.read().ignore).toEqual({ files: false, global: false, parents: false });
  });

  it('fires once for each change of one of its four settings, and for no other search setting', () => {
    const walkSettings = createVsCodeWalkSettings(new VsCodeSettingsStore());
    let fired = 0;
    const subscription = walkSettings.onDidChange(() => fired++);
    for (const key of ['search.useIgnoreFiles', 'search.useGlobalIgnoreFiles', 'search.useParentIgnoreFiles', 'search.followSymlinks']) __configEmitter.fire(key);
    __configEmitter.fire('search.exclude');
    __configEmitter.fire('damocles.maxIndexedFiles');
    expect(fired).toBe(4);
    subscription.dispose();
    __configEmitter.fire('search.followSymlinks');
    expect(fired).toBe(4);
  });

  it('is what the fake platform answers, over its own settings store', async () => {
    const fake = createFakePlatform({ settings: { user: { 'search.followSymlinks': false } } });
    let fired = 0;
    fake.walkSettings.onDidChange(() => fired++);
    expect(fake.walkSettings.read()).toEqual({ ignore: { files: true, global: true, parents: true }, followLinks: false });
    await fake.settings.update('search.useIgnoreFiles', false, 'user');
    expect(fake.walkSettings.read().ignore.files).toBe(false);
    expect(fired).toBe(1);
  });
});
