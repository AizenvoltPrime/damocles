import { readonly, shallowRef, type Ref } from 'vue';
import type { BridgeHost, DamoclesBridge } from '@shared/damocles-bridge';
import { isHostColor, type HostColor } from '@shared/host-colors';

export interface ChatHost {
  readonly name: string;
  // its safety color
  readonly color?: HostColor;
  // this computer's name, for the user's own sign-in
  readonly computer: string;
  // the host is offline or waits for the user to sign in
  readonly attention?: 'offline' | 'signIn';
  // Remove Damocles server ran on the host, by another device (its name) or as an automatic connect found it
  readonly removed?: { readonly by?: string };
  // a pending server switch on the host, or this app being too old for it
  readonly update?: BridgeHost['update'];
  // the app's updater runs, so the update banner offers Check for updates
  readonly canCheckForUpdates?: true;
  // main may ask to allow YOLO on the host (a saved host)
  readonly canAllowYolo?: true;
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
      ...(isHostColor(label.color) ? { color: label.color } : {}),
      computer: label.computer,
      ...(label.attention !== undefined ? { attention: label.attention } : {}),
      ...(label.removed !== undefined ? { removed: typeof label.removed.by === 'string' ? { by: label.removed.by } : {} } : {}),
      ...(label.update !== undefined ? { update: label.update } : {}),
      ...(label.canCheckForUpdates === true ? { canCheckForUpdates: true as const } : {}),
      ...(label.canAllowYolo === true ? { canAllowYolo: true as const } : {}),
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

/**
 * The connection banner's Reconnect (Reconnect now, Retry), Sign in, Show log or Edit host, and the update banner's actions,
 * which main runs on the chat's own host.
 */
export function chatHostAction(action: Parameters<DamoclesBridge['hostAction']>[0]): void {
  window.damoclesBridge?.hostAction(action);
}
