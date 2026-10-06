const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A lowercase UUID, the form `crypto.randomUUID()` returns. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
