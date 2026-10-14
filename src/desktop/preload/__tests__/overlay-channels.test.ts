import { describe, expect, it } from 'vitest';
import { MAX_OVERLAY_LABEL_LENGTH, MAX_OVERLAY_TEXT_LENGTH, parseInputAnswer, parseInputRequest, tidyMenu, type OverlayMenuItem } from '../overlay-channels';
import { MAX_INPUT_VALUE_LENGTH } from '../../../shared/input-validation';

const item = (id: string): OverlayMenuItem => ({ kind: 'item', id, label: id });
const separator: OverlayMenuItem = { kind: 'separator' };

describe('tidyMenu', () => {
  it('drops the separators conditional sections leave at either end or doubled, and keeps the items in order', () => {
    expect(tidyMenu([separator, item('a'), separator, separator, item('b'), separator])).toEqual([item('a'), separator, item('b')]);
    expect(tidyMenu([separator, separator])).toEqual([]);
    expect(tidyMenu([])).toEqual([]);
    const plain = [item('a'), separator, item('b')];
    expect(tidyMenu(plain)).toEqual(plain);
  });
});

describe('parseInputRequest', () => {
  const request = { kind: 'input', title: 'Commit to a New Branch', prompt: 'Please provide a new branch name', placeholder: 'Branch name', value: 'me/', valueSelection: [3, 3], validation: 'branchName' };

  it('copies a request within bounds and drops unknown fields', () => {
    expect(parseInputRequest({ ...request, extra: 1 })).toEqual(request);
    expect(parseInputRequest({ kind: 'input', prompt: 'Name' })).toEqual({ kind: 'input', prompt: 'Name' });
  });

  it('refuses a malformed or unbounded request', () => {
    const refused: unknown[] = [
      undefined,
      { ...request, kind: 'message' },
      { ...request, prompt: '' },
      { ...request, prompt: 'p'.repeat(MAX_OVERLAY_TEXT_LENGTH + 1) },
      { ...request, title: 't'.repeat(MAX_OVERLAY_LABEL_LENGTH + 1) },
      { ...request, placeholder: 7 },
      { ...request, value: 'v'.repeat(MAX_INPUT_VALUE_LENGTH + 1) },
      { ...request, validation: 'email' },
      { ...request, valueSelection: [3, 4] },
      { ...request, valueSelection: [2, 1] },
      { ...request, valueSelection: [-1, 0] },
      { ...request, valueSelection: [0.5, 1] },
      { ...request, valueSelection: [0] },
      { kind: 'input', prompt: 'Name', valueSelection: [0, 1] },
    ];
    for (const raw of refused) expect(parseInputRequest(raw), JSON.stringify(raw)).toBeUndefined();
  });

  it('takes a password box, but never with a validation kind or a prefilled value', () => {
    const password = { kind: 'input', title: 'Git Authentication', prompt: "Password for 'https://example.com':", placeholder: 'Password', password: true };
    expect(parseInputRequest(password)).toEqual(password);
    expect(parseInputRequest({ kind: 'input', prompt: 'Name', password: false })).toEqual({ kind: 'input', prompt: 'Name' });
    expect(parseInputRequest({ ...password, validation: 'branchName' })).toBeUndefined();
    expect(parseInputRequest({ ...password, value: 'hunter2' })).toBeUndefined();
    expect(parseInputRequest({ ...password, password: 'yes' })).toBeUndefined();
  });
});

describe('parseInputAnswer', () => {
  const branch = { kind: 'input', prompt: 'Name', validation: 'branchName' } as const;
  const posix = { windows: false };

  it('accepts a value the validation kind accepts, and any bounded string without one', () => {
    expect(parseInputAnswer({ kind: 'input', value: 'me/fix' }, branch, posix)).toBe('me/fix');
    expect(parseInputAnswer({ kind: 'input', value: 'a b' }, { kind: 'input', prompt: 'Name' }, posix)).toBe('a b');
  });

  it('refuses a path Windows would resolve elsewhere only when main runs on Windows', () => {
    const path = { kind: 'input', prompt: 'Path', validation: 'path' } as const;
    expect(parseInputAnswer({ kind: 'input', value: 'src/con.ts' }, path, { windows: true })).toBeUndefined();
    expect(parseInputAnswer({ kind: 'input', value: 'src/con.ts' }, path, posix)).toBe('src/con.ts');
  });

  it('refuses what the overlay should have blocked', () => {
    expect(parseInputAnswer({ kind: 'input', value: 'a..b' }, branch, posix)).toBeUndefined();
    expect(parseInputAnswer({ kind: 'input', value: '' }, branch, posix)).toBeUndefined();
    expect(parseInputAnswer({ kind: 'input', value: 7 }, branch, posix)).toBeUndefined();
    expect(parseInputAnswer({ kind: 'input', value: '../x' }, { kind: 'input', prompt: 'Path', validation: 'path' }, posix)).toBeUndefined();
    expect(parseInputAnswer({ kind: 'input', value: 'v'.repeat(MAX_INPUT_VALUE_LENGTH + 1) }, { kind: 'input', prompt: 'Name' }, posix)).toBeUndefined();
  });
});
