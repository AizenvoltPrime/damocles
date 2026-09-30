import type { QueuedMessage } from '../../shared/types/session';
import type { UserContentBlock } from '../../shared/types/content';

/**
 * Factory for creating queued message objects.
 *
 * Messages are injected directly into the SDK input stream via queueInput().
 * This factory only handles message ID/timestamp generation.
 */
export function createQueuedMessage(content: string | UserContentBlock[]): QueuedMessage {
  return {
    id: `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    content,
    timestamp: Date.now(),
  };
}
