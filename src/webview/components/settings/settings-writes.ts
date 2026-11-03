import { defineStore } from 'pinia';
import { shallowRef } from 'vue';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import type { ViewText } from '@/composables/useLocalizedText';

type SettingWriteResult = Extract<ExtensionToWebviewMessage, { type: 'settingWriteResult' }>;

/** `seq` grows with every result, so a row replays its feedback even when two writes report the same file. */
export type SettingWriteFeedback =
  | { readonly kind: 'saved'; readonly seq: number; readonly file: string | undefined; readonly scope: string }
  | { readonly kind: 'error'; readonly seq: number; readonly error: ViewText };

/** A setting write's optimistic update, which a control applies before the host confirms (M7). */
export interface OptimisticWrite {
  apply(): void;
  // the host reported this write failed
  revert(): void;
  // the host answered this write, before any revert runs
  settled?(saved: boolean): void;
  // the write changes one element of the key's list, as a per-tool switch does, so its failure reverts only its own change
  partial?: boolean;
}

interface InFlightWrite {
  revert: () => void;
  readonly settled: ((saved: boolean) => void) | undefined;
  readonly partial: boolean;
}

/**
 * The outcome of each setting write, keyed by its damocles.* key. The revert a control registers runs only if the host
 * reports that write failed.
 * The host answers one key's writes in the order sent, so a result settles that key's oldest write in flight; a failed
 * write of the whole value that a later one of the whole value already overwrote hands its revert to that later write
 * instead of running it. A partial write always settles on its own.
 */
export const useSettingWritesStore = defineStore('settingWrites', () => {
  const feedback = shallowRef<Readonly<Record<string, SettingWriteFeedback>>>({});
  const inFlight = new Map<string, InFlightWrite[]>();
  let seq = 0;

  function begin(key: string, revert: () => void, options: Pick<OptimisticWrite, 'settled' | 'partial'> = {}): void {
    inFlight.set(key, [...(inFlight.get(key) ?? []), { revert, settled: options.settled, partial: options.partial === true }]);
    if (feedback.value[key]?.kind === 'error') {
      const { [key]: _cleared, ...rest } = feedback.value;
      feedback.value = rest;
    }
  }

  function settle(result: SettingWriteResult): void {
    if (result.ok) finish(result.key, { kind: 'saved', file: result.file, scope: result.scope });
    else finish(result.key, { kind: 'error', error: result.error });
  }

  /** A failed write whose reason the host already worded. */
  function settleError(key: string, error: ViewText): void {
    finish(key, { kind: 'error', error });
  }

  function finish(key: string, outcome: { readonly kind: 'saved'; readonly file: string | undefined; readonly scope: string } | { readonly kind: 'error'; readonly error: ViewText }): void {
    seq += 1;
    const [write, ...later] = inFlight.get(key) ?? [];
    if (later.length > 0) inFlight.set(key, later);
    else inFlight.delete(key);
    write?.settled?.(outcome.kind === 'saved');
    if (outcome.kind === 'saved') {
      feedback.value = { ...feedback.value, [key]: { ...outcome, seq } };
      return;
    }
    const heir = write && !write.partial ? later.find((entry) => !entry.partial) : undefined;
    if (write && heir) heir.revert = write.revert;
    else write?.revert();
    feedback.value = { ...feedback.value, [key]: { ...outcome, seq } };
  }

  /** The newest result among `keys`; a row backed by several keys shows whichever settled last. */
  function latest(keys: readonly string[]): SettingWriteFeedback | undefined {
    let found: SettingWriteFeedback | undefined;
    for (const key of keys) {
      const entry = feedback.value[key];
      if (entry && (!found || entry.seq > found.seq)) found = entry;
    }
    return found;
  }

  function $reset(): void {
    feedback.value = {};
    inFlight.clear();
  }

  return { feedback, begin, settle, settleError, latest, $reset };
});

/**
 * Sends a setting write the way every row does (M7): `apply` updates the store at once, and `revert` puts the
 * previous value back if the host reports the write for `key` failed.
 */
export function useSettingWrite(): (key: string, message: WebviewToExtensionMessage, optimistic: OptimisticWrite) => void {
  const writes = useSettingWritesStore();
  const { postMessage } = usePlatformBridge();
  return (key, message, optimistic) => {
    writes.begin(key, optimistic.revert, optimistic);
    optimistic.apply();
    postMessage(message);
  };
}
