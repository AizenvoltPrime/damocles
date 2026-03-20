import { describe, it, expect } from 'vitest';
import {
  buildRecallSystemPrompt,
  buildInitialPrompt,
  buildContinuationPrompt,
  FORCED_ANSWER_PROMPT,
  RECALL_SYSTEM_PROMPT,
} from '../prompts';
import type { OrientationContext } from '../orientation';

// ─────────────────────────────────────────────────────────────────────────────
// buildRecallSystemPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('buildRecallSystemPrompt', () => {
  it('includes the user prompt in the task section', () => {
    const prompt = buildRecallSystemPrompt('how does auth work?', 10, 50000);
    expect(prompt).toContain('how does auth work?');
  });

  it('includes turn count and character count', () => {
    const prompt = buildRecallSystemPrompt('test', 42, 150000);
    expect(prompt).toContain('42');
    expect(prompt).toContain('150,000');
  });

  it('includes REPL environment description', () => {
    const prompt = buildRecallSystemPrompt('test', 1, 1000);
    expect(prompt).toContain('context');
    expect(prompt).toContain('llm_query');
    expect(prompt).toContain('llm_query_batched');
    expect(prompt).toContain('FINAL');
    expect(prompt).toContain('FINAL_VAR');
    expect(prompt).toContain('SHOW_VARS');
  });

  it('includes examples', () => {
    const prompt = buildRecallSystemPrompt('test', 1, 1000);
    expect(prompt).toContain('<examples>');
    expect(prompt).toContain('</examples>');
  });

  it('includes output rules', () => {
    const prompt = buildRecallSystemPrompt('test', 1, 1000);
    expect(prompt).toContain('<output_rules>');
    expect(prompt).toContain('</output_rules>');
  });

  it('uses global scope section when nodeContext is null', () => {
    const prompt = buildRecallSystemPrompt('test', 1, 1000, null);
    expect(prompt).toContain('searching across all conversation history');
  });

  it('uses global scope section when nodeContext is undefined', () => {
    const prompt = buildRecallSystemPrompt('test', 1, 1000);
    expect(prompt).toContain('searching across all conversation history');
  });

  it('uses node-scoped section when nodeContext is provided', () => {
    const prompt = buildRecallSystemPrompt('test', 1, 1000, { nodeTitle: 'Test Task' });
    expect(prompt).toContain('Test Task');
    expect(prompt).toContain('searching through turns from the task');
  });

  it('includes turn_index and text_search descriptions', () => {
    const prompt = buildRecallSystemPrompt('test', 1, 1000);
    expect(prompt).toContain('turn_index');
    expect(prompt).toContain('text_search');
  });

  it('includes orientation section when orientation context is provided', () => {
    const orientation: OrientationContext = {
      expandedTerms: ['authentication', 'jwt'],
      bm25Results: [{ turnIndex: 3, promptIndex: 3, score: 5.2, preview: 'Set up auth...' }],
      turnIndex: [],
      investigationReport: null,
      durationMs: 150,
    };
    const prompt = buildRecallSystemPrompt('auth setup', 10, 50000, null, orientation);
    expect(prompt).toContain('<orientation>');
    expect(prompt).toContain('authentication, jwt');
    expect(prompt).toContain('[Turn 3]');
    expect(prompt).toContain('5.2');
  });

  it('omits orientation section when orientation is null', () => {
    const prompt = buildRecallSystemPrompt('test', 1, 1000, null, null);
    expect(prompt).not.toContain('<orientation>');
  });

  it('includes investigation report in orientation when present', () => {
    const orientation: OrientationContext = {
      expandedTerms: [],
      bm25Results: [],
      turnIndex: [],
      investigationReport: 'Turn 5 [high]: discusses auth token expiry',
      durationMs: 200,
    };
    const prompt = buildRecallSystemPrompt('test', 1, 1000, null, orientation);
    expect(prompt).toContain('INVESTIGATION');
    expect(prompt).toContain('Turn 5 [high]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildInitialPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('buildInitialPrompt', () => {
  it('includes the user prompt', () => {
    const result = buildInitialPrompt('how does auth work?');
    expect(result).toContain('how does auth work?');
  });

  it('mentions the context variable', () => {
    const result = buildInitialPrompt('test');
    expect(result).toContain('context');
  });

  it('guides the model to assess query type when no orientation', () => {
    const result = buildInitialPrompt('test');
    expect(result).toContain('vague');
    expect(result).toContain('specific');
  });

  it('uses oriented prompt when orientation has BM25 results', () => {
    const orientation: OrientationContext = {
      expandedTerms: ['auth'],
      bm25Results: [{ turnIndex: 3, promptIndex: 3, score: 5.0, preview: 'Set up auth' }],
      turnIndex: [],
      investigationReport: null,
      durationMs: 100,
    };
    const result = buildInitialPrompt('auth setup', orientation);
    expect(result).toContain('orientation');
    expect(result).toContain('text_search');
    expect(result).not.toContain('vague');
  });

  it('uses fallback prompt when orientation has no BM25 results', () => {
    const orientation: OrientationContext = {
      expandedTerms: [],
      bm25Results: [],
      turnIndex: [],
      investigationReport: null,
      durationMs: 50,
    };
    const result = buildInitialPrompt('test', orientation);
    expect(result).toContain('vague');
    expect(result).toContain('specific');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildContinuationPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('buildContinuationPrompt', () => {
  it('includes the user prompt', () => {
    const result = buildContinuationPrompt('how does auth work?');
    expect(result).toContain('how does auth work?');
  });

  it('includes variable summary when provided', () => {
    const result = buildContinuationPrompt('test', '  results: Array(5)\n  summary: string (200 chars)');
    expect(result).toContain('results: Array(5)');
    expect(result).toContain('summary: string (200 chars)');
    expect(result).toContain('Do NOT re-extract');
  });

  it('omits variable context when no summary provided', () => {
    const result = buildContinuationPrompt('test');
    expect(result).not.toContain('REPL state');
  });

  it('prompts model to call FINAL if ready', () => {
    const result = buildContinuationPrompt('test');
    expect(result).toContain('FINAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

describe('prompt constants', () => {
  it('FORCED_ANSWER_PROMPT instructs FINAL call', () => {
    expect(FORCED_ANSWER_PROMPT).toContain('FINAL');
    expect(FORCED_ANSWER_PROMPT).toContain('repl');
  });

  it('RECALL_SYSTEM_PROMPT describes recall mode', () => {
    expect(RECALL_SYSTEM_PROMPT).toContain('recall mode');
    expect(RECALL_SYSTEM_PROMPT).toContain('recall_session_context');
  });
});
