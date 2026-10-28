import { onScopeDispose, shallowRef, watch, type ShallowRef } from 'vue';
import type { DamoclesOverlayApi, HostOperations } from '../../preload/overlay-channels';
import { answerOf } from './popup-answer';

/**
 * A host's setup and removal as main holds them: read from main when the view mounts or names another host, then each
 * snapshot main publishes. Snapshots may arrive out of order with the read's answer, so the highest revision wins.
 */
export function useHostOperations(api: DamoclesOverlayApi, hostId: () => string): ShallowRef<HostOperations | undefined> {
  const operations = shallowRef<HostOperations | undefined>();
  const take = (snapshot: HostOperations): void => {
    if (snapshot.hostId !== hostId()) return;
    if (operations.value === undefined || snapshot.revision > operations.value.revision) operations.value = snapshot;
  };
  onScopeDispose(api.onHostOperations(take));
  watch(hostId, (id) => {
    operations.value = undefined;
    // a failed read leaves the view to main's next snapshot
    void answerOf(api.getHostOperations(id)).then((snapshot) => snapshot && take(snapshot), () => undefined);
  }, { immediate: true });
  return operations;
}
