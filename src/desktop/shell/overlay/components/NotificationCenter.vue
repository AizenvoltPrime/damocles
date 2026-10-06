<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { Bell, Moon } from 'lucide-vue-next';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import type { NotificationCenterState, NotificationEntry } from '../../../preload/notifications';
import { trapTab } from '../focus-trap';
import { notificationView, relativeTime, TONE_CLASSES } from '../notification-view';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import NotificationAvatar from './NotificationAvatar.vue';

const props = defineProps<{ api: DamoclesOverlayApi; request: Extract<OverlayRequest, { kind: 'notifications' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t, locale } = useI18n();
const translate = (key: string, values?: Record<string, unknown>): string => (values ? t(key, values) : t(key));

// CSS px: the gap under the bell, the margin kept from the viewport's edges, and a virtualized row's fixed height.
const GAP = 6;
const EDGE = 12;
const ROW_HEIGHT = 84;
// Plan section 7: lists that can pass 200 rows render virtualized.
const VIRTUALIZE_AFTER = 200;
// Rows past this many arrive together rather than one step after another.
const MAX_STAGGERED_ROWS = 10;
const CLOCK_TICK_MS = 30_000;

const titleId = useId();
const helpId = useId();
const dndLabelId = useId();
const subtitleId = useId();
const state = shallowRef<NotificationCenterState | null>(null);
const entries = computed(() => state.value?.entries ?? []);
const virtual = computed(() => entries.value.length > VIRTUALIZE_AFTER);
const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(entries, { itemHeight: ROW_HEIGHT, overscan: 8 });
const now = ref(Date.now());
const rows = computed(() => {
  const shown = virtual.value
    ? list.value.map((item) => ({ entry: item.data, index: item.index }))
    : entries.value.map((entry, index) => ({ entry, index }));
  return shown.map((row) => ({ ...row, view: notificationView(row.entry.body, translate, locale.value, now.value) }));
});

const panel = ref<HTMLElement | null>(null);

const placement = computed(() => {
  const { anchor } = props.request;
  const top = anchor.y + anchor.height + GAP;
  return {
    top: `${top}px`,
    right: `${Math.max(EDGE, window.innerWidth - (anchor.x + anchor.width))}px`,
    maxHeight: `min(540px, calc(100vh - ${top + EDGE}px))`,
  };
});

const subtitle = computed(() => {
  if (state.value?.popupsOff) return t('notifications.popupsOff');
  return state.value?.doNotDisturb ? t('notifications.popupsSilenced') : t('notifications.popupsOn');
});

function open(entry: NotificationEntry): void {
  emit('answer', { kind: 'notifications', action: 'open', entryId: entry.id });
}

// Main refuses the center's channels once the center has closed, as for a click still in flight; nothing is left to update.
function ignoreRefusal(): void {}

function clearAll(): void {
  props.api.clearNotifications().catch(ignoreRefusal);
}

function setDoNotDisturb(on: boolean): void {
  props.api.setDoNotDisturb(on).catch(ignoreRefusal);
}

function rowButton(index: number): HTMLElement | null {
  return panel.value?.querySelector<HTMLElement>(`[data-row-index="${index}"]`) ?? null;
}

function dndSwitch(): HTMLElement | null {
  return panel.value?.querySelector<HTMLElement>('[data-testid="notification-dnd"]') ?? null;
}

// Clear all and the rows go with the last entry; focus on one of them moves to the Do not disturb switch instead of
// falling to the body, outside the center's Tab trap.
watch(() => entries.value.length === 0, (empty) => {
  const active = document.activeElement;
  if (!empty || !(active instanceof HTMLElement) || !active.closest('[data-testid="notification-clear"], [data-testid="notification-list"]')) return;
  void nextTick(() => dndSwitch()?.focus());
});

// Arrow keys move through the rows; a virtualized row off screen is scrolled in before it takes focus.
async function focusRow(index: number): Promise<void> {
  const count = entries.value.length;
  if (count === 0) return;
  const target = (index + count) % count;
  let button = rowButton(target);
  if (!button && virtual.value) {
    scrollTo(target);
    await nextTick();
    await nextTick();
    button = rowButton(target);
  }
  button?.focus();
}

function onKeydown(event: KeyboardEvent): void {
  if (panel.value && trapTab(event, panel.value)) return;
  const current = (document.activeElement as HTMLElement | null)?.dataset.rowIndex;
  const index = current === undefined ? -1 : Number(current);
  const moves: Record<string, number | undefined> = {
    ArrowDown: index + 1,
    ArrowUp: index < 0 ? -1 : index - 1,
    Home: 0,
    End: entries.value.length - 1,
  };
  const next = moves[event.key];
  if (next === undefined) return;
  event.preventDefault();
  void focusRow(next);
}

const stops: Array<() => void> = [];
let tick: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  // Subscribed before the first read, so a change between the two is not lost; a push is always the newer state.
  stops.push(props.api.onNotifications((next) => {
    state.value = next;
  }));
  tick = setInterval(() => {
    now.value = Date.now();
  }, CLOCK_TICK_MS);
  const first = await props.api.getNotifications().catch(() => null);
  if (!state.value) state.value = first;
  await nextTick();
  (rowButton(0) ?? dndSwitch())?.focus();
});
onBeforeUnmount(() => {
  for (const stop of stops) stop();
  clearInterval(tick);
});
</script>

<template>
  <section
    ref="panel"
    role="dialog"
    data-testid="notification-center"
    :aria-labelledby="titleId"
    class="notification-center fixed flex w-[min(360px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-(--d-border2) bg-(--d-card) text-(--d-text) shadow-(--d-shadow)"
    :style="placement"
    @keydown="onKeydown"
  >
    <header class="flex items-center gap-2 pt-[11px] pr-3 pb-[9px] pl-3.5">
      <h2
        :id="titleId"
        class="text-[13px] font-semibold"
      >
        {{ t('notifications.title') }}
      </h2>
      <span
        v-if="entries.length > 0"
        data-testid="notification-count"
        class="font-mono text-[10.5px] text-(--d-faint)"
      >{{ entries.length }}</span>
      <span class="flex-1" />
      <button
        v-if="entries.length > 0"
        type="button"
        data-testid="notification-clear"
        class="rounded-md px-1.5 py-0.5 text-[11.5px] text-(--d-muted) transition-colors hover:text-(--d-text)"
        @click="clearAll"
      >
        {{ t('notifications.clearAll') }}
      </button>
    </header>
    <!-- The whole row is the switch's label, as in the reference, so a click anywhere on it toggles; the switch's name is the
         heading alone and the subtitle its description. -->
    <label
      data-testid="notification-dnd-row"
      class="mx-2 mb-2 flex items-center gap-2.5 rounded-[9px] bg-(--d-panel) px-2.5 py-2 transition-colors hover:bg-(--d-hover)"
    >
      <Moon
        aria-hidden="true"
        class="size-3.5 shrink-0 text-(--d-muted)"
      />
      <span class="flex min-w-0 flex-1 flex-col">
        <span
          :id="dndLabelId"
          class="text-[12.5px] font-medium"
        >{{ t('notifications.doNotDisturb') }}</span>
        <span
          :id="subtitleId"
          data-testid="notification-dnd-subtitle"
          class="text-[11px] text-(--d-faint-text)"
        >{{ subtitle }}</span>
      </span>
      <ToggleSwitch
        data-testid="notification-dnd"
        :checked="state?.doNotDisturb ?? false"
        :aria-labelledby="dndLabelId"
        :aria-describedby="subtitleId"
        @update:checked="setDoNotDisturb"
      />
    </label>
    <div
      v-bind="virtual ? containerProps : {}"
      class="min-h-0 flex-1 overflow-y-auto"
    >
      <p
        :id="helpId"
        class="sr-only"
      >
        {{ t('notifications.keyboardHelp') }}
      </p>
      <div v-bind="virtual ? wrapperProps : {}">
        <ul
          v-if="entries.length > 0"
          data-testid="notification-list"
          :aria-label="t('notifications.listLabel')"
          :aria-describedby="helpId"
        >
          <li
            v-for="{ entry, index, view } in rows"
            :key="entry.id"
            class="border-t border-(--d-border)"
            :class="virtual ? '' : 'center-row-arrive'"
            :style="virtual ? { height: `${ROW_HEIGHT}px` } : { '--row-index': String(Math.min(index, MAX_STAGGERED_ROWS)) }"
          >
            <button
              type="button"
              data-testid="notification-row"
              :data-row-index="index"
              :data-entry-id="entry.id"
              :data-kind="entry.body.kind"
              :data-read="entry.read"
              class="flex w-full gap-2.5 py-[9px] pr-3 pl-3.5 text-left transition-colors hover:bg-(--d-hover) focus-visible:bg-(--d-hover)"
              :class="virtual ? 'h-full overflow-hidden' : ''"
              @click="open(entry)"
            >
              <NotificationAvatar
                :view="view"
                size="row"
              />
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="flex items-baseline gap-2">
                  <span class="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{{ view.title || view.where }}</span>
                  <time
                    class="shrink-0 text-[10.5px] text-(--d-faint-text)"
                    :datetime="new Date(entry.at).toISOString()"
                  >{{ relativeTime(entry.at, now, translate) }}</time>
                </span>
                <span class="line-clamp-2 text-xs text-(--d-muted)">
                  <span
                    class="font-medium"
                    :class="TONE_CLASSES[view.tone].rowLead"
                  >{{ view.lead }}</span> {{ view.message }}
                </span>
                <span
                  v-if="view.title"
                  class="mt-0.5 truncate text-[10.5px] text-(--d-faint-text)"
                >{{ view.where }}</span>
              </span>
              <span
                class="mt-1.5 size-[7px] shrink-0 rounded-full transition-opacity duration-300"
                :class="entry.read ? 'opacity-0' : 'bg-(--d-accent)'"
              >
                <span
                  v-if="!entry.read"
                  class="sr-only"
                >{{ t('notifications.unread') }}</span>
              </span>
            </button>
          </li>
        </ul>
        <div
          v-else
          data-testid="notification-empty"
          class="flex flex-col items-center gap-1.5 border-t border-(--d-border) px-4 pt-[26px] pb-[30px] text-xs text-(--d-faint-text)"
        >
          <Bell
            aria-hidden="true"
            class="size-5"
          />
          {{ t('notifications.empty') }}
        </div>
      </div>
    </div>
    <footer
      data-testid="notification-footer"
      class="border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5 text-[11px] text-(--d-faint)"
    >
      {{ t('notifications.footer') }}
    </footer>
  </section>
</template>
