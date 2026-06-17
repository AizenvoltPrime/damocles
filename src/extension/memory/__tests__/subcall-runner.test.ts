import { describe, it, expect, vi, beforeEach } from 'vitest';

type StructuredEvent = { type: string; subtype?: string; structured_output?: unknown };

function sdkYielding(events: StructuredEvent[]): () => unknown {
  return () => (async function* () {
    for (const event of events) yield event;
  })();
}

interface ConfigValues {
  subcallEngine?: 'small-fast' | 'explore';
}

function mockVscodeConfig(values: ConfigValues): void {
  vi.doMock('vscode', () => ({
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) =>
          key in values ? (values as Record<string, unknown>)[key] : fallback,
      }),
      isTrusted: true,
    },
  }));
}

const requireAuthFor = vi.fn();
const buildSubCallEnv = vi.fn();
const proxyStart = vi.fn();
const proxyStop = vi.fn();
let proxyConstructed = 0;

const piRunStructured = vi.fn();
const piHasModel = vi.fn();

/** Mock the supporting modules. `harness` selects which `runSmallFast` branch is exercised (US-006b). */
function mockSupportingModules(harness: 'sdk' | 'pi' = 'sdk'): void {
  vi.doMock('../../logger', () => ({ log: vi.fn() }));
  vi.doMock('../../auth/sdk-env', () => ({
    buildSdkEnv: () => ({}),
    requireAuthFor,
    getSmallFastModel: () => 'claude-haiku-4-5-20251001',
    SMALL_FAST_ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
  }));
  vi.doMock('../../auth/sub-call-env', () => ({
    buildSubCallEnv,
    getSmallFastModelForBackend: () => 'claude-haiku-4-5-20251001',
    inferSubCallBackendForCtx: () => 'anthropic',
  }));
  vi.doMock('../../explore/proxy-server', () => ({
    ExploreProxy: class {
      url = 'http://127.0.0.1:1234';
      constructor() {
        proxyConstructed++;
      }
      start = proxyStart;
      stop = proxyStop;
    },
  }));
  vi.doMock('../../explore', () => ({}));
  vi.doMock('../../pi-session/harness', () => ({ getEffectiveHarness: () => harness }));
  vi.doMock('../../pi-session/pi-runtime', () => ({
    PiRuntime: { get: () => ({ hasAuthedSubCallModel: piHasModel, runStructuredCompletion: piRunStructured }) },
  }));
}

const deps = {
  getBridgeCtx: () => null,
  getExploreConfig: vi.fn(),
  getCwd: () => '/test',
};

describe('createMemorySubCallRunner', () => {
  beforeEach(() => {
    vi.resetModules();
    requireAuthFor.mockReset();
    buildSubCallEnv.mockReset();
    proxyStart.mockReset();
    proxyStop.mockReset();
    proxyConstructed = 0;
    deps.getExploreConfig.mockReset();
    piRunStructured.mockReset();
    piHasModel.mockReset();

    requireAuthFor.mockResolvedValue({ ok: true, modelValue: 'claude-haiku-4-5-20251001', missingBackend: 'anthropic', message: '' });
    buildSubCallEnv.mockResolvedValue({ env: {}, resolvedModel: 'claude-haiku-4-5-20251001' });
    proxyStart.mockResolvedValue(undefined);
  });

  it('small-fast engine: returns structured output value', async () => {
    mockSupportingModules();
    mockVscodeConfig({ subcallEngine: 'small-fast' });
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => sdkYielding([{ type: 'result', subtype: 'success', structured_output: { rank: [1, 2, 3] } }]),
    }));

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(deps);
    const result = await runner.run<{ rank: number[] }>({
      prompt: 'p',
      systemPrompt: 's',
      schema: { type: 'object' },
      purpose: 'rerank',
    });

    expect(result).toEqual({ value: { rank: [1, 2, 3] } });
  });

  it('small-fast: requireAuthFor not ok → no-model', async () => {
    mockSupportingModules();
    mockVscodeConfig({ subcallEngine: 'small-fast' });
    requireAuthFor.mockResolvedValue({ ok: false, modelValue: 'm', missingBackend: 'anthropic', message: 'no creds' });
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => sdkYielding([{ type: 'result', subtype: 'success', structured_output: {} }]),
    }));

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(deps);
    const result = await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'rerank' });

    expect(result).toEqual({ value: null, failure: 'no-model' });
  });

  it('explore engine + null/empty config → no-model', async () => {
    mockSupportingModules();
    mockVscodeConfig({ subcallEngine: 'explore' });
    deps.getExploreConfig.mockReturnValue(null);
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => sdkYielding([{ type: 'result', subtype: 'success', structured_output: {} }]),
    }));

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(deps);
    const result = await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'rerank' });

    expect(result).toEqual({ value: null, failure: 'no-model' });
    expect(proxyConstructed).toBe(0);
  });

  it('explore engine: extract (raw conversation) also runs on the third-party provider', async () => {
    mockSupportingModules();
    mockVscodeConfig({ subcallEngine: 'explore' });
    deps.getExploreConfig.mockReturnValue({ provider: 'openrouter', model: 'm', baseUrl: 'https://x', apiKey: 'k' });
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => sdkYielding([{ type: 'result', subtype: 'success', structured_output: { ok: true } }]),
    }));

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(deps);
    const result = await runner.run<{ ok: boolean }>({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'extract' });

    expect(result).toEqual({ value: { ok: true } });
    expect(proxyConstructed).toBe(1);
    expect(proxyStart).toHaveBeenCalledOnce();
    expect(deps.getExploreConfig).toHaveBeenCalled();
  });

  it('SDK error_max_structured_output_retries → transient', async () => {
    mockSupportingModules();
    mockVscodeConfig({ subcallEngine: 'small-fast' });
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => sdkYielding([{ type: 'result', subtype: 'error_max_structured_output_retries' }]),
    }));

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(deps);
    const result = await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'rerank' });

    expect(result).toEqual({ value: null, failure: 'transient' });
  });

  it('explore engine + rerank: starts proxy, runs, stops in finally', async () => {
    mockSupportingModules();
    mockVscodeConfig({ subcallEngine: 'explore' });
    deps.getExploreConfig.mockReturnValue({ provider: 'openrouter', model: 'm', baseUrl: 'https://x', apiKey: 'k' });
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => sdkYielding([{ type: 'result', subtype: 'success', structured_output: { ranked: [3, 1] } }]),
    }));

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(deps);
    const result = await runner.run<{ ranked: number[] }>({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'rerank' });

    expect(result).toEqual({ value: { ranked: [3, 1] } });
    expect(proxyConstructed).toBe(1);
    expect(proxyStart).toHaveBeenCalledOnce();
    expect(proxyStop).toHaveBeenCalledOnce();
  });

  it('pi harness small-fast: routes through PiRuntime.runStructuredCompletion and returns the value', async () => {
    mockSupportingModules('pi');
    mockVscodeConfig({ subcallEngine: 'small-fast' });
    piHasModel.mockReturnValue(true);
    piRunStructured.mockResolvedValue({ rank: [9, 8] });
    vi.doMock('../../shared/sdk-loader', () => ({ loadSdkQuery: () => { throw new Error('SDK must not be used on the pi path'); } }));

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(deps);
    const result = await runner.run<{ rank: number[] }>({ prompt: 'p', systemPrompt: 's', schema: { type: 'object' }, purpose: 'rerank' });

    expect(result).toEqual({ value: { rank: [9, 8] } });
    expect(piRunStructured).toHaveBeenCalledOnce();
  });

  it('pi harness small-fast: no authed provider → no-model (without touching the SDK)', async () => {
    mockSupportingModules('pi');
    mockVscodeConfig({ subcallEngine: 'small-fast' });
    piHasModel.mockReturnValue(false);
    vi.doMock('../../shared/sdk-loader', () => ({ loadSdkQuery: () => { throw new Error('SDK must not be used on the pi path'); } }));

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(deps);
    const result = await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'rerank' });

    expect(result).toEqual({ value: null, failure: 'no-model' });
    expect(piRunStructured).not.toHaveBeenCalled();
  });

  it('pi harness small-fast: null completion → transient', async () => {
    mockSupportingModules('pi');
    mockVscodeConfig({ subcallEngine: 'small-fast' });
    piHasModel.mockReturnValue(true);
    piRunStructured.mockResolvedValue(null);
    vi.doMock('../../shared/sdk-loader', () => ({ loadSdkQuery: () => { throw new Error('SDK must not be used on the pi path'); } }));

    const { createMemorySubCallRunner } = await import('../subcall-runner');
    const runner = createMemorySubCallRunner(deps);
    const result = await runner.run({ prompt: 'p', systemPrompt: 's', schema: {}, purpose: 'extract' });

    expect(result).toEqual({ value: null, failure: 'transient' });
  });
});
