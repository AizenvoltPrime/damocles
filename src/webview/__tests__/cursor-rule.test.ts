// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The base cursor rule in style.css: every enabled clickable control shows the pointer, a disabled one the default cursor. */

function cursorRule(): string {
  const style = readFileSync(join(__dirname, '..', 'style.css'), 'utf8');
  const start = style.indexOf('@layer base {');
  const end = style.indexOf('\n}\n', start);
  // happy-dom ignores rules inside @layer, so the block is applied without its wrapper.
  return style.slice(start + '@layer base {'.length, end);
}

beforeAll(() => {
  const sheet = document.createElement('style');
  sheet.textContent = cursorRule();
  document.head.appendChild(sheet);
});

const cursor = (selector: string): string => getComputedStyle(document.querySelector(selector)!).cursor;

describe('the base cursor rule', () => {
  it('gives native checkboxes and radios and their labels the pointer, and keeps the default cursor when disabled', () => {
    document.body.innerHTML = `
      <label id="check"><input type="checkbox"> Remember</label>
      <label id="radio"><input type="radio"> One</label>
      <label id="off"><input type="checkbox" disabled> Locked</label>
      <input id="text" type="text">`;

    expect(cursor('#check')).toBe('pointer');
    expect(cursor('#check input')).toBe('pointer');
    expect(cursor('#radio')).toBe('pointer');
    expect(cursor('#radio input')).toBe('pointer');
    expect(cursor('#off')).toBe('default');
    expect(cursor('#off input')).toBe('default');
    expect(cursor('#text')).not.toBe('pointer');
  });
});
