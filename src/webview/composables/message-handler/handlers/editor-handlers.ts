import { useEditorStore } from "@/stores/useEditorStore";
import type { HandlerContext, HandlerRegistry } from "../types";

// Nothing reaches the editor store while `monaco` is off, so the lazy Monaco chunk never loads on such a host.
function monacoEnabled(type: string, ctx: HandlerContext): boolean {
  if (ctx.stores.settingsStore.hostCapabilities.monaco) return true;
  console.warn(`[editor] ignored ${type}: the host did not enable monaco`);
  return false;
}

export function createEditorHandlers(): Partial<HandlerRegistry> {
  return {
    editorShowDiff: (msg, ctx) => {
      if (monacoEnabled(msg.type, ctx)) useEditorStore().showDiff(msg);
    },
    editorCloseView: (msg, ctx) => {
      if (monacoEnabled(msg.type, ctx)) useEditorStore().closeView(msg.viewId);
    },
  };
}
