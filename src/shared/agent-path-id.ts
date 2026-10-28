/** pi's session id rule (`assertValidSessionId`); also keeps every id a single safe path segment. */
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isSafeAgentPathId(id: string): boolean {
  return SAFE_ID.test(id);
}
