import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import { queueCapturedImage } from "@/composables/capturedImageQueue";
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

    // The image goes only into the composer's own state, never a store; a composer not mounted yet takes it as it mounts.
    composerAddImage: (msg, ctx) => {
      const composer = ctx.refs.chatInputRef.value;
      if (composer) composer.addCapturedImage(msg.image, msg.origin);
      // A read-only chat's card takes the composer's place for good.
      else if (ctx.stores.uiStore.historyReadOnly) toast.error(i18n.global.t("imageAttachment.noComposer"));
      else queueCapturedImage({ image: msg.image, origin: msg.origin });
    },
  };
}
