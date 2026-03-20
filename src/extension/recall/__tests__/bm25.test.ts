import { describe, it, expect } from 'vitest';
import { tokenize, createBM25Index } from '../bm25';
import type { StructuredTurn } from '../types';
import { createCardGameHistory } from './fixtures/histories';

function makeTurn(overrides: Partial<StructuredTurn> & { promptIndex: number }): StructuredTurn {
  return {
    timestamp: new Date(Date.UTC(2025, 0, 1) + overrides.promptIndex * 60_000).toISOString(),
    userMessage: 'test message',
    assistantResponse: 'test response',
    toolCalls: [],
    contentBlocks: [],
    thinkingBlocks: [],
    filesTouched: [],
    nodeId: null,
    summary: null,
    keywords: null,
    ...overrides,
  };
}

describe('tokenize', () => {
  it('converts text to lowercase tokens', () => {
    const tokens = tokenize('Hello WORLD FooBar');
    expect(tokens).toEqual(['hello', 'world', 'foobar']);
  });

  it('removes common stop words', () => {
    const tokens = tokenize('the quick fox is and was being');
    expect(tokens).toEqual(['quick', 'fox']);
  });

  it('filters tokens shorter than 2 characters', () => {
    const tokens = tokenize('a x I ab cd');
    expect(tokens).toEqual(['ab', 'cd']);
  });

  it('returns empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('keeps coding-relevant words', () => {
    const tokens = tokenize('fix update implement refactor debug deploy');
    expect(tokens).toContain('fix');
    expect(tokens).toContain('update');
    expect(tokens).toContain('implement');
    expect(tokens).toContain('refactor');
    expect(tokens).toContain('debug');
    expect(tokens).toContain('deploy');
  });
});

describe('createBM25Index — construction', () => {
  it('returns index that always returns empty array for empty corpus', () => {
    const index = createBM25Index([]);
    expect(index.search('anything')).toEqual([]);
    expect(index.search('multiple query terms')).toEqual([]);
  });

  it('works with a single document', () => {
    const index = createBM25Index([
      makeTurn({ promptIndex: 0, userMessage: 'implement authentication system' }),
    ]);
    const results = index.search('authentication');
    expect(results).toHaveLength(1);
    expect(results[0]!.turnIndex).toBe(0);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('returns empty array for no-match query', () => {
    const index = createBM25Index([
      makeTurn({ promptIndex: 0, userMessage: 'implement authentication system' }),
    ]);
    expect(index.search('xylophone')).toEqual([]);
  });
});

describe('search — basic retrieval', () => {
  const turns = [
    makeTurn({ promptIndex: 0, userMessage: 'set up database schema', assistantResponse: 'created PostgreSQL tables' }),
    makeTurn({ promptIndex: 1, userMessage: 'add authentication middleware', assistantResponse: 'JWT token verification' }),
    makeTurn({ promptIndex: 2, userMessage: 'fix database connection pooling', assistantResponse: 'increased pool size' }),
    makeTurn({ promptIndex: 3, userMessage: 'deploy application to production', assistantResponse: 'configured Docker' }),
    makeTurn({ promptIndex: 4, userMessage: 'optimize database query performance', assistantResponse: 'added indexes' }),
  ];
  const index = createBM25Index(turns);

  it('finds matching documents for a single-term search', () => {
    const results = index.search('database');
    expect(results.length).toBeGreaterThan(0);
    const matchedIndices = results.map(r => r.turnIndex);
    expect(matchedIndices).toContain(0);
    expect(matchedIndices).toContain(2);
    expect(matchedIndices).toContain(4);
  });

  it('combines scores for multi-term queries', () => {
    const results = index.search('database query');
    expect(results.length).toBeGreaterThan(0);
    const topResult = results[0]!;
    expect(topResult.turnIndex).toBe(4);
  });

  it('limits results with topK', () => {
    const results = index.search('database', 2);
    expect(results).toHaveLength(2);
  });

  it('returns all matches when topK exceeds result count', () => {
    const results = index.search('database', 100);
    const allResults = index.search('database');
    expect(results).toHaveLength(allResults.length);
  });

  it('ranks rare terms higher than common terms via IDF', () => {
    const commonTermTurns = [
      makeTurn({ promptIndex: 0, userMessage: 'server endpoint handler', assistantResponse: 'created server route' }),
      makeTurn({ promptIndex: 1, userMessage: 'server middleware layer', assistantResponse: 'added server logging' }),
      makeTurn({ promptIndex: 2, userMessage: 'server configuration setup', assistantResponse: 'server deployment' }),
      makeTurn({ promptIndex: 3, userMessage: 'quantum entanglement simulator', assistantResponse: 'built quantum module' }),
    ];
    const idfIndex = createBM25Index(commonTermTurns);

    const commonResults = idfIndex.search('server');
    const rareResults = idfIndex.search('quantum');

    expect(rareResults.length).toBeGreaterThan(0);
    expect(commonResults.length).toBeGreaterThan(0);
    expect(rareResults[0]!.score).toBeGreaterThan(commonResults[0]!.score);
  });
});

describe('search — card game fixture', () => {
  const history = createCardGameHistory();
  const index = createBM25Index(history);

  it('ranks the hover flickering fix turn highest for "hover flickering"', () => {
    const results = index.search('hover flickering');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.turnIndex).toBe(3);
  });

  it('ranks the mana system turn highest for "mana system"', () => {
    const results = index.search('mana system');
    expect(results.length).toBeGreaterThan(0);
    const topTurnIndex = results[0]!.turnIndex;
    expect([5, 6]).toContain(topTurnIndex);
  });

  it('finds the InputManager turn for "InputManager"', () => {
    const results = index.search('InputManager');
    expect(results.length).toBeGreaterThan(0);
    const matchedIndices = results.map(r => r.turnIndex);
    expect(matchedIndices).toContain(0);
  });

  it('returns empty array for completely unrelated term', () => {
    const results = index.search('kubernetes orchestration microservices');
    expect(results).toEqual([]);
  });
});

describe('search — keywords enrichment', () => {
  it('scores turns with matching keywords higher than pure text match', () => {
    const withoutKeywords = makeTurn({
      promptIndex: 0,
      userMessage: 'configure display output module',
      assistantResponse: 'adjusted display settings and output layer',
    });
    const withKeywords = makeTurn({
      promptIndex: 1,
      userMessage: 'configure display output module',
      assistantResponse: 'adjusted display settings and output layer',
      keywords: ['shader', 'graphics', 'vulkan'],
    });
    const index = createBM25Index([withoutKeywords, withKeywords]);

    const results = index.search('shader vulkan graphics');
    expect(results).toHaveLength(1);
    expect(results[0]!.turnIndex).toBe(1);
  });

  it('handles null keywords without errors', () => {
    const turns = [
      makeTurn({ promptIndex: 0, userMessage: 'test query', keywords: null }),
      makeTurn({ promptIndex: 1, userMessage: 'another query', keywords: null }),
    ];
    expect(() => createBM25Index(turns)).not.toThrow();
    const index = createBM25Index(turns);
    expect(() => index.search('test')).not.toThrow();
  });
});

describe('preview generation', () => {
  it('trims preview to approximately 200 characters from userMessage', () => {
    const longMessage = 'word '.repeat(100);
    const turns = [makeTurn({ promptIndex: 0, userMessage: longMessage })];
    const index = createBM25Index(turns);
    const results = index.search('word');
    expect(results).toHaveLength(1);
    expect(results[0]!.preview.length).toBeLessThanOrEqual(204);
  });

  it('returns full text for short messages', () => {
    const shortMessage = 'fix the hover bug';
    const turns = [makeTurn({ promptIndex: 0, userMessage: shortMessage })];
    const index = createBM25Index(turns);
    const results = index.search('hover bug');
    expect(results).toHaveLength(1);
    expect(results[0]!.preview).toBe(shortMessage);
  });
});
