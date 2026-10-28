import { computed, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { ChatConnection, HeldMessage } from '@shared/host-connection';
import { useHostConnection } from '@/composables/useHostConnection';

const CONNECTED: ChatConnection['state'] = { phase: 'connected' };

/**
 * A remote chat's connection to its host and the messages main holds for it while the host is away (desktop main's
 * PANEL_CHANNELS.connection). Main holds the messages and decides every change; the page shows them and asks for Cancel or
 * Discard. A page main gives no connection (a local chat, VS Code) is always connected and holds nothing.
 */
export const useConnectionStore = defineStore('connection', () => {
  const pushed = shallowRef<ChatConnection | undefined>(undefined);
  let subscribed = false;

  /** Reads main's connection and follows its pushes; a later call does nothing. */
  function attach(): void {
    const bridge = typeof window === 'undefined' ? undefined : window.damoclesBridge;
    if (subscribed || !bridge) return;
    subscribed = true;
    bridge.onConnection((next) => {
      pushed.value = next;
    });
    const current = bridge.getConnection();
    if (current) pushed.value = current;
  }

  const state = computed(() => pushed.value?.state ?? CONNECTED);
  // the host is away: a send waits in main, and an answer to a prompt could not reach core
  const away = computed(() => state.value.phase !== 'connected');
  const queued = computed((): readonly HeldMessage[] => pushed.value?.queued ?? []);
  // what the page shows of being away (dimmed prompts, the hint) waits for the grace, like the banner; input stops at once
  const view = useHostConnection(() => {
    const current = state.value;
    return { connected: current.phase === 'connected', reconnect: current.phase === 'connected' || current.phase === 'offline' ? undefined : current };
  });
  const awayShown = computed(() => state.value.phase === 'offline' || (away.value && view.shown.value !== undefined));

  function cancel(id: string): void {
    window.damoclesBridge?.queueAction({ action: 'cancel', id });
  }

  function discard(id: string): void {
    window.damoclesBridge?.queueAction({ action: 'discard', id });
  }

  return { attach, state, away, awayShown, queued, cancel, discard };
});
