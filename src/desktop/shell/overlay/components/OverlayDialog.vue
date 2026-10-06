<script lang="ts">
// The control that last took focus on the page, or for focus inside a popup (a select's listbox) the control that opened
// it. A control disabled while its question is asked (a settings row whose change waits on the answer) drops focus to
// the body before the dialog opens, so the dialog returns focus here.
let lastFocused: HTMLElement | null = null;

// Content a control opens. Only these hand focus to their controller: a region some other control merely controls (a
// search box's results, a tab's panel) does not, so the walk never climbs past the first one.
const POPUP_CONTENT = '[role="listbox"], [role="menu"], [data-dismissable-layer]';

function controllerOf(element: HTMLElement): HTMLElement {
  if (!element.closest(POPUP_CONTENT)) return element;
  for (let node: HTMLElement | null = element; node; node = node.matches(POPUP_CONTENT) ? null : node.parentElement) {
    // aria-controls is a list of ids.
    const controller = node.id ? document.querySelector<HTMLElement>(`[aria-controls~="${CSS.escape(node.id)}"]`) : null;
    if (controller) return controller;
  }
  return element;
}

document.addEventListener('focusin', (event) => {
  if (event.target instanceof HTMLElement) lastFocused = controllerOf(event.target);
}, true);

// How long a returning control may stay disabled while the answer is applied before focus gives up on it.
const RETURN_WAIT_MS = 5000;

function isDisabled(element: HTMLElement): boolean {
  return element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
}

// Focus goes back once the control is enabled again, unless the user has put it somewhere else meanwhile.
function returnFocusTo(element: HTMLElement | null): void {
  if (!element?.isConnected) return;
  // Focus left on the closing dialog (inert, or already removed) counts as nowhere.
  const free = (): boolean => {
    const active = document.activeElement;
    return active === null || active === document.body || !active.isConnected || active.closest('[inert]') !== null;
  };
  if (!isDisabled(element)) {
    if (free()) element.focus();
    return;
  }
  const observer = new MutationObserver(() => {
    if (isDisabled(element)) return;
    stop();
    if (free() && element.isConnected) element.focus();
  });
  const timer = setTimeout(() => stop(), RETURN_WAIT_MS);
  function stop(): void {
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(element, { attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'data-disabled'] });
}
</script>

<script setup lang="ts">
import { nextTick, onScopeDispose, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { Info, OctagonAlert, TriangleAlert } from 'lucide-vue-next';
import { useOverlayDialog } from '@/composables/useOverlayDialog';
import type { MessageSeverity } from '../../../preload/overlay-channels';

export interface DialogButton {
  readonly label: string;
  // fill: the dialog's main action; plain: Cancel and the other actions
  readonly variant: 'fill' | 'plain';
  readonly icon?: Component;
  readonly testId?: string;
}

/**
 * Every desktop dialog (D41): a severity badge, a heading and the buttons, as an alertdialog on the overlay's modal
 * layer, so it paints and takes Escape above the settings modal. Focus starts on `initialFocus`, Tab stays inside, Enter
 * activates the focused button and Escape or a click on the scrim chooses `cancelIndex`.
 */
const props = defineProps<{
  severity: MessageSeverity;
  title: string;
  message?: string | undefined;
  buttons: readonly DialogButton[];
  initialFocus: number;
  cancelIndex: number;
  testId?: string;
}>();
const emit = defineEmits<{ choose: [index: number] }>();
const { t } = useI18n();

const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : lastFocused;
const { zIndex, root, titleId } = useOverlayDialog(() => emit('choose', props.cancelIndex), { modal: true });
const messageId = `${titleId}-message`;
const severityId = `${titleId}-severity`;
// After useOverlayDialog's own return, which cannot reach a control that was disabled when the dialog opened.
onScopeDispose(() => void nextTick(() => returnFocusTo(opener)));

const BADGE: Readonly<Record<MessageSeverity, { readonly icon: Component; readonly classes: string }>> = {
  info: { icon: Info, classes: 'bg-(--d-info)/15 text-(--d-info)' },
  warning: { icon: TriangleAlert, classes: 'bg-(--d-warning)/15 text-(--d-warning)' },
  danger: { icon: OctagonAlert, classes: 'bg-(--d-danger)/15 text-(--d-danger)' },
};
const FILL: Readonly<Record<MessageSeverity, string>> = {
  info: 'bg-(--d-accent) text-(--d-on-accent)',
  warning: 'bg-(--d-accent) text-(--d-on-accent)',
  danger: 'bg-(--d-danger) text-(--d-on-danger)',
};
</script>

<template>
  <div
    class="overlay-dialog fixed inset-0 flex items-center justify-center bg-(--d-scrim) p-5"
    :style="{ zIndex }"
    @click.self="emit('choose', cancelIndex)"
    @contextmenu.self.prevent="emit('choose', cancelIndex)"
  >
    <div
      ref="root"
      role="alertdialog"
      aria-modal="true"
      tabindex="-1"
      :data-testid="testId ?? 'overlay-dialog'"
      :data-severity="severity"
      :aria-labelledby="`${severityId} ${titleId}`"
      :aria-describedby="message || $slots.default ? messageId : undefined"
      class="overlay-dialog-panel flex w-[min(440px,100%)] flex-col gap-3.5 rounded-[14px] border border-(--d-border2) bg-(--d-card) px-[18px] pt-[18px] pb-4 text-(--d-text) shadow-(--d-shadow) outline-none"
    >
      <div class="flex items-start gap-3">
        <span
          class="flex size-[30px] shrink-0 items-center justify-center rounded-[9px]"
          :class="BADGE[severity].classes"
        >
          <component
            :is="BADGE[severity].icon"
            aria-hidden="true"
            class="size-4"
          />
          <span
            :id="severityId"
            class="sr-only"
          >{{ t(`dialog.${severity}`) }}</span>
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
          <h2
            :id="titleId"
            class="text-[14.5px] leading-snug font-semibold break-words"
          >
            {{ title }}
          </h2>
          <div
            v-if="message || $slots.default"
            :id="messageId"
            class="flex flex-col gap-3"
          >
            <p
              v-if="message"
              class="text-[12.5px] leading-relaxed text-pretty break-words whitespace-pre-wrap text-(--d-muted)"
            >
              {{ message }}
            </p>
            <slot />
          </div>
        </div>
      </div>
      <div class="flex flex-wrap justify-end gap-2">
        <button
          v-for="(button, index) in buttons"
          :key="index"
          type="button"
          :data-testid="button.testId"
          :data-overlay-initial-focus="index === initialFocus ? '' : undefined"
          class="d-press flex h-8 items-center gap-1.5 rounded-[9px] px-3.5 text-[12.5px]"
          :class="button.variant === 'fill' ? [FILL[severity], 'font-semibold hover:brightness-110'] : 'hover:bg-(--d-hover)'"
          @click="emit('choose', index)"
        >
          <component
            :is="button.icon"
            v-if="button.icon"
            aria-hidden="true"
            class="size-[13px]"
          />
          {{ button.label }}
        </button>
      </div>
    </div>
  </div>
</template>
