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
import { defineComponent, nextTick, onScopeDispose, type Component, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import { Info, OctagonAlert, TriangleAlert } from 'lucide-vue-next';
import { AlertDialogContent, AlertDialogRoot, injectDialogRootContext } from 'reka-ui';
import { useOverlayDialog } from '@/composables/useOverlayDialog';
import type { MessageSeverity } from '../../../preload/overlay-channels';

export interface DialogButton {
  readonly label: string;
  // fill: the dialog's main action; plain: Cancel and the other actions
  readonly variant: 'fill' | 'plain';
  readonly icon?: Component;
  readonly testId?: string;
  // a button waiting on the dialog's input, such as a commit message
  readonly disabled?: boolean;
}

// accent: a question with no risk to warn of (a hand-off, a merge); its badge shows the action's own icon.
export type DialogSeverity = MessageSeverity | 'accent';

/**
 * Every desktop dialog (D41): a severity badge, a heading and the buttons, as a reka alert dialog on the overlay's modal
 * layer, so it paints and takes Escape above the settings modal and the pointer and focus above an open reka dialog. Focus starts on `initialFocus`, Tab stays inside, Enter
 * activates the focused button and Escape or a click on the scrim chooses `cancelIndex`. While `hasDraft` (the dialog holds
 * text the user typed) the scrim does nothing, so a stray click beside the panel never throws the text away.
 */
const props = defineProps<{
  severity: DialogSeverity;
  // the badge's icon in place of the severity's own
  icon?: Component | undefined;
  title: string;
  message?: string | undefined;
  buttons: readonly DialogButton[];
  initialFocus: number;
  cancelIndex: number;
  testId?: string;
  hasDraft?: boolean;
  // a dialog listing rows with several parts each
  wide?: boolean;
}>();
const emit = defineEmits<{ choose: [index: number] }>();
const { t } = useI18n();

const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : lastFocused;
const { zIndex, root, titleId, focusInitial } = useOverlayDialog(() => emit('choose', props.cancelIndex), { modal: true, opener });
const messageId = `${titleId}-message`;
const severityId = `${titleId}-severity`;

// reka names its content by the root's ids; the dialog's own take their place before the content reads them.
const DialogIds = defineComponent({
  props: { titleId: { type: String, required: true }, descriptionId: { type: String, required: true } },
  setup(ids) {
    const context = injectDialogRootContext();
    context.titleId = ids.titleId;
    context.descriptionId = ids.descriptionId;
    return () => null;
  },
});

function bindRoot(content: Element | ComponentPublicInstance | null): void {
  root.value = content && '$el' in content ? (content.$el as HTMLElement) : null;
}

// A reka dialog beneath kept focus until this layer's trap took over from its own, a tick after mount.
function onOpenAutoFocus(event: Event): void {
  event.preventDefault();
  focusInitial();
}

// After useOverlayDialog's own return, which cannot reach a control that was disabled when the dialog opened.
onScopeDispose(() => void nextTick(() => returnFocusTo(opener)));

function onScrim(): void {
  if (!props.hasDraft) emit('choose', props.cancelIndex);
}

const BADGE: Readonly<Record<DialogSeverity, { readonly icon: Component; readonly classes: string }>> = {
  accent: { icon: Info, classes: 'bg-(--d-accent-soft) text-(--d-accent-text)' },
  info: { icon: Info, classes: 'bg-(--d-info)/15 text-(--d-info)' },
  warning: { icon: TriangleAlert, classes: 'bg-(--d-warning)/15 text-(--d-warning)' },
  danger: { icon: OctagonAlert, classes: 'bg-(--d-danger)/15 text-(--d-danger)' },
};
const FILL: Readonly<Record<DialogSeverity, string>> = {
  accent: 'bg-(--d-accent) text-(--d-on-accent)',
  info: 'bg-(--d-accent) text-(--d-on-accent)',
  warning: 'bg-(--d-accent) text-(--d-on-accent)',
  danger: 'bg-(--d-danger) text-(--d-on-danger)',
};
</script>

<!-- The panel is a reka alert dialog layer that is always open, since main owns the open state and the panel plays its exit
     before the answer reaches main. As a layer it takes the pointer and focus above an open reka dialog (the Connect dialog),
     whose trap and outside-pointer rules leave a plain element neither. -->
<!-- pointer-events-auto: an open reka layer sets the body's pointer-events to none, which the scrim, outside the panel's
     layer, would otherwise inherit. -->
<template>
  <div
    class="overlay-dialog pointer-events-auto fixed inset-0 flex items-center justify-center bg-(--d-scrim) p-5"
    :style="{ zIndex }"
    @click.self="onScrim"
    @contextmenu.self.prevent="onScrim"
  >
    <AlertDialogRoot :open="true">
      <DialogIds
        :title-id="titleId"
        :description-id="messageId"
      />
      <AlertDialogContent
        :ref="bindRoot"
        data-overlay-layer
        aria-modal="true"
        tabindex="-1"
        :data-testid="testId ?? 'overlay-dialog'"
        :data-severity="severity"
        :aria-labelledby="severity === 'accent' ? titleId : `${severityId} ${titleId}`"
        :aria-describedby="message || $slots.default ? messageId : undefined"
        :class="wide ? 'w-[min(31rem,100%)]' : 'w-[min(27.5rem,100%)]'"
        class="overlay-dialog-panel flex flex-col gap-3.5 rounded-[0.875rem] border border-(--d-border2) bg-(--d-card) px-4.5 pt-4.5 pb-4 text-(--d-text) shadow-(--d-shadow) outline-none"
        @open-auto-focus="onOpenAutoFocus"
        @close-auto-focus.prevent
      >
        <div class="flex items-start gap-3">
          <span
            class="flex size-7.5 shrink-0 items-center justify-center rounded-9"
            :class="BADGE[severity].classes"
          >
            <component
              :is="icon ?? BADGE[severity].icon"
              aria-hidden="true"
              class="size-4"
              data-testid="overlay-dialog-icon"
            />
            <span
              v-if="severity !== 'accent'"
              :id="severityId"
              class="sr-only"
            >{{ t(`dialog.${severity}`) }}</span>
          </span>
          <div class="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
            <h2
              :id="titleId"
              class="text-[0.90625rem] leading-snug font-semibold wrap-break-word whitespace-pre-line"
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
                class="text-12.5/relaxed text-pretty wrap-break-word whitespace-pre-wrap text-(--d-muted)"
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
            :disabled="button.disabled"
            class="d-press flex h-8 items-center gap-1.5 rounded-9 px-3.5 text-12.5 disabled:cursor-default disabled:opacity-50"
            :class="button.variant === 'fill' ? [FILL[severity], 'font-semibold enabled:hover:brightness-110'] : 'enabled:hover:bg-(--d-hover)'"
            @click="emit('choose', index)"
          >
            <component
              :is="button.icon"
              v-if="button.icon"
              aria-hidden="true"
              class="size-3.25"
            />
            {{ button.label }}
          </button>
        </div>
      </AlertDialogContent>
    </AlertDialogRoot>
  </div>
</template>
