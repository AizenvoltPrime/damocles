import { inject, provide, type InjectionKey, type Ref } from "vue";
import type VirtualizedMessageList from "@/components/VirtualizedMessageList.vue";

export type MessageListInstance = InstanceType<typeof VirtualizedMessageList>;

export const MESSAGE_LIST_REF_KEY: InjectionKey<Ref<MessageListInstance | null>> = Symbol("messageListRef");

export function provideMessageListRef(messageListRef: Ref<MessageListInstance | null>): void {
  provide(MESSAGE_LIST_REF_KEY, messageListRef);
}

export function injectMessageListRef(): Ref<MessageListInstance | null> | undefined {
  return inject(MESSAGE_LIST_REF_KEY);
}
