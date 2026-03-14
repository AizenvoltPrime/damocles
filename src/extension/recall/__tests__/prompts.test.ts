import { describe, it, expect } from 'vitest';
import {
  buildRecallSystemPrompt,
  buildInitialPrompt,
  buildContinuationPrompt,
  FORCED_ANSWER_PROMPT,
  RECALL_SYSTEM_PROMPT,
} from '../prompts';

// ─────────────────────────────────────────────────────────────────────────────
// buildRecallSystemPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('buildRecallSystemPrompt', () => {
  it('includes the user prompt in the task section', () => {
    const prompt = buildRecallSystemPrompt('how does auth work?', 10, 50000, {
      intent: 'explain',
      secondaryIntent: null,
      keyEntities: ['auth'],
    });
    expect(prompt).toContain('how does auth work?');
  });

  it('includes turn count and character count', () => {
    const prompt = buildRecallSystemPrompt('test', 42, 150000, {
      intent: 'general',
      secondaryIntent: null,
      keyEntities: [],
    });
    expect(prompt).toContain('42');
    expect(prompt).toContain('150,000');
  });

  it('includes intent context', () => {
    const prompt = buildRecallSystemPrompt('fix the bug', 5, 10000, {
      intent: 'debug',
      secondaryIntent: null,
      keyEntities: ['auth', 'login'],
    });
    expect(prompt).toContain('Intent: debug');
    expect(prompt).toContain('"auth"');
    expect(prompt).toContain('"login"');
  });

  it('includes REPL environment description', () => {
    const prompt = buildRecallSystemPrompt('test', 1, 1000, {
      intent: 'general',
      secondaryIntent: null,
      keyEntities: [],
    });
    expect(prompt).toContain('context');
    expect(prompt).toContain('llm_query');
    expect(prompt).toContain('llm_query_batched');
    expect(prompt).toContain('FINAL');
    expect(prompt).toContain('FINAL_VAR');
    expect(prompt).toContain('SHOW_VARS');
  });

  it('includes examples', () => {
    const prompt = buildRecallSystemPrompt('test', 1, 1000, {
      intent: 'general',
      secondaryIntent: null,
      keyEntities: [],
    });
    expect(prompt).toContain('<examples>');
    expect(prompt).toContain('</examples>');
  });

  it('includes output rules', () => {
    const prompt = buildRecallSystemPrompt('test', 1, 1000, {
      intent: 'general',
      secondaryIntent: null,
      keyEntities: [],
    });
    expect(prompt).toContain('<output_rules>');
    expect(prompt).toContain('</output_rules>');
  });

  describe('intent-specific guidance', () => {
    it('provides debug guidance for debug intent', () => {
      const prompt = buildRecallSystemPrompt('fix error', 5, 10000, {
        intent: 'debug',
        secondaryIntent: null,
        keyEntities: ['TypeError'],
      });
      expect(prompt).toContain('debugging');
      expect(prompt).toContain('"TypeError"');
    });

    it('provides recall guidance for recall intent', () => {
      const prompt = buildRecallSystemPrompt('what did you say about X', 5, 10000, {
        intent: 'recall',
        secondaryIntent: null,
        keyEntities: ['X'],
      });
      expect(prompt).toContain('referencing');
    });

    it('provides explain guidance for explain intent', () => {
      const prompt = buildRecallSystemPrompt('how does it work', 5, 10000, {
        intent: 'explain',
        secondaryIntent: null,
        keyEntities: ['auth'],
      });
      expect(prompt).toContain('understand');
    });

    it('provides feature guidance', () => {
      const prompt = buildRecallSystemPrompt('add dark mode', 5, 10000, {
        intent: 'feature',
        secondaryIntent: null,
        keyEntities: ['dark mode'],
      });
      expect(prompt).toContain('implementing new functionality');
    });

    it('provides refactor guidance', () => {
      const prompt = buildRecallSystemPrompt('refactor utils', 5, 10000, {
        intent: 'refactor',
        secondaryIntent: null,
        keyEntities: ['utils'],
      });
      expect(prompt).toContain('restructuring existing code');
    });

    it('provides test guidance for test intent', () => {
      const prompt = buildRecallSystemPrompt('write tests for auth', 5, 10000, {
        intent: 'test',
        secondaryIntent: null,
        keyEntities: ['auth'],
      });
      expect(prompt).toContain('write or set up tests');
      expect(prompt).toContain('Test execution results');
      expect(prompt).toContain('"auth"');
    });

    it('provides general guidance as default', () => {
      const prompt = buildRecallSystemPrompt('hello', 5, 10000, {
        intent: 'general',
        secondaryIntent: null,
        keyEntities: [],
      });
      expect(prompt).toContain('last 2-3 turns');
    });

    it('produces merged guidance with secondary intent', () => {
      const prompt = buildRecallSystemPrompt('fix the test and add more tests', 5, 10000, {
        intent: 'debug',
        secondaryIntent: 'test',
        keyEntities: ['CardManager'],
      });
      expect(prompt).toContain('PRIMARY OBJECTIVE');
      expect(prompt).toContain('SECONDARY OBJECTIVE');
      expect(prompt).toContain('debugging');
      expect(prompt).toContain('write or set up tests');
      expect(prompt).toContain('(secondary: test)');
    });
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

  it('guides the model to assess query type', () => {
    const result = buildInitialPrompt('test');
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
