import { computed, onScopeDispose, shallowRef, toValue, type MaybeRefOrGetter } from 'vue';
import { usePlatformBridge } from './usePlatformBridge';

type Settle = (delivered: boolean) => void;

/** Steers sent from an agent overlay's steer bar, by `steerAgent` requestId, until `subagentSteered` answers. */
const pending = new Map<string, Settle>();

/** Called by the `subagentSteered` handler; a requestId no steer bar sent is ignored. */
export function settleOverlaySteer(requestId: string, delivered: boolean): void {
  const settle = pending.get(requestId);
  pending.delete(requestId);
  settle?.(delivered);
}

/**
 * The steer bar of a subagent or team member overlay. The note stays in the field until the host
 * confirms delivery, so a refused steer (the agent finished, or was not found) keeps what was typed.
 */
export function useOverlaySteer(agentId: MaybeRefOrGetter<string | null | undefined>) {
  const { postMessage } = usePlatformBridge();
  const text = shallowRef('');
  const sending = shallowRef(false);
  const failed = shallowRef(false);
  let requestId: string | null = null;

  const canSend = computed(() => !sending.value && Boolean(toValue(agentId)) && text.value.trim().length > 0);

  function send(): void {
    const id = toValue(agentId);
    if (!canSend.value || !id) return;
    requestId = crypto.randomUUID();
    sending.value = true;
    failed.value = false;
    pending.set(requestId, (delivered) => {
      requestId = null;
      sending.value = false;
      failed.value = !delivered;
      if (delivered) text.value = '';
    });
    postMessage({ type: 'steerAgent', agentId: id, message: text.value.trim(), requestId });
  }

  onScopeDispose(() => {
    if (requestId) pending.delete(requestId);
  });

  return { text, sending, failed, canSend, send };
}
