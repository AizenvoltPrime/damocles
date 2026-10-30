import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform, installFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { HostInstance } from '../../chat-panel/types';
import { republishAccountInfo } from '../../chat-panel/message-router/handlers/account-info';
import { PiRuntime } from '../pi-runtime';
import { PiSession } from '../pi-session';
import { installPlatform } from '../../platform-host';
import { piSupportedModels } from '../pi-models';

const dirs: string[] = [];
afterEach(async () => {
  await PiRuntime.disposeInstance();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('an account republish on a daemon\'s core', () => {
  it('posts each view the account state and the model list once', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-account-models-')));
    dirs.push(dir);
    const host = createFakeRemoteHost();
    installPlatform({ ...createFakePlatform(), remote: host.remote });
    PiRuntime.get(dir);
    const posted: Array<[string, ExtensionToWebviewMessage['type']]> = [];
    const views = [{ viewKey: 'view-a', clientId: 'client-a' }, { viewKey: 'view-b', clientId: 'client-b' }];
    const session = Object.create(PiSession.prototype) as PiSession;
    Object.assign(session, {
      _disposed: false,
      options: {
        platform: { ...createFakePlatform(), remote: host.remote },
        onViewMessages: (build: (clientId: string | undefined) => readonly ExtensionToWebviewMessage[]) => {
          for (const { viewKey, clientId } of views) for (const message of build(clientId)) posted.push([viewKey, message.type]);
        },
      },
      accountMessages: (): ExtensionToWebviewMessage[] => [{ type: 'accountInfo', data: { model: 'm', dollarBilled: true } } as ExtensionToWebviewMessage],
      modelsForView: () => [],
    });
    republishAccountInfo(() => new Map([['panel-1', { session } as unknown as HostInstance]]));
    expect(posted).toEqual([
      ['view-a', 'accountInfo'],
      ['view-b', 'accountInfo'],
      ['view-a', 'availableModels'],
      ['view-b', 'availableModels'],
    ]);
  });

  it('posts them to one device\'s views alone when only that device\'s user layer changed', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-account-models-')));
    dirs.push(dir);
    const host = createFakeRemoteHost();
    installPlatform({ ...createFakePlatform(), remote: host.remote });
    PiRuntime.get(dir);
    const posted: Array<[string, ExtensionToWebviewMessage['type']]> = [];
    const views = [{ viewKey: 'view-a', clientId: 'client-a' }, { viewKey: 'view-b', clientId: 'client-b' }];
    const session = Object.create(PiSession.prototype) as PiSession;
    Object.assign(session, {
      _disposed: false,
      options: {
        platform: { ...createFakePlatform(), remote: host.remote },
        onViewMessages: (build: (clientId: string | undefined) => readonly ExtensionToWebviewMessage[]) => {
          for (const { viewKey, clientId } of views) for (const message of build(clientId)) posted.push([viewKey, message.type]);
        },
      },
      accountMessages: (): ExtensionToWebviewMessage[] => [{ type: 'accountInfo', data: { model: 'm', dollarBilled: true } } as ExtensionToWebviewMessage],
      modelsForView: () => [],
    });
    republishAccountInfo(() => new Map([['panel-1', { session } as unknown as HostInstance]]), 'client-b');
    expect(posted).toEqual([
      ['view-b', 'accountInfo'],
      ['view-b', 'availableModels'],
    ]);
  });
});

describe('the first account state of a chat that has not started, on this computer', () => {
  it('bills by the saved OpenAI key the runtime has not synced yet, as the user prefers it over a ChatGPT sign-in', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-account-first-')));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 9_999_999_999_999 } }));
    const platform = installFakePlatform({ secrets: { 'damocles.openai.apiKey': 'sk-saved' } });
    PiRuntime.get(dir);
    const posted: ExtensionToWebviewMessage[] = [];
    const session = Object.create(PiSession.prototype) as PiSession;
    Object.assign(session, {
      _disposed: false,
      modelValue: 'gpt-6-astra',
      supportedModelsCache: piSupportedModels(),
      options: { platform, getPreferOpenAIApiKey: () => true },
      emit: (message: ExtensionToWebviewMessage) => void posted.push(message),
    });

    session.publishAccountInfo();

    await vi.waitFor(() => expect(posted.map((message) => message.type)).toEqual(['accountInfo', 'availableModels']));
    expect(posted[0]).toMatchObject({ type: 'accountInfo', data: { model: 'gpt-6-astra', dollarBilled: true } });
  });
});
