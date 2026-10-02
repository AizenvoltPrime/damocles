import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installLogSink } from '../../logger';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { OPENAI_API_KEY_SECRET } from '../openai-auth';
import {
  OPENAI_KEY_MOVED_NOTICE_SHOWN_STATE,
  migrateOpenAIApiKey,
  showOpenAIKeyMovedNotice,
  type AppHost,
} from '../openai-key-migration';

const NOTICE = "Your OpenAI API key moved to the other Damocles app's keychain. Enter it here once.";

const logLines: string[] = [];
beforeAll(() => {
  installLogSink({ appendLine: (line: string) => void logLines.push(line), show: () => {}, dispose: () => {} });
});

describe('OpenAI API key migration', () => {
  let root: string;
  let agentDir: string;
  let markerPath: string;

  beforeEach(() => {
    logLines.length = 0;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-oai-mig-'));
    agentDir = path.join(root, 'agent');
    fs.mkdirSync(agentDir);
    markerPath = path.join(root, 'home', '.damocles', 'openai-api-key-moved.json');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const authPath = () => path.join(agentDir, 'auth.json');
  const readAuth = (): Record<string, unknown> => JSON.parse(fs.readFileSync(authPath(), 'utf8'));
  const writeAuth = (auth: Record<string, unknown>) => fs.writeFileSync(authPath(), JSON.stringify(auth));

  /** pi's resolution of the stored credential and its unconditional logout, over the real file. */
  function fakeRuntime() {
    return {
      getAuth: vi.fn(async (provider: string) => {
        const cred = readAuth()[provider] as { type: string; key: string } | undefined;
        return cred?.type === 'api_key' ? { auth: { apiKey: cred.key }, source: 'stored credential' } : undefined;
      }),
      logout: vi.fn(async (provider: string) => {
        const auth = readAuth();
        delete auth[provider];
        writeAuth(auth);
      }),
    };
  }

  function migrate(platform: FakePlatform, modelRuntime = fakeRuntime(), host: AppHost = 'vscode') {
    return { modelRuntime, run: () => migrateOpenAIApiKey({ modelRuntime, secrets: platform.secrets, agentDir, markerPath, host }) };
  }

  it('copies the key, reads it back, deletes the auth.json copy and writes a secret-free marker', async () => {
    writeAuth({ openai: { type: 'api_key', key: 'sk-plain' }, anthropic: { type: 'api_key', key: 'sk-ant' } });
    const platform = createFakePlatform();
    const { modelRuntime, run } = migrate(platform);

    expect(await run()).toBe(true);

    expect(platform.secrets.entries.get(OPENAI_API_KEY_SECRET)).toBe('sk-plain');
    expect(modelRuntime.logout).toHaveBeenCalledExactlyOnceWith('openai');
    expect(readAuth()).toEqual({ anthropic: { type: 'api_key', key: 'sk-ant' } });
    const marker = fs.readFileSync(markerPath, 'utf8');
    expect(marker).not.toContain('sk-plain');
    expect(JSON.parse(marker)).toEqual({ movedAt: expect.any(Number), by: 'vscode' });
    expect(fs.readdirSync(path.dirname(markerPath))).toEqual(['openai-api-key-moved.json']);
  });

  it('keeps a different key already in the secret store, logs that the auth.json key is discarded, and deletes it', async () => {
    writeAuth({ openai: { type: 'api_key', key: 'sk-old' } });
    const platform = createFakePlatform({ secrets: { [OPENAI_API_KEY_SECRET]: 'sk-new' } });
    const { run } = migrate(platform);

    expect(await run()).toBe(true);

    expect(platform.secrets.entries.get(OPENAI_API_KEY_SECRET)).toBe('sk-new');
    expect(readAuth()).toEqual({});
    const logged = logLines.join('\n');
    expect(logged).toContain('holds a different API key, which wins; the auth.json key is discarded');
    expect(logged).not.toContain('sk-old');
    expect(logged).not.toContain('sk-new');
  });

  it('logs an auth.json key equal to the stored one as the same key', async () => {
    writeAuth({ openai: { type: 'api_key', key: 'sk-same' } });
    const platform = createFakePlatform({ secrets: { [OPENAI_API_KEY_SECRET]: 'sk-same' } });

    expect(await migrate(platform).run()).toBe(true);

    expect(logLines.join('\n')).toContain('already holds the same API key as auth.json');
    expect(logLines.join('\n')).not.toContain('discarded');
  });

  it('moves and deletes nothing into a store that is not persistent, and a later persistent start migrates', async () => {
    writeAuth({ openai: { type: 'api_key', key: 'sk-plain' } });
    const volatile = createFakePlatform({ secretsPersistent: false });
    const first = migrate(volatile);

    expect(await first.run()).toBe(false);

    expect(readAuth()).toEqual({ openai: { type: 'api_key', key: 'sk-plain' } });
    expect(volatile.secrets.entries.size).toBe(0);
    expect(first.modelRuntime.logout).not.toHaveBeenCalled();
    expect(fs.existsSync(markerPath)).toBe(false);

    const persistent = createFakePlatform();
    expect(await migrate(persistent).run()).toBe(true);

    expect(persistent.secrets.entries.get(OPENAI_API_KEY_SECRET)).toBe('sk-plain');
    expect(readAuth()).toEqual({});
  });

  it('deletes nothing when the key does not read back', async () => {
    writeAuth({ openai: { type: 'api_key', key: 'sk-plain' } });
    const platform = createFakePlatform();
    const secrets = { ...platform.secrets, get: vi.fn(async () => undefined) };
    const modelRuntime = fakeRuntime();

    await expect(migrateOpenAIApiKey({ modelRuntime, secrets, agentDir, markerPath, host: 'vscode' })).rejects.toThrow('did not read back');

    expect(modelRuntime.logout).not.toHaveBeenCalled();
    expect(readAuth()).toEqual({ openai: { type: 'api_key', key: 'sk-plain' } });
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('never copies an ambient OPENAI_API_KEY that pi falls through to for an empty stored key', async () => {
    writeAuth({ openai: { type: 'api_key', key: '' } });
    const platform = createFakePlatform();
    const modelRuntime = fakeRuntime();
    modelRuntime.getAuth.mockResolvedValueOnce({ auth: { apiKey: 'sk-from-env' }, source: 'OPENAI_API_KEY' });

    await expect(migrate(platform, modelRuntime).run()).rejects.toThrow('no stored key');

    expect(platform.secrets.entries.size).toBe(0);
    expect(modelRuntime.logout).not.toHaveBeenCalled();
  });

  it.each([
    ['a ChatGPT grant', { openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }],
    ['no openai credential', { 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }],
  ])('leaves %s alone', async (_label, auth) => {
    writeAuth(auth);
    const platform = createFakePlatform();
    const { modelRuntime, run } = migrate(platform);

    expect(await run()).toBe(false);

    expect(modelRuntime.logout).not.toHaveBeenCalled();
    expect(readAuth()).toEqual(auth);
    expect(platform.secrets.entries.size).toBe(0);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('is idempotent: a second start moves nothing and rewrites no marker', async () => {
    writeAuth({ openai: { type: 'api_key', key: 'sk-plain' } });
    const platform = createFakePlatform();
    const first = migrate(platform);
    await first.run();
    const marker = fs.readFileSync(markerPath, 'utf8');

    const second = migrate(platform);
    expect(await second.run()).toBe(false);

    expect(second.modelRuntime.logout).not.toHaveBeenCalled();
    expect(fs.readFileSync(markerPath, 'utf8')).toBe(marker);
    expect(platform.secrets.entries.get(OPENAI_API_KEY_SECRET)).toBe('sk-plain');
  });

  describe("the other app's one-time notice", () => {
    async function noticeIn(platform: FakePlatform, host: AppHost, openAuthPanel = vi.fn()) {
      await showOpenAIKeyMovedNotice({
        secrets: platform.secrets,
        state: platform.state.global,
        notifications: platform.notifications,
        agentDir,
        markerPath,
        host,
        openAuthPanel,
      });
      return { messages: platform.notifications.calls.map((c) => c.message), openAuthPanel };
    }

    async function movedBy(host: AppHost): Promise<void> {
      writeAuth({ openai: { type: 'api_key', key: 'sk-plain' } });
      await migrate(createFakePlatform(), fakeRuntime(), host).run();
    }

    it('shows once in the other app, opens the auth panel from its action, and never again', async () => {
      await movedBy('vscode');
      const desktop = createFakePlatform({ host: 'desktop' });
      desktop.notifications.answerWith((call) => call.actions[0]);

      const first = await noticeIn(desktop, 'desktop');
      expect(first.messages).toEqual([NOTICE]);
      expect(desktop.notifications.calls[0]!.actions).toEqual(['Open OpenAI Sign-in']);
      expect(first.openAuthPanel).toHaveBeenCalledTimes(1);
      expect(desktop.state.global.get(OPENAI_KEY_MOVED_NOTICE_SHOWN_STATE)).toBe(true);

      const second = await noticeIn(desktop, 'desktop');
      expect(second.messages).toEqual([NOTICE]);
      expect(second.openAuthPanel).not.toHaveBeenCalled();
    });

    it('stays silent in the app that moved the key', async () => {
      await movedBy('vscode');
      const vscode = createFakePlatform({ host: 'vscode' });
      expect((await noticeIn(vscode, 'vscode')).messages).toEqual([]);
    });

    it('stays silent once the key was entered in this app', async () => {
      await movedBy('desktop');
      const vscode = createFakePlatform({ host: 'vscode', secrets: { [OPENAI_API_KEY_SECRET]: 'sk-entered' } });
      expect((await noticeIn(vscode, 'vscode')).messages).toEqual([]);
    });

    it('stays silent while auth.json still holds a key, which this app migrates itself', async () => {
      await movedBy('desktop');
      writeAuth({ openai: { type: 'api_key', key: 'sk-plain' } });
      const vscode = createFakePlatform({ host: 'vscode' });
      expect((await noticeIn(vscode, 'vscode')).messages).toEqual([]);
    });

    it('stays silent in the other app when this one could not move the key into a non-persistent store', async () => {
      writeAuth({ openai: { type: 'api_key', key: 'sk-plain' } });
      await migrate(createFakePlatform({ secretsPersistent: false }), fakeRuntime(), 'desktop').run();
      const vscode = createFakePlatform({ host: 'vscode' });
      expect((await noticeIn(vscode, 'vscode')).messages).toEqual([]);
      expect(fs.existsSync(markerPath)).toBe(false);
    });

    it('stays silent with no marker', async () => {
      const vscode = createFakePlatform({ host: 'vscode' });
      expect((await noticeIn(vscode, 'vscode')).messages).toEqual([]);
    });
  });
});
