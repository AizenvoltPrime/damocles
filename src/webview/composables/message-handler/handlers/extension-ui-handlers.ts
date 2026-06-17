import type { HandlerRegistry } from "../types";

/** Route a pi-extension `ctx.ui.*` request into the dialog store for the webview to render (US-026). */
export function createExtensionUiHandlers(): Partial<HandlerRegistry> {
  return {
    extensionUiRequest: (msg, ctx) => {
      ctx.stores.extensionUiStore.setRequest({
        requestId: msg.requestId,
        kind: msg.kind,
        title: msg.title,
        ...(msg.message !== undefined ? { message: msg.message } : {}),
        ...(msg.options !== undefined ? { options: msg.options } : {}),
        ...(msg.placeholder !== undefined ? { placeholder: msg.placeholder } : {}),
        ...(msg.prefill !== undefined ? { prefill: msg.prefill } : {}),
      });
    },
  };
}
