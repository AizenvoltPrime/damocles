import { computed, onScopeDispose, ref, watch, type ComputedRef } from 'vue';
import { RECONNECTED_MS, secondsUntil, shownFrom, type HostReconnect } from '@shared/host-connection';

// What a host's banner and dot read: whether it is connected, the reconnect loop's phase, and slice 6's coarse attention.
export interface HostConnectionSource {
  // which host, where one view can show another host: a different host is never "back"
  readonly hostId?: string | undefined;
  readonly connected: boolean;
  readonly reconnect?: HostReconnect | undefined;
  // a host the loop does not run for: offline, or an attempt waiting for the user to sign in
  readonly attention?: 'offline' | 'signIn' | undefined;
}

// reconnecting: suspect, waiting or running; reconnected: back after the banner showed, for RECONNECTED_MS.
export type HostBannerKind = 'reconnecting' | 'signIn' | 'failed' | 'offline' | 'reconnected';

export interface HostConnectionView {
  // the phase once it has lasted OFFLINE_GRACE_MS from its since; undefined before that and while connected
  readonly shown: ComputedRef<HostReconnect | undefined>;
  readonly kind: ComputedRef<HostBannerKind | undefined>;
  // the countdown to the next attempt while waiting; 0 while it is due
  readonly seconds: ComputedRef<number | undefined>;
}

/**
 * A host's connection as its banner and dot show it (docs/invariants.md "Desktop host", offline banner): nothing for a drop
 * shorter than the grace, then the phase, a whole-second countdown while the loop waits, and a green moment once the host is
 * back after it showed. One timer at a time wakes the view only when what it shows changes.
 */
export function useHostConnection(source: () => HostConnectionSource | undefined): HostConnectionView {
  const now = ref(Date.now());
  const back = ref(false);
  let wake: ReturnType<typeof setTimeout> | undefined;
  let backTimer: ReturnType<typeof setTimeout> | undefined;

  const shown = computed(() => {
    const reconnect = source()?.reconnect;
    return reconnect && now.value >= shownFrom(reconnect) ? reconnect : undefined;
  });
  const seconds = computed(() => (shown.value?.phase === 'waiting' ? secondsUntil(shown.value.retryAt, now.value) : undefined));
  const away = computed((): HostBannerKind | undefined => {
    const current = source();
    if (!current) return undefined;
    if (current.reconnect) {
      const phase = shown.value?.phase;
      if (phase === undefined) return undefined;
      return phase === 'failed' ? 'failed' : phase === 'signIn' ? 'signIn' : 'reconnecting';
    }
    return current.attention;
  });
  const kind = computed(() => away.value ?? (back.value ? 'reconnected' : undefined));

  // the next moment the view changes on its own: the grace's end, or the countdown's next whole second
  const schedule = (): void => {
    if (wake !== undefined) clearTimeout(wake);
    wake = undefined;
    const reconnect = source()?.reconnect;
    if (!reconnect) return;
    const at = Date.now();
    const graceEnd = shownFrom(reconnect);
    let next: number | undefined;
    if (at < graceEnd) next = graceEnd;
    else if (reconnect.phase === 'waiting' && reconnect.retryAt > at) next = reconnect.retryAt - (Math.ceil((reconnect.retryAt - at) / 1000) - 1) * 1000;
    if (next === undefined) return;
    wake = setTimeout(() => {
      now.value = Date.now();
      schedule();
    }, Math.max(0, next - at));
  };

  const endBack = (): void => {
    back.value = false;
    if (backTimer !== undefined) clearTimeout(backTimer);
    backTimer = undefined;
  };

  // sync: the clock moves with the phase, so no read sees a new phase against the old clock; a new drop ends a green moment
  watch(() => source()?.reconnect, (reconnect) => {
    now.value = Date.now();
    if (reconnect) endBack();
    schedule();
  }, { immediate: true, flush: 'sync' });

  // a host that showed it was away and is connected again shows green, then the banner collapses
  watch(() => [away.value, source()?.hostId] as const, ([next, hostId], [previous, previousHostId]) => {
    if (next !== undefined || hostId !== previousHostId) {
      endBack();
      return;
    }
    if (previous === undefined || source()?.connected !== true) return;
    endBack();
    back.value = true;
    backTimer = setTimeout(() => {
      back.value = false;
      backTimer = undefined;
    }, RECONNECTED_MS);
  });

  onScopeDispose(() => {
    if (wake !== undefined) clearTimeout(wake);
    if (backTimer !== undefined) clearTimeout(backTimer);
  });

  return { shown, kind, seconds };
}
