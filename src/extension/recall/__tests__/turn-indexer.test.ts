import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StructuredTurn } from '../types';

vi.mock('../haiku-query', () => ({
  haikuStructuredQuery: vi.fn(),
}));

vi.mock('../../logger', () => ({ log: vi.fn() }));

import { haikuStructuredQuery } from '../haiku-query';
import { indexTurn } from '../turn-indexer';
const mockHaikuQuery = vi.mocked(haikuStructuredQuery);

function makeTurn(overrides: Partial<StructuredTurn> = {}): StructuredTurn {
  return {
    promptIndex: 0,
    timestamp: new Date().toISOString(),
    userMessage: 'Fix the login bug',
    assistantResponse: 'I found and fixed the issue in auth.ts',
    toolCalls: [],
    contentBlocks: [],
    thinkingBlocks: [],
    filesTouched: [],
    nodeId: 'test-node-id',
    summary: null,
    keywords: null,
    ...overrides,
  };
}

describe('indexTurn: SDK unavailable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when haikuStructuredQuery returns null', async () => {
    mockHaikuQuery.mockResolvedValueOnce(null);

    const result = await indexTurn(makeTurn(), '/test');

    expect(result).toBeNull();
  });
});

describe('indexTurn: valid response', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns summary and keywords on successful response', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ summary: 'Test summary', keywords: ['auth', 'jwt'] });

    const result = await indexTurn(makeTurn(), '/test');

    expect(result).toEqual({ summary: 'Test summary', keywords: ['auth', 'jwt'] });
  });
});

describe('indexTurn: Haiku failure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when haikuStructuredQuery throws', async () => {
    mockHaikuQuery.mockRejectedValueOnce(new Error('Haiku crash'));

    const result = await indexTurn(makeTurn(), '/test');

    expect(result).toBeNull();
  });
});

describe('indexTurn: input truncation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('truncates long userMessage and assistantResponse before passing to Haiku', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ summary: 'Truncated summary', keywords: ['long'] });

    const longUserMessage = 'x'.repeat(1000);
    const longAssistantResponse = 'y'.repeat(2000);
    const turn = makeTurn({ userMessage: longUserMessage, assistantResponse: longAssistantResponse });

    await indexTurn(turn, '/test');

    expect(mockHaikuQuery).toHaveBeenCalledOnce();
    const callArgs = mockHaikuQuery.mock.calls[0]![0] as unknown as { userMessage: string; schema: { type: string; required: string[] } };
    expect(callArgs.userMessage).toContain('x'.repeat(500));
    expect(callArgs.userMessage).not.toContain('x'.repeat(501));
    expect(callArgs.userMessage).toContain('y'.repeat(1000));
    expect(callArgs.userMessage).not.toContain('y'.repeat(1001));
    expect(callArgs.schema.type).toBe('object');
    expect(callArgs.schema.required).toContain('summary');
    expect(callArgs.schema.required).toContain('keywords');
  });
});

describe('indexTurn: abort signal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards abort signal to haikuStructuredQuery', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ summary: 'S', keywords: ['k'] });

    const controller = new AbortController();
    await indexTurn(makeTurn(), '/test', controller.signal);

    const callArgs = mockHaikuQuery.mock.calls[0]![0] as { abortSignal?: AbortSignal };
    expect(callArgs.abortSignal).toBe(controller.signal);
  });
});
