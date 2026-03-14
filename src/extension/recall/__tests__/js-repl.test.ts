import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsRepl, type LlmQueryFn, type LlmQueryBatchedFn } from '../js-repl';
import type { StructuredTurn } from '../types';

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

function makeHistory(count: number): StructuredTurn[] {
  return Array.from({ length: count }, (_, i) =>
    makeTurn({
      promptIndex: i,
      userMessage: `user message ${i}`,
      assistantResponse: `assistant response ${i}`,
    }),
  );
}

const noopLlmQuery: LlmQueryFn = async () => 'mock response';
const noopLlmQueryBatched: LlmQueryBatchedFn = async (prompts) => prompts.map(() => 'mock response');

describe('JsRepl', () => {
  let repl: JsRepl;
  let history: StructuredTurn[];

  beforeEach(() => {
    history = makeHistory(5);
    repl = new JsRepl(history, noopLlmQuery, noopLlmQueryBatched);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Basic execution
  // ─────────────────────────────────────────────────────────────────────────

  describe('basic execution', () => {
    it('executes simple code', async () => {
      const result = await repl.execute('console.log("hello")');
      expect(result.stdout).toBe('hello');
      expect(result.error).toBeNull();
    });

    it('returns expression value from explicit return', async () => {
      const result = await repl.execute('return 42');
      expect(result.error).toBeNull();
    });

    it('captures multiple console.log calls', async () => {
      const result = await repl.execute('console.log("a"); console.log("b"); console.log("c")');
      expect(result.stdout).toBe('a\nb\nc');
    });

    it('captures errors without crashing', async () => {
      const result = await repl.execute('throw new Error("test error")');
      expect(result.error).toContain('test error');
    });

    it('returns error for syntax errors', async () => {
      const result = await repl.execute('const x = {');
      expect(result.error).not.toBeNull();
    });

    it('handles undefined/null results gracefully', async () => {
      const result = await repl.execute('undefined');
      expect(result.error).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Context access
  // ─────────────────────────────────────────────────────────────────────────

  describe('context access', () => {
    it('provides context array with correct length', async () => {
      const result = await repl.execute('console.log(context.length)');
      expect(result.stdout).toBe('5');
    });

    it('provides structured turn data in context', async () => {
      const result = await repl.execute('console.log(context[0].userMessage)');
      expect(result.stdout).toBe('user message 0');
    });

    it('provides assistant responses', async () => {
      const result = await repl.execute('console.log(context[2].assistantResponse)');
      expect(result.stdout).toBe('assistant response 2');
    });

    it('provides promptIndex', async () => {
      const result = await repl.execute('console.log(context[3].promptIndex)');
      expect(result.stdout).toBe('3');
    });

    it('provides filesTouched', async () => {
      const historyWithFiles = [makeTurn({ filesTouched: ['/src/a.ts', '/src/b.ts'] })];
      const r = new JsRepl(historyWithFiles, noopLlmQuery, noopLlmQueryBatched);
      const result = await r.execute('console.log(context[0].filesTouched.join(", "))');
      expect(result.stdout).toBe('/src/a.ts, /src/b.ts');
      r.dispose();
    });

    it('provides toolCalls', async () => {
      const historyWithTools = [
        makeTurn({
          toolCalls: [{ name: 'Read', input: { file_path: '/x.ts' }, result: 'content' }],
        }),
      ];
      const r = new JsRepl(historyWithTools, noopLlmQuery, noopLlmQueryBatched);
      const result = await r.execute('console.log(context[0].toolCalls[0].name)');
      expect(result.stdout).toBe('Read');
      r.dispose();
    });

    it('context is a deep copy (mutations do not affect original)', async () => {
      await repl.execute('context[0].userMessage = "mutated"');
      expect(history[0]!.userMessage).toBe('user message 0');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FINAL and FINAL_VAR
  // ─────────────────────────────────────────────────────────────────────────

  describe('FINAL and FINAL_VAR', () => {
    it('captures FINAL() calls as finalValue', async () => {
      const result = await repl.execute('FINAL("the final answer")');
      expect(result.finalValue).toBe('the final answer');
    });

    it('captures FINAL() with objects', async () => {
      const result = await repl.execute('FINAL({ key: "value" })');
      expect(result.finalValue).toBe('{"key":"value"}');
    });

    it('captures FINAL_VAR() calls', async () => {
      const result = await repl.execute('FINAL_VAR("myResult")');
      expect(result.finalVarName).toBe('myResult');
    });

    it('FINAL adds to stdout', async () => {
      const result = await repl.execute('FINAL("short answer")');
      expect(result.stdout).toContain('FINAL(');
    });

    it('FINAL_VAR adds to stdout', async () => {
      const result = await repl.execute('FINAL_VAR("myVar")');
      expect(result.stdout).toContain('FINAL_VAR("myVar")');
    });

    it('FINAL truncates long values in stdout', async () => {
      const longValue = 'x'.repeat(500);
      const result = await repl.execute(`FINAL("${longValue}")`);
      expect(result.stdout).toContain('...');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Variable persistence and hoisting
  // ─────────────────────────────────────────────────────────────────────────

  describe('variable persistence', () => {
    it('persists variables across executions via hoisting', async () => {
      await repl.execute('const myVar = "persisted"');
      const result = await repl.execute('console.log(myVar)');
      expect(result.stdout).toBe('persisted');
    });

    it('persists let variables', async () => {
      await repl.execute('let counter = 42');
      const result = await repl.execute('console.log(counter)');
      expect(result.stdout).toBe('42');
    });

    it('persists var variables', async () => {
      await repl.execute('var total = 100');
      const result = await repl.execute('console.log(total)');
      expect(result.stdout).toBe('100');
    });

    it('does not persist scaffold names to globalThis', async () => {
      await repl.execute('const context = "overwritten"');
      const result = await repl.execute('console.log(Array.isArray(context))');
      expect(result.stdout).toBe('true');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scaffold restoration
  // ─────────────────────────────────────────────────────────────────────────

  describe('scaffold restoration', () => {
    it('restores context after execution', async () => {
      await repl.execute('console.log("test")');
      const result = await repl.execute('console.log(typeof context)');
      expect(result.stdout).toBe('object');
    });

    it('restores console after execution', async () => {
      await repl.execute('console.log("first")');
      const result = await repl.execute('console.log("second")');
      expect(result.stdout).toBe('second');
    });

    it('restores FINAL after execution', async () => {
      await repl.execute('console.log(typeof FINAL)');
      const result = await repl.execute('console.log(typeof FINAL)');
      expect(result.stdout).toBe('function');
    });

    it('restores llm_query after execution', async () => {
      const result = await repl.execute('console.log(typeof llm_query)');
      expect(result.stdout).toBe('function');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SHOW_VARS
  // ─────────────────────────────────────────────────────────────────────────

  describe('SHOW_VARS', () => {
    it('returns "No user variables defined" when no vars exist', async () => {
      const result = await repl.execute('SHOW_VARS()');
      expect(result.stdout).toContain('No user variables defined');
    });

    it('lists user-defined variables', async () => {
      await repl.execute('const myArray = [1, 2, 3]');
      const result = await repl.execute('SHOW_VARS()');
      expect(result.stdout).toContain('myArray');
      expect(result.stdout).toContain('Array(3)');
    });

    it('shows string length for string variables', async () => {
      await repl.execute('const greeting = "hello world"');
      const result = await repl.execute('SHOW_VARS()');
      expect(result.stdout).toContain('greeting');
      expect(result.stdout).toContain('string');
      expect(result.stdout).toContain('11 chars');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // llm_query integration
  // ─────────────────────────────────────────────────────────────────────────

  describe('llm_query integration', () => {
    it('calls llm_query and records subcalls', async () => {
      const mockQuery: LlmQueryFn = vi.fn(async () => 'llm says hello');
      const r = new JsRepl(history, mockQuery, noopLlmQueryBatched);

      const result = await r.execute('const answer = await llm_query("what is 2+2?"); console.log(answer)');
      expect(result.stdout).toBe('llm says hello');
      expect(result.subcalls).toHaveLength(1);
      expect(result.subcalls[0]!.prompt).toContain('what is 2+2?');
      expect(result.subcalls[0]!.response).toContain('llm says hello');
      r.dispose();
    });

    it('calls llm_query_batched and records subcalls for each prompt', async () => {
      const mockBatched: LlmQueryBatchedFn = vi.fn(async (prompts) =>
        prompts.map((_: string, i: number) => `response ${i}`),
      );
      const r = new JsRepl(history, noopLlmQuery, mockBatched);

      const result = await r.execute(
        'const responses = await llm_query_batched(["q1", "q2", "q3"]); console.log(responses.length)',
      );
      expect(result.stdout).toBe('3');
      expect(result.subcalls).toHaveLength(3);
      r.dispose();
    });

    it('truncates long prompts in subcall records', async () => {
      const longPrompt = 'x'.repeat(1000);
      const r = new JsRepl(history, noopLlmQuery, noopLlmQueryBatched);
      const result = await r.execute(`await llm_query("${longPrompt}")`);
      expect(result.subcalls[0]!.prompt.length).toBeLessThanOrEqual(500);
      r.dispose();
    });

    it('returns disposed message after dispose()', async () => {
      const mockQuery: LlmQueryFn = vi.fn(async () => 'should not reach');
      const r = new JsRepl(history, mockQuery, noopLlmQueryBatched);
      r.dispose();
      const result = await r.execute('await llm_query("test")');
      expect(result.error).toContain('disposed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // resolveVariable
  // ─────────────────────────────────────────────────────────────────────────

  describe('resolveVariable', () => {
    it('resolves string variables', async () => {
      await repl.execute('const result = "hello world"');
      expect(repl.resolveVariable('result')).toBe('hello world');
    });

    it('resolves array variables as JSON', async () => {
      await repl.execute('const arr = [1, 2, 3]');
      const resolved = repl.resolveVariable('arr');
      expect(resolved).toBe(JSON.stringify([1, 2, 3], null, 2));
    });

    it('returns null for undefined variables', () => {
      expect(repl.resolveVariable('nonexistent')).toBeNull();
    });

    it('returns null after dispose', async () => {
      await repl.execute('const result = "test"');
      repl.dispose();
      expect(repl.resolveVariable('result')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getVariableSummary
  // ─────────────────────────────────────────────────────────────────────────

  describe('getVariableSummary', () => {
    it('returns empty string when no user variables exist', () => {
      expect(repl.getVariableSummary()).toBe('');
    });

    it('lists user variables after definition', async () => {
      await repl.execute('const data = [1, 2]');
      const summary = repl.getVariableSummary();
      expect(summary).toContain('data');
    });

    it('returns empty string after dispose', async () => {
      await repl.execute('const x = 1');
      repl.dispose();
      expect(repl.getVariableSummary()).toBe('');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Security (VM hardening)
  // ─────────────────────────────────────────────────────────────────────────

  describe('security', () => {
    it('blocks eval via codeGeneration restriction', async () => {
      const result = await repl.execute('eval("1+1")');
      expect(result.error).not.toBeNull();
    });

    it('cannot access process', async () => {
      const result = await repl.execute('console.log(typeof process)');
      expect(result.stdout).toBe('undefined');
    });

    it('cannot access require', async () => {
      const result = await repl.execute('console.log(typeof require)');
      expect(result.stdout).toBe('undefined');
    });

    it('blocks Function constructor prototype access', async () => {
      const result = await repl.execute(
        'const F = (function(){}).constructor; const f = new F("return process"); f()',
      );
      expect(result.error).not.toBeNull();
    });

    it('provides standard built-ins', async () => {
      const result = await repl.execute(`
        console.log(typeof JSON);
        console.log(typeof Math);
        console.log(typeof Array);
        console.log(typeof Map);
        console.log(typeof Set);
        console.log(typeof Promise);
        console.log(typeof RegExp);
      `);
      const lines = result.stdout.split('\n');
      for (const line of lines) {
        expect(line).not.toBe('undefined');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Stdout truncation
  // ─────────────────────────────────────────────────────────────────────────

  describe('stdout truncation', () => {
    it('truncates stdout over 20K chars', async () => {
      const result = await repl.execute(`console.log("${'x'.repeat(25_000)}")`);
      expect(result.stdout.length).toBeLessThanOrEqual(20_100);
      expect(result.stdout).toContain('[truncated]');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // console.error and console.warn
  // ─────────────────────────────────────────────────────────────────────────

  describe('console variants', () => {
    it('captures console.error with [ERROR] prefix', async () => {
      const result = await repl.execute('console.error("problem")');
      expect(result.stdout).toBe('[ERROR] problem');
    });

    it('captures console.warn with [WARN] prefix', async () => {
      const result = await repl.execute('console.warn("warning")');
      expect(result.stdout).toBe('[WARN] warning');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge cases
  // ─────────────────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty code', async () => {
      const result = await repl.execute('');
      expect(result.error).toBeNull();
    });

    it('handles async code', async () => {
      const result = await repl.execute(`
        const p = new Promise(resolve => resolve(42));
        const val = await p;
        console.log(val);
      `);
      expect(result.stdout).toBe('42');
    });

    it('handles multiple FINAL calls (last wins for finalValue)', async () => {
      const result = await repl.execute('FINAL("first"); FINAL("second")');
      expect(result.finalValue).toBe('second');
    });

    it('resets state between executions', async () => {
      const r1 = await repl.execute('FINAL("value")');
      expect(r1.finalValue).toBe('value');
      const r2 = await repl.execute('console.log("no final")');
      expect(r2.finalValue).toBeNull();
      expect(r2.finalVarName).toBeNull();
    });

    it('handles JSON.stringify in console.log', async () => {
      const result = await repl.execute('console.log({ a: 1, b: [2, 3] })');
      expect(result.stdout).toContain('"a": 1');
    });
  });
});
