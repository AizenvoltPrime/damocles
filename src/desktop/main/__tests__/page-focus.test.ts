import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { leavePageOnPartKeys, partStepOf } from '../page-focus';

const key = (keyName: string, mods: { shift?: boolean; control?: boolean; alt?: boolean; meta?: boolean } = {}, type: 'keyDown' | 'keyUp' = 'keyDown') =>
  ({ type, key: keyName, shift: false, control: false, alt: false, meta: false, ...mods });

describe('partStepOf', () => {
  it('reads Focus Next Part\'s and Focus Previous Part\'s accelerators, F6 and Shift+F6, as they go down', () => {
    expect(partStepOf(key('F6'))).toBe(1);
    expect(partStepOf(key('F6', { shift: true }))).toBe(-1);
  });

  it('reads nothing else: another key, F6 with Ctrl, Alt or Meta, F6 coming up, and Escape, which stays the page\'s', () => {
    for (const input of [key('F5'), key('Tab'), key('Escape'), key('F6', { control: true }), key('F6', { alt: true }), key('F6', { meta: true }), key('F6', {}, 'keyUp')]) {
      expect(partStepOf(input)).toBeUndefined();
    }
  });
});

describe('leavePageOnPartKeys', () => {
  it('keeps F6 and Shift+F6 from the page and moves focus a part on or back, and lets every other key through', () => {
    const contents = new EventEmitter();
    const focusPart = vi.fn();
    leavePageOnPartKeys(contents as unknown as Pick<WebContents, 'on'>, focusPart);
    const press = (input: ReturnType<typeof key>): boolean => {
      const event = { preventDefault: vi.fn() };
      contents.emit('before-input-event', event, input);
      return event.preventDefault.mock.calls.length > 0;
    };
    expect([press(key('F6')), press(key('F6', { shift: true })), press(key('a')), press(key('Escape')), press(key('F6', {}, 'keyUp'))]).toEqual([true, true, false, false, false]);
    expect(focusPart.mock.calls).toEqual([[1], [-1]]);
  });
});
