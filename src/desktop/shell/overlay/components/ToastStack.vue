<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleX, Info, TriangleAlert, X } from 'lucide-vue-next';
import type { DamoclesOverlayApi, OverlayToast } from '../../../preload/overlay-channels';
import { trapTab } from '../focus-trap';

const props = defineProps<{ api: DamoclesOverlayApi }>();
const { t } = useI18n();

// At most this many toasts show; older ones collapse into the "N more · Dismiss all" pill.
const MAX_VISIBLE = 3;
// CSS px between the stack and the overlay viewport's bottom-right corner; the reported area includes it on every side.
const MARGIN = 16;

type Politeness = 'polite' | 'assertive';
function politeness(toast: OverlayToast): Politeness {
  return toast.severity === 'error' ? 'assertive' : 'polite';
}

const toasts = ref<OverlayToast[]>([]);
const visible = computed(() => toasts.value.slice(-MAX_VISIBLE));
// Toasts show in arrival order; each is announced through the hidden live region for its politeness, which exists before any text lands in it.
const announcements = ref<Record<Politeness, string>>({ polite: '', assertive: '' });
function announce(toast: OverlayToast): void {
  const live = politeness(toast);
  announcements.value[live] = '';
  void nextTick(() => {
    announcements.value[live] = `${t(`toasts.${toast.severity}`)}: ${toast.message}`;
  });
}
const hiddenCount = computed(() => Math.max(0, toasts.value.length - MAX_VISIBLE));
const stack = ref<HTMLElement | null>(null);

function toastElement(id: string): HTMLElement | undefined {
  return [...(stack.value?.querySelectorAll<HTMLElement>('[data-toast-id]') ?? [])].find((element) => element.dataset.toastId === id);
}

// The DOM typings predate FocusOptions.focusVisible, which Chromium supports.
type VisibleFocusOptions = NonNullable<Parameters<HTMLElement['focus']>[0]> & { readonly focusVisible?: boolean };

function focusNewest(options: VisibleFocusOptions = {}): void {
  const newest = visible.value.at(-1);
  if (newest) toastElement(newest.id)?.querySelector('button')?.focus(options);
}

// When the control holding keyboard focus goes, focus moves to the newest toast left; with none left main moves it out.
function remove(keep: (toast: OverlayToast) => boolean): void {
  const hadFocus = stack.value?.contains(document.activeElement) === true;
  toasts.value = toasts.value.filter(keep);
  if (!hadFocus) return;
  void nextTick(() => {
    if (!stack.value?.contains(document.activeElement)) focusNewest();
  });
}

function drop(id: string): void {
  remove((toast) => toast.id !== id);
}

// Main owns each toast's timeout; the overlay only reports the user's answer, undefined meaning dismissed.
function resolve(id: string, action?: string): void {
  drop(id);
  props.api.resolveToast(id, action);
}

function dismissAll(): void {
  const all = toasts.value;
  remove(() => false);
  for (const toast of all) props.api.resolveToast(toast.id);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    props.api.leaveToasts();
    return;
  }
  if (stack.value) trapTab(event, stack.value);
}

let reported = { width: -1, height: -1 };
function reportArea(): void {
  const rect = stack.value?.getBoundingClientRect();
  const size = toasts.value.length === 0 || !rect
    ? { width: 0, height: 0 }
    : { width: Math.ceil(rect.width) + MARGIN * 2, height: Math.ceil(rect.height) + MARGIN * 2 };
  if (size.width === reported.width && size.height === reported.height) return;
  reported = size;
  props.api.reportToastArea(size);
}

const stops: Array<() => void> = [];
let observer: ResizeObserver | undefined;
onMounted(() => {
  stops.push(props.api.onToast((toast) => {
    if (toasts.value.some((existing) => existing.id === toast.id)) return;
    toasts.value = [...toasts.value, toast];
    announce(toast);
  }));
  stops.push(props.api.onToastDismiss(drop));
  // F6 lands on the newest toast's first control; the key went to another view, so this page's last input may be a click that would hide the ring.
  stops.push(props.api.onToastsFocus(() => focusNewest({ focusVisible: true })));
  observer = new ResizeObserver(reportArea);
  if (stack.value) observer.observe(stack.value);
  reportArea();
});
watch(toasts, reportArea, { flush: 'post' });
onBeforeUnmount(() => {
  for (const stop of stops) stop();
  observer?.disconnect();
});

const ICONS = { info: Info, warning: TriangleAlert, error: CircleX } as const;
const ICON_CLASS = { info: 'text-(--d-info)', warning: 'text-(--d-warning)', error: 'text-(--d-danger)' } as const;
</script>

<template>
  <section
    ref="stack"
    data-testid="overlay-toasts"
    :aria-label="t('toasts.region')"
    class="pointer-events-none fixed right-4 bottom-4 flex w-[360px] flex-col items-end gap-2.5"
    @keydown="onKeydown"
  >
    <button
      v-if="hiddenCount > 0"
      type="button"
      data-testid="overlay-toasts-more"
      class="pointer-events-auto self-center rounded-full border border-(--d-border2) bg-(--d-card) px-3 py-1 text-[11.5px] text-(--d-muted) shadow-(--d-shadow) hover:text-(--d-text)"
      @click="dismissAll"
    >
      {{ t('toasts.moreDismissAll', { count: hiddenCount }) }}
    </button>
    <div
      v-for="live in (['polite', 'assertive'] as const)"
      :key="live"
      :aria-live="live"
      :data-testid="`overlay-toasts-${live}`"
      class="sr-only"
    >
      {{ announcements[live] }}
    </div>
    <div
      v-for="toast in visible"
      :key="toast.id"
      data-testid="overlay-toast"
      :data-toast-id="toast.id"
      :data-severity="toast.severity"
      class="pointer-events-auto flex w-full gap-3 rounded-[14px] border border-(--d-border2) bg-(--d-card) p-3 text-(--d-text) shadow-(--d-shadow) overlay-toast-enter"
    >
      <component
        :is="ICONS[toast.severity]"
        aria-hidden="true"
        class="mt-0.5 size-4 shrink-0"
        :class="ICON_CLASS[toast.severity]"
      />
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <p class="text-[12.5px] break-words whitespace-pre-wrap">
          <span class="sr-only">{{ t(`toasts.${toast.severity}`) }}: </span>{{ toast.message }}
        </p>
        <div
          v-if="toast.actions.length > 0"
          class="flex flex-wrap gap-1.5"
        >
          <button
            v-for="(action, index) in toast.actions"
            :key="index"
            type="button"
            class="flex h-7 items-center rounded-lg border border-(--d-border2) px-[11px] text-xs whitespace-nowrap hover:bg-(--d-hover)"
            @click="resolve(toast.id, action)"
          >
            {{ action }}
          </button>
        </div>
      </div>
      <button
        type="button"
        data-testid="overlay-toast-dismiss"
        class="-mt-1 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text)"
        :aria-label="t('toasts.dismiss')"
        :title="t('toasts.dismiss')"
        @click="resolve(toast.id)"
      >
        <X
          aria-hidden="true"
          class="size-3"
        />
      </button>
    </div>
  </section>
</template>
