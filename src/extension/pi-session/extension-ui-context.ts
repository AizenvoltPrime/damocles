import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';

/** RPC mode degrades all TUI-only surfaces; theme rendering is not used by webview-bridged dialogs. */
const EMPTY_THEME = {} as Theme;

interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/**
 * Per-PiSession webview-bridged `ExtensionUIContext` (US-026). `select`/`confirm`/`input`/`editor`
 * post additive `extensionUiRequest` messages and await an `extensionUiResponse`; `notify` maps to a
 * webview notice. Every other method is a safe no-op mirroring pi's RPC-mode degradation
 * (`docs/rpc.md`) — the foundation third-party (marketplace) extensions render their dialogs through.
 *
 * Bound via `session.bindExtensions({ uiContext, mode: 'rpc' })`. The owning PiSession forwards
 * `extensionUiResponse` here through `resolve(requestId, value)`.
 */
export class WebviewExtensionUIContext implements ExtensionUIContext {
  private seq = 0;
  private readonly pending = new Map<string, (value: string | boolean | null) => void>();
  private readonly emit: (message: ExtensionToWebviewMessage) => void;
  private readonly sessionId: () => string;

  constructor(emit: (message: ExtensionToWebviewMessage) => void, sessionId: () => string) {
    this.emit = emit;
    this.sessionId = sessionId;
  }

  /** Resolve a pending dialog with the value from a webview `extensionUiResponse`. */
  resolve(requestId: string, value: string | boolean | null): void {
    const resolver = this.pending.get(requestId);
    if (resolver) {
      this.pending.delete(requestId);
      resolver(value);
    }
  }

  /** Cancel all in-flight dialogs (session replacement / dispose) so awaiters don't hang. */
  cancelAll(): void {
    for (const resolver of this.pending.values()) resolver(null);
    this.pending.clear();
  }

  private request(
    payload: Omit<Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }>, 'type' | 'requestId'>,
    signal: AbortSignal | undefined,
  ): Promise<string | boolean | null> {
    const requestId = `${this.sessionId()}:ui:${(this.seq += 1)}`;
    return new Promise((resolve) => {
      const onAbort = () => {
        if (this.pending.delete(requestId)) resolve(null);
      };
      this.pending.set(requestId, (value) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.emit({ type: 'extensionUiRequest', requestId, ...payload });
    });
  }

  // ---- bridged dialogs ----------------------------------------------------

  async select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined> {
    const value = await this.request({ kind: 'select', title, options }, opts?.signal);
    return typeof value === 'string' ? value : undefined;
  }

  async confirm(title: string, message: string, opts?: DialogOptions): Promise<boolean> {
    const value = await this.request({ kind: 'confirm', title, message }, opts?.signal);
    return value === true;
  }

  async input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined> {
    const value = await this.request(
      { kind: 'input', title, ...(placeholder !== undefined ? { placeholder } : {}) },
      opts?.signal,
    );
    return typeof value === 'string' ? value : undefined;
  }

  async editor(title: string, prefill?: string): Promise<string | undefined> {
    const value = await this.request({ kind: 'editor', title, ...(prefill !== undefined ? { prefill } : {}) }, undefined);
    return typeof value === 'string' ? value : undefined;
  }

  notify(message: string, type?: 'info' | 'warning' | 'error'): void {
    this.emit({ type: 'notification', message, notificationType: type ?? 'info' });
  }

  // ---- degraded RPC no-ops (mirror pi's noOpUIContext) --------------------

  onTerminalInput(): () => void {
    return () => {};
  }
  setStatus(): void {}
  setWorkingMessage(): void {}
  setWorkingVisible(): void {}
  setWorkingIndicator(): void {}
  setHiddenThinkingLabel(): void {}
  setWidget(): void {}
  setFooter(): void {}
  setHeader(): void {}
  setTitle(): void {}
  async custom(): Promise<never> {
    return undefined as never;
  }
  pasteToEditor(): void {}
  setEditorText(): void {}
  getEditorText(): string {
    return '';
  }
  addAutocompleteProvider(): void {}
  setEditorComponent(): void {}
  getEditorComponent(): undefined {
    return undefined;
  }
  get theme(): Theme {
    return EMPTY_THEME;
  }
  getAllThemes(): { name: string; path: string | undefined }[] {
    return [];
  }
  getTheme(): Theme | undefined {
    return undefined;
  }
  setTheme(): { success: boolean; error?: string } {
    return { success: false, error: 'UI not available in webview RPC mode' };
  }
  getToolsExpanded(): boolean {
    return false;
  }
  setToolsExpanded(): void {}
}
