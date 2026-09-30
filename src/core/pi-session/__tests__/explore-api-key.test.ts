import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { platform as hostPlatform } from '../../platform-host';
import { setExploreApiKey } from '../explore-api-key';
import { EXPLORE_SECRET_KEYS } from '../explore-providers';

afterEach(() => vi.restoreAllMocks());

describe('setExploreApiKey', () => {
  it('treats a provider named after an Object.prototype member as unknown and falls back to OpenRouter', async () => {
    const platform = createFakePlatform({ settings: { user: { 'damocles.explore.provider': 'constructor' } } });
    platform.dialogs.answerInputBox(() => 'sk-or-key');
    await setExploreApiKey(platform);
    expect(platform.dialogs.inputBoxCalls[0]?.options).toMatchObject({ prompt: 'Enter your OpenRouter API key for Explore agents', placeholder: 'sk-or-...' });
    expect([...platform.secrets.entries]).toEqual([[EXPLORE_SECRET_KEYS.openrouter, 'sk-or-key']]);
  });

  it('localizes the prompt and the saved and removed notices', async () => {
    vi.spyOn(hostPlatform().localization, 't').mockImplementation((message: string, ...args) => `[el] ${message.replace('{0}', String(args[0]))}`);
    const platform = createFakePlatform({ settings: { user: { 'damocles.explore.provider': 'gemini' } } });
    platform.dialogs.answerInputBox(() => 'AIza-key');
    await setExploreApiKey(platform);
    platform.dialogs.answerInputBox(() => '');
    await setExploreApiKey(platform);

    expect(platform.dialogs.inputBoxCalls[0]?.options.prompt).toBe('[el] Enter your Google Gemini API key');
    expect(platform.notifications.calls.map((c) => c.message)).toEqual(['[el] Damocles: Gemini API key saved', '[el] Damocles: Gemini API key removed']);
    expect(platform.secrets.entries.size).toBe(0);
  });
});
