import { describe, it, expect } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { extractOriginalInputs } from '../original-input';
import { DAMOCLES_ORIGINAL_INPUT_ENTRY } from '../constants';

function sidecar(userEntryId: string, original: unknown): SessionEntry {
  return { id: `c-${userEntryId}`, type: 'custom', customType: DAMOCLES_ORIGINAL_INPUT_ENTRY, data: { userEntryId, original } } as unknown as SessionEntry;
}

describe('extractOriginalInputs', () => {
  it('maps user entry ids to their recorded original typed input', () => {
    const map = extractOriginalInputs([sidecar('u1', '/example what is the day'), sidecar('u2', '/simplify foo.ts')]);
    expect(map.get('u1')).toBe('/example what is the day');
    expect(map.get('u2')).toBe('/simplify foo.ts');
  });

  it('latest record for an entry id wins (a forked re-record supersedes)', () => {
    const map = extractOriginalInputs([sidecar('u1', '/old'), sidecar('u1', '/new')]);
    expect(map.get('u1')).toBe('/new');
  });

  it('ignores malformed payloads (untrusted JSONL)', () => {
    const map = extractOriginalInputs([
      sidecar('u1', 42),
      { id: 'x', type: 'custom', customType: DAMOCLES_ORIGINAL_INPUT_ENTRY, data: { original: 'no id' } } as unknown as SessionEntry,
      { id: 'y', type: 'custom', customType: 'something-else', data: { userEntryId: 'u2', original: '/x' } } as unknown as SessionEntry,
    ]);
    expect(map.size).toBe(0);
  });

  it('is empty for a branch with no sidecar entries', () => {
    expect(extractOriginalInputs([{ id: 'u1', type: 'message', message: { role: 'user', content: 'hi' } } as unknown as SessionEntry]).size).toBe(0);
  });
});
