import type { HandlerRegistry } from "../types";

export function createInputHandlers(): Partial<HandlerRegistry> {
  return {
    prefillInput: (msg, ctx) => {
      if (!msg.text) return;
      ctx.refs.chatInputRef.value?.setInput(msg.text);
    },

    // The host's text joins the draft; a composer not mounted yet takes it as soon as it mounts.
    composerAppend: (msg, ctx) => {
      if (!msg.text) return;
      const composer = ctx.refs.chatInputRef.value;
      if (composer) composer.appendPrompt(msg.text);
      else ctx.stores.uiStore.appendedPrompt = [...(ctx.stores.uiStore.appendedPrompt ?? []), msg.text];
    },
  };
}
