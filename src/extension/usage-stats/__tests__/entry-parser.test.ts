import { describe, it, expect } from 'vitest';
import { normalizeModelKey, parseLedgerLine, parseSessionLine } from '../entry-parser';

const usage = (input: number, output: number, total: number) => ({
  input, output, cacheRead: 3, cacheWrite: 4, totalTokens: input + output + 7,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total },
});

const line = (value: unknown) => JSON.stringify(value);

describe('parseSessionLine', () => {
  it('reads a header', () => {
    expect(parseSessionLine(line({ type: 'session', version: 3, id: 'sess-1', timestamp: '2025-03-01T10:00:00.000Z', cwd: '/work' }))).toEqual({
      kind: 'header', id: 'sess-1', timestamp: '2025-03-01T10:00:00.000Z', startedMs: Date.parse('2025-03-01T10:00:00.000Z'), cwd: '/work',
    });
  });

  it('reads a title, a model change and both launch kinds', () => {
    expect(parseSessionLine(line({ type: 'session_info', id: 'a1', timestamp: '2025-03-01T10:00:00.000Z', name: 'Fix it' }))).toEqual({ kind: 'title', name: 'Fix it' });
    expect(parseSessionLine(line({ type: 'model_change', id: 'a2', timestamp: 'x', provider: 'anthropic', modelId: 'claude-opus-4-1' })))
      .toEqual({ kind: 'model', provider: 'anthropic', model: 'claude-opus-4-1' });
    expect(parseSessionLine(line({ type: 'custom', customType: 'damocles-agent-launch', data: { kind: 'subagent', agentId: 'a', agentType: 'Explore' } })))
      .toEqual({ kind: 'launch', detail: 'Explore' });
    expect(parseSessionLine(line({ type: 'custom', customType: 'damocles-agent-launch', data: { kind: 'team-member', agentId: 'a', role: 'reviewer' } })))
      .toEqual({ kind: 'launch', detail: 'reviewer' });
  });

  it.each(['aborted', 'error', 'stop'])('counts an assistant message whatever its stop reason (%s)', (stopReason) => {
    const parsed = parseSessionLine(line({
      type: 'message', id: 'ab12cd34', timestamp: '2025-03-01T10:00:01.000Z',
      message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4-5', stopReason, usage: usage(10, 5, 0.33) },
    }));
    expect(parsed).toMatchObject({
      kind: 'usage', id: 'ab12cd34', entryKind: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4-5', stopReason,
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 4, cost: { total: 0.33 } },
    });
  });

  it('keys cache warms, compactions, branch summaries and tool results by entry kind', () => {
    const at = { id: 'ee11ff22', timestamp: '2025-03-01T10:00:02.000Z' };
    expect(parseSessionLine(line({ ...at, type: 'usage', kind: 'cache_warm', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', usage: usage(1, 1, 0.1) })))
      .toMatchObject({ entryKind: 'usage:cache_warm', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
    expect(parseSessionLine(line({ ...at, type: 'compaction', summary: 's', firstKeptEntryId: 'x', tokensBefore: 9, usage: usage(1, 1, 0.1) })))
      .toMatchObject({ entryKind: 'compaction', provider: null, model: null });
    expect(parseSessionLine(line({ ...at, type: 'branch_summary', fromId: 'x', summary: 's', usage: usage(1, 1, 0.1) })))
      .toMatchObject({ entryKind: 'branch_summary' });
    expect(parseSessionLine(line({ ...at, type: 'message', message: { role: 'toolResult', usage: usage(1, 1, 0.1) } })))
      .toMatchObject({ entryKind: 'tool_result' });
  });

  it('skips lines without any marker before parsing them', () => {
    expect(parseSessionLine('{"type":"message","message":{"role":"user","content":"hi"}}')).toEqual({ kind: 'skip' });
    expect(parseSessionLine('not json and no marker')).toEqual({ kind: 'skip' });
  });

  it('skips usage-free entries that pass the prefilter', () => {
    expect(parseSessionLine(line({ type: 'message', id: 'a', timestamp: 't', message: { role: 'user', content: '"usage":{' } }))).toEqual({ kind: 'skip' });
  });

  it('reports malformed marker lines as errors and never throws', () => {
    expect(parseSessionLine('{"type":"session","id":')).toEqual({ kind: 'error' });
    expect(parseSessionLine('{"usage":{"input":1}')).toEqual({ kind: 'error' });
    expect(parseSessionLine(line({ type: 'session', id: 'x', timestamp: 'not a date', cwd: '/w' }))).toEqual({ kind: 'error' });
    expect(parseSessionLine(line({ type: 'message', timestamp: '2025-03-01T10:00:00.000Z', message: { role: 'assistant', usage: usage(1, 1, 1) } })))
      .toEqual({ kind: 'error' });
  });
});

describe('parseLedgerLine', () => {
  const record = {
    v: 1, type: 'subcall', id: '6f1c', timestamp: '2025-03-02T08:00:00.000Z', purpose: 'session-title', provider: 'anthropic',
    model: 'claude-haiku-4-5', stopReason: 'toolUse', cwd: '/work', sessionId: 'sess-1', usage: usage(20, 2, 0.05),
  };

  it('reads a sub-call record', () => {
    expect(parseLedgerLine(line(record))).toMatchObject({
      kind: 'usage', id: '6f1c', entryKind: 'subcall', purpose: 'session-title', cwd: '/work', sessionId: 'sess-1',
      provider: 'anthropic', model: 'claude-haiku-4-5', stopReason: 'toolUse', usage: { input: 20, output: 2, cost: { total: 0.05 } },
    });
  });

  it('keeps a record with no project or session', () => {
    expect(parseLedgerLine(line({ ...record, cwd: null, sessionId: null }))).toMatchObject({ cwd: null, sessionId: null });
  });

  it('reports a truncated or incomplete record as an error', () => {
    expect(parseLedgerLine(line(record).slice(0, -5))).toEqual({ kind: 'error' });
    expect(parseLedgerLine(line({ ...record, provider: undefined }))).toEqual({ kind: 'error' });
  });
});

describe('normalizeModelKey', () => {
  const registry = new Set(['anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-4-5-20250929']);

  it('maps a dated id to its base when only the base is registered', () => {
    expect(normalizeModelKey('anthropic', 'claude-haiku-4-5-20251001', registry)).toBe('anthropic/claude-haiku-4-5');
  });

  it('keeps a registered dated id and an unknown id as they are', () => {
    expect(normalizeModelKey('anthropic', 'claude-sonnet-4-5-20250929', registry)).toBe('anthropic/claude-sonnet-4-5-20250929');
    expect(normalizeModelKey('openai', 'gpt-5-20250101', registry)).toBe('openai/gpt-5-20250101');
  });

  it('never maps across providers', () => {
    expect(normalizeModelKey('bedrock', 'claude-haiku-4-5-20251001', registry)).toBe('bedrock/claude-haiku-4-5-20251001');
  });
});
