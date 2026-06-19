import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Capture the options PiSession is constructed with, so we can drive its onSessionIdChange callback. */
let capturedOptions: { onSessionIdChange?: (id: string | null) => void } | null = null;

vi.mock('../../pi-session/pi-session', () => ({
  PiSession: class {
    constructor(options: { onSessionIdChange?: (id: string | null) => void }) {
      capturedOptions = options;
    }
  },
}));
vi.mock('../../pi-session/harness', () => ({ getEffectiveHarness: () => 'pi' }));
vi.mock('../../session', () => ({ ensureSessionDir: async () => undefined }));
vi.mock('../../logger', () => ({ log: vi.fn() }));

import { SessionManager, type SessionManagerConfig } from '../session-manager';

const ensureInitialized = vi.fn(async () => undefined);
const migrateSessionId = vi.fn();
const consolidateSession = vi.fn(async () => undefined);
const memoryService = { isEnabled: true, ensureInitialized, migrateSessionId, consolidateSession };

const setupWatcher = vi.fn(async () => undefined);
const addOrUpdate = vi.fn(async () => undefined);
const postMessage = vi.fn();

function makeManager(): SessionManager {
  const config = {
    workspacePath: '/repo',
    getMcpConfigLoaded: () => true,
    getEnabledMcpServers: () => ({}),
    getActiveModelForPanel: () => 'claude-opus-4-8',
    getPreferOpenAIApiKey: () => false,
    resolveThinkingForPanel: () => ({ thinkingDisabled: false, effort: null, maxThinkingTokens: null }),
    postMessage,
    setupSessionWatcher: setupWatcher,
    addOrUpdateSession: addOrUpdate,
    getMemoryService: () => memoryService,
    getCompassService: () => null,
    getBrowserService: () => null,
    getRawBrowserService: () => ({}),
    secrets: {} as never,
  } as unknown as SessionManagerConfig;
  return new SessionManager(config);
}

describe('SessionManager pi consolidation-on-switch (US-006b)', () => {
  beforeEach(() => {
    capturedOptions = null;
    ensureInitialized.mockClear();
    migrateSessionId.mockClear();
    consolidateSession.mockClear();
    setupWatcher.mockClear();
    addOrUpdate.mockClear();
    postMessage.mockClear();
  });

  it('migrates + consolidates memory when the pi session id changes', async () => {
    const manager = makeManager();
    await manager.createSessionForPanel({} as never, { getPermissionMode: () => 'default' } as never, 'panel-1');

    expect(capturedOptions?.onSessionIdChange).toBeTypeOf('function');
    capturedOptions!.onSessionIdChange!('pi-session-42');
    await Promise.resolve();
    await Promise.resolve();

    expect(postMessage).toHaveBeenCalledWith(expect.anything(), { type: 'sessionStarted', sessionId: 'pi-session-42' });
    expect(migrateSessionId).toHaveBeenCalledWith('panel-1', 'pi-session-42');
    expect(consolidateSession).toHaveBeenCalledWith('pi-session-42');
  });

  it('does not consolidate when the session id is null', async () => {
    const manager = makeManager();
    await manager.createSessionForPanel({} as never, { getPermissionMode: () => 'default' } as never, 'panel-1');

    capturedOptions!.onSessionIdChange!(null);
    await Promise.resolve();

    expect(consolidateSession).not.toHaveBeenCalled();
  });
});
