import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../logger', () => ({ log: vi.fn() }));

import { appendSubCallUsage } from '../subcall-ledger';

const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
const message = { provider: 'openai', model: 'gpt-6-luna', stopReason: 'stop' as const, usage };

describe('appendSubCallUsage', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subcall-ledger-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates the directory and appends one JSON line per call', () => {
    const ledger = path.join(dir, 'nested', 'subcalls.jsonl');
    appendSubCallUsage(message, 'btw', { cwd: '/ws', sessionId: 's' }, ledger);
    appendSubCallUsage(message, 'session-title', {}, ledger);
    const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ v: 1, type: 'subcall', purpose: 'btw', provider: 'openai', model: 'gpt-6-luna', stopReason: 'stop', cwd: '/ws', sessionId: 's', usage });
    expect(lines[1]).toMatchObject({ purpose: 'session-title', cwd: null, sessionId: null });
    expect(lines[0]!['id']).not.toBe(lines[1]!['id']);
    expect(Number.isNaN(Date.parse(String(lines[0]!['timestamp'])))).toBe(false);
  });

  it('writes nothing for a call that billed nothing, and trusts tokens over a zero totalTokens', () => {
    const ledger = path.join(dir, 'subcalls.jsonl');
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    appendSubCallUsage({ ...message, usage: zero }, 'btw', {}, ledger);
    expect(fs.existsSync(ledger)).toBe(false);
    appendSubCallUsage({ ...message, usage: { ...zero, input: 7 } }, 'btw', {}, ledger);
    appendSubCallUsage({ ...message, usage: { ...zero, cost: { ...zero.cost, total: 0.01 } } }, 'btw', {}, ledger);
    expect(fs.readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('does not throw when the ledger cannot be written', () => {
    const ledger = path.join(dir, 'is-a-dir');
    fs.mkdirSync(ledger, { recursive: true });
    expect(() => appendSubCallUsage(message, 'memory-merge', {}, ledger)).not.toThrow();
  });
});
