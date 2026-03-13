import { describe, it, expect } from 'vitest';
import { extractFilesTouched } from '../types';
import type { ToolCallRecord, StructuredTurn, RecallConfig } from '../types';
import {
  DEFAULT_ROOT_MODEL,
  DEFAULT_SUBCALL_MODEL,
  DEFAULT_MAX_ITERATIONS,
  BLOCK_TIMEOUT_MS,
  ASYNC_TIMEOUT_MS,
  PER_CALL_TIMEOUT_MS,
  TOTAL_LOOP_TIMEOUT_MS,
  ITERATION_TIMEOUT_MS,
  STDOUT_TRUNCATION_LIMIT,
  DIRECT_CONTEXT_THRESHOLD,
  SPECIFIC_MESSAGE_MIN_LENGTH,
  RECENT_CONTEXT_MIN_TURNS,
  RECENT_CONTEXT_MAX_TURNS,
  DEFAULT_MAX_INJECTED_CHARS,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// extractFilesTouched
// ─────────────────────────────────────────────────────────────────────────────

describe('extractFilesTouched', () => {
  it('extracts file paths from tool call inputs', () => {
    const toolCalls: ToolCallRecord[] = [
      { name: 'Read', input: { file_path: '/src/main.ts' }, result: 'content' },
      { name: 'Edit', input: { file_path: '/src/utils.ts' }, result: 'ok' },
    ];
    expect(extractFilesTouched(toolCalls)).toEqual(['/src/main.ts', '/src/utils.ts']);
  });

  it('deduplicates file paths', () => {
    const toolCalls: ToolCallRecord[] = [
      { name: 'Read', input: { file_path: '/src/main.ts' }, result: 'content' },
      { name: 'Edit', input: { file_path: '/src/main.ts' }, result: 'ok' },
    ];
    expect(extractFilesTouched(toolCalls)).toEqual(['/src/main.ts']);
  });

  it('returns empty array when no file_path in inputs', () => {
    const toolCalls: ToolCallRecord[] = [
      { name: 'Bash', input: { command: 'ls' }, result: 'output' },
    ];
    expect(extractFilesTouched(toolCalls)).toEqual([]);
  });

  it('returns empty array for empty tool calls', () => {
    expect(extractFilesTouched([])).toEqual([]);
  });

  it('ignores non-string file_path values', () => {
    const toolCalls: ToolCallRecord[] = [
      { name: 'Read', input: { file_path: 123 as unknown as string }, result: '' },
      { name: 'Read', input: { file_path: null as unknown as string }, result: '' },
      { name: 'Read', input: { file_path: undefined as unknown as string }, result: '' },
    ];
    expect(extractFilesTouched(toolCalls)).toEqual([]);
  });

  it('handles mixed tool calls with and without file_path', () => {
    const toolCalls: ToolCallRecord[] = [
      { name: 'Read', input: { file_path: '/src/a.ts' }, result: '' },
      { name: 'Bash', input: { command: 'npm test' }, result: '' },
      { name: 'Write', input: { file_path: '/src/b.ts', content: 'x' }, result: '' },
    ];
    expect(extractFilesTouched(toolCalls)).toEqual(['/src/a.ts', '/src/b.ts']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constants validation
// ─────────────────────────────────────────────────────────────────────────────

describe('recall constants', () => {
  it('has sensible default models', () => {
    expect(DEFAULT_ROOT_MODEL).toBe('claude-sonnet-4-6');
    expect(DEFAULT_SUBCALL_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('has sensible iteration limits', () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(15);
    expect(DEFAULT_MAX_ITERATIONS).toBeGreaterThan(0);
  });

  it('has consistent timeout hierarchy', () => {
    expect(BLOCK_TIMEOUT_MS).toBeLessThan(ASYNC_TIMEOUT_MS);
    expect(ASYNC_TIMEOUT_MS).toBeLessThan(PER_CALL_TIMEOUT_MS);
    expect(ITERATION_TIMEOUT_MS).toBeLessThanOrEqual(TOTAL_LOOP_TIMEOUT_MS);
  });

  it('has sensible truncation limits', () => {
    expect(STDOUT_TRUNCATION_LIMIT).toBeGreaterThan(1000);
    expect(DIRECT_CONTEXT_THRESHOLD).toBeGreaterThan(0);
  });

  it('has sensible continuation context thresholds', () => {
    expect(SPECIFIC_MESSAGE_MIN_LENGTH).toBeGreaterThan(0);
    expect(RECENT_CONTEXT_MIN_TURNS).toBeLessThanOrEqual(RECENT_CONTEXT_MAX_TURNS);
    expect(RECENT_CONTEXT_MIN_TURNS).toBeGreaterThan(0);
  });

  it('has sensible injection limits', () => {
    expect(DEFAULT_MAX_INJECTED_CHARS).toBeGreaterThan(DIRECT_CONTEXT_THRESHOLD);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Type shape validation
// ─────────────────────────────────────────────────────────────────────────────

describe('type shape validation', () => {
  it('RecallConfig has required fields', () => {
    const config: RecallConfig = {
      enabled: true,
      subcallModel: 'test',
      maxIterations: 5,
      maxInjectedChars: 100_000,
    };
    expect(config.enabled).toBe(true);
    expect(config.maxIterations).toBe(5);
  });

  it('StructuredTurn has all required fields', () => {
    const turn: StructuredTurn = {
      promptIndex: 0,
      timestamp: '2025-01-01T00:00:00.000Z',
      userMessage: 'hello',
      assistantResponse: 'hi',
      toolCalls: [],
      thinkingBlocks: [],
      filesTouched: [],
    };
    expect(turn.promptIndex).toBe(0);
    expect(turn.filesTouched).toEqual([]);
  });

  it('ToolCallRecord supports optional id field', () => {
    const withId: ToolCallRecord = { id: '123', name: 'Read', input: {}, result: '' };
    const withoutId: ToolCallRecord = { name: 'Read', input: {}, result: '' };
    expect(withId.id).toBe('123');
    expect(withoutId.id).toBeUndefined();
  });
});
