import { describe, it, expect } from 'vitest';
import { definedProps } from '../definedProps';

/**
 * The vendored `components/ui` wrappers forward their props with `v-bind="definedProps(props)"`.
 * The contract that makes that a no-op at runtime is narrow: drop exactly the undefined-valued keys
 * and keep everything else, including falsy values that a truthiness filter would have eaten.
 */
describe('definedProps', () => {
  it('drops keys whose value is undefined', () => {
    const result = definedProps({ as: 'button', asChild: undefined });
    expect(Object.keys(result)).toEqual(['as']);
    expect('asChild' in result).toBe(false);
  });

  it('keeps falsy values that are not undefined', () => {
    const result = definedProps({ a: false, b: 0, c: '', d: null, e: NaN });
    expect(result).toEqual({ a: false, b: 0, c: '', d: null, e: NaN });
    expect(Object.keys(result)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps function values, so forwarded emit handlers survive', () => {
    const onSelect = () => {};
    const result = definedProps({ onSelect, onLeave: undefined });
    expect(result.onSelect).toBe(onSelect);
    expect('onLeave' in result).toBe(false);
  });

  it('returns a plain object rather than mutating the source', () => {
    const source = { a: 1, b: undefined };
    const result = definedProps(source);
    expect(result).not.toBe(source);
    expect('b' in source).toBe(true);
  });

  it('yields an empty object when every value is undefined', () => {
    expect(definedProps({ a: undefined, b: undefined })).toEqual({});
  });
});
