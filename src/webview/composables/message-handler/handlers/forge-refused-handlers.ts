import { useForgeRefusalStore } from "@/stores/useForgeRefusalStore";
import type { HandlerRegistry } from "../types";

/** The refused notice: an agent shell's git was refused an account; the notice under its shell card offers the fix. */
export function createForgeRefusedHandlers(): Partial<HandlerRegistry> {
  return {
    forgeShellRefused: (msg) => {
      useForgeRefusalStore().add(msg);
    },
    forgeRefusedBindResult: (msg) => {
      useForgeRefusalStore().bindResult(msg.toolCallId, msg.accountId, msg.ok);
    },
    forgeRefusedOpenMenu: (msg) => {
      useForgeRefusalStore().requestMenu(msg.toolCallId);
    },
  };
}
