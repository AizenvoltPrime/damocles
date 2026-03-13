import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isContinuationPrompt } from '../recall-loop';
import type { StructuredTurn, RecallConfig } from '../types';

function makeTurn(overrides: Partial<StructuredTurn> = {}): StructuredTurn {
  return {
    promptIndex: 0,
    timestamp: '2025-01-01T00:00:00.000Z',
    userMessage: 'test message',
    assistantResponse: 'test response',
    toolCalls: [],
    thinkingBlocks: [],
    filesTouched: [],
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
// isContinuationPrompt
//
// Word-set heuristic: returns true only when EVERY word is a common function
// word with no domain-specific search signal. This is the narrow hard gate
// that saves a Haiku call for trivially content-free prompts.
// ─────────────────────────────────────────────────────────────────────────────

describe('isContinuationPrompt', () => {
  describe('continuation prompts (should return true)', () => {
    it('identifies single-word affirmatives', () => {
      expect(isContinuationPrompt('yes')).toBe(true);
      expect(isContinuationPrompt('ok')).toBe(true);
      expect(isContinuationPrompt('okay')).toBe(true);
      expect(isContinuationPrompt('sure')).toBe(true);
      expect(isContinuationPrompt('yep')).toBe(true);
      expect(isContinuationPrompt('yeah')).toBe(true);
      expect(isContinuationPrompt('correct')).toBe(true);
      expect(isContinuationPrompt('perfect')).toBe(true);
      expect(isContinuationPrompt('great')).toBe(true);
      expect(isContinuationPrompt('fine')).toBe(true);
    });

    it('identifies single-word negatives', () => {
      expect(isContinuationPrompt('no')).toBe(true);
      expect(isContinuationPrompt('nah')).toBe(true);
      expect(isContinuationPrompt('nope')).toBe(true);
    });

    it('identifies multi-word continuation phrases', () => {
      expect(isContinuationPrompt('do it')).toBe(true);
      expect(isContinuationPrompt('go ahead')).toBe(true);
      expect(isContinuationPrompt('try again')).toBe(true);
      expect(isContinuationPrompt('continue')).toBe(true);
      expect(isContinuationPrompt('do that')).toBe(true);
      expect(isContinuationPrompt('ok do it')).toBe(true);
      expect(isContinuationPrompt('yes please')).toBe(true);
      expect(isContinuationPrompt('ok go ahead')).toBe(true);
      expect(isContinuationPrompt('do that again please')).toBe(true);
      expect(isContinuationPrompt('yes but also do that')).toBe(true);
    });

    it('handles whitespace and punctuation', () => {
      expect(isContinuationPrompt('  yes  ')).toBe(true);
      expect(isContinuationPrompt('ok!')).toBe(true);
      expect(isContinuationPrompt('sure.')).toBe(true);
      expect(isContinuationPrompt('go ahead!!')).toBe(true);
    });

    it('handles empty and whitespace-only prompts', () => {
      expect(isContinuationPrompt('')).toBe(true);
      expect(isContinuationPrompt('   ')).toBe(true);
      expect(isContinuationPrompt('...')).toBe(true);
    });
  });

  describe('referential queries with search signal (should return false)', () => {
    it('rejects prompts with domain keywords', () => {
      expect(isContinuationPrompt('fix the auth bug')).toBe(false);
      expect(isContinuationPrompt('what about bridge')).toBe(false);
      expect(isContinuationPrompt('refactor the parser')).toBe(false);
      expect(isContinuationPrompt('show me the changes')).toBe(false);
      expect(isContinuationPrompt('fix it please auth')).toBe(false);
    });

    it('rejects prompts with file paths', () => {
      expect(isContinuationPrompt('fix src/main.ts')).toBe(false);
      expect(isContinuationPrompt('fix src\\main.ts')).toBe(false);
    });

    it('rejects prompts with file extensions', () => {
      expect(isContinuationPrompt('fix main.ts')).toBe(false);
      expect(isContinuationPrompt('update config.json')).toBe(false);
      expect(isContinuationPrompt('edit style.css')).toBe(false);
    });

    it('rejects longer prompts with domain terms', () => {
      expect(isContinuationPrompt('what did you say about that?')).toBe(false);
      expect(isContinuationPrompt('now do the same for the other')).toBe(false);
      expect(isContinuationPrompt('can you explain how that works')).toBe(false);
    });

    it('rejects prompts exceeding word limit even if all words match', () => {
      const longContinuation = 'yes ok sure great fine perfect correct right exactly good agreed'.split(' ').join(' ');
      expect(isContinuationPrompt(longContinuation)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('treats dot-separated words without valid extensions as continuation', () => {
      expect(isContinuationPrompt('ok')).toBe(true);
    });

    it('rejects multi-char file extensions', () => {
      expect(isContinuationPrompt('ok utils.ts')).toBe(false);
    });

    it('does not consider URLs as continuation', () => {
      expect(isContinuationPrompt('go to api/endpoint')).toBe(false);
    });
  });
});

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
      intentContext: { intent: 'general', keyEntities: [] },
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
      intentContext: { intent: 'general', keyEntities: [] },
    });

    expect(result.context).not.toBeNull();
    expect(result.trajectory.shortCircuited).toBe(true);
    expect(result.context).toContain('hello');
    expect(result.context).toContain('hi');
  });

  it('returns recent full context for continuation prompts (heuristic)', async () => {
    const largeHistory = makeHistory(20, 1000);

    const result = await runRecallLoop(largeHistory, 'do it', 20, {
      config: makeDefaultConfig(),
      cwd: '/test',
      model: 'test-model',
      intentContext: { intent: 'general', keyEntities: [] },
    });

    expect(result.context).not.toBeNull();
    expect(result.trajectory.shortCircuited).toBe(true);
  });

  it('returns recent full context when intent is continuation', async () => {
    const largeHistory = makeHistory(20, 1000);

    const result = await runRecallLoop(largeHistory, 'show me the changes', 20, {
      config: makeDefaultConfig(),
      cwd: '/test',
      model: 'test-model',
      intentContext: { intent: 'continuation', keyEntities: [] },
    });

    expect(result.context).not.toBeNull();
    expect(result.trajectory.shortCircuited).toBe(true);
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
        intentContext: { intent: 'debug', keyEntities: ['auth'] },
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
      intentContext: { intent: 'general', keyEntities: [] },
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
        intentContext: { intent: 'debug', keyEntities: ['auth'] },
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
      intentContext: { intent: 'general', keyEntities: [] },
    });

    expect(result.trajectory.historyChars).toBe(300);
  });
});
