import type { ElicitationRequest, ElicitationResult } from '../../../shared/types/elicitation';
import type { PostMessageFn } from '../types';

interface PendingElicitation {
  resolve: (result: ElicitationResult) => void;
  cleanup: () => void;
}

export class ElicitationManager {
  private pendingElicitations: Map<string, PendingElicitation> = new Map();
  private getPostMessage: () => PostMessageFn | null;

  constructor(getPostMessage: () => PostMessageFn | null) {
    this.getPostMessage = getPostMessage;
  }

  async requestElicitation(request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult> {
    const postMessage = this.getPostMessage();
    if (!postMessage) {
      return { action: 'cancel' };
    }

    return new Promise<ElicitationResult>((resolve) => {
      const abortHandler = () => {
        this.pendingElicitations.delete(request.elicitationId);
        resolve({ action: 'cancel' });
      };

      const cleanup = () => {
        signal.removeEventListener('abort', abortHandler);
      };

      this.pendingElicitations.set(request.elicitationId, { resolve, cleanup });
      signal.addEventListener('abort', abortHandler, { once: true });

      postMessage({
        type: 'requestElicitation',
        elicitationId: request.elicitationId,
        serverName: request.serverName,
        message: request.message,
        mode: request.mode,
        ...(request.url !== undefined ? { url: request.url } : {}),
        ...(request.requestedSchema !== undefined ? { requestedSchema: request.requestedSchema } : {}),
      });
    });
  }

  resolveElicitation(elicitationId: string, result: ElicitationResult): void {
    const pending = this.pendingElicitations.get(elicitationId);
    if (!pending) return;

    this.pendingElicitations.delete(elicitationId);
    pending.cleanup();
    pending.resolve(result);
  }

  clearAll(): void {
    for (const [, pending] of this.pendingElicitations) {
      pending.cleanup();
      pending.resolve({ action: 'cancel' });
    }
    this.pendingElicitations.clear();
  }
}
