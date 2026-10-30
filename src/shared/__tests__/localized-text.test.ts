import { describe, expect, it } from 'vitest';
import { fillMessage, parseLocalizedText, renderLocalizedText, type LocalizedText } from '../localized-text';
import { localized, INVALID } from '../../desktop/core-protocol/schema';

const deep = (depth: number): unknown => (depth === 0 ? { message: 'leaf' } : { message: '{0}', args: [deep(depth - 1)] });

describe('parseLocalizedText', () => {
  it('takes nested text, numbers and { number }, as a fresh value holding only the fields it knows', () => {
    const raw = { message: '{0} of {1}: {2}', args: ['a', 3, { number: 1234.5 }, { message: 'nested {0}', args: ['b'], extra: true }], comment: 'gone', extra: 1 };
    const parsed = parseLocalizedText(raw, 100);
    expect(parsed).toEqual({ message: '{0} of {1}: {2}', args: ['a', 3, { number: 1234.5 }, { message: 'nested {0}', args: ['b'] }] });
    expect(parsed).not.toBe(raw);
    expect(parseLocalizedText({ message: 'plain' }, 100)).toEqual({ message: 'plain' });
  });

  it('refuses what is not LocalizedText', () => {
    for (const raw of ['a string', null, undefined, 7, [], {}, { message: 7 }, { message: 'x', args: 'a' }, { message: 'x', args: [null] }, { message: 'x', args: [true] }, { message: 'x', args: [{ number: '1' }] }]) {
      expect(parseLocalizedText(raw, 100)).toBeUndefined();
    }
  });

  it('refuses a non-finite number in either form', () => {
    for (const arg of [Number.NaN, Number.POSITIVE_INFINITY, { number: Number.NaN }, { number: Number.NEGATIVE_INFINITY }]) {
      expect(parseLocalizedText({ message: '{0}', args: [arg] }, 100)).toBeUndefined();
    }
  });

  it('bounds every string, the argument count and the nesting', () => {
    expect(parseLocalizedText({ message: 'x'.repeat(11) }, 10)).toBeUndefined();
    expect(parseLocalizedText({ message: '{0}', args: [{ message: 'x'.repeat(11) }] }, 10)).toBeUndefined();
    expect(parseLocalizedText({ message: 'many', args: Array.from({ length: 64 }, () => 'a') }, 10)).not.toBeUndefined();
    expect(parseLocalizedText({ message: 'many', args: Array.from({ length: 65 }, () => 'a') }, 10)).toBeUndefined();
    expect(parseLocalizedText(deep(8), 10)).not.toBeUndefined();
    expect(parseLocalizedText(deep(9), 10)).toBeUndefined();
  });

  it('is the wire\'s localized() parser', () => {
    expect(localized(10)({ message: 'ok', args: [1] })).toEqual({ message: 'ok', args: [1] });
    expect(localized(10)({ message: '{0}', args: [{ number: Number.NaN }] })).toBe(INVALID);
    expect(localized(10)('a string')).toBe(INVALID);
  });
});

describe('fillMessage', () => {
  it('fills positional arguments in one pass and leaves an index with no argument as written', () => {
    expect(fillMessage('{1} then {0} then {1}', ['a', 2])).toBe('2 then a then 2');
    expect(fillMessage('missing {2}', ['a'])).toBe('missing {2}');
    expect(fillMessage('{0}', [false])).toBe('false');
    expect(fillMessage('{0} {1}', ['{1}', 'b'])).toBe('{1} b');
  });

  it('is what the shared renderer fills with', () => {
    const text: LocalizedText = { message: '{0} and {1}', args: [{ number: 1000 }, { message: 'two' }] };
    expect(renderLocalizedText(text, () => undefined, 'en')).toBe('1,000 and two');
  });
});
