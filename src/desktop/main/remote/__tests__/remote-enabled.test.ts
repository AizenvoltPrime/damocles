import { describe, expect, it, vi } from 'vitest';
import { gated, remoteEnabled } from '../remote-enabled';

describe('remoteEnabled', () => {
  it('shows remote features in a development build whatever DAMOCLES_REMOTE says', () => {
    expect(remoteEnabled({ isPackaged: false }, {})).toBe(true);
    expect(remoteEnabled({ isPackaged: false }, { DAMOCLES_REMOTE: '0' })).toBe(true);
    expect(remoteEnabled({ isPackaged: false }, { DAMOCLES_REMOTE: '1' })).toBe(true);
  });

  it('hides them in a packaged build unless DAMOCLES_REMOTE is exactly 1', () => {
    expect(remoteEnabled({ isPackaged: true }, {})).toBe(false);
    expect(remoteEnabled({ isPackaged: true }, { DAMOCLES_REMOTE: '0' })).toBe(false);
    expect(remoteEnabled({ isPackaged: true }, { DAMOCLES_REMOTE: 'true' })).toBe(false);
    expect(remoteEnabled({ isPackaged: true }, { DAMOCLES_REMOTE: '1' })).toBe(true);
  });
});

describe('gated', () => {
  it('serves a remote entry point only while the gate is open, and never reaches it past a closed one', () => {
    const serve = vi.fn(() => 'hosts');
    expect(() => gated(false, serve)).toThrow('not enabled');
    expect(serve).not.toHaveBeenCalled();
    expect(gated(true, serve)).toBe('hosts');
  });
});
