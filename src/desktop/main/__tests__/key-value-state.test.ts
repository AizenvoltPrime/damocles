import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopKeyValueState } from '../platform/key-value-state';
import { flushAcrossHeldRename } from '../../../__mocks__/held-rename';

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-state-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('desktop key-value state', () => {
  it('persists an update that a new instance reads, and removes a key set to undefined', async () => {
    const state = createDesktopKeyValueState(userData, () => undefined);
    await state.global.update('a', { n: 1 });
    await state.global.update('b', 2);
    await state.global.update('b', undefined);
    const reopened = createDesktopKeyValueState(userData, () => undefined);
    expect(reopened.global.get('a')).toEqual({ n: 1 });
    expect(reopened.global.get('b', 'none')).toBe('none');
  });

  it('keeps the value in memory and fires nothing when the write fails', async () => {
    const state = createDesktopKeyValueState(userData, () => undefined);
    await state.workspace.update('damocles.defaultWorkspaceFolder', 'a');
    const listener = vi.fn();
    state.onDidChange('workspace', 'damocles.defaultWorkspaceFolder', listener);
    const file = path.join(userData, 'state', 'workspace.json');
    fs.rmSync(file);
    fs.mkdirSync(file);
    await expect(state.workspace.update('damocles.defaultWorkspaceFolder', 'b')).rejects.toThrow();
    expect(state.workspace.get('damocles.defaultWorkspaceFolder')).toBe('a');
    expect(listener).not.toHaveBeenCalled();
  });

  it('resolves an update and tells every listener when one of them throws', async () => {
    const lines: string[] = [];
    const state = createDesktopKeyValueState(userData, (line) => lines.push(line));
    const second = vi.fn();
    state.onDidChange('global', 'language', () => {
      throw new Error('menu rebuild failed');
    });
    state.onDidChange('global', 'language', second);
    await expect(state.global.update('language', 'el')).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledOnce();
    expect(lines.some((line) => line.startsWith('[state] a listener threw') && line.includes('menu rebuild failed'))).toBe(true);
  });

  it('keeps both of two concurrent updates', async () => {
    const state = createDesktopKeyValueState(userData, () => undefined);
    await Promise.all([state.global.update('a', 1), state.global.update('b', 2)]);
    expect(createDesktopKeyValueState(userData, () => undefined).global.get('a')).toBe(1);
    expect(createDesktopKeyValueState(userData, () => undefined).global.get('b')).toBe(2);
    expect([state.global.get('a'), state.global.get('b')]).toEqual([1, 2]);
  });

  it('flush waits for a write in flight and for one queued while it waits, in either memento', async () => {
    const state = createDesktopKeyValueState(userData, () => undefined);
    await state.workspace.update('seed', 0);
    const onDisk = await flushAcrossHeldRename(path.join(userData, 'state', 'global.json'), {
      first: () => state.global.update('a', 1),
      flush: () => state.flush(),
      second: () => Promise.all([state.global.update('b', 2), state.workspace.update('c', 3)]),
      onDisk: () => {
        const reopened = createDesktopKeyValueState(userData, () => undefined);
        return [reopened.global.get('a'), reopened.global.get('b'), reopened.workspace.get('c')];
      },
    });
    expect(onDisk).toEqual([1, 2, 3]);
  });
});
