import { inject, provide, type InjectionKey } from "vue";

/** Sends a prompt through the composer's own send path, so queueing mid-turn and every send refusal apply; false when it was not dispatched. */
export type SendPrompt = (prompt: string) => boolean;

export const SEND_PROMPT_KEY: InjectionKey<SendPrompt> = Symbol("sendPrompt");

export function provideSendPrompt(send: SendPrompt): void {
  provide(SEND_PROMPT_KEY, send);
}

export function injectSendPrompt(): SendPrompt | undefined {
  return inject(SEND_PROMPT_KEY, undefined);
}
