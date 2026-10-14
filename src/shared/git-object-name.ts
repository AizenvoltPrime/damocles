/** A full object name, SHA-1 or SHA-256: the only commit form a renderer or a pinned tab names. */
export function isObjectName(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}
