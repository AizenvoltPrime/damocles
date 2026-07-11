import { describe, it, expect } from 'vitest';
import type { MemoryEntry } from '@shared/types/memory';
import { formatMemoryForCopy } from '../format-memory-copy';

/**
 * `formatMemoryForCopy` (Slice 1 memory copy button): deterministic plaintext serializer for the
 * clipboard. Verifies section ordering, that ALL facts are copied (no 3-fact display truncation),
 * empty/absent sections are omitted, observationTags win over tags, and the function stays pure.
 * Two cases pin the EXACT output layout (whole-string toBe) to lock inter-section \n\n spacing and
 * header-block ordering, not just presence via toContain.
 */

// Minimal MemoryEntry factory: only the copy-relevant fields matter, the rest are structural fillers.
function makeMemory(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'id-1',
    tier: 'note',
    content: 'body',
    sessionId: null,
    workspace: null,
    createdAt: 0,
    updatedAt: 0,
    tags: [],
    ...overrides,
  };
}

describe('formatMemoryForCopy', () => {
  it('serializes an observation with all fields: exact layout, title first, Type second, ALL facts, observationTags', () => {
    const memory = makeMemory({
      id: 'obs-1',
      tier: 'observation',
      title: 'Refactored serializer',
      observationType: 'refactor',
      content: 'Extracted the plaintext serializer into a pure module.',
      facts: ['fact one', 'fact two', 'fact three', 'fact four', 'fact five'],
      observationTags: ['mechanism', 'rationale'],
      tags: ['ignored-tag'],
    });

    const output = formatMemoryForCopy(memory);
    const lines = output.split('\n');

    // Title is the FIRST line; Type is the SECOND — header-block ordering is exact.
    expect(lines[0]).toBe('Refactored serializer');
    expect(lines[1]).toBe('Type: refactor');
    // Content present.
    expect(output).toContain('Extracted the plaintext serializer into a pure module.');
    // ALL facts present (more than 3 — proves no truncation).
    expect(output).toContain('Facts:');
    for (const fact of memory.facts!) {
      expect(output).toContain(`- ${fact}`);
    }
    // Tags line uses observationTags, NOT tags.
    expect(output).toContain('Tags: mechanism, rationale');
    expect(output).not.toContain('ignored-tag');
    // Exact deterministic layout: single blank line between every section, no trailing newline.
    expect(output).toBe(
      [
        'Refactored serializer',
        'Type: refactor',
        '',
        'Extracted the plaintext serializer into a pure module.',
        '',
        'Facts:',
        '- fact one',
        '- fact two',
        '- fact three',
        '- fact four',
        '- fact five',
        '',
        'Tags: mechanism, rationale',
      ].join('\n'),
    );
  });

  it('omits Facts block and Tags line for an observation without facts or tags', () => {
    const memory = makeMemory({
      id: 'obs-2',
      tier: 'observation',
      title: 'Empty-ish observation',
      observationType: 'insight',
      content: 'Just a body.',
      tags: [],
    });

    const output = formatMemoryForCopy(memory);

    expect(output).toContain('Empty-ish observation');
    expect(output).toContain('Type: insight');
    expect(output).toContain('Just a body.');
    expect(output).not.toContain('Facts:');
    expect(output).not.toContain('Tags:');
  });

  it('serializes a fact item with kind, scope, and tags — no title line', () => {
    const memory = makeMemory({
      id: 'fact-1',
      tier: 'project',
      content: 'The build uses vite.',
      kind: 'fact',
      scope: 'project',
      tags: ['build', 'tooling'],
    });

    const output = formatMemoryForCopy(memory);

    // No title line: first line is the content.
    expect(output.split('\n')[0]).toBe('The build uses vite.');
    expect(output).toContain('Kind: fact');
    expect(output).toContain('Scope: project');
    expect(output).toContain('Tags: build, tooling');
    expect(output).not.toContain('Type:');
    // Exact layout: content, blank line, then Kind/Scope/Tags trailer (no blank lines within it).
    expect(output).toBe(
      ['The build uses vite.', '', 'Kind: fact', 'Scope: project', 'Tags: build, tooling'].join('\n'),
    );
  });

  it('serializes a bare note as just its content with no stray labels', () => {
    const memory = makeMemory({
      id: 'note-1',
      content: 'Remember to hydrate.',
      tags: [],
    });

    const output = formatMemoryForCopy(memory);

    expect(output).toBe('Remember to hydrate.');
    for (const label of ['Facts:', 'Tags:', 'Type:', 'Kind:', 'Scope:']) {
      expect(output).not.toContain(label);
    }
  });

  it('omits the Tags line entirely for an empty tags array', () => {
    const memory = makeMemory({
      id: 'note-2',
      content: 'No tags here.',
      tags: [],
    });

    const output = formatMemoryForCopy(memory);

    expect(output).toContain('No tags here.');
    expect(output).not.toContain('Tags:');
  });

  it('falls back to tags when observationTags is absent (fallback branch)', () => {
    const memory = makeMemory({
      id: 'obs-fallback',
      tier: 'observation',
      title: 'Fallback tags',
      observationType: 'insight',
      content: 'Body.',
      tags: ['alpha', 'beta'],
      // observationTags intentionally omitted → the Tags line must use `tags`.
    });

    const output = formatMemoryForCopy(memory);
    expect(output).toContain('Tags: alpha, beta');
  });

  it.each([
    ['preference', 'global'],
    ['episode', 'session'],
  ] as const)('serializes a %s item with kind and scope', (kind, scope) => {
    const memory = makeMemory({
      id: `kind-${kind}`,
      content: 'A durable statement.',
      kind,
      scope,
      tags: ['x'],
    });

    const output = formatMemoryForCopy(memory);
    expect(output).toBe(
      ['A durable statement.', '', `Kind: ${kind}`, `Scope: ${scope}`, 'Tags: x'].join('\n'),
    );
  });

  it('collapses embedded newlines in title and facts to single lines (layout guarantee)', () => {
    const memory = makeMemory({
      id: 'multiline',
      tier: 'observation',
      title: 'Title with\na break',
      observationType: 'fix',
      content: 'Body stays\nverbatim across lines.',
      facts: ['fact with\n\na blank line', 'second - dash fact'],
      observationTags: ['impact'],
    });

    const output = formatMemoryForCopy(memory);
    const lines = output.split('\n');

    // Title collapsed to one line; Type still line index 1 (contract preserved).
    expect(lines[0]).toBe('Title with a break');
    expect(lines[1]).toBe('Type: fix');
    // Multi-line content is printed verbatim (NOT normalized).
    expect(output).toContain('Body stays\nverbatim across lines.');
    // Each fact is a single bullet line — the blank line inside a fact does not fracture the block.
    expect(output).toContain('- fact with a blank line');
    expect(output).toContain('- second - dash fact');
    // No fact bullet is empty (would signal a fractured block).
    expect(output).not.toContain('- \n');
  });

  it('is pure: same input yields same output and never mutates the input', () => {
    const memory = makeMemory({
      id: 'pure-1',
      tier: 'observation',
      title: 'Pure check',
      observationType: 'fix',
      content: 'Body.',
      facts: ['a', 'b'],
      observationTags: ['caveat'],
      tags: ['t'],
    });
    const snapshot = structuredClone(memory);

    const first = formatMemoryForCopy(memory);
    const second = formatMemoryForCopy(memory);

    expect(first).toBe(second);
    expect(memory).toEqual(snapshot);
  });
});
