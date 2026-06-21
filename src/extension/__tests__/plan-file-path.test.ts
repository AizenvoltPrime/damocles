import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { computePlanFilePath, isPlanFilePath, DAMOCLES_PLANS_DIR } from '../paths';
import { slugify } from '@shared/utils';

describe('slugify', () => {
  it('lowercases and collapses non-alphanumeric runs into single hyphens', () => {
    expect(slugify('Fix the Bug!! (now)')).toBe('fix-the-bug-now');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('  ...Hello... ')).toBe('hello');
  });

  it('returns empty string when there is nothing alphanumeric', () => {
    expect(slugify('—///—')).toBe('');
  });
});

describe('computePlanFilePath', () => {
  const id = 'abcdef1234567890';
  const suffix = (p: string) => path.basename(p, '.md').slice(-8);

  it('is deterministic for the same inputs (same path every call)', () => {
    expect(computePlanFilePath(id, 'Add the feature')).toBe(computePlanFilePath(id, 'Add the feature'));
  });

  it('builds <slug>-<id8>.md under the plans dir with an 8-hex id suffix', () => {
    const p = computePlanFilePath(id, 'Add the feature');
    expect(path.dirname(p)).toBe(DAMOCLES_PLANS_DIR);
    expect(path.basename(p)).toMatch(/^add-the-feature-[0-9a-f]{8}\.md$/);
  });

  it('derives the id suffix from a hash, not a positional slice, so uuidv7 ids sharing a timestamp prefix get distinct paths', () => {
    // uuidv7's leading bytes are a shared millisecond timestamp; only the tail carries entropy. Two ids that
    // differ only past the first 8 chars must still produce different plan files for the same first message.
    const a = '0190aaaa-7000-7000-8000-000000000001';
    const b = '0190aaaa-7000-7000-8000-000000000002';
    expect(a.slice(0, 8)).toBe(b.slice(0, 8));
    expect(computePlanFilePath(a, 'Same message')).not.toBe(computePlanFilePath(b, 'Same message'));
  });

  it('never-prompted sessions (empty first message) still get distinct fallback paths', () => {
    const a = '0190aaaa-7000-7000-8000-000000000001';
    const b = '0190aaaa-7000-7000-8000-000000000002';
    const pa = computePlanFilePath(a, '');
    const pb = computePlanFilePath(b, '');
    expect(path.basename(pa)).toMatch(/^plan-[0-9a-f]{8}\.md$/);
    expect(pa).not.toBe(pb);
  });

  it('caps the slug at 50 chars and trims a trailing hyphen', () => {
    const long = 'a'.repeat(60) + ' ' + 'b'.repeat(60);
    const p = computePlanFilePath(id, long);
    const slug = path.basename(p, '.md').slice(0, -9);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back to "plan" when the first message has no alphanumerics', () => {
    expect(path.basename(computePlanFilePath(id, '???'))).toMatch(/^plan-[0-9a-f]{8}\.md$/);
    expect(path.basename(computePlanFilePath(id, ''))).toMatch(/^plan-[0-9a-f]{8}\.md$/);
    expect(suffix(computePlanFilePath(id, '???'))).toBe(suffix(computePlanFilePath(id, '')));
  });

  it('always resolves inside DAMOCLES_PLANS_DIR even for adversarial messages', () => {
    const p = path.resolve(computePlanFilePath(id, '../../etc/passwd'));
    expect(p.startsWith(path.resolve(DAMOCLES_PLANS_DIR) + path.sep)).toBe(true);
  });
});

describe('isPlanFilePath', () => {
  it('accepts a .md file inside the plans dir (including a computed plan path)', () => {
    expect(isPlanFilePath(path.join(DAMOCLES_PLANS_DIR, 'add-feature-abcdef12.md'))).toBe(true);
    expect(isPlanFilePath(computePlanFilePath('abcdef1234', 'x'))).toBe(true);
  });

  it('rejects paths outside the plans dir, non-.md files, and empty input', () => {
    expect(isPlanFilePath('/repo/app.ts')).toBe(false);
    expect(isPlanFilePath(path.join(DAMOCLES_PLANS_DIR, 'notes.txt'))).toBe(false);
    expect(isPlanFilePath(path.join(path.dirname(DAMOCLES_PLANS_DIR), 'evil.md'))).toBe(false);
    expect(isPlanFilePath('')).toBe(false);
  });
});
