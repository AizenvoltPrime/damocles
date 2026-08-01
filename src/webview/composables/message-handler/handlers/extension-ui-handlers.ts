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
        ...(msg.agentId !== undefined ? { agentId: msg.agentId } : {}),
        ...(msg.agentName !== undefined ? { agentName: msg.agentName } : {}),
        ...(msg.teamId !== undefined ? { teamId: msg.teamId } : {}),
      });
    },
    // The extension withdrew a dialog that will never be answered; there is no response leg.
    extensionUiCancel: (msg, ctx) => {
      ctx.stores.extensionUiStore.cancel(msg.requestId);
    },
  };
}
