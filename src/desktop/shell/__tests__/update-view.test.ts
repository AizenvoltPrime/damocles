import { describe, expect, it } from 'vitest';
import type { UpdateState } from '../../preload/updates';
import { pillMenu, pillView, updateTone } from '../update-view';

const STATES: Record<UpdateState['kind'], UpdateState> = {
  disabled: { kind: 'disabled' },
  idle: { kind: 'idle' },
  checking: { kind: 'checking' },
  upToDate: { kind: 'upToDate', checkedAt: 1 },
  available: { kind: 'available', version: '3.5.0', notes: '' },
  downloading: { kind: 'downloading', version: '3.5.0', percent: 42 },
  ready: { kind: 'ready', version: '3.5.0', notes: '' },
  restarting: { kind: 'restarting', version: '3.5.0', notes: '' },
  error: { kind: 'error', reason: 'offline' },
};

describe('update view', () => {
  it('shows the pill only while an update asks something of the user', () => {
    const shown = Object.fromEntries(Object.entries(STATES).map(([kind, state]) => [kind, pillView(state)]));
    expect(shown).toEqual({
      disabled: null,
      idle: null,
      checking: null,
      upToDate: null,
      available: { kind: 'available', version: '3.5.0' },
      downloading: { kind: 'downloading', version: '3.5.0', percent: 42 },
      ready: { kind: 'ready', version: '3.5.0' },
      restarting: { kind: 'restarting', version: '3.5.0' },
      error: null,
    });
  });

  it('offers Restart in the pill menu only once the update is ready, and its notes only then', () => {
    expect(pillMenu({ kind: 'downloading', version: '3.5.0', percent: 10 })).toEqual([
      { action: 'restart', disabled: true },
      { action: 'showLog', disabled: false },
    ]);
    expect(pillMenu({ kind: 'ready', version: '3.5.0' })).toEqual([
      { action: 'restart', disabled: false },
      { action: 'releaseNotes', disabled: false },
      { action: 'showLog', disabled: false },
    ]);
    expect(pillMenu({ kind: 'restarting', version: '3.5.0' })).toEqual([
      { action: 'restart', disabled: true },
      { action: 'showLog', disabled: false },
    ]);
  });

  it('colours the status by state', () => {
    const tones = Object.fromEntries(Object.entries(STATES).map(([kind, state]) => [kind, updateTone(state)]));
    expect(tones).toEqual({
      disabled: 'neutral',
      idle: 'neutral',
      checking: 'accent',
      upToDate: 'success',
      available: 'accent',
      downloading: 'accent',
      ready: 'accent',
      restarting: 'accent',
      error: 'danger',
    });
  });
});
