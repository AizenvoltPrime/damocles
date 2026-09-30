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
    editorOpenFile: (msg, ctx) => {
      if (monacoEnabled(msg.type, ctx)) useEditorStore().openFile(msg);
    },
    editorCloseView: (msg, ctx) => {
      if (monacoEnabled(msg.type, ctx)) useEditorStore().closeView(msg.viewId);
    },
    settingsFileContent: (msg, ctx) => {
      if (monacoEnabled(msg.type, ctx)) useEditorStore().setSettingsFile(msg.file);
    },
    settingsFileSaveResult: (msg, ctx) => {
      if (monacoEnabled(msg.type, ctx)) useEditorStore().setSaveResult(msg);
    },
    settingsFileChanged: (msg, ctx) => {
      if (monacoEnabled(msg.type, ctx)) useEditorStore().noteSettingsFileChanged(msg.scope, msg.version);
    },
    settingsFileAvailability: (msg, ctx) => {
      if (monacoEnabled(msg.type, ctx)) useEditorStore().setSettingsFileAvailability(msg.files);
    },
  };
}
