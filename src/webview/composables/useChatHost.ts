import { readonly, shallowRef, type Ref } from 'vue';
import type { BridgeHost } from '@shared/damocles-bridge';
import { isHostTone, type HostTone } from '@shared/host-tones';

export interface ChatHost {
  readonly name: string;
  // its safety color
  readonly color?: HostTone;
  // this computer's name, for the user's own sign-in
  readonly computer: string;
  // the host is offline or waits for the user to sign in
  readonly attention?: 'offline' | 'signIn';
  // a daemon of another protocol still runs agents there
  readonly update?: BridgeHost['update'];
}

const host = shallowRef<ChatHost | undefined>(undefined);
let watching = false;

/** A remote chat's host as this computer's host store names it (desktop main's panel init); undefined for a local chat or VS Code. */
export function useChatHost(): Readonly<Ref<ChatHost | undefined>> {
  const bridge = typeof window === 'undefined' ? undefined : window.damoclesBridge;
  if (!watching && bridge) {
    watching = true;
    // subscribed first: a read made before main answers the page's init learns the host once it does
    const shown = (label: BridgeHost): ChatHost => ({
      name: label.name,
      ...(isHostTone(label.color) ? { color: label.color } : {}),
      computer: label.computer,
      ...(label.attention !== undefined ? { attention: label.attention } : {}),
      ...(label.update !== undefined ? { update: label.update } : {}),
    });
    bridge.onHost((next) => {
      host.value = shown(next);
    });
    const label = bridge.getHost();
    if (label) host.value = shown(label);
  }
  return readonly(host) as Readonly<Ref<ChatHost | undefined>>;
}

/**
 * The host of a remote chat main shows read-only from its session mirror while that host is not connected; undefined for a
 * live chat. Main opens the chat again once the host connects, so a page reads it once.
 */
export function chatOffline(): { readonly hostId: string; readonly hostName: string } | undefined {
  return typeof window === 'undefined' ? undefined : window.damoclesBridge?.getOffline();
}

/** The connection banner's Reconnect (Reconnect now, Retry), Sign in, Show log or Edit host, which main runs on the chat's own host. */
export function chatHostAction(action: 'reconnect' | 'signIn' | 'showLog' | 'editHost' | 'switchWhenIdle' | 'switchNow'): void {
  window.damoclesBridge?.hostAction(action);
}
