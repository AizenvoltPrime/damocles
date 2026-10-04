import { defineStore } from 'pinia';
import { shallowRef } from 'vue';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';
import { usePlatformBridge } from '@/composables/usePlatformBridge';

type SettingWriteResult = Extract<ExtensionToWebviewMessage, { type: 'settingWriteResult' }>;

/** `seq` grows with every result, so a row replays its feedback even when two writes report the same file. */
export type SettingWriteFeedback =
  | { readonly kind: 'saved'; readonly seq: number; readonly file: string | undefined; readonly scope: string }
  | { readonly kind: 'error'; readonly seq: number; readonly error: string };

/**
 * The outcome of each setting write, keyed by its damocles.* key. A control updates its value before the host
 * confirms (M7); the revert it registers runs only if the host reports that write failed.
 * The host answers one key's writes in the order sent, so a result settles that key's oldest write in flight; a failed
 * write that a later one already overwrote hands its revert to that later write instead of running it.
 */
export const useSettingWritesStore = defineStore('settingWrites', () => {
  const feedback = shallowRef<Readonly<Record<string, SettingWriteFeedback>>>({});
  const inFlight = new Map<string, Array<() => void>>();
  let seq = 0;

  function begin(key: string, revert: () => void): void {
    inFlight.set(key, [...(inFlight.get(key) ?? []), revert]);
    if (feedback.value[key]?.kind === 'error') {
      const { [key]: _cleared, ...rest } = feedback.value;
      feedback.value = rest;
    }
  }

  function settle(result: SettingWriteResult): void {
    seq += 1;
    const [revert, ...later] = inFlight.get(result.key) ?? [];
    if (later.length > 0) inFlight.set(result.key, later);
    else inFlight.delete(result.key);
    if (result.ok) {
      feedback.value = { ...feedback.value, [result.key]: { kind: 'saved', seq, file: result.file, scope: result.scope } };
      return;
    }
    if (revert && later.length > 0) later[0] = revert;
    else revert?.();
    feedback.value = { ...feedback.value, [result.key]: { kind: 'error', seq, error: result.error } };
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

  return { feedback, begin, settle, latest, $reset };
});

/**
 * Sends a setting write the way every row does (M7): `apply` updates the store at once, and `revert` puts the
 * previous value back if the host reports the write for `key` failed.
 */
export function useSettingWrite(): (key: string, message: WebviewToExtensionMessage, optimistic: { apply: () => void; revert: () => void }) => void {
  const writes = useSettingWritesStore();
  const { postMessage } = usePlatformBridge();
  return (key, message, optimistic) => {
    writes.begin(key, optimistic.revert);
    optimistic.apply();
    postMessage(message);
  };
}
