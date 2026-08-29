/** Reads a table keyed by model-supplied text; a bare index returns an inherited Object.prototype member. */
export function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
