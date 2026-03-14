import { describe, it, expect } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Context chunking tests
//
// These test the chunking algorithm used by hook-handlers.ts to split recall
// context into 9K-char pieces for the SDK's 10K additionalContext limit.
// The algorithm is replicated here to test the contract independently.
// If the production implementation in hook-handlers.ts changes, these tests
// should be updated to match.
//
// Source: src/extension/claude-session/hook-handlers.ts (chunkText function)
// ─────────────────────────────────────────────────────────────────────────────

const RECALL_CHUNK_SIZE = 9_000;

function chunkText(text: string, maxChunkSize: number): string[] {
  if (text.length <= maxChunkSize) return [text];

  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    if (text.length - pos <= 0) break;
    if (text.length - pos <= maxChunkSize) {
      chunks.push(text.substring(pos));
      break;
    }

    const end = pos + maxChunkSize;
    const newlineAt = text.lastIndexOf('\n', end);
    const splitAt = newlineAt > pos ? newlineAt : end;

    chunks.push(text.substring(pos, splitAt));
    pos = splitAt + (text[splitAt] === '\n' ? 1 : 0);
  }

  return chunks;
}

function wrapChunks(chunks: string[]): string[] {
  if (chunks.length === 1) {
    return [`<recall_session_context>\n${chunks[0]}\n</recall_session_context>`];
  }
  return chunks.map((chunk, i) =>
    `<recall_session_context part="${i + 1}" of="${chunks.length}">\n${chunk}\n</recall_session_context>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Basic chunking behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('chunkText: basic behavior', () => {
  it('returns single chunk for text under maxChunkSize', () => {
    const text = 'Hello, world!';
    const chunks = chunkText(text, RECALL_CHUNK_SIZE);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('returns single chunk for text exactly at maxChunkSize', () => {
    const text = 'x'.repeat(RECALL_CHUNK_SIZE);
    const chunks = chunkText(text, RECALL_CHUNK_SIZE);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('returns two chunks for text at maxChunkSize + 1', () => {
    const text = 'x'.repeat(RECALL_CHUNK_SIZE + 1);
    const chunks = chunkText(text, RECALL_CHUNK_SIZE);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBeLessThanOrEqual(RECALL_CHUNK_SIZE);
    expect(chunks[1]!.length).toBeGreaterThan(0);
  });

  it('returns correct number of chunks for large text', () => {
    const size = RECALL_CHUNK_SIZE * 5 + 100;
    const text = 'x'.repeat(size);
    const chunks = chunkText(text, RECALL_CHUNK_SIZE);

    expect(chunks).toHaveLength(6);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(RECALL_CHUNK_SIZE);
    }
  });

  it('handles empty string', () => {
    const chunks = chunkText('', RECALL_CHUNK_SIZE);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('');
  });

  it('handles single character', () => {
    const chunks = chunkText('a', RECALL_CHUNK_SIZE);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Newline-aware splitting
// ─────────────────────────────────────────────────────────────────────────────

describe('chunkText: newline-aware splitting', () => {
  it('splits at newline boundary when available', () => {
    const line = 'x'.repeat(4000);
    const text = `${line}\n${line}\n${line}`;
    const chunks = chunkText(text, RECALL_CHUNK_SIZE);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(RECALL_CHUNK_SIZE);
    }
    const firstChunkNewlines = (chunks[0]!.match(/\n/g) || []).length;
    expect(firstChunkNewlines).toBeLessThanOrEqual(1);
  });

  it('splits at exact boundary when no newline is available', () => {
    const text = 'x'.repeat(RECALL_CHUNK_SIZE * 2);
    const chunks = chunkText(text, RECALL_CHUNK_SIZE);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBe(RECALL_CHUNK_SIZE);
    expect(chunks[1]!.length).toBe(RECALL_CHUNK_SIZE);
  });

  it('does not include the newline character at the split point in either chunk', () => {
    const before = 'a'.repeat(8000);
    const after = 'b'.repeat(5000);
    const text = `${before}\n${after}`;
    const chunks = chunkText(text, RECALL_CHUNK_SIZE);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.endsWith('\n')).toBe(false);
    expect(chunks[1]!.startsWith('\n')).toBe(false);
  });

  it('handles text with very short lines (many newlines)', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `Line ${i}: data`);
    const text = lines.join('\n');
    const chunks = chunkText(text, RECALL_CHUNK_SIZE);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(RECALL_CHUNK_SIZE);
    }
  });

  it('handles text with newlines near the exact boundary', () => {
    const firstPart = 'x'.repeat(RECALL_CHUNK_SIZE - 1);
    const text = `${firstPart}\nmore text here`;
    const chunks = chunkText(text, RECALL_CHUNK_SIZE);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(firstPart);
    expect(chunks[1]).toBe('more text here');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content preservation
// ─────────────────────────────────────────────────────────────────────────────

describe('chunkText: content preservation', () => {
  it('all content is preserved after chunking (no newlines)', () => {
    const text = 'x'.repeat(RECALL_CHUNK_SIZE * 3 + 500);
    const chunks = chunkText(text, RECALL_CHUNK_SIZE);
    const reassembled = chunks.join('');

    expect(reassembled).toBe(text);
  });

  it('all content is preserved after chunking (with newlines)', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'data '.repeat(20)}`);
    const text = lines.join('\n');
    const chunks = chunkText(text, RECALL_CHUNK_SIZE);
    const reassembled = chunks.join('\n');

    expect(reassembled).toBe(text);
  });

  it('preserves exact text for single-chunk case', () => {
    const text = 'Hello\nWorld\nFoo\nBar';
    const chunks = chunkText(text, RECALL_CHUNK_SIZE);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Realistic recall context scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe('chunkText: realistic recall context', () => {
  function buildRecallContext(turnCount: number): string {
    const turns = Array.from({ length: turnCount }, (_, i) => {
      const userMsg = `User prompt ${i}: ${'implement feature '.repeat(10)}`;
      const assistantMsg = `Assistant response ${i}: ${'I made the following changes. '.repeat(30)}`;
      return `[Prompt ${i}] User: ${userMsg}\nAssistant: ${assistantMsg}`;
    });
    return turns.join('\n\n');
  }

  it('small recall context (3 turns) fits in one chunk', () => {
    const context = buildRecallContext(3);
    const chunks = chunkText(context, RECALL_CHUNK_SIZE);

    expect(chunks).toHaveLength(1);
    expect(context.length).toBeLessThan(RECALL_CHUNK_SIZE);
  });

  it('medium recall context (10 turns) chunks correctly', () => {
    const context = buildRecallContext(10);
    const chunks = chunkText(context, RECALL_CHUNK_SIZE);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(RECALL_CHUNK_SIZE);
    }
  });

  it('large recall context (50 turns) chunks into many pieces', () => {
    const context = buildRecallContext(50);
    const chunks = chunkText(context, RECALL_CHUNK_SIZE);

    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(RECALL_CHUNK_SIZE);
    }
  });

  it('each chunk starts with recognizable content (not mid-word)', () => {
    const context = buildRecallContext(20);
    const chunks = chunkText(context, RECALL_CHUNK_SIZE);

    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk).toMatch(/^[\[A-Za-z]/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wrap chunks with XML tags (as hook-handlers does)
// ─────────────────────────────────────────────────────────────────────────────

describe('wrapChunks: XML tag wrapping', () => {
  it('single chunk gets no part numbering', () => {
    const wrapped = wrapChunks(['Hello world']);

    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]).toContain('<recall_session_context>');
    expect(wrapped[0]).not.toContain('part=');
    expect(wrapped[0]).toContain('Hello world');
  });

  it('multiple chunks get sequential part numbering', () => {
    const wrapped = wrapChunks(['chunk1', 'chunk2', 'chunk3']);

    expect(wrapped).toHaveLength(3);
    expect(wrapped[0]).toContain('part="1" of="3"');
    expect(wrapped[1]).toContain('part="2" of="3"');
    expect(wrapped[2]).toContain('part="3" of="3"');
  });

  it('wrapped chunks contain the original content', () => {
    const chunks = ['first chunk content', 'second chunk content'];
    const wrapped = wrapChunks(chunks);

    expect(wrapped[0]).toContain('first chunk content');
    expect(wrapped[1]).toContain('second chunk content');
  });

  it('each wrapped chunk has opening and closing tags', () => {
    const wrapped = wrapChunks(['a', 'b']);

    for (const w of wrapped) {
      expect(w).toContain('<recall_session_context');
      expect(w).toContain('</recall_session_context>');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end chunking + wrapping
// ─────────────────────────────────────────────────────────────────────────────

describe('end-to-end: chunk + wrap', () => {
  it('small context produces single wrapped entry', () => {
    const context = 'Short recall context';
    const chunks = chunkText(context, RECALL_CHUNK_SIZE);
    const wrapped = wrapChunks(chunks);

    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]).toContain('Short recall context');
    expect(wrapped[0]).not.toContain('part=');
  });

  it('large context produces numbered wrapped entries all under SDK limit', () => {
    const SDK_LIMIT = 10_000;
    const context = 'x'.repeat(50_000);
    const chunks = chunkText(context, RECALL_CHUNK_SIZE);
    const wrapped = wrapChunks(chunks);

    expect(wrapped.length).toBeGreaterThan(1);
    for (const w of wrapped) {
      expect(w.length).toBeLessThan(SDK_LIMIT);
    }
  });

  it('100K context produces correct number of wrapped entries', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `Turn ${i}: ${'context '.repeat(10)}`);
    const context = lines.join('\n');
    const chunks = chunkText(context, RECALL_CHUNK_SIZE);
    const wrapped = wrapChunks(chunks);

    const expectedChunks = Math.ceil(context.length / RECALL_CHUNK_SIZE);
    expect(wrapped.length).toBeGreaterThanOrEqual(expectedChunks - 1);
    expect(wrapped.length).toBeLessThanOrEqual(expectedChunks + 1);

    const totalText = wrapped.join('');
    for (let i = 0; i < Math.min(50, lines.length); i++) {
      expect(totalText).toContain(`Turn ${i}:`);
    }
  });

  it('maxInjectedChars cap is applied before chunking', () => {
    const maxInjectedChars = 20_000;
    let context = 'x'.repeat(50_000);

    if (context.length > maxInjectedChars) {
      context = context.substring(0, maxInjectedChars);
    }

    const chunks = chunkText(context, RECALL_CHUNK_SIZE);
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);

    expect(totalLength).toBeLessThanOrEqual(maxInjectedChars);
  });

  it('overflow entry count matches chunk count minus one', () => {
    const context = 'x'.repeat(45_000);
    const chunks = chunkText(context, RECALL_CHUNK_SIZE);

    const primaryEntry = 1;
    const overflowEntries = chunks.length - primaryEntry;
    expect(overflowEntries).toBe(chunks.length - 1);
    expect(overflowEntries).toBeGreaterThan(0);
  });
});
