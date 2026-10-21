<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { Bell, CircleAlert, Moon } from 'lucide-vue-next';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest, PopupAnswer } from '../../../preload/overlay-channels';
import type { NotificationCenterState, NotificationEntry } from '../../../preload/notifications';
import { trapTab } from '../focus-trap';
import { answerOf } from '../popup-answer';
import { notificationView, relativeTime, TONE_CLASSES } from '../notification-view';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import NotificationAvatar from './NotificationAvatar.vue';

const props = defineProps<{ api: DamoclesOverlayApi; request: Extract<OverlayRequest, { kind: 'notifications' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t, locale } = useI18n();
const translate = (key: string, values?: Record<string, unknown>): string => (values ? t(key, values) : t(key));

// rem: the gap under the bell, the margin kept from the viewport's edges, and a virtualized row's fixed height.
const GAP_REM = 0.375;
const EDGE_REM = 0.75;
const ROW_REM = 5.25;
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
// the first read failed and main has pushed no state since
const loadFailed = ref(false);
const entries = computed(() => state.value?.entries ?? []);
const virtual = computed(() => entries.value.length > VIRTUALIZE_AFTER);
const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(entries, { itemHeight: () => remPx(ROW_REM), overscan: 8 });
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
  const top = anchor.y + anchor.height + remPx(GAP_REM);
  const edge = remPx(EDGE_REM);
  return {
    top: `${top}px`,
    right: `${Math.max(edge, window.innerWidth - (anchor.x + anchor.width))}px`,
    maxHeight: `min(33.75rem, calc(100vh - ${top + edge}px))`,
  };
});

const subtitle = computed(() => {
  if (state.value?.popupsOff) return t('notifications.popupsOff');
  return state.value?.doNotDisturb ? t('notifications.popupsSilenced') : t('notifications.popupsOn');
});

function open(entry: NotificationEntry): void {
  emit('answer', { kind: 'notifications', action: 'open', entryId: entry.id });
}

function answer(entry: NotificationEntry, label: string): void {
  emit('answer', { kind: 'notifications', action: 'answer', entryId: entry.id, label });
}

// A notice main keeps until it is answered offers its actions under its row.
function actionsOf(entry: NotificationEntry): readonly string[] {
  return entry.awaitingAnswer && entry.body.kind === 'notice' ? entry.body.actions : [];
}

// The center shows only the state main pushes, so a failed action leaves main's state on screen; this says it failed.
const failedAction = ref<string | null>(null);

function act(failureKey: string, action: () => Promise<PopupAnswer<void>>): void {
  failedAction.value = null;
  action().catch(() => {
    failedAction.value = failureKey;
  });
}

function clearAll(): void {
  act('notifications.clearFailed', () => props.api.clearNotifications());
}

function setDoNotDisturb(on: boolean): void {
  act('notifications.doNotDisturbFailed', () => props.api.setDoNotDisturb(on));
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
  try {
    const first = await answerOf(props.api.getNotifications());
    if (!state.value && first) state.value = first;
  } catch {
    loadFailed.value = true;
  }
  await nextTick();
  (rowButton(0) ?? dndSwitch())?.focus();
});
onBeforeUnmount(() => {
  for (const stop of stops) stop();
  clearInterval(tick);
});
</script>

<!-- Popover needs its trigger in this document; the bell is in the shell view, so the center places itself under it. -->
<template>
  <section
    ref="panel"
    role="dialog"
    data-testid="notification-center"
    :aria-labelledby="titleId"
    class="notification-center fixed flex w-[min(22.5rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-(--d-border2) bg-(--d-card) text-(--d-text) shadow-(--d-shadow)"
    :style="placement"
    @keydown="onKeydown"
  >
    <header class="flex items-center gap-2 pt-2.75 pr-3 pb-2.25 pl-3.5">
      <h2
        :id="titleId"
        class="text-13 font-semibold"
      >
        {{ t('notifications.title') }}
      </h2>
      <span
        v-if="entries.length > 0"
        data-testid="notification-count"
        class="font-mono text-10.5 text-(--d-faint)"
      >{{ entries.length }}</span>
      <span class="flex-1" />
      <Button
        v-if="entries.length > 0"
        type="button"
        variant="ghost"
        data-testid="notification-clear"
        class="h-auto rounded-md px-1.5 py-0.5 text-11.5 font-normal text-(--d-muted) hover:bg-transparent hover:text-(--d-text)"
        @click="clearAll"
      >
        {{ t('notifications.clearAll') }}
      </Button>
    </header>
    <!-- The whole row is the switch's label, as in the reference, so a click anywhere on it toggles; the switch's name is the
         heading alone and the subtitle its description. -->
    <label
      data-testid="notification-dnd-row"
      class="mx-2 mb-2 flex items-center gap-2.5 rounded-9 bg-(--d-panel) px-2.5 py-2 transition-colors hover:bg-(--d-hover)"
    >
      <Moon
        aria-hidden="true"
        class="size-3.5 shrink-0 text-(--d-muted)"
      />
      <span class="flex min-w-0 flex-1 flex-col">
        <span
          :id="dndLabelId"
          class="text-12.5 font-medium"
        >{{ t('notifications.doNotDisturb') }}</span>
        <span
          :id="subtitleId"
          data-testid="notification-dnd-subtitle"
          class="text-11 text-(--d-faint-text)"
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
    <p
      v-if="failedAction"
      role="alert"
      data-testid="notification-action-failed"
      class="mx-3.5 mb-2 text-11.5 text-(--d-danger-text)"
    >
      {{ t(failedAction) }}
    </p>
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
            :style="virtual ? { height: `${ROW_REM}rem` } : { '--row-index': String(Math.min(index, MAX_STAGGERED_ROWS)) }"
          >
            <button
              type="button"
              data-testid="notification-row"
              :data-row-index="index"
              :data-entry-id="entry.id"
              :data-kind="entry.body.kind"
              :data-read="entry.read"
              class="flex w-full gap-2.5 py-2.25 pr-3 pl-3.5 text-left transition-colors hover:bg-(--d-hover) focus-visible:bg-(--d-hover)"
              :class="virtual ? 'h-full overflow-hidden' : ''"
              @click="open(entry)"
            >
              <NotificationAvatar
                :view="view"
                size="row"
              />
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="flex items-baseline gap-2">
                  <span class="min-w-0 flex-1 truncate text-12.5 font-semibold">{{ view.title || view.where }}</span>
                  <time
                    class="shrink-0 text-10.5 text-(--d-faint-text)"
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
                  class="mt-0.5 truncate text-10.5 text-(--d-faint-text)"
                >{{ view.where }}</span>
              </span>
              <span
                class="mt-1.5 size-1.75 shrink-0 rounded-full transition-opacity duration-300"
                :class="entry.read ? 'opacity-0' : 'bg-(--d-accent)'"
              >
                <span
                  v-if="!entry.read"
                  class="sr-only"
                >{{ t('notifications.unread') }}</span>
              </span>
            </button>
            <!-- The toast's tinted action pills, which no Button variant draws; one row of them under the entry. -->
            <div
              v-if="actionsOf(entry).length > 0"
              data-testid="notification-row-actions"
              class="flex flex-wrap gap-1.5 pr-3 pb-2.25 pl-14"
            >
              <button
                v-for="(label, actionIndex) in actionsOf(entry)"
                :key="actionIndex"
                type="button"
                data-testid="notification-row-action"
                class="d-press flex h-7 items-center rounded-lg px-2.75 text-xs whitespace-nowrap"
                :class="actionIndex === 0
                  ? [TONE_CLASSES[view.tone].pill, TONE_CLASSES[view.tone].pillText, 'font-semibold hover:brightness-115']
                  : 'border border-(--d-border2) text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text)'"
                @click="answer(entry, label)"
              >
                {{ label }}
              </button>
            </div>
          </li>
        </ul>
        <div
          v-else-if="!state && loadFailed"
          role="alert"
          data-testid="notification-load-failed"
          class="flex flex-col items-center gap-1.5 border-t border-(--d-border) px-4 pt-6.5 pb-7.5 text-xs text-(--d-danger-text)"
        >
          <CircleAlert
            aria-hidden="true"
            class="size-5"
          />
          {{ t('notifications.loadFailed') }}
        </div>
        <div
          v-else
          data-testid="notification-empty"
          class="flex flex-col items-center gap-1.5 border-t border-(--d-border) px-4 pt-6.5 pb-7.5 text-xs text-(--d-faint-text)"
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
      class="border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5 text-11 text-(--d-faint)"
    >
      {{ t('notifications.footer') }}
    </footer>
  </section>
</template>
