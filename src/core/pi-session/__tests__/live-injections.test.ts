import { describe, it, expect } from 'vitest';
import { CONTEXT_INJECTION_CUSTOM_TYPE, readLiveInjections } from '../live-injections';
import type { ContextInjectionDetailsV1 } from '../../memory/injection/details';

function details(over: Partial<ContextInjectionDetailsV1> = {}): ContextInjectionDetailsV1 {
  return { v: 1, promptIndex: 0, memories: [], notices: [], profile: false, compassKey: null, ...over };
}

function injection(d: unknown, customType = CONTEXT_INJECTION_CUSTOM_TYPE): unknown {
  return { role: 'custom', customType, content: 'text', display: false, details: d, timestamp: 0 };
}

describe('readLiveInjections', () => {
  it('folds memories, profile presence and the newest compass key', () => {
    const live = readLiveInjections([
      { role: 'user', content: 'hi', timestamp: 0 },
      injection(details({ promptIndex: 0, memories: [{ id: 'a', hash: 'h1', tier: 'full' }], profile: true, compassKey: 'k1' })),
      injection(details({ promptIndex: 1, memories: [{ id: 'b', hash: 'h2', tier: 'compact' }] })),
      injection(details({ promptIndex: 2, compassKey: 'k2' })),
    ]);
    expect([...live.memories.keys()]).toEqual(['a', 'b']);
    expect(live.memories.get('b')).toEqual({ hash: 'h2', tier: 'compact', promptIndex: 1 });
    expect(live.profileInContext).toBe(true);
    expect(live.compassKey).toBe('k2');
  });

  it('ignores invalid details and other custom types', () => {
    const live = readLiveInjections([
      injection({ v: 2, promptIndex: 0, memories: [{ id: 'x', hash: 'h', tier: 'full' }], notices: [], profile: true, compassKey: null }),
      injection(details({ memories: [{ id: 'y', hash: 'h', tier: 'huge' as never }] })),
      injection(undefined),
      injection(details({ memories: [{ id: 'z', hash: 'h', tier: 'full' }], profile: true }), 'other-type'),
    ]);
    expect(live.memories.size).toBe(0);
    expect(live.profileInContext).toBe(false);
  });

  it('never reads ids out of the message text', () => {
    const quoting = {
      role: 'custom',
      customType: CONTEXT_INJECTION_CUSTOM_TYPE,
      content: '<damocles_memory><memory id="985d5b12-ff9a-499f-922c-5dcdf2e9a8fe">x</memory></damocles_memory>',
      display: false,
      timestamp: 0,
    };
    expect(readLiveInjections([quoting]).memories.size).toBe(0);
  });

  it('lets full beat compact in either order', () => {
    const upgraded = readLiveInjections([
      injection(details({ memories: [{ id: 'a', hash: 'h', tier: 'compact' }] })),
      injection(details({ promptIndex: 1, memories: [{ id: 'a', hash: 'h', tier: 'full' }] })),
    ]);
    expect(upgraded.memories.get('a')?.tier).toBe('full');

    const notDowngraded = readLiveInjections([
      injection(details({ memories: [{ id: 'a', hash: 'h', tier: 'full' }] })),
      injection(details({ promptIndex: 1, memories: [{ id: 'a', hash: 'h', tier: 'compact' }] })),
    ]);
    expect(notDowngraded.memories.get('a')).toEqual({ hash: 'h', tier: 'full', promptIndex: 0 });
  });

  it('retires an id on a forgotten or superseded notice', () => {
    const live = readLiveInjections([
      injection(details({ memories: [{ id: 'a', hash: 'h', tier: 'full' }, { id: 'b', hash: 'h', tier: 'full' }] })),
      injection(details({
        promptIndex: 1,
        notices: [{ id: 'a', kind: 'forgotten' }, { id: 'b', kind: 'superseded' }],
        memories: [{ id: 'b2', hash: 'n', tier: 'full' }],
      })),
    ]);
    expect([...live.memories.keys()]).toEqual(['b2']);
  });

  it('updates the hash on an edited notice', () => {
    const live = readLiveInjections([
      injection(details({ memories: [{ id: 'a', hash: 'old', tier: 'compact' }] })),
      injection(details({ promptIndex: 3, notices: [{ id: 'a', kind: 'edited' }], memories: [{ id: 'a', hash: 'new', tier: 'full' }] })),
    ]);
    expect(live.memories.get('a')).toEqual({ hash: 'new', tier: 'full', promptIndex: 3 });
  });
});
