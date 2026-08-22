/**
 * Assertions for test code that indexes into arrays and maps.
 *
 * `noUncheckedIndexedAccess` makes `items[0]` `T | undefined`, and a spec that then reads a property
 * off it is asserting two things at once: that the element exists, and that it looks right. These
 * split the first assertion out so it fails with a useful message instead of the element's
 * `undefined` silently propagating into a comparison that happens to pass.
 */

export function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`expected an element at index ${index}, but the array holds ${items.length}`);
  }
  return value;
}

/** First argument of the first `name` emit, asserting the emit happened at all. */
export function firstEmit(events: unknown[][] | undefined, name: string): unknown {
  const first = events?.[0];
  if (!first) throw new Error(`expected a '${name}' emit, but none was recorded`);
  return first[0];
}

export function defined<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) {
    throw new Error(`expected ${what} to be defined, got ${String(value)}`);
  }
  return value;
}
