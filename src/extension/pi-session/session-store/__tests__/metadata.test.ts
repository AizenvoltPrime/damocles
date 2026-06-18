import { describe, test, expect } from 'vitest';
import type { SessionEntry, SessionHeader } from '@earendil-works/pi-coding-agent';
import { mapPiFieldsToStored, computePiSessionFields, type PiSessionFields } from '../metadata';
import { DAMOCLES_USER_RENAMED_ENTRY, DAMOCLES_TAG_ENTRY } from '../constants';

describe('mapPiFieldsToStored', () => {
  const base: PiSessionFields = {
    id: 'id-2',
    name: 'A title',
    firstMessage: 'first',
    messageCount: 2,
    created: 1000,
    modified: 2000,
    userRenamed: false,
    tag: undefined,
  };

  test('auto title (no rename marker) maps name to aiTitle', () => {
    const stored = mapPiFieldsToStored(base);
    expect(stored.aiTitle).toBe('A title');
    expect(stored.customTitle).toBeUndefined();
  });

  test('user-renamed session maps name to customTitle', () => {
    const stored = mapPiFieldsToStored({ ...base, userRenamed: true });
    expect(stored.customTitle).toBe('A title');
    expect(stored.aiTitle).toBeUndefined();
  });

  test('no name leaves both title fields unset', () => {
    const stored = mapPiFieldsToStored({ ...base, name: undefined });
    expect(stored.aiTitle).toBeUndefined();
    expect(stored.customTitle).toBeUndefined();
  });

  test('a tag is carried onto the StoredSession; absence omits it', () => {
    expect(mapPiFieldsToStored({ ...base, tag: 'wip' }).tag).toBe('wip');
    expect(mapPiFieldsToStored(base).tag).toBeUndefined();
  });
});

describe('computePiSessionFields', () => {
  const header: SessionHeader = {
    type: 'session',
    id: 'id-3',
    timestamp: '2026-06-18T00:00:00.000Z',
    cwd: '/ws',
  };

  function msg(role: 'user' | 'assistant', text: string, timestamp: number): SessionEntry {
    return {
      type: 'message',
      id: `m-${timestamp}`,
      parentId: null,
      timestamp: new Date(timestamp).toISOString(),
      message: { role, content: [{ type: 'text', text }], timestamp },
    } as unknown as SessionEntry;
  }

  test('counts message entries and takes the first user message as the preview', () => {
    const entries = [
      msg('user', 'first question', 1_000),
      msg('assistant', 'an answer', 2_000),
      msg('user', 'second question', 3_000),
    ];
    const fields = computePiSessionFields(header, entries, undefined, 9_999);
    expect(fields.messageCount).toBe(3);
    expect(fields.firstMessage).toBe('first question');
    expect(fields.modified).toBe(3_000);
    expect(fields.userRenamed).toBe(false);
  });

  test('falls back to "(no messages)" when there is no user text', () => {
    const fields = computePiSessionFields(header, [], undefined, 9_999);
    expect(fields.firstMessage).toBe('(no messages)');
    expect(fields.messageCount).toBe(0);
    expect(fields.modified).toBe(new Date('2026-06-18T00:00:00.000Z').getTime());
  });

  test('messageCount counts only user/assistant turns, not tool-result messages', () => {
    const toolResult = {
      type: 'message',
      id: 'tr-1',
      parentId: null,
      timestamp: new Date(1_500).toISOString(),
      message: { role: 'toolResult', content: [{ type: 'text', text: 'output' }], timestamp: 1_500 },
    } as unknown as SessionEntry;
    const entries = [msg('user', 'q', 1_000), toolResult, msg('assistant', 'a', 2_000)];
    expect(computePiSessionFields(header, entries, undefined, 9_999).messageCount).toBe(2);
  });

  test('firstMessage skips a synthetic <…>-prefixed prompt and uses the first real one', () => {
    const entries = [msg('user', '<system-context> injected', 1_000), msg('user', 'real question', 2_000)];
    expect(computePiSessionFields(header, entries, undefined, 9_999).firstMessage).toBe('real question');
  });

  test('detects the user-rename marker custom entry', () => {
    const marker = {
      type: 'custom',
      id: 'c-1',
      parentId: null,
      timestamp: '2026-06-18T00:00:00.000Z',
      customType: DAMOCLES_USER_RENAMED_ENTRY,
    } as unknown as SessionEntry;
    const fields = computePiSessionFields(header, [marker, msg('user', 'hi', 1_000)], 'renamed', 9_999);
    expect(fields.userRenamed).toBe(true);
    expect(fields.name).toBe('renamed');
    expect(fields.messageCount).toBe(1);
  });

  function tagEntry(tag: string | null, id: string): SessionEntry {
    return {
      type: 'custom',
      id,
      parentId: null,
      timestamp: '2026-06-18T00:00:00.000Z',
      customType: DAMOCLES_TAG_ENTRY,
      data: { tag },
    } as unknown as SessionEntry;
  }

  test('folds the latest tag entry into the fields (latest wins, null clears)', () => {
    expect(computePiSessionFields(header, [tagEntry('red', 't1')], undefined, 9_999).tag).toBe('red');
    expect(computePiSessionFields(header, [tagEntry('red', 't1'), tagEntry('green', 't2')], undefined, 9_999).tag).toBe('green');
    expect(computePiSessionFields(header, [tagEntry('red', 't1'), tagEntry(null, 't2')], undefined, 9_999).tag).toBeUndefined();
  });
});
