import type { ElicitationRequest, ElicitationResult } from '../../../shared/types/elicitation';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { registerAbortablePrompt, type PermissionState } from '../state';
import type { PostMessageFn } from '../types';

export class ElicitationManager {
  private state: PermissionState;
  private getPostMessage: () => PostMessageFn | null;

  constructor(state: PermissionState, getPostMessage: () => PostMessageFn | null) {
    this.state = state;
    this.getPostMessage = getPostMessage;
  }

  async requestElicitation(request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult> {
    const postMessage = this.getPostMessage();
    if (!postMessage) {
      return { action: 'cancel' };
    }

    return new Promise<ElicitationResult>((resolve) => {
      const abortHandler = () => {
        this.state.removePendingElicitation(request.elicitationId);
        resolve({ action: 'cancel' });
      };

      const cleanup = () => {
        signal.removeEventListener('abort', abortHandler);
      };

      const message: ExtensionToWebviewMessage = {
        type: 'requestElicitation',
        elicitationId: request.elicitationId,
        serverName: request.serverName,
        message: request.message,
        mode: request.mode,
        ...(request.url !== undefined ? { url: request.url } : {}),
        ...(request.requestedSchema !== undefined ? { requestedSchema: request.requestedSchema } : {}),
      };

      registerAbortablePrompt({
        signal,
        toolUseId: request.elicitationId,
        register: () => {
          this.state.addPendingElicitation(request.elicitationId, { resolve, cleanup, request: message });
          postMessage(message);
        },
        onAborted: abortHandler,
      });
    });
  }

  resolveElicitation(elicitationId: string, result: ElicitationResult): void {
    const pending = this.state.removePendingElicitation(elicitationId);
    if (!pending) return;

    pending.cleanup();
    pending.resolve(result);
  }
}
