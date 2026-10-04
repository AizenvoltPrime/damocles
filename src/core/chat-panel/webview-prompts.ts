import type { InputBoxOptions, QuickPickItem, QuickPickOptions } from "../../platform/dialog-service";
import type { PanelHost } from "../../platform/window-service";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import { log } from "../logger";
import type { AttachedView } from "./types";

type UiRequestMessage = Extract<ExtensionToWebviewMessage, { type: "extensionUiRequest" }>;

// PiSession's extension dialogs use `<sessionId>:ui:<n>`, so this prefix alone tells the two apart.
const REQUEST_PREFIX = "host-prompt:";

export interface PromptTarget {
  readonly panelId: string;
  readonly host: PanelHost;
}

export interface PromptPanels {
  // The chat panel a prompt renders in, once its webview is ready; undefined when none could be had before the signal aborted.
  target(signal: AbortSignal | undefined): Promise<PromptTarget | undefined>;
  // A settings view attached to the panel; while one is, the panel's prompts render there instead of in the chat.
  attachedView(panelId: string): AttachedView | undefined;
}

interface PendingPrompt {
  readonly target: PromptTarget;
  readonly message: UiRequestMessage;
  // offered item ids for a quick pick; undefined for text input
  readonly itemIds: ReadonlySet<string> | undefined;
  readonly settle: (value: string | undefined) => void;
  // the attached view showing the prompt; undefined while the chat shows it
  shownIn: AttachedView | undefined;
}

/**
 * Host dialogs (DialogService.inputBox / quickPick) rendered in a chat panel's webview over the extensionUi*
 * messages, or in the settings view attached to that panel while one is. An answer is accepted only from the
 * panel the prompt was posted to, and only from where it is shown now. Answers are never logged: they carry
 * API keys and pasted OAuth redirect URLs.
 */
export class WebviewPrompts {
  private seq = 0;
  private disposed = false;
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly panels: PromptPanels;
  private readonly post: (host: PanelHost, message: ExtensionToWebviewMessage) => void;

  constructor(panels: PromptPanels, post: (host: PanelHost, message: ExtensionToWebviewMessage) => void) {
    this.panels = panels;
    this.post = post;
  }

  inputBox(opts: InputBoxOptions, signal?: AbortSignal): Promise<string | undefined> {
    return this.request(
      {
        kind: "input",
        title: opts.prompt ?? "",
        ...(opts.placeholder !== undefined ? { placeholder: opts.placeholder } : {}),
        ...(opts.password === true ? { password: true } : {}),
      },
      undefined,
      signal,
    );
  }

  quickPick(items: readonly QuickPickItem[], opts: QuickPickOptions, signal?: AbortSignal): Promise<string | undefined> {
    return this.request(
      {
        kind: "select",
        title: opts.title ?? "",
        options: items.map((item) => item.label),
        items: items.map((item) => ({
          id: item.id,
          label: item.label,
          ...(item.description !== undefined ? { description: item.description } : {}),
          ...(item.detail !== undefined ? { detail: item.detail } : {}),
        })),
        ...(opts.placeholder !== undefined ? { placeholder: opts.placeholder } : {}),
      },
      new Set(items.map((item) => item.id)),
      signal,
    );
  }

  /**
   * Settles a host prompt from a webview answer; `view` is the attached view that sent it, undefined for the chat.
   * False when requestId is not a host prompt's (a PiSession dialog's).
   */
  handleResponse(panelId: string, requestId: string, value: string | boolean | null, view?: AttachedView): boolean {
    if (!requestId.startsWith(REQUEST_PREFIX)) return false;
    const entry = this.pending.get(requestId);
    if (!entry) return true;
    if (entry.target.panelId !== panelId) {
      log("[WebviewPrompts] ignoring an answer to %s from panel %s; it was asked in %s", requestId, panelId, entry.target.panelId);
      return true;
    }
    if (entry.shownIn !== view) {
      log("[WebviewPrompts] ignoring an answer to %s from a surface that no longer shows it", requestId);
      return true;
    }
    if (value === null) {
      entry.settle(undefined);
    } else if (typeof value !== "string") {
      log("[WebviewPrompts] %s answered with a non-text value; treating it as dismissed", requestId);
      entry.settle(undefined);
    } else if (entry.itemIds !== undefined && !entry.itemIds.has(value)) {
      log("[WebviewPrompts] %s answered with an item that was not offered; treating it as dismissed", requestId);
      entry.settle(undefined);
    } else {
      entry.settle(value);
    }
    return true;
  }

  /**
   * Posts the panel's pending prompts that `view` shows again (the chat when undefined), for a webview that (re)started
   * and lost them: the chat on `ready`, an attached settings view on `requestSettingsState`.
   */
  repost(panelId: string, view?: AttachedView): void {
    for (const entry of this.pending.values()) {
      if (entry.target.panelId === panelId && entry.shownIn === view) this.postTo(entry, entry.message);
    }
  }

  /** Moves the panel's pending prompts to where they render now, after its attached view changed: withdrawn from the old surface, posted to the new one. */
  resurface(panelId: string): void {
    const view = this.panels.attachedView(panelId);
    for (const [requestId, entry] of this.pending) {
      if (entry.target.panelId !== panelId || entry.shownIn === view) continue;
      this.postTo(entry, { type: "extensionUiCancel", requestId });
      entry.shownIn = view;
      this.postTo(entry, entry.message);
    }
  }

  /** Withdraw every pending prompt from its webview and resolve it undefined; later prompts resolve undefined at once. */
  dispose(): void {
    this.disposed = true;
    for (const [requestId, entry] of [...this.pending]) {
      this.postTo(entry, { type: "extensionUiCancel", requestId });
      entry.settle(undefined);
    }
  }

  private postTo(entry: PendingPrompt, message: ExtensionToWebviewMessage): void {
    if (entry.shownIn) entry.shownIn.post(message);
    else this.post(entry.target.host, message);
  }

  private async request(
    payload: Omit<UiRequestMessage, "type" | "requestId">,
    itemIds: ReadonlySet<string> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    if (signal?.aborted || this.disposed) return undefined;
    const target = await this.panels.target(signal);
    if (!target || signal?.aborted || this.disposed) return undefined;
    const requestId = `${REQUEST_PREFIX}${(this.seq += 1)}`;
    const message: UiRequestMessage = { type: "extensionUiRequest", requestId, ...payload };
    return new Promise<string | undefined>((resolve) => {
      const onAbort = (): void => {
        if (!this.pending.has(requestId)) return;
        this.postTo(entry, { type: "extensionUiCancel", requestId });
        settle(undefined);
      };
      const settle = (value: string | undefined): void => {
        if (!this.pending.delete(requestId)) return;
        signal?.removeEventListener("abort", onAbort);
        disposed.dispose();
        resolve(value);
      };
      const entry: PendingPrompt = { target, message, itemIds, settle, shownIn: this.panels.attachedView(target.panelId) };
      this.pending.set(requestId, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      const disposed = target.host.onDispose(() => settle(undefined));
      // The asked tab may sit behind another tab (a browser tab, or a chat tab on another project).
      if (!entry.shownIn) target.host.reveal();
      this.postTo(entry, message);
    });
  }
}
