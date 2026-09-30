import { isImageBlock, type ImageBlock } from '../../../shared/types/content';

/** The payload Damocles persists when the user steered a running/queued subagent via `/steer`. */
export interface SteerData {
  agentId: string;
  agentType?: string;
  description?: string;
  message: string;
  /** Absent on a text-only steer and on entries written before steers carried images. */
  images?: ImageBlock[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a persisted `.data` payload (untrusted: hand-edited JSONL, older versions). */
export function isSteerData(value: unknown): value is SteerData {
  if (!isRecord(value)) return false;
  const images = value['images'];
  const hasImages = Array.isArray(images) && images.length > 0 && images.every(isImageBlock);
  return (
    typeof value['agentId'] === 'string' &&
    value['agentId'].length > 0 &&
    typeof value['message'] === 'string' &&
    (value['message'].length > 0 || hasImages) &&
    (images === undefined || hasImages) &&
    (value['agentType'] === undefined || typeof value['agentType'] === 'string') &&
    (value['description'] === undefined || typeof value['description'] === 'string')
  );
}
