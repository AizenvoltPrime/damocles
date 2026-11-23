// ThemeRead's screenshot card: the user sees the screenshot and allows or denies sending it. It asks in every permission mode,
// YOLO included, and no mode change answers it.
import { randomUUID } from 'node:crypto';
import type { ThemeScreenshotChoice } from '../../../shared/themes/agent';
import { registerAbortablePrompt, type PermissionState } from '../state';
import type { PendingThemeScreenshot, PostMessageFn } from '../types';

export interface ThemeScreenshotAsk {
  readonly toolUseId: string;
  // app://damocles/theme-shot/<id>
  readonly url: string;
  readonly width: number;
  readonly height: number;
  // a chat on a remote host: the device whose window it shows, which alone serves the image, so only its views show the card
  readonly device?: { readonly clientId: string };
}

export class ThemeScreenshotManager {
  private readonly state: PermissionState;
  private readonly getPostMessage: () => PostMessageFn | null;
  private readonly actor: () => string | undefined;

  constructor(state: PermissionState, getPostMessage: () => PostMessageFn | null, actor: () => string | undefined = () => undefined) {
    this.state = state;
    this.getPostMessage = getPostMessage;
    this.actor = actor;
  }

  /** Raises the card until the user answers or `signal` aborts, which resolves undefined. */
  requestThemeScreenshot(ask: ThemeScreenshotAsk, signal: AbortSignal): Promise<ThemeScreenshotChoice | undefined> {
    const promptId = `themeshot-${randomUUID()}`;
    return new Promise<ThemeScreenshotChoice | undefined>((resolve) => {
      const onAborted = (): void => {
        if (this.state.removePendingThemeScreenshot(promptId)) this.getPostMessage()?.({ type: 'themeScreenshotClosed', promptId });
        resolve(undefined);
      };
      const request: PendingThemeScreenshot['request'] = {
        type: 'requestThemeScreenshot',
        promptId,
        toolUseId: ask.toolUseId,
        url: ask.url,
        width: ask.width,
        height: ask.height,
        owner: this.state.promptOwner(null),
      };
      const device = ask.device?.clientId;
      registerAbortablePrompt({
        signal,
        toolUseId: promptId,
        register: () => {
          this.state.addPendingThemeScreenshot(promptId, { resolve, cleanup: () => signal.removeEventListener('abort', onAborted), request, ...(device !== undefined ? { device } : {}) });
          if (device !== undefined) this.state.devicePrompts.set(promptId, (clientId) => (clientId === device ? request : undefined));
          this.state.postPrompt(promptId, request, this.getPostMessage());
        },
        onAborted,
      });
    });
  }

  /**
   * The user's answer from any view; every view drops the card. One from another device, which shows no card, is ignored; one
   * for a card no longer open is answered with its close.
   */
  resolveThemeScreenshot(promptId: string, choice: ThemeScreenshotChoice): void {
    const open = this.state.pendingThemeScreenshots.get(promptId);
    if (open?.device !== undefined && this.actor() !== open.device) return;
    const pending = this.state.removePendingThemeScreenshot(promptId);
    if (!pending) {
      this.getPostMessage()?.({ type: 'themeScreenshotClosed', promptId });
      return;
    }
    pending.cleanup();
    this.getPostMessage()?.({ type: 'themeScreenshotClosed', promptId });
    pending.resolve(choice);
  }
}
