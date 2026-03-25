import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReadStateTracker } from '../read-state-tracker';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../logger', () => ({ log: vi.fn() }));

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests — ReadStateTracker
//
// Validates the tracker captures {path, mtime} correctly, resolves relative
// paths, deduplicates, and handles edge cases.
// ─────────────────────────────────────────────────────────────────────────────

describe('ReadStateTracker', () => {
  let tracker: ReadStateTracker;
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'readstate-'));
    testFile = join(tmpDir, 'test.ts');
    writeFileSync(testFile, 'const x = 1;\n');
    tracker = new ReadStateTracker(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('captures resolved path and floored mtime on trackRead', async () => {
    await tracker.trackRead('test.ts');

    expect(tracker.size).toBe(1);
    const [[trackedPath, mtime]] = [...tracker.entries()];
    expect(trackedPath).toBe(testFile);

    const actual = statSync(testFile);
    expect(mtime).toBe(Math.floor(actual.mtimeMs));
  });

  it('resolves relative paths against cwd', async () => {
    await tracker.trackRead('test.ts');
    const [[trackedPath]] = [...tracker.entries()];
    expect(trackedPath).toBe(testFile);
  });

  it('handles absolute paths', async () => {
    await tracker.trackRead(testFile);
    const [[trackedPath]] = [...tracker.entries()];
    expect(trackedPath).toBe(testFile);
  });

  it('deduplicates by resolved path — last mtime wins', async () => {
    await tracker.trackRead('test.ts');

    await new Promise(r => setTimeout(r, 50));
    writeFileSync(testFile, 'const x = 2;\n');

    await tracker.trackRead('test.ts');
    expect(tracker.size).toBe(1);

    const [[, mtime]] = [...tracker.entries()];
    const actual = statSync(testFile);
    expect(mtime).toBe(Math.floor(actual.mtimeMs));
  });

  it('silently skips non-existent files', async () => {
    await tracker.trackRead('nonexistent.ts');
    expect(tracker.size).toBe(0);
  });

  it('clear removes all entries', async () => {
    await tracker.trackRead('test.ts');
    expect(tracker.size).toBe(1);
    tracker.clear();
    expect(tracker.size).toBe(0);
  });

  it('tracks multiple distinct files', async () => {
    const otherFile = join(tmpDir, 'other.ts');
    writeFileSync(otherFile, 'const y = 2;\n');

    await tracker.trackRead('test.ts');
    await tracker.trackRead('other.ts');
    expect(tracker.size).toBe(2);

    const paths = [...tracker.entries()].map(([p]) => p);
    expect(paths).toContain(testFile);
    expect(paths).toContain(otherFile);
  });

  it('retains entries across tracker lifetime (no closeAndReset — only clear on full reset)', async () => {
    await tracker.trackRead('test.ts');
    expect(tracker.size).toBe(1);
    const [[trackedPath]] = [...tracker.entries()];
    expect(trackedPath).toBe(testFile);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests — seedReadState with real Claude model
//
// These verify that query.seedReadState() allows Edit to succeed on a
// brand-new query that never Read the file itself. This is the exact
// scenario that occurs in recall mode: every turn recreates the SDK query
// via closeAndReset() → ensureStreamingQuery(), wiping the SDK's internal
// read state. Without seedReadState, Edit fails with "file not read yet."
//
// Models: Sonnet 4.6
//
// Run:
//   DAMOCLES_INTEGRATION=1 npx vitest run src/extension/claude-session/__tests__/read-state-tracker.test.ts
//
// Cost: ~$0.05-0.10 per full run
// ─────────────────────────────────────────────────────────────────────────────

const INTEGRATION = !!process.env['DAMOCLES_INTEGRATION'];
const ROOT_MODEL = 'claude-sonnet-4-6';
const integrationSuite = INTEGRATION ? describe : describe.skip;

integrationSuite('integration: seedReadState — Edit works after context loss (Sonnet)', () => {
  let tmpDir: string;
  let testFile: string;
  let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = mkdtempSync(join(tmpdir(), 'seed-read-int-'));
    testFile = join(tmpDir, 'target.ts');
    writeFileSync(testFile, 'export const greeting = "hello world";\n');

    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    queryFn = sdk.query;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Edit succeeds on new query when read state is seeded', async () => {
    const tracker = new ReadStateTracker(tmpDir);

    // ── Query 1: Read the file ──────────────────────────────────────────
    // Claude reads target.ts. Only Read is auto-approved; all other tools
    // are denied so Claude doesn't try to do anything else.
    const q1 = queryFn({
      prompt: 'Read the file "target.ts" in the current directory. Only read it, do nothing else.',
      options: {
        model: ROOT_MODEL,
        cwd: tmpDir,
        maxTurns: 3,
        persistSession: false,
        allowedTools: ['Read'],
        canUseTool: async (_toolName: string, input: Record<string, unknown>) => {
          return { behavior: 'allow' as const, updatedInput: input };
        },
        tools: { type: 'preset', preset: 'claude_code' },
        systemPrompt: { type: 'preset', preset: 'claude_code' },
      },
    });

    for await (const _msg of q1) {
      // Consume all stream events until the query completes
    }

    // Capture read state — mirrors the PostToolUse hook behavior in production.
    // In the real flow, hook-handlers.ts calls tracker.trackRead(filePath) when
    // a Read tool completes. Here we call it manually with the known test file.
    await tracker.trackRead(testFile);
    expect(tracker.size).toBe(1);

    // ── Query 2: New query with seeded read state ───────────────────────
    // Uses an async iterable prompt (like production) to ensure
    // seedReadState is applied before the SDK processes the first message.
    const promptText = [
      'Edit the file "target.ts" using the Edit tool.',
      'The file currently contains exactly one line:',
      'export const greeting = "hello world";',
      '',
      'Add a comment "// SEED_TEST_MARKER" as the very first line.',
      'Use old_string=\'export const greeting\' and new_string=\'// SEED_TEST_MARKER\\nexport const greeting\'',
    ].join('\n');

    let resolvePrompt: () => void;
    const promptReady = new Promise<void>(r => { resolvePrompt = r; });

    async function* inputStream() {
      await promptReady;
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: promptText },
        parent_tool_use_id: null,
      };
    }

    const q2 = queryFn({
      prompt: inputStream(),
      options: {
        model: ROOT_MODEL,
        cwd: tmpDir,
        maxTurns: 5,
        persistSession: false,
        allowedTools: ['Edit'],
        disallowedTools: ['Read', 'Write'],
        canUseTool: async (_toolName: string, input: Record<string, unknown>) => {
          return { behavior: 'allow' as const, updatedInput: input };
        },
        tools: { type: 'preset', preset: 'claude_code' },
        systemPrompt: { type: 'preset', preset: 'claude_code' },
      },
    });

    // Seed read state AFTER query creation, BEFORE releasing the prompt.
    // This mirrors production: postQueryCreatedHook → seedReadState → input arrives.
    for (const [filePath, mtime] of tracker.entries()) {
      await q2.seedReadState(filePath, mtime);
    }
    resolvePrompt!();

    for await (const _msg of q2) {
      // Consume all events
    }

    const content = readFileSync(testFile, 'utf-8');
    expect(content).toContain('SEED_TEST_MARKER');
  }, 120_000);

  it('Edit fails on fresh query without seeded read state (control)', async () => {
    // ── Query 1: Read the file ──────────────────────────────────────────
    const q1 = queryFn({
      prompt: 'Read "target.ts". Only read it.',
      options: {
        model: ROOT_MODEL,
        cwd: tmpDir,
        maxTurns: 3,
        persistSession: false,
        allowedTools: ['Read'],
        canUseTool: async (_toolName: string, input: Record<string, unknown>) => {
          return { behavior: 'allow' as const, updatedInput: input };
        },
        tools: { type: 'preset', preset: 'claude_code' },
        systemPrompt: { type: 'preset', preset: 'claude_code' },
      },
    });

    for await (const _msg of q1) {}

    // ── Query 2: NO seed, Read disallowed ───────────────────────────────
    // The SDK's internal read-state guard rejects Edit ("file not read
    // yet") because there's no seed and Read is disallowed.
    let resolvePrompt: () => void;
    const promptReady = new Promise<void>(r => { resolvePrompt = r; });

    async function* inputStream() {
      await promptReady;
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: [
          'Edit "target.ts" using the Edit tool.',
          'The file contains: export const greeting = "hello world";',
          'Add "// NO_SEED_MARKER" as the first line.',
        ].join('\n') },
        parent_tool_use_id: null,
      };
    }

    const q2 = queryFn({
      prompt: inputStream(),
      options: {
        model: ROOT_MODEL,
        cwd: tmpDir,
        maxTurns: 5,
        persistSession: false,
        allowedTools: ['Edit'],
        disallowedTools: ['Read', 'Write'],
        canUseTool: async (_toolName: string, input: Record<string, unknown>) => {
          return { behavior: 'allow' as const, updatedInput: input };
        },
        tools: { type: 'preset', preset: 'claude_code' },
        systemPrompt: { type: 'preset', preset: 'claude_code' },
      },
    });

    // Do NOT seed read state — this is the "before fix" scenario
    resolvePrompt!();

    for await (const _msg of q2) {}

    // File should remain unmodified — Edit was rejected by SDK
    const content = readFileSync(testFile, 'utf-8');
    expect(content).not.toContain('NO_SEED_MARKER');
    expect(content).toBe('export const greeting = "hello world";\n');
  }, 120_000);
});
