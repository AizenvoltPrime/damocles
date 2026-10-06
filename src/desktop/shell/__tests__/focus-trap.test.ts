// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { trapTab } from '../overlay/focus-trap';

afterEach(() => {
  document.body.replaceChildren();
});

function tab(shiftKey = false): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
}

describe('trapTab', () => {
  it('wraps at the last and first controls outside a part on its way out', () => {
    const root = document.createElement('section');
    const first = document.createElement('button');
    const last = document.createElement('button');
    // A toast playing its exit is inert; its buttons can take no focus, so they cannot be where the cycle ends.
    const leaving = document.createElement('article');
    leaving.setAttribute('inert', '');
    leaving.append(document.createElement('button'));
    root.append(first, last, leaving);
    document.body.append(root);

    last.focus();
    const forward = tab();
    expect(trapTab(forward, root)).toBe(true);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const back = tab(true);
    expect(trapTab(back, root)).toBe(true);
    expect(document.activeElement).toBe(last);
  });
});
