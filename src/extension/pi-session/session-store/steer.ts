/** The payload Damocles persists when the user steered a running/queued subagent via `/steer`. */
export interface SteerData {
  agentId: string;
  agentType?: string;
  description?: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a persisted `.data` payload (untrusted: hand-edited JSONL, older versions). */
export function isSteerData(value: unknown): value is SteerData {
  return (
    isRecord(value) &&
    typeof value['agentId'] === 'string' &&
    value['agentId'].length > 0 &&
    typeof value['message'] === 'string' &&
    value['message'].length > 0 &&
    (value['agentType'] === undefined || typeof value['agentType'] === 'string') &&
    (value['description'] === undefined || typeof value['description'] === 'string')
  );
}
