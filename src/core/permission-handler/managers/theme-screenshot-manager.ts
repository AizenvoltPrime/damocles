// ThemeRead's screenshot card: the user sees the screenshot (or, for a draft, its name and miniature) and allows it once,
// allows it for the chat, or denies it. It asks in every permission mode, YOLO included, and no mode change answers it or
// grants the chat; only the user's Allow for this chat does.
import { randomUUID } from 'node:crypto';
import type { ThemeScreenshotChoice } from '../../../shared/themes/agent';
import type { ThemeFile } from '../../../shared/themes/schema';
import { registerAbortablePrompt, type PermissionState } from '../state';
import type { PendingThemeScreenshot, PostMessageFn } from '../types';

export type ThemeScreenshotAsk = {
  readonly toolUseId: string;
  // the chat's session id, which Allow for this chat grants on this computer
  readonly chat: string;
  // a chat on a remote host: the device whose window it shows, which alone serves the image and holds the chat's grant, so
  // only its views show the card
  readonly device?: { readonly clientId: string };
} & (
  // app://damocles/theme-shot/<id>
  | { readonly url: string; readonly width: number; readonly height: number; readonly draft?: never }
  // a draft main paints and captures only after the Allow; captureId: on a device's card, the capture its main holds
  | { readonly draft: { readonly name: string; readonly theme: ThemeFile }; readonly captureId?: string; readonly url?: never }
);

export class ThemeScreenshotManager {
  private readonly state: PermissionState;
  private readonly getPostMessage: () => PostMessageFn | null;
  private readonly actor: () => string | undefined;
  // the session id of the chat this panel granted, in memory only; never set for a device's card, whose main holds the grant
  private granted: string | undefined;

  constructor(state: PermissionState, getPostMessage: () => PostMessageFn | null, actor: () => string | undefined = () => undefined) {
    this.state = state;
    this.getPostMessage = getPostMessage;
    this.actor = actor;
  }

  /** Raises the card until the user answers or `signal` aborts, which resolves undefined; a device's allowChat resolves allow. */
  requestThemeScreenshot(ask: ThemeScreenshotAsk, signal: AbortSignal): Promise<ThemeScreenshotChoice | undefined> {
    const promptId = `themeshot-${randomUUID()}`;
    return new Promise<ThemeScreenshotChoice | undefined>((resolve) => {
      const onAborted = (): void => {
        if (this.state.removePendingThemeScreenshot(promptId)) this.getPostMessage()?.({ type: 'themeScreenshotClosed', promptId });
        resolve(undefined);
      };
      const device = ask.device?.clientId;
      const shown = ask.draft === undefined
        ? { url: ask.url, width: ask.width, height: ask.height }
        : { draft: { name: ask.draft.name, theme: ask.draft.theme }, ...(device !== undefined && ask.captureId !== undefined ? { captureId: ask.captureId } : {}) };
      const request: PendingThemeScreenshot['request'] = {
        type: 'requestThemeScreenshot',
        promptId,
        toolUseId: ask.toolUseId,
        ...shown,
        owner: this.state.promptOwner(null),
      };
      registerAbortablePrompt({
        signal,
        toolUseId: promptId,
        register: () => {
          this.state.addPendingThemeScreenshot(promptId, { resolve, cleanup: () => signal.removeEventListener('abort', onAborted), request, ...(device !== undefined ? { device } : { chat: ask.chat }) });
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
    if (choice === 'allowChat') {
      if (pending.device !== undefined) {
        pending.resolve('allow');
        return;
      }
      if (this.granted !== pending.chat) {
        this.granted = pending.chat;
        this.getPostMessage()?.({ type: 'themeScreenshotGrant', granted: true });
      }
    }
    pending.resolve(choice);
  }

  /** Whether the user allowed every screenshot of this chat, on this computer. */
  screenshotGranted(chat: string): boolean {
    return this.granted === chat;
  }

  /** Ends the grant: of any chat (the strip's Revoke, which the page always hears answered), or only of `chat` (main's notice). */
  revokeScreenshotGrant(chat?: string): void {
    if (chat !== undefined && chat !== this.granted) return;
    this.granted = undefined;
    this.getPostMessage()?.({ type: 'themeScreenshotGrant', granted: false });
  }

  /** The panel's live session is `sessionId` now; a grant of any other session ends. */
  endScreenshotGrantUnless(sessionId: string): void {
    if (this.granted !== undefined && this.granted !== sessionId) this.revokeScreenshotGrant();
  }

  /** Tells a page that loaded whether the chat holds the grant. */
  republish(): void {
    this.getPostMessage()?.({ type: 'themeScreenshotGrant', granted: this.granted !== undefined });
  }

  dispose(): void {
    this.granted = undefined;
  }
}
