import { describe, it, expect, vi, beforeEach } from 'vitest';

const INTEGRATION = !!process.env['DAMOCLES_INTEGRATION'];
const suite = INTEGRATION ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — mocked SDK
// ─────────────────────────────────────────────────────────────────────────────

function mockAuthOk(): void {
  vi.doMock('../../auth/sdk-env', () => ({
    buildSdkEnv: () => ({}),
    getSmallFastModel: () => 'claude-haiku-4-5-20251001',
    requireAuthFor: async () => ({
      ok: true,
      modelValue: 'claude-haiku-4-5-20251001',
      missingBackend: 'anthropic',
      message: '',
    }),
    SMALL_FAST_ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
    SDK_STRIPPED_ENV_KEYS: [],
    setSdkEnvExtensionContext: () => {},
    getSdkEnvExtensionContext: () => null,
    resetSdkEnvExtensionContext: () => {},
  }));
}

describe('haikuStructuredQuery: SDK unavailable', () => {
  beforeEach(() => {
    vi.resetModules();
    mockAuthOk();
  });

  it('returns null when SDK cannot be loaded', async () => {
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => null,
    }));

    const { haikuStructuredQuery } = await import('../haiku-query');
    const result = await haikuStructuredQuery({
      systemPrompt: 'test',
      userMessage: 'test',
      schema: { type: 'object', properties: {}, required: [] },
      cwd: '/test',
    });

    expect(result).toBeNull();
  });
});

describe('haikuStructuredQuery: SDK error handling', () => {
  beforeEach(() => {
    vi.resetModules();
    mockAuthOk();
  });

  it('returns null when SDK query throws', async () => {
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => () => {
        throw new Error('SDK crash');
      },
    }));

    const { haikuStructuredQuery } = await import('../haiku-query');
    const result = await haikuStructuredQuery({
      systemPrompt: 'test',
      userMessage: 'test',
      schema: { type: 'object', properties: {}, required: [] },
      cwd: '/test',
    });

    expect(result).toBeNull();
  });

  it('returns null on max_structured_output_retries error', async () => {
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => () => (async function* () {
        yield {
          type: 'result',
          subtype: 'error_max_structured_output_retries',
        };
      })(),
    }));

    const { haikuStructuredQuery } = await import('../haiku-query');
    const result = await haikuStructuredQuery({
      systemPrompt: 'test',
      userMessage: 'test',
      schema: { type: 'object', properties: {}, required: [] },
      cwd: '/test',
    });

    expect(result).toBeNull();
  });

  it('returns null on error_max_turns', async () => {
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => () => (async function* () {
        yield {
          type: 'result',
          subtype: 'error_max_turns',
        };
      })(),
    }));

    const { haikuStructuredQuery } = await import('../haiku-query');
    const result = await haikuStructuredQuery({
      systemPrompt: 'test',
      userMessage: 'test',
      schema: { type: 'object', properties: {}, required: [] },
      cwd: '/test',
    });

    expect(result).toBeNull();
  });

  it('extracts structured_output from result event', async () => {
    const expected = { title: 'Test Title', entities: ['a', 'b'] };
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => () => (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          structured_output: expected,
        };
      })(),
    }));

    const { haikuStructuredQuery } = await import('../haiku-query');
    const result = await haikuStructuredQuery<typeof expected>({
      systemPrompt: 'test',
      userMessage: 'test',
      schema: { type: 'object', properties: {}, required: [] },
      cwd: '/test',
    });

    expect(result).toEqual(expected);
  });

  it('returns null when generator yields no result event', async () => {
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => () => (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
      })(),
    }));

    const { haikuStructuredQuery } = await import('../haiku-query');
    const result = await haikuStructuredQuery({
      systemPrompt: 'test',
      userMessage: 'test',
      schema: { type: 'object', properties: {}, required: [] },
      cwd: '/test',
    });

    expect(result).toBeNull();
  });
});

describe('haikuStructuredQuery: abort handling', () => {
  beforeEach(() => {
    vi.resetModules();
    mockAuthOk();
  });

  it('respects pre-aborted signal', async () => {
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => (params: { options: { abortController: AbortController } }) => {
        return (async function* () {
          if (params.options.abortController.signal.aborted) return;
          yield {
            type: 'result',
            subtype: 'success',
            structured_output: { value: 'should not reach' },
          };
        })();
      },
    }));

    const { haikuStructuredQuery } = await import('../haiku-query');
    const controller = new AbortController();
    controller.abort();

    const result = await haikuStructuredQuery({
      systemPrompt: 'test',
      userMessage: 'test',
      schema: { type: 'object', properties: {}, required: [] },
      cwd: '/test',
      abortSignal: controller.signal,
    });

    expect(result).toBeNull();
  });

  it('propagates parent abort to internal controller', async () => {
    let internalController: AbortController | null = null;
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    vi.doMock('../../shared/sdk-loader', () => ({
      loadSdkQuery: () => (params: { options: { abortController: AbortController } }) => {
        internalController = params.options.abortController;
        return (async function* () {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 10_000);
            params.options.abortController.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          });
          yield { type: 'result', subtype: 'success', structured_output: {} };
        })();
      },
    }));

    const { haikuStructuredQuery } = await import('../haiku-query');
    const parent = new AbortController();

    const promise = haikuStructuredQuery({
      systemPrompt: 'test',
      userMessage: 'test',
      schema: { type: 'object', properties: {}, required: [] },
      cwd: '/test',
      abortSignal: parent.signal,
    });

    await new Promise(r => setTimeout(r, 50));
    parent.abort();

    const result = await promise;
    expect(result).toBeNull();
    expect(internalController!.signal.aborted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — real Haiku structured output via SDK
//
// These validate that the SDK integration actually produces correct structured
// output. Critical for catching schema mismatches, model behavior changes,
// and SDK API surface changes.
//
// Run: DAMOCLES_INTEGRATION=1 npx vitest run src/extension/recall/__tests__/haiku-query.test.ts
// ─────────────────────────────────────────────────────────────────────────────

suite('integration: haikuStructuredQuery (real Haiku)', () => {
  let haikuStructuredQuery: typeof import('../haiku-query').haikuStructuredQuery;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../logger', () => ({ log: vi.fn() }));
    const module = await import('../haiku-query');
    haikuStructuredQuery = module.haikuStructuredQuery;
  });

  it('returns structured output matching a simple schema', async () => {
    const result = await haikuStructuredQuery<{ title: string; tags: string[] }>({
      systemPrompt: 'Generate a concise title and relevant tags for the given text.',
      userMessage: 'Fix the authentication bug where JWT refresh tokens expire prematurely',
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        },
        required: ['title', 'tags'],
        additionalProperties: false,
      },
      cwd: process.cwd(),
    });

    expect(result).not.toBeNull();
    expect(typeof result!.title).toBe('string');
    expect(result!.title.length).toBeGreaterThan(0);
    expect(Array.isArray(result!.tags)).toBe(true);
    expect(result!.tags.length).toBeGreaterThan(0);
    expect(result!.tags.some(t => /auth|jwt|token/i.test(t))).toBe(true);
  }, 30_000);

  it('returns structured output with enum field', async () => {
    const result = await haikuStructuredQuery<{ outcome: 'resolved' | 'partial' | 'abandoned' }>({
      systemPrompt: 'Determine the outcome of the described task.',
      userMessage: 'I successfully migrated all database queries from raw SQL to the ORM and ran all tests. Everything passes.',
      schema: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['resolved', 'partial', 'abandoned'] },
        },
        required: ['outcome'],
        additionalProperties: false,
      },
      cwd: process.cwd(),
    });

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('resolved');
  }, 30_000);

  it('handles abort signal gracefully', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await haikuStructuredQuery<{ title: string }>({
      systemPrompt: 'test',
      userMessage: 'test',
      schema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
      cwd: process.cwd(),
      abortSignal: controller.signal,
    });

    expect(result).toBeNull();
  }, 30_000);

  it('title generation schema matches NodeManager usage', async () => {
    const result = await haikuStructuredQuery<{ title: string; keyEntities: string[] }>({
      systemPrompt: `Generate a concise task title and extract key entities from a user prompt.
The title should be 3-5 words summarizing the task.
Entities should be specific technical terms, file names, component names, or concepts mentioned in the prompt.`,
      userMessage: 'Fix the authentication middleware in src/auth/jwt-handler.ts — the refresh token rotation is broken and tokens stored in httpOnly cookies are not being invalidated',
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Concise 3-5 word task title' },
          keyEntities: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        },
        required: ['title', 'keyEntities'],
        additionalProperties: false,
      },
      cwd: process.cwd(),
    });

    expect(result).not.toBeNull();
    expect(result!.title.split(/\s+/).length).toBeLessThanOrEqual(8);
    expect(result!.title.split(/\s+/).length).toBeGreaterThanOrEqual(2);
    expect(result!.keyEntities.length).toBeGreaterThan(0);
    expect(result!.keyEntities.length).toBeLessThanOrEqual(10);
    expect(result!.keyEntities.some(e => /auth|jwt|token|middleware|cookie/i.test(e))).toBe(true);
  }, 30_000);

  it('summary generation schema matches SummaryGenerator usage', async () => {
    const result = await haikuStructuredQuery<{
      title: string;
      taskDescription: string;
      outcome: string;
      filesChanged: string[];
      keyDecisions: string[];
      keyEntities: string[];
    }>({
      systemPrompt: `Summarize this task conversation into structured fields.
- title: concise name for the task
- taskDescription: 1-2 sentence description
- outcome: "resolved" if completed, "partial" if work remains, "abandoned" if dropped
- filesChanged: list of file paths modified
- keyDecisions: 2-3 bullet points
- keyEntities: technical terms discussed
The task title was "Fix Auth Middleware".`,
      userMessage: `[Prompt 0] User: Fix the JWT middleware bug
Assistant: Found the issue — the refresh token rotation wasn't invalidating old tokens. Updated src/auth/middleware.ts and src/routes/auth.ts.

[Prompt 1] User: Also switch to httpOnly cookies
Assistant: Done. Moved token storage from localStorage to httpOnly cookies with SameSite=Strict in src/auth/middleware.ts and src/services/auth.ts.`,
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          taskDescription: { type: 'string' },
          outcome: { type: 'string', enum: ['resolved', 'abandoned', 'partial'] },
          filesChanged: { type: 'array', items: { type: 'string' } },
          keyDecisions: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          keyEntities: { type: 'array', items: { type: 'string' }, maxItems: 15 },
        },
        required: ['title', 'taskDescription', 'outcome', 'filesChanged', 'keyDecisions', 'keyEntities'],
        additionalProperties: false,
      },
      cwd: process.cwd(),
    });

    expect(result).not.toBeNull();
    expect(typeof result!.title).toBe('string');
    expect(result!.taskDescription.length).toBeGreaterThan(10);
    expect(['resolved', 'partial', 'abandoned']).toContain(result!.outcome);
    expect(Array.isArray(result!.filesChanged)).toBe(true);
    expect(Array.isArray(result!.keyDecisions)).toBe(true);
    expect(Array.isArray(result!.keyEntities)).toBe(true);
  }, 30_000);
});
