// ThemeSet install's card, a content decision: no mode, YOLO, rule or hook answers it. Every answer a view sends is answered:
// with the card's close when taken, else with the card as it stands.
import { randomUUID } from 'node:crypto';
import type { ThemeInstallAnswer, ThemeInstallPreview } from '../../../shared/themes/install';
import { registerAbortablePrompt, type PermissionState } from '../state';
import type { PendingThemeInstall, PostMessageFn } from '../types';
import type { ThemeCardDevice } from './theme-change-manager';

export interface ThemeInstallAsk {
  readonly toolUseId: string;
  readonly preview: ThemeInstallPreview;
  // a chat on a remote host: the device the install lands on and its computer's name; another device's card shows no image
  // and offers Cancel only
  readonly device?: ThemeCardDevice;
}

/** An open card, held by its tool until the tool closes it. */
export interface ThemeInstallPrompt {
  readonly promptId: string;
  // the user's answer; undefined once the card closed unanswered (the signal aborted, the panel ended)
  answer(): Promise<ThemeInstallAnswer | undefined>;
  // the preview again, as a flash check ended or a file was allowed to flash
  update(preview: ThemeInstallPreview): void;
  // how far the flash check of the wallpaper `sha256` is, 0 to 1
  progress(sha256: string, fraction: number): void;
  close(): void;
}

/** The preview another device's views get: no thumbnails, since only the device the install lands on shows its images. */
function withoutImages(preview: ThemeInstallPreview): ThemeInstallPreview {
  return { ...preview, wallpapers: preview.wallpapers.map(({ thumb: _thumb, ...wallpaper }) => wallpaper) };
}

export class ThemeInstallManager {
  private readonly state: PermissionState;
  private readonly getPostMessage: () => PostMessageFn | null;
  private readonly actor: () => string | undefined;

  constructor(state: PermissionState, getPostMessage: () => PostMessageFn | null, actor: () => string | undefined = () => undefined) {
    this.state = state;
    this.getPostMessage = getPostMessage;
    this.actor = actor;
  }

  /**
   * Raises the card until its tool closes it or `signal` aborts; `allowFlash` runs its Allow flashing for this file, undefined
   * on a daemon's core, whose chats' presses main sends to the computer the install stages on. It registers with no webview
   * attached too: a reload shows it.
   */
  open(ask: ThemeInstallAsk, signal: AbortSignal, allowFlash: ((sha256: string) => void) | undefined): ThemeInstallPrompt {
    const promptId = `themeinstall-${randomUUID()}`;
    let answered: ThemeInstallAnswer | undefined;
    let waiter: ((answer: ThemeInstallAnswer | undefined) => void) | undefined;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', close);
      if (this.state.removePendingThemeInstall(promptId)) this.getPostMessage()?.({ type: 'themeInstallClosed', promptId });
      const waiting = waiter;
      waiter = undefined;
      waiting?.(answered);
    };
    const request: PendingThemeInstall['request'] = { type: 'requestThemeInstall', promptId, toolUseId: ask.toolUseId, preview: ask.preview, owner: this.state.promptOwner(null) };
    const { device } = ask;
    registerAbortablePrompt({
      signal,
      toolUseId: promptId,
      register: () => {
        this.state.addPendingThemeInstall(promptId, {
          request,
          deliver: (answer) => {
            answered = answer;
            close();
          },
          ...(allowFlash ? { allowFlash } : {}),
          close,
          ...(device ? { device: device.clientId } : {}),
        });
        if (device) this.state.devicePrompts.set(promptId, (clientId) => this.requestFor(promptId, device, clientId));
        this.state.postPrompt(promptId, request, this.getPostMessage());
      },
      onAborted: close,
    });
    return {
      promptId,
      answer: () => (closed ? Promise.resolve(answered) : new Promise((resolve) => { waiter = resolve; })),
      update: (preview) => {
        const pending = this.state.pendingThemeInstalls.get(promptId);
        if (closed || !pending || preview.installId !== pending.request.preview.installId) return;
        this.state.updatePendingThemeInstall(promptId, { ...pending.request, preview });
        if (device && this.state.postToDevices) {
          this.state.postToDevices((clientId) => ({ type: 'themeInstallUpdated', promptId, preview: clientId === device.clientId ? preview : withoutImages(preview) }));
        } else {
          this.getPostMessage()?.({ type: 'themeInstallUpdated', promptId, preview });
        }
      },
      progress: (sha256, fraction) => {
        if (closed || !this.state.pendingThemeInstalls.has(promptId)) return;
        this.getPostMessage()?.({ type: 'themeInstallProgress', promptId, sha256, fraction });
      },
      close,
    };
  }

  /**
   * The user's answer from any view; one taken closes the card on every view. Not taken for Install without a clash choice
   * when the name clashes, for Replace of a theme that cannot be replaced, and for anything but Cancel from a device the
   * install does not land on: the views are then sent the card as it stands, with the preview the answer was judged by. One
   * for a card no longer open is answered with its close.
   */
  resolveThemeInstall(promptId: string, answer: ThemeInstallAnswer): void {
    const pending = this.state.pendingThemeInstalls.get(promptId);
    if (!pending) {
      this.getPostMessage()?.({ type: 'themeInstallClosed', promptId });
      return;
    }
    if (answer.choice === 'cancel') {
      pending.deliver({ choice: 'cancel' });
      return;
    }
    const clash = pending.request.preview.clash;
    const onClash = clash !== undefined ? answer.onClash : undefined;
    if (!this.onItsDevice(pending) || (clash !== undefined && (onClash === undefined || (onClash === 'replace' && !clash.replaceable)))) {
      this.state.postPrompt(promptId, pending.request, this.getPostMessage());
      return;
    }
    pending.deliver({ choice: 'install', ...(onClash !== undefined ? { onClash } : {}), useArrangement: pending.request.preview.arrangement && answer.useArrangement });
  }

  /**
   * The card's Allow flashing for this file, from the device the install lands on, for a wallpaper the card lists as flagged
   * and not yet allowed; anything else is ignored.
   */
  allowFlash(promptId: string, sha256: string): void {
    const pending = this.state.pendingThemeInstalls.get(promptId);
    if (!pending?.allowFlash || !this.onItsDevice(pending)) return;
    const wallpaper = pending.request.preview.wallpapers.find((candidate) => candidate.sha256 === sha256);
    if (wallpaper?.flash !== 'flagged' || wallpaper.allowed === true) return;
    pending.allowFlash(sha256);
  }

  /** Whether the answer comes from the device the install lands on; a card with no device has none to check. */
  private onItsDevice(pending: PendingThemeInstall): boolean {
    return pending.device === undefined || this.actor() === pending.device;
  }

  /** The card as `clientId`'s views show it: whole on the device it installs on, without images and Cancel only elsewhere. */
  private requestFor(promptId: string, device: ThemeCardDevice, clientId: string | undefined): PendingThemeInstall['request'] | undefined {
    const request = this.state.pendingThemeInstalls.get(promptId)?.request;
    if (!request || clientId === device.clientId) return request;
    return { ...request, preview: withoutImages(request.preview), otherDevice: device.computer !== undefined ? { computer: device.computer } : {} };
  }
}
