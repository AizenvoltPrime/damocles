import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { PendingFormInfo } from '@shared/types/forms';

/**
 * Store for the `BrowserRequestInput` interactive form-fill tool.
 *
 * SECURITY: This store holds ONLY the form SCHEMA (`PendingFormInfo`). User-entered VALUES never
 * live here — they exist solely as component-local state inside `FormPrompt.vue`, are emitted once
 * via `submit(values)`, and are cleared on submit/cancel. Do not add a values ref to this store.
 */
export const useFormStore = defineStore('form', () => {
  const pendingForm = ref<PendingFormInfo | null>(null);
  // FIFO queue of forms that arrived while one was already open (e.g. a subagent requesting input
  // concurrently). Holds SCHEMAS only — never values. A queued form is shown, in order, once the
  // current one settles, instead of being dropped (which would strand its extension-side promise).
  const queue = ref<PendingFormInfo[]>([]);

  function setForm(info: PendingFormInfo) {
    if (pendingForm.value) {
      queue.value = [...queue.value, info];
      return;
    }
    pendingForm.value = info;
  }

  function clearForm() {
    // Advance to the next queued form, if any, so a concurrently-requested form is shown next.
    const [next, ...rest] = queue.value;
    if (next) {
      queue.value = rest;
      pendingForm.value = next;
      return;
    }
    pendingForm.value = null;
  }

  function $reset() {
    pendingForm.value = null;
    queue.value = [];
  }

  return { pendingForm, queue, setForm, clearForm, $reset };
});
