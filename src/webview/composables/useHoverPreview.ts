import { onBeforeUnmount, ref } from "vue";

// ms the pointer rests on a chip before its preview opens, and may wander off before it closes.
export const HOVER_OPEN_MS = 450;
export const HOVER_CLOSE_MS = 160;

/**
 * An attachment chip's preview popover: the pointer opens it after a rest and closes it on leaving, without taking focus; a
 * click or key opens it as a popover that takes focus and stays, also when the hover had already opened it.
 */
export function useHoverPreview() {
  const open = ref(false);
  const openedByHover = ref(false);
  // The trigger pressed while the hover held the preview open; the toggle that press makes keeps it open instead.
  let pressedTrigger: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(next: boolean, ms: number): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (next && !open.value) {
        openedByHover.value = true;
        open.value = true;
      } else if (!next && openedByHover.value) {
        pressedTrigger = null;
        open.value = false;
      }
    }, ms);
  }

  // Bound to the trigger's pointerdown and keydown, which come before the click that toggles the popover.
  function onTriggerPress(event: PointerEvent | KeyboardEvent): void {
    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
    pressedTrigger = open.value && openedByHover.value ? (event.currentTarget as HTMLElement) : null;
  }

  function onOpenChange(next: boolean): void {
    clearTimeout(timer);
    const pressed = next ? null : pressedTrigger;
    pressedTrigger = null;
    openedByHover.value = false;
    if (pressed) {
      focusContent(pressed);
      return;
    }
    open.value = next;
  }

  function onOpenAutoFocus(event: Event): void {
    if (openedByHover.value) event.preventDefault();
  }

  onBeforeUnmount(() => clearTimeout(timer));
  return { open, schedule, onTriggerPress, onOpenChange, onOpenAutoFocus };
}

// The content is already mounted, so its open auto-focus has passed; focus goes where that would have put it.
function focusContent(trigger: HTMLElement): void {
  const content = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
  if (!content) return;
  const first = content.querySelector<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
  (first ?? content).focus();
}
