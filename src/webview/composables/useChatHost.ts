import { readonly, shallowRef, type Ref } from 'vue';

export interface ChatHost {
  readonly name: string;
}

const host = shallowRef<ChatHost | undefined>(undefined);
let watching = false;

/** A remote chat's host as this computer's host store names it (desktop main's panel init); undefined for a local chat or VS Code. */
export function useChatHost(): Readonly<Ref<ChatHost | undefined>> {
  const bridge = typeof window === 'undefined' ? undefined : window.damoclesBridge;
  if (!watching && bridge) {
    watching = true;
    // subscribed first: a read made before main answers the page's init learns the host once it does
    bridge.onHost((next) => {
      host.value = { name: next.name };
    });
    const label = bridge.getHost();
    if (label) host.value = { name: label.name };
  }
  return readonly(host) as Readonly<Ref<ChatHost | undefined>>;
}
