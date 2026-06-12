import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockSessionDir = vi.hoisted(() => ({ value: '' }));

vi.mock('../paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../paths')>();
  return {
    ...actual,
    getSessionDir: async () => mockSessionDir.value,
    getSessionFilePath: async (_workspacePath: string, sessionId: string) => {
      if (!actual.isValidSessionId(sessionId)) {
        throw new Error('Invalid session ID format');
      }
      return path.join(mockSessionDir.value, `${sessionId}.jsonl`);
    },
  };
});

import { readSessionForDisplay } from '../reading';

const WORKSPACE = 'c:\\fake\\workspace';

function writeFixture(sessionId: string, entries: object[]): void {
  const file = path.join(mockSessionDir.value, `${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

beforeAll(() => {
  mockSessionDir.value = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-model-fallback-'));
});

afterAll(() => {
  fs.rmSync(mockSessionDir.value, { recursive: true, force: true });
});

describe('readSessionForDisplay model_fallback replay', () => {
  it('maps a persisted camelCase model_fallback entry on the active branch to ModelFallbackInfo', async () => {
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1';
    writeFixture(sessionId, [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-06-12T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-06-12T10:00:05.000Z', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'system', subtype: 'model_fallback', trigger: 'overloaded', originalModel: 'claude-opus-4-8', fallbackModel: 'claude-sonnet-4-6', content: 'Model fallback occurred', level: 'warning', isMeta: false, uuid: 'fb1', parentUuid: 'a1', timestamp: '2026-06-12T10:00:10.000Z' },
      { type: 'user', uuid: 'u2', parentUuid: 'fb1', timestamp: '2026-06-12T10:00:20.000Z', message: { role: 'user', content: 'continue' } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-06-12T10:00:25.000Z', message: { role: 'assistant', id: 'm2', content: [{ type: 'text', text: 'ok' }] } },
    ]);

    const result = await readSessionForDisplay(WORKSPACE, sessionId);

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.modelFallbacks).toEqual([
      {
        id: 'fb1',
        fromModel: 'claude-opus-4-8',
        toModel: 'claude-sonnet-4-6',
        trigger: 'overloaded',
        timestamp: Date.parse('2026-06-12T10:00:10.000Z'),
      },
    ]);
  });

  it('excludes a model_fallback entry whose uuid is not on the active branch', async () => {
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2';
    writeFixture(sessionId, [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-06-12T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-06-12T10:00:05.000Z', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'system', subtype: 'model_fallback', trigger: 'server_error', originalModel: 'claude-opus-4-8', fallbackModel: 'claude-sonnet-4-6', content: 'Model fallback occurred', level: 'warning', isMeta: false, uuid: 'fb-forked', parentUuid: 'a1', timestamp: '2026-06-12T10:00:10.000Z' },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-06-12T10:00:20.000Z', message: { role: 'user', content: 'rewound turn' } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-06-12T10:00:25.000Z', message: { role: 'assistant', id: 'm2', content: [{ type: 'text', text: 'ok' }] } },
    ]);

    const result = await readSessionForDisplay(WORKSPACE, sessionId);

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.modelFallbacks).toBeUndefined();
  });

  it('excludes model_fallback entries that predate the last compact boundary', async () => {
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3';
    writeFixture(sessionId, [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-06-12T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-06-12T10:00:05.000Z', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'system', subtype: 'model_fallback', trigger: 'overloaded', originalModel: 'claude-opus-4-8', fallbackModel: 'claude-sonnet-4-6', content: 'Model fallback occurred', level: 'warning', isMeta: false, uuid: 'fb-old', parentUuid: 'a1', timestamp: '2026-06-12T10:00:10.000Z' },
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 150000 }, uuid: 'cb1', parentUuid: 'fb-old', timestamp: '2026-06-12T10:01:00.000Z' },
      { type: 'user', uuid: 'u2', parentUuid: 'cb1', timestamp: '2026-06-12T10:02:00.000Z', message: { role: 'user', content: 'after compact' } },
      { type: 'system', subtype: 'model_fallback', trigger: 'server_error', originalModel: 'claude-opus-4-8', fallbackModel: 'claude-sonnet-4-6', content: 'Model fallback occurred', level: 'warning', isMeta: false, uuid: 'fb-new', parentUuid: 'u2', timestamp: '2026-06-12T10:02:30.000Z' },
      { type: 'assistant', uuid: 'a2', parentUuid: 'fb-new', timestamp: '2026-06-12T10:03:00.000Z', message: { role: 'assistant', id: 'm2', content: [{ type: 'text', text: 'ok' }] } },
    ]);

    const result = await readSessionForDisplay(WORKSPACE, sessionId);

    expect(result.compactInfo?.timestamp).toBe(Date.parse('2026-06-12T10:01:00.000Z'));
    expect(result.modelFallbacks?.map(f => f.id)).toEqual(['fb-new']);
  });

  it('includes trailing model_fallback entries dangling below the leaf', async () => {
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4';
    writeFixture(sessionId, [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-06-12T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-06-12T10:00:05.000Z', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'system', subtype: 'model_fallback', trigger: 'overloaded', originalModel: 'claude-opus-4-8', fallbackModel: 'claude-sonnet-4-6', content: 'Model fallback occurred', level: 'warning', isMeta: false, uuid: 'fb-tail-1', parentUuid: 'a1', timestamp: '2026-06-12T10:00:10.000Z' },
      { type: 'system', subtype: 'model_fallback', trigger: 'last_resort', originalModel: 'claude-sonnet-4-6', fallbackModel: 'claude-haiku-4-5', content: 'Model fallback occurred', level: 'warning', isMeta: false, uuid: 'fb-tail-2', parentUuid: 'fb-tail-1', timestamp: '2026-06-12T10:00:11.000Z' },
    ]);

    const result = await readSessionForDisplay(WORKSPACE, sessionId);

    expect(result.modelFallbacks?.map(f => f.id)).toEqual(['fb-tail-1', 'fb-tail-2']);
  });

  it('includes sibling trailing fallbacks both parented on the leaf', async () => {
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee5';
    writeFixture(sessionId, [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-06-12T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-06-12T10:00:05.000Z', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'system', subtype: 'model_fallback', trigger: 'overloaded', originalModel: 'claude-opus-4-8', fallbackModel: 'claude-sonnet-4-6', content: 'Model fallback occurred', level: 'warning', isMeta: false, uuid: 'fb-sib-1', parentUuid: 'a1', timestamp: '2026-06-12T10:00:10.000Z' },
      { type: 'system', subtype: 'model_fallback', trigger: 'last_resort', originalModel: 'claude-sonnet-4-6', fallbackModel: 'claude-haiku-4-5', content: 'Model fallback occurred', level: 'warning', isMeta: false, uuid: 'fb-sib-2', parentUuid: 'a1', timestamp: '2026-06-12T10:00:11.000Z' },
    ]);

    const result = await readSessionForDisplay(WORKSPACE, sessionId);

    expect(result.modelFallbacks?.map(f => f.id)).toEqual(['fb-sib-1', 'fb-sib-2']);
  });
});
