import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StructuredTurn, RecallConfig } from '../types';

function makeTurn(overrides: Partial<StructuredTurn> = {}): StructuredTurn {
  return {
    promptIndex: 0,
    timestamp: '2025-01-01T00:00:00.000Z',
    userMessage: 'test message',
    assistantResponse: 'test response',
    toolCalls: [],
    contentBlocks: [],
    thinkingBlocks: [],
    filesTouched: [],
    nodeId: null,
    ...overrides,
  };
}

function makeHistory(count: number, charsPer = 100): StructuredTurn[] {
  return Array.from({ length: count }, (_, i) =>
    makeTurn({
      promptIndex: i,
      userMessage: `user message ${i} ${'x'.repeat(charsPer)}`,
      assistantResponse: `assistant response ${i} ${'y'.repeat(charsPer)}`,
    }),
  );
}

function makeDefaultConfig(): RecallConfig {
  return {
    enabled: true,
    subcallModel: 'claude-haiku-4-5-20251001',
    maxIterations: 15,
    maxInjectedChars: 200_000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// runRecallLoop short-circuit paths
//
// We cannot test the full REPL loop easily without mocking the SDK,
// but we CAN test the short-circuit paths by importing and calling
// the function. Since runRecallLoop depends on loadSdkQuery (dynamic
// import), the full loop paths require integration tests. Here we
// test the deterministic short-circuit behaviors.
// ─────────────────────────────────────────────────────────────────────────────

describe('runRecallLoop short-circuit paths', () => {
  let runRecallLoop: typeof import('../recall-loop').runRecallLoop;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({
      log: vi.fn(),
    }));
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => null,
    }));
    const module = await import('../recall-loop');
    runRecallLoop = module.runRecallLoop;
  });

  it('returns null context for empty history', async () => {
    const result = await runRecallLoop([], 'test prompt', 0, {
      config: makeDefaultConfig(),
      cwd: '/test',
      model: 'test-model',
      nodeContext: null,
    });

    expect(result.context).toBeNull();
    expect(result.trajectory.shortCircuited).toBe(true);
    expect(result.trajectory.turnCount).toBe(0);
  });

  it('returns direct context when history is under threshold', async () => {
    const smallHistory = [
      makeTurn({ userMessage: 'hello', assistantResponse: 'hi' }),
    ];

    const result = await runRecallLoop(smallHistory, 'specific query about authentication', 1, {
      config: makeDefaultConfig(),
      cwd: '/test',
      model: 'test-model',
      nodeContext: null,
    });

    expect(result.context).not.toBeNull();
    expect(result.trajectory.shortCircuited).toBe(true);
    expect(result.context).toContain('hello');
    expect(result.context).toContain('hi');
  });

  it('does NOT short-circuit short referential prompts with keywords', async () => {
    const largeHistory = makeHistory(20, 1000);

    const result = await runRecallLoop(
      largeHistory,
      'fix the auth bug',
      20,
      {
        config: makeDefaultConfig(),
        cwd: '/test',
        model: 'test-model',
        nodeContext: null,
      },
    );

    expect(result.context).not.toBeNull();
    expect(result.trajectory.shortCircuited).toBe(false);
  });

  it('includes correct trajectory metadata', async () => {
    const history = makeHistory(5, 10);

    const result = await runRecallLoop(history, 'test', 5, {
      config: makeDefaultConfig(),
      cwd: '/test',
      model: 'test-model',
      nodeContext: null,
    });

    expect(result.trajectory.promptIndex).toBe(5);
    expect(result.trajectory.userPrompt).toBe('test');
    expect(result.trajectory.turnCount).toBe(5);
    expect(result.trajectory.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('falls back to recent context when SDK is unavailable', async () => {
    const history = makeHistory(20, 1000);

    const result = await runRecallLoop(
      history,
      'specific query about authentication module in src/auth',
      20,
      {
        config: makeDefaultConfig(),
        cwd: '/test',
        model: 'test-model',
        nodeContext: null,
      },
    );

    expect(result.context).not.toBeNull();
    expect(result.trajectory.iterations).toHaveLength(0);
  });

  it('trajectory tracks historyChars correctly', async () => {
    const history = [
      makeTurn({ userMessage: 'a'.repeat(100), assistantResponse: 'b'.repeat(200) }),
    ];

    const result = await runRecallLoop(history, 'test', 1, {
      config: makeDefaultConfig(),
      cwd: '/test',
      model: 'test-model',
      nodeContext: null,
    });

    expect(result.trajectory.historyChars).toBe(300);
  });
});
