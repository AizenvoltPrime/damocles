import { describe, it, expect } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { UnpersistedToolImages } from '../unpersisted-tool-images';

function fakeSession() {
  const listeners = new Set<(e: unknown) => void>();
  return {
    session: { subscribe: (l: (e: unknown) => void) => { listeners.add(l); return () => listeners.delete(l); } } as unknown as AgentSession,
    emit: (e: unknown) => { for (const l of listeners) l(e); },
    listenerCount: () => listeners.size,
  };
}

const png = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
const toolEnd = (toolCallId: string, content: unknown[], isError = false) =>
  ({ type: 'tool_execution_end', toolCallId, toolName: 'browser_screenshot', result: { content }, isError });
const resultEnd = (toolCallId: string) => ({ type: 'message_end', message: { role: 'toolResult', toolCallId, content: [] } });

describe('UnpersistedToolImages', () => {
  it('records a successful result with images until its toolResult message ends', () => {
    const cache = new UnpersistedToolImages();
    const s = fakeSession();
    cache.track(s.session);
    s.emit(toolEnd('t1', [{ type: 'text', text: 'shot' }, png]));
    expect(cache.get('t1')).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
    s.emit(resultEnd('t1'));
    expect(cache.get('t1')).toBeUndefined();
  });

  it('skips a failed result and a result without images', () => {
    const cache = new UnpersistedToolImages();
    const s = fakeSession();
    cache.track(s.session);
    s.emit(toolEnd('failed', [png], true));
    s.emit(toolEnd('text', [{ type: 'text', text: 'ok' }]));
    expect(cache.get('failed')).toBeUndefined();
    expect(cache.get('text')).toBeUndefined();
  });

  it('agent_end drops results whose message_end never came, from that session only', () => {
    const cache = new UnpersistedToolImages();
    const a = fakeSession();
    const b = fakeSession();
    cache.track(a.session);
    cache.track(b.session);
    a.emit(toolEnd('a1', [png]));
    b.emit(toolEnd('b1', [png]));
    a.emit({ type: 'agent_end', messages: [] });
    expect(cache.get('a1')).toBeUndefined();
    expect(cache.get('b1')).toBeDefined();
    a.emit(toolEnd('a2', [png]));
    expect(cache.get('a2')).toBeDefined();
  });

  it('untrack unsubscribes and drops that session\'s ids only', () => {
    const cache = new UnpersistedToolImages();
    const a = fakeSession();
    const b = fakeSession();
    cache.track(a.session);
    cache.track(b.session);
    a.emit(toolEnd('a1', [png]));
    b.emit(toolEnd('b1', [png]));
    cache.untrack(a.session);
    expect(a.listenerCount()).toBe(0);
    expect(cache.get('a1')).toBeUndefined();
    expect(cache.get('b1')).toBeDefined();
    a.emit(toolEnd('a2', [png]));
    expect(cache.get('a2')).toBeUndefined();
  });

  it('clear untracks every session', () => {
    const cache = new UnpersistedToolImages();
    const s = fakeSession();
    cache.track(s.session);
    s.emit(toolEnd('t1', [png]));
    cache.clear();
    expect(cache.get('t1')).toBeUndefined();
    expect(s.listenerCount()).toBe(0);
  });
});
