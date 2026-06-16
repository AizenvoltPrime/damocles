import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the pi loader + agent-dir so init()'s caching/lifecycle logic can be exercised on any Node
// version (the real value-import path needs Node >=22). The fake pi exposes only what _doInit uses.
const H = vi.hoisted(() => {
  const createServicesSpy = vi.fn();
  const fakePi = {
    createAgentSessionServices: createServicesSpy,
    DefaultPackageManager: class {
      getInstalledPath(): string | undefined {
        return undefined;
      }
    },
  };
  return { createServicesSpy, fakePi, ctrl: { loadable: true } };
});

vi.mock('../pi-loader', () => ({
  initPiLoader: vi.fn(async () => (H.ctrl.loadable ? H.fakePi : null)),
  getPiCodingAgent: vi.fn(() => (H.ctrl.loadable ? H.fakePi : null)),
  PI_MIN_NODE_MAJOR: 22,
  nodeSupportsPi: () => true,
}));

vi.mock('../agent-dir', () => ({
  ensurePiAgentDir: (dir: string) => dir,
  PI_AGENT_DIR: '/fake/agent',
}));

import { PiRuntime } from '../pi-runtime';

function fakeServices() {
  return {
    cwd: '/cwd',
    agentDir: '/agent',
    authStorage: { set: vi.fn() },
    settingsManager: {},
    modelRegistry: { getAvailable: () => [], refresh: vi.fn() },
    resourceLoader: {},
    diagnostics: [],
  };
}

describe('PiRuntime.init lifecycle', () => {
  beforeEach(() => {
    H.ctrl.loadable = true;
    H.createServicesSpy.mockReset();
    H.createServicesSpy.mockResolvedValue(fakeServices());
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('creates services exactly once across concurrent and repeat init() calls', async () => {
    const runtime = PiRuntime.get('/cwd', '/agent');
    await Promise.all([runtime.init(), runtime.init()]);
    await runtime.init();
    expect(H.createServicesSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the cached promise on failure so a later init() retries', async () => {
    H.ctrl.loadable = false;
    const runtime = PiRuntime.get('/cwd', '/agent');
    await expect(runtime.init()).rejects.toThrow(/failed to load/);

    H.ctrl.loadable = true;
    await expect(runtime.init()).resolves.toBeUndefined();
    expect(H.createServicesSpy).toHaveBeenCalledTimes(1);
    expect(runtime.services).not.toBeNull();
  });

  it('rejects init() after dispose (no resurrection of a disposed runtime)', async () => {
    const runtime = PiRuntime.get('/cwd', '/agent');
    await runtime.init();
    await runtime.dispose();
    expect(runtime.services).toBeNull();
    await expect(runtime.init()).rejects.toThrow(/disposed/);
  });
});
