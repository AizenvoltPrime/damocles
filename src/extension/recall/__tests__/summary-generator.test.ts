import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskNode, StructuredTurn } from '../types';

vi.mock('../haiku-query', () => ({
  haikuStructuredQuery: vi.fn(),
}));

vi.mock('../../logger', () => ({ log: vi.fn() }));

import { haikuStructuredQuery } from '../haiku-query';
import { generateNodeSummary } from '../summary-generator';
const mockHaikuQuery = vi.mocked(haikuStructuredQuery);

const INTEGRATION = !!process.env['DAMOCLES_INTEGRATION'];
const integrationSuite = INTEGRATION ? describe : describe.skip;

function makeNode(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    nodeId: 'test-node-id',
    title: 'Fix Auth Bug',
    status: 'ACTIVE',
    keyEntities: ['auth', 'JWT', 'login'],
    turnIndices: [0, 1, 2],
    createdAt: new Date().toISOString(),
    closedAt: null,
    summary: null,
    relatedClosedNodeIds: [],
    manuallyDisconnectedNodeIds: [],
    seedContext: null,
    ...overrides,
  };
}

function makeTurn(index: number, overrides: Partial<StructuredTurn> = {}): StructuredTurn {
  return {
    promptIndex: index,
    timestamp: new Date().toISOString(),
    userMessage: `User message for prompt ${index}`,
    assistantResponse: `Assistant response for prompt ${index}`,
    toolCalls: [],
    contentBlocks: [],
    thinkingBlocks: [],
    filesTouched: [],
    nodeId: 'test-node-id',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — mocked Haiku
// ─────────────────────────────────────────────────────────────────────────────

describe('generateNodeSummary: empty turns fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns user-provided outcome for empty turn list', async () => {
    const node = makeNode();
    const result = await generateNodeSummary(node, [], '/test', 'abandoned');

    expect(result.title).toBe('Fix Auth Bug');
    expect(result.taskDescription).toBe('No conversation turns recorded.');
    expect(result.outcome).toBe('abandoned');
    expect(result.filesChanged).toEqual([]);
    expect(result.keyDecisions).toEqual([]);
    expect(result.keyEntities).toEqual(['auth', 'JWT', 'login']);
    expect(mockHaikuQuery).not.toHaveBeenCalled();
  });

  it('uses provided outcome regardless of content', async () => {
    const node = makeNode();
    const result = await generateNodeSummary(node, [], '/test', 'resolved');
    expect(result.outcome).toBe('resolved');
  });
});

describe('generateNodeSummary: successful Haiku call', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns Haiku-generated summary with user-provided outcome', async () => {
    const haikuResult = {
      title: 'Authentication Bug Fix',
      taskDescription: 'Fixed JWT token validation and refresh flow.',
      filesChanged: ['src/auth/jwt.ts', 'src/middleware/auth.ts'],
      keyDecisions: ['Used httpOnly cookies', 'Added refresh token rotation'],
      keyEntities: ['JWT', 'auth', 'refresh token', 'middleware'],
    };
    mockHaikuQuery.mockResolvedValueOnce(haikuResult);

    const node = makeNode();
    const turns = [makeTurn(0), makeTurn(1)];
    const result = await generateNodeSummary(node, turns, '/test', 'resolved');

    expect(result.title).toBe('Authentication Bug Fix');
    expect(result.taskDescription).toBe('Fixed JWT token validation and refresh flow.');
    expect(result.outcome).toBe('resolved');
    expect(result.filesChanged).toEqual(['src/auth/jwt.ts', 'src/middleware/auth.ts']);
  });

  it('passes node title in system prompt', async () => {
    mockHaikuQuery.mockResolvedValueOnce({
      title: 'T', taskDescription: 'D',
      filesChanged: [], keyDecisions: [], keyEntities: [],
    });

    const node = makeNode({ title: 'Refactor Database Layer' });
    await generateNodeSummary(node, [makeTurn(0)], '/test', 'resolved');

    const callArgs = mockHaikuQuery.mock.calls[0]![0] as { systemPrompt: string };
    expect(callArgs.systemPrompt).toContain('Refactor Database Layer');
  });

  it('passes abort signal through', async () => {
    mockHaikuQuery.mockResolvedValueOnce({
      title: 'T', taskDescription: 'D',
      filesChanged: [], keyDecisions: [], keyEntities: [],
    });

    const controller = new AbortController();
    await generateNodeSummary(makeNode(), [makeTurn(0)], '/test', 'resolved', controller.signal);

    const callArgs = mockHaikuQuery.mock.calls[0]![0] as { abortSignal?: AbortSignal };
    expect(callArgs.abortSignal).toBe(controller.signal);
  });

  it('overrides with user outcome even when Haiku returns data', async () => {
    mockHaikuQuery.mockResolvedValueOnce({
      title: 'T', taskDescription: 'D',
      filesChanged: [], keyDecisions: [], keyEntities: [],
    });

    const result = await generateNodeSummary(makeNode(), [makeTurn(0)], '/test', 'abandoned');
    expect(result.outcome).toBe('abandoned');
  });
});

describe('generateNodeSummary: Haiku failure fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns fallback summary with user-provided outcome when Haiku returns null', async () => {
    mockHaikuQuery.mockResolvedValueOnce(null);

    const node = makeNode({ title: 'My Task', keyEntities: ['entity1', 'entity2'] });
    const turns = [
      makeTurn(0, { filesTouched: ['src/a.ts', 'src/b.ts'] }),
      makeTurn(1, { filesTouched: ['src/b.ts', 'src/c.ts'] }),
      makeTurn(2, { filesTouched: [] }),
    ];

    const result = await generateNodeSummary(node, turns, '/test', 'partial');

    expect(result.title).toBe('My Task');
    expect(result.taskDescription).toBe('Task with 3 conversation turns.');
    expect(result.outcome).toBe('partial');
    expect(result.filesChanged).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts', 'src/c.ts']));
    expect(result.filesChanged).toHaveLength(3);
    expect(result.keyDecisions).toEqual([]);
    expect(result.keyEntities).toEqual(['entity1', 'entity2']);
  });

  it('deduplicates filesTouched in fallback', async () => {
    mockHaikuQuery.mockResolvedValueOnce(null);

    const turns = [
      makeTurn(0, { filesTouched: ['src/shared.ts'] }),
      makeTurn(1, { filesTouched: ['src/shared.ts'] }),
    ];

    const result = await generateNodeSummary(makeNode(), turns, '/test', 'resolved');
    const sharedCount = result.filesChanged.filter(f => f === 'src/shared.ts').length;
    expect(sharedCount).toBe(1);
  });
});

describe('generateNodeSummary: transcript truncation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('truncates transcript over 100K chars', async () => {
    mockHaikuQuery.mockResolvedValueOnce({
      title: 'T', taskDescription: 'D',
      filesChanged: [], keyDecisions: [], keyEntities: [],
    });

    const longResponse = 'x'.repeat(60_000);
    const turns = [
      makeTurn(0, { assistantResponse: longResponse }),
      makeTurn(1, { assistantResponse: longResponse }),
    ];

    await generateNodeSummary(makeNode(), turns, '/test', 'resolved');

    const callArgs = mockHaikuQuery.mock.calls[0]![0] as { userMessage: string };
    expect(callArgs.userMessage.length).toBeLessThanOrEqual(100_100);
    expect(callArgs.userMessage).toContain('[...truncated...]');
  });

  it('does not truncate transcript under 100K chars', async () => {
    mockHaikuQuery.mockResolvedValueOnce({
      title: 'T', taskDescription: 'D',
      filesChanged: [], keyDecisions: [], keyEntities: [],
    });

    const turns = [makeTurn(0), makeTurn(1)];
    await generateNodeSummary(makeNode(), turns, '/test', 'resolved');

    const callArgs = mockHaikuQuery.mock.calls[0]![0] as { userMessage: string };
    expect(callArgs.userMessage).not.toContain('[...truncated...]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — real Haiku calls via SDK
//
// Run: DAMOCLES_INTEGRATION=1 npx vitest run src/extension/recall/__tests__/summary-generator.test.ts
// ─────────────────────────────────────────────────────────────────────────────

integrationSuite('integration: generateNodeSummary (real Haiku)', () => {
  let realGenerateNodeSummary: typeof generateNodeSummary;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    const module = await import('../summary-generator');
    realGenerateNodeSummary = module.generateNodeSummary;
  });

  it('generates a meaningful summary with user-provided resolved outcome', async () => {
    const node = makeNode({ title: 'Fix Auth Bug', keyEntities: ['auth', 'JWT', 'login'] });
    const turns: StructuredTurn[] = [
      makeTurn(0, {
        userMessage: 'Fix the JWT token validation bug — refresh tokens are not being rotated properly',
        assistantResponse: 'I found the issue in auth-middleware.ts. The refresh token was not being invalidated after rotation. I updated the /refresh endpoint to mark old tokens as used in the database.',
        filesTouched: ['src/auth/auth-middleware.ts', 'src/routes/auth.ts'],
      }),
      makeTurn(1, {
        userMessage: 'Also add httpOnly cookie storage for the tokens instead of localStorage',
        assistantResponse: 'Updated the token storage to use httpOnly cookies with SameSite=Strict. Removed localStorage usage from the frontend auth service.',
        filesTouched: ['src/auth/auth-middleware.ts', 'src/services/auth-service.ts'],
      }),
    ];

    const result = await realGenerateNodeSummary(node, turns, process.cwd(), 'resolved');

    expect(result.title).toBeTruthy();
    expect(result.taskDescription.length).toBeGreaterThan(10);
    expect(result.outcome).toBe('resolved');
    expect(result.filesChanged.length).toBeGreaterThan(0);
    expect(result.keyEntities.length).toBeGreaterThan(0);
    expect(result.keyEntities.some(e => /auth|jwt|token/i.test(e))).toBe(true);
  }, 30_000);

  it('preserves user-provided partial outcome', async () => {
    const node = makeNode({ title: 'Add OAuth Login', keyEntities: ['OAuth', 'Google', 'login'] });
    const turns: StructuredTurn[] = [
      makeTurn(0, {
        userMessage: 'Add Google OAuth login support',
        assistantResponse: 'I started setting up the OAuth configuration and added the Google client ID. Still need to implement the callback handler and token exchange.',
        filesTouched: ['src/config/oauth.ts'],
      }),
    ];

    const result = await realGenerateNodeSummary(node, turns, process.cwd(), 'partial');

    expect(result.outcome).toBe('partial');
    expect(result.taskDescription.length).toBeGreaterThan(10);
  }, 30_000);

  it('generates summary with valid schema fields', async () => {
    const node = makeNode({ title: 'Refactor DB', keyEntities: ['database', 'migration'] });
    const turns: StructuredTurn[] = [
      makeTurn(0, {
        userMessage: 'Refactor the database layer to use Drizzle ORM instead of raw SQL',
        assistantResponse: 'Migrated all queries to Drizzle ORM. Created schema files for users, posts, and comments tables. Removed raw SQL helper utilities.',
        filesTouched: ['src/db/schema.ts', 'src/db/queries.ts', 'src/utils/sql-helper.ts'],
      }),
    ];

    const result = await realGenerateNodeSummary(node, turns, process.cwd(), 'resolved');

    expect(typeof result.title).toBe('string');
    expect(typeof result.taskDescription).toBe('string');
    expect(result.outcome).toBe('resolved');
    expect(Array.isArray(result.filesChanged)).toBe(true);
    expect(Array.isArray(result.keyDecisions)).toBe(true);
    expect(Array.isArray(result.keyEntities)).toBe(true);
  }, 30_000);
});
