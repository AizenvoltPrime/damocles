<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { X } from 'lucide-vue-next';
import type { DamoclesOverlayApi, OverlayRect, OverlayToast, OverlayToastArea } from '../../../preload/overlay-channels';
import { TOAST_OPEN_ACTION } from '../../../preload/notifications';
import { trapTab } from '../focus-trap';
import { notificationView, relativeTime, TONE_CLASSES, type NotificationView } from '../notification-view';
import NotificationAvatar from './NotificationAvatar.vue';
import ToastLife from './ToastLife.vue';

const props = defineProps<{ api: DamoclesOverlayApi }>();
const { t, locale } = useI18n();

// Served by protocol.ts; a bound URL, so vite does not treat it as a module import.
const LOGO_URL = 'app://damocles/resources/icon.png';
const APP_NAME = 'Damocles';
// At most this many toasts show; older ones collapse into the "N more · Dismiss all" pill.
const MAX_VISIBLE = 3;
// CSS px between the stack and the popup window's bottom-right corner; the reported area includes it on every side.
// The toast and pill shadows reach at most 14px below and 10px beside them, so the window never clips them.
// The stack's width is fixed: the window is sized to the area it reports, so a width from 100vw would feed back.
const MARGIN = 16;
// How often the header's relative time is refreshed while a toast shows.
const CLOCK_TICK_MS = 30_000;

type Politeness = 'polite' | 'assertive';

const toasts = shallowRef<readonly OverlayToast[]>([]);
const visible = computed(() => toasts.value.slice(-MAX_VISIBLE));
const hiddenCount = computed(() => Math.max(0, toasts.value.length - MAX_VISIBLE));
const now = ref(Date.now());

const translate = (key: string, values?: Record<string, unknown>): string => (values ? t(key, values) : t(key));
function viewOf(toast: OverlayToast): NotificationView {
  return notificationView(toast.body, translate, locale.value, now.value);
}
const shownToasts = computed(() => visible.value.map((toast) => ({ toast, shown: viewOf(toast) })));

// Mirrors main's countdown, so a toast that mounts late (it was collapsed) starts its life bar where main's timer is.
const clocks = new Map<string, { remaining: number; since: number | undefined }>();
function remainingNow(toast: OverlayToast): number {
  const clock = clocks.get(toast.id);
  if (!clock) return toast.remainingMs;
  return Math.max(0, clock.remaining - (clock.since === undefined ? 0 : Date.now() - clock.since));
}

// Each toast is announced as its own node in the hidden live region for its politeness, which exists before any node
// lands in it: a screen reader reads every node added, so toasts that arrive together are each heard. A node goes with
// its toast, silently, since a live region announces only additions.
interface Announcement {
  readonly id: string;
  readonly text: string;
}
const announcements = shallowRef<Readonly<Record<Politeness, readonly Announcement[]>>>({ polite: [], assertive: [] });
function announce(toast: OverlayToast): void {
  const shown = viewOf(toast);
  const live: Politeness = shown.urgent ? 'assertive' : 'polite';
  const text = [shown.where, shown.title, `${shown.lead} ${shown.message}`.trim()].filter((part) => part !== '').join(': ');
  announcements.value = { ...announcements.value, [live]: [...announcements.value[live], { id: toast.id, text }] };
}

const stack = ref<HTMLElement | null>(null);

function toastElement(id: string): HTMLElement | undefined {
  return [...(stack.value?.querySelectorAll<HTMLElement>('[data-toast-id]') ?? [])].find((element) => element.dataset.toastId === id);
}

// The DOM typings predate FocusOptions.focusVisible, which Chromium supports.
type VisibleFocusOptions = NonNullable<Parameters<HTMLElement['focus']>[0]> & { readonly focusVisible?: boolean };

function focusNewest(options: VisibleFocusOptions = {}): void {
  const newest = visible.value.at(-1);
  const element = newest ? toastElement(newest.id) : undefined;
  (element?.querySelector<HTMLElement>('[data-toast-primary]') ?? element?.querySelector<HTMLElement>('button'))?.focus(options);
}

function remove(keep: (toast: OverlayToast) => boolean): void {
  const kept = toasts.value.filter(keep);
  for (const toast of toasts.value) if (!kept.includes(toast)) clocks.delete(toast.id);
  toasts.value = kept;
  const ids = new Set(kept.map((toast) => toast.id));
  const still = (list: readonly Announcement[]): readonly Announcement[] => list.filter((announcement) => ids.has(announcement.id));
  announcements.value = { polite: still(announcements.value.polite), assertive: still(announcements.value.assertive) };
}

// The part holding keyboard focus can go: its toast answered or dismissed, collapsed into the pill by a newer one, or the
// pill with nothing left behind it. Focus then moves to the newest toast; with none left it leaves the popup window at
// once, as Escape does, rather than once the exit has played and main hides the window. Pre-flush, while that part is
// still in the DOM.
watch(toasts, (list) => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !stack.value?.contains(active)) return;
  const card = active.closest<HTMLElement>('[data-toast-id]')?.dataset.toastId;
  const stays = card === undefined ? hiddenCount.value > 0 : visible.value.some((toast) => toast.id === card);
  if (stays) return;
  if (list.length === 0) props.api.leaveToasts();
  else void nextTick(() => focusNewest());
});

function drop(id: string): void {
  remove((toast) => toast.id !== id);
}

// Main owns each toast's life; the page only reports the user's answer, undefined meaning dismissed. The answer goes
// before focus leaves the stack, so main runs the action (a chat reloading, a chat selected) before it places focus.
function resolve(id: string, action?: string): void {
  props.api.resolveToast(id, action);
  drop(id);
}

function dismissAll(): void {
  for (const toast of toasts.value) props.api.resolveToast(toast.id);
  remove(() => false);
}

// A click on a kind's card is its action, as in the reference; a core notice has no action of its own.
function openFromCard(toast: OverlayToast): void {
  if (toast.body.kind !== 'notice') resolve(toast.id, TOAST_OPEN_ACTION);
}

// The pointer or keyboard focus on a toast holds its life; main pauses its timer and the bar pauses with :hover and :focus-within.
const holders = new Map<string, Set<'pointer' | 'focus'>>();
function hold(id: string, by: 'pointer' | 'focus', held: boolean): void {
  const reasons = holders.get(id) ?? new Set();
  const was = reasons.size > 0;
  if (held) reasons.add(by);
  else reasons.delete(by);
  if (reasons.size > 0) holders.set(id, reasons);
  else holders.delete(id);
  if (was !== reasons.size > 0) setHeld(id, !was);
}

function setHeld(id: string, held: boolean): void {
  const clock = clocks.get(id);
  if (clock) {
    if (held && clock.since !== undefined) {
      clock.remaining = Math.max(0, clock.remaining - (Date.now() - clock.since));
      clock.since = undefined;
    } else if (!held) {
      clock.since = Date.now();
    }
  }
  props.api.holdToast(id, held);
}

// A card that leaves the visible set (collapsed into the pill, or gone) may never report the pointer or focus leaving,
// so its holds end here; one still waiting in the pill tells main to run its timer again.
watch(() => visible.value.map((toast) => toast.id), (ids, previous) => {
  for (const id of previous) {
    if (ids.includes(id) || !holders.delete(id)) continue;
    if (toasts.value.some((toast) => toast.id === id)) setHeld(id, false);
  }
});

function onFocusOut(id: string, event: FocusEvent): void {
  const next = event.relatedTarget;
  if (next instanceof Node && toastElement(id)?.contains(next)) return;
  hold(id, 'focus', false);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    props.api.leaveToasts();
    return;
  }
  if (stack.value) trapTab(event, stack.value);
}

function offsetWithin(node: HTMLElement, ancestor: HTMLElement): { left: number; top: number } {
  const offset = { left: 0, top: 0 };
  for (let current: HTMLElement | null = node; current && current !== ancestor; current = current.offsetParent as HTMLElement | null) {
    offset.left += current.offsetLeft;
    offset.top += current.offsetTop;
  }
  return offset;
}

// The toasts and the pill: the only parts of the popup window that take the pointer (D52).
const PART = '[data-toast-part]';

// Layout sizes, never transformed boxes, so an entrance's slide does not widen the area. The area also covers a leaving
// toast, which may stand above the stack, so main keeps the window over it until its exit has played.
let reported = '';
function reportArea(): void {
  const element = stack.value;
  let area: OverlayToastArea = { width: 0, height: 0, parts: [] };
  if (element && (toasts.value.length > 0 || leaving.value > 0)) {
    const tops = [...element.querySelectorAll<HTMLElement>('[data-toast-id]')].map((toast) => offsetWithin(toast, element).top);
    const top = Math.min(0, ...tops);
    const parts = [...element.querySelectorAll<HTMLElement>(PART)].flatMap((part): OverlayRect[] => {
      const offset = offsetWithin(part, element);
      const box = { x: MARGIN + offset.left, y: MARGIN - top + offset.top, width: part.offsetWidth, height: part.offsetHeight };
      return box.width > 0 && box.height > 0 ? [box] : [];
    });
    area = { width: Math.ceil(element.offsetWidth) + MARGIN * 2, height: Math.ceil(element.offsetHeight - top) + MARGIN * 2, parts };
  }
  const key = JSON.stringify(area);
  if (key === reported) return;
  reported = key;
  props.api.reportToastArea(area);
}

// Main lets the popup window take the pointer only while it is over a toast or the pill; elsewhere clicks reach what is
// under the window, whose pointer moves still arrive here.
let pointerOverPart = false;
function pointerOver(over: boolean): void {
  if (over === pointerOverPart) return;
  pointerOverPart = over;
  props.api.reportToastPointer(over);
}
function onMouseOver(event: MouseEvent): void {
  pointerOver(event.target instanceof Element && event.target.closest(PART) !== null);
}
function onMouseOut(event: MouseEvent): void {
  if (event.relatedTarget === null) pointerOver(false);
}

// A leaving toast leaves the flow where it stands, measured from the stack's bottom, so its siblings glide into place.
const leaving = ref(0);
function onBeforeLeave(element: Element): void {
  const toast = element as HTMLElement;
  const parent = toast.offsetParent as HTMLElement | null;
  leaving.value++;
  toast.style.width = `${toast.offsetWidth}px`;
  toast.style.right = '0px';
  toast.style.bottom = `${(parent?.clientHeight ?? 0) - toast.offsetTop - toast.offsetHeight}px`;
  toast.setAttribute('inert', '');
}
function onAfterLeave(): void {
  leaving.value = Math.max(0, leaving.value - 1);
  void nextTick(reportArea);
}

const stops: Array<() => void> = [];
let observer: ResizeObserver | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
watch(() => toasts.value.length > 0, (showing) => {
  clearInterval(tick);
  tick = undefined;
  if (!showing) return;
  now.value = Date.now();
  tick = setInterval(() => {
    now.value = Date.now();
  }, CLOCK_TICK_MS);
});

onMounted(() => {
  stops.push(props.api.onToast((toast) => {
    if (toasts.value.some((existing) => existing.id === toast.id)) return;
    clocks.set(toast.id, { remaining: toast.remainingMs, since: Date.now() });
    toasts.value = [...toasts.value, toast];
    announce(toast);
  }));
  stops.push(props.api.onToastDismiss(drop));
  // F6 lands on the newest toast's action; the key went to another view, so this page's last input may be a click that would hide the ring.
  stops.push(props.api.onToastsFocus(() => focusNewest({ focusVisible: true })));
  observer = new ResizeObserver(reportArea);
  if (stack.value) observer.observe(stack.value);
  reportArea();
  document.addEventListener('mouseover', onMouseOver);
  document.addEventListener('mouseout', onMouseOut);
});
watch(toasts, reportArea, { flush: 'post' });
onBeforeUnmount(() => {
  for (const stop of stops) stop();
  observer?.disconnect();
  clearInterval(tick);
  document.removeEventListener('mouseover', onMouseOver);
  document.removeEventListener('mouseout', onMouseOut);
});
</script>

<template>
  <section
    ref="stack"
    data-testid="overlay-toasts"
    :aria-label="t('toasts.region')"
    class="pointer-events-none fixed right-4 bottom-4 flex w-[380px] flex-col items-end gap-2.5"
    @keydown="onKeydown"
  >
    <Transition name="t-fade">
      <button
        v-if="hiddenCount > 0"
        type="button"
        data-testid="overlay-toasts-more"
        data-toast-part
        class="d-press pointer-events-auto self-center rounded-full border border-(--d-border2) bg-(--d-card) px-3 py-1 text-[11.5px] text-(--d-muted) shadow-[0_1px_2px_rgb(0_0_0/0.12),0_4px_12px_-2px_rgb(0_0_0/0.24)] hover:text-(--d-text)"
        @click="dismissAll"
      >
        {{ t('toasts.moreDismissAll', { count: hiddenCount }) }}
      </button>
    </Transition>
    <div
      v-for="live in (['polite', 'assertive'] as const)"
      :key="live"
      :aria-live="live"
      :data-testid="`overlay-toasts-${live}`"
      class="sr-only"
    >
      <p
        v-for="announcement in announcements[live]"
        :key="announcement.id"
      >
        {{ announcement.text }}
      </p>
    </div>
    <TransitionGroup
      tag="div"
      name="toast"
      class="relative flex w-full flex-col items-end gap-2.5"
      @before-leave="onBeforeLeave"
      @after-leave="onAfterLeave"
    >
      <article
        v-for="{ toast, shown } in shownToasts"
        :key="toast.id"
        data-testid="overlay-toast"
        data-toast-part
        :data-toast-id="toast.id"
        :data-kind="shown.kind"
        :data-severity="toast.body.kind === 'notice' ? toast.body.severity : undefined"
        class="toast-card pointer-events-auto relative flex w-full gap-3 overflow-hidden rounded-[14px] border border-(--d-border2) bg-(--d-card) p-3 pb-[13px] text-(--d-text) shadow-[0_1px_2px_rgb(0_0_0/0.12),0_4px_12px_-2px_rgb(0_0_0/0.24)]"
        :class="shown.kind === 'notice' ? '' : 'cursor-pointer'"
        @mouseenter="hold(toast.id, 'pointer', true)"
        @mouseleave="hold(toast.id, 'pointer', false)"
        @focusin="hold(toast.id, 'focus', true)"
        @focusout="onFocusOut(toast.id, $event)"
        @click="openFromCard(toast)"
      >
        <NotificationAvatar
          :view="shown"
          size="toast"
        />
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <div class="flex h-[18px] items-center gap-1.5 text-[11px] text-(--d-faint)">
            <img
              :src="LOGO_URL"
              alt=""
              class="size-3"
            >
            <span class="font-semibold text-(--d-muted)">{{ APP_NAME }}</span>
            <span aria-hidden="true">·</span>
            <span class="min-w-0 truncate">{{ shown.where }}</span>
            <span class="flex-1" />
            <time
              class="shrink-0"
              :datetime="new Date(toast.at).toISOString()"
            >{{ relativeTime(toast.at, now, translate) }}</time>
            <button
              type="button"
              data-testid="overlay-toast-dismiss"
              class="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
              :aria-label="t('toasts.dismiss')"
              :title="t('toasts.dismiss')"
              @click.stop="resolve(toast.id)"
            >
              <X
                aria-hidden="true"
                class="size-3"
              />
            </button>
          </div>
          <template v-if="shown.kind === 'notice'">
            <p class="max-h-40 overflow-y-auto text-[12.5px] break-words whitespace-pre-wrap text-(--d-text)">
              <span class="sr-only">{{ shown.where }}: </span>{{ shown.message }}
            </p>
          </template>
          <template v-else>
            <div class="truncate text-[13.5px] font-semibold">
              {{ shown.title }}
            </div>
            <p class="line-clamp-2 text-[12.5px] text-pretty text-(--d-muted)">
              <span
                class="font-semibold"
                :class="TONE_CLASSES[shown.tone].cardLead"
              >{{ shown.lead }}</span> {{ shown.message }}
            </p>
          </template>
          <div
            v-if="shown.action || shown.actions.length > 0"
            class="mt-2 flex flex-wrap gap-1.5"
          >
            <button
              v-if="shown.action"
              type="button"
              data-toast-primary
              class="d-press flex h-7 items-center gap-1.5 rounded-lg px-[11px] text-xs font-semibold whitespace-nowrap hover:brightness-115"
              :class="[TONE_CLASSES[shown.tone].pill, TONE_CLASSES[shown.tone].pillText]"
              @click.stop="resolve(toast.id, TOAST_OPEN_ACTION)"
            >
              <component
                :is="shown.action.icon"
                aria-hidden="true"
                class="size-3"
              />
              {{ shown.action.label }}
            </button>
            <button
              v-for="(action, index) in shown.actions"
              :key="index"
              type="button"
              :data-toast-primary="index === 0 ? '' : undefined"
              class="d-press flex h-7 items-center rounded-lg px-[11px] text-xs whitespace-nowrap"
              :class="index === 0
                ? [TONE_CLASSES[shown.tone].pill, TONE_CLASSES[shown.tone].pillText, 'font-semibold hover:brightness-115']
                : 'border border-(--d-border2) text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text)'"
              @click.stop="resolve(toast.id, action)"
            >
              {{ action }}
            </button>
          </div>
        </div>
        <ToastLife
          :life-ms="toast.lifeMs"
          :remaining-ms="remainingNow(toast)"
          :fill-class="TONE_CLASSES[shown.tone].lifeBar"
        />
      </article>
    </TransitionGroup>
  </section>
</template>
