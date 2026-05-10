import type { HandlerRegistry } from "../types";

export function createInputHandlers(): Partial<HandlerRegistry> {
  return {
    prefillInput: (msg, ctx) => {
      if (!msg.text) return;
      ctx.refs.chatInputRef.value?.setInput(msg.text);
    },
  };
}
