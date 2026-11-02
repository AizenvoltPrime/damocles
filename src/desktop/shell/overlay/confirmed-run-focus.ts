import { ref, watch, type Ref } from 'vue';

export interface ConfirmedRunFocus {
  // the user's answer to the confirmation, before it closes
  chose(confirmed: boolean): void;
  // the confirmation's close-auto-focus handler
  closeAutoFocus(event: Event): void;
}

// A confirmed run hides the button its confirmation would return focus to: focus moves to the run's steps once they show, or
// back to that button when the call failed before any run started. A refusal leaves reka returning focus to the button.
export function useConfirmedRunFocus(steps: Readonly<Ref<HTMLElement | null>>, button: () => HTMLElement | undefined, callFailed: () => boolean): ConfirmedRunFocus {
  let confirmed = false;
  const pending = ref(false);
  watch([pending, steps, callFailed], ([want, list, failed]) => {
    const target = want ? (list ?? (failed ? button() : undefined)) : undefined;
    if (!target) return;
    pending.value = false;
    target.focus();
  }, { flush: 'post' });
  return {
    chose: (answer) => {
      confirmed = answer;
    },
    closeAutoFocus: (event) => {
      if (!confirmed) return;
      confirmed = false;
      event.preventDefault();
      pending.value = true;
    },
  };
}
