<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Search } from 'lucide-vue-next';
import type { OverlayAnswer, OverlayMenuItem, OverlayRequest } from '../../../preload/overlay-channels';
import { OVERLAY_ICON_COMPONENTS } from '../icons';
import { placePopup } from '../placement';

type MenuRequest = Extract<OverlayRequest, { kind: 'menu' }>;
type MenuEntry = Extract<OverlayMenuItem, { kind: 'item' }>;

const props = defineProps<{ request: MenuRequest }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

// Type-ahead keystrokes further apart than this start a new search.
const TYPE_AHEAD_RESET_MS = 500;

const root = ref<HTMLElement | null>(null);
const filterInput = ref<HTMLInputElement | null>(null);
const position = ref<{ left: number; top: number }>({ left: props.request.anchor.x, top: props.request.anchor.y + props.request.anchor.height });
const filter = ref('');

const rows = computed<OverlayMenuItem[]>(() => {
  const needle = filter.value.trim().toLocaleLowerCase();
  if (!needle) return [...props.request.items];
  return props.request.items.filter((item) => item.kind === 'item' && item.label.toLocaleLowerCase().includes(needle));
});
const items = computed(() => rows.value.filter((row): row is MenuEntry => row.kind === 'item'));

const itemElements = (): HTMLElement[] => [...(root.value?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])];

function focusItem(index: number): void {
  const elements = itemElements();
  if (elements.length === 0) return;
  elements[(index + elements.length) % elements.length]?.focus();
}

const focusedIndex = (): number => itemElements().indexOf(document.activeElement as HTMLElement);

function choose(item: MenuEntry): void {
  if (item.disabled) return;
  emit('answer', { kind: 'menu', itemId: item.id });
}

let typed = '';
let typedAt = 0;
function typeAhead(char: string): void {
  const now = Date.now();
  typed = now - typedAt > TYPE_AHEAD_RESET_MS ? char : typed + char;
  typedAt = now;
  // Repeating one letter cycles through the items that start with it.
  const needle = ([...typed].every((c) => c === char) ? char : typed).toLocaleLowerCase();
  const start = focusedIndex();
  const list = items.value;
  for (let step = 1; step <= list.length; step++) {
    const index = (start + step) % list.length;
    if (list[index]?.label.toLocaleLowerCase().startsWith(needle)) {
      focusItem(index);
      return;
    }
  }
}

function onItemKeydown(event: KeyboardEvent, item: MenuEntry): void {
  const index = focusedIndex();
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  if (!printable) typed = '';
  if (event.key === 'ArrowDown') focusItem(index + 1);
  else if (event.key === 'ArrowUp') {
    if (index === 0 && filterInput.value) filterInput.value.focus();
    else focusItem(index - 1);
  } else if (event.key === 'Home') focusItem(0);
  else if (event.key === 'End') focusItem(-1);
  else if (event.key === 'Enter' || event.key === ' ') choose(item);
  else if (event.key === 'Tab') emit('answer', { kind: 'dismissed' });
  else if (printable) typeAhead(event.key);
  else return;
  event.preventDefault();
}

function onFilterKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') focusItem(0);
  else if (event.key === 'Enter') {
    const first = items.value.find((item) => !item.disabled);
    if (first) choose(first);
  } else if (event.key === 'Tab') emit('answer', { kind: 'dismissed' });
  else return;
  event.preventDefault();
}

onMounted(() => {
  const element = root.value;
  if (!element) return;
  // Layout size, not getBoundingClientRect: the entrance animation starts scaled down.
  position.value = placePopup(props.request.anchor, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
  void nextTick(() => (filterInput.value ? filterInput.value.focus() : focusItem(0)));
});
</script>

<template>
  <div
    ref="root"
    data-testid="overlay-menu"
    class="fixed flex max-h-[min(420px,calc(100vh-16px))] w-[230px] animate-[d-pop_.14s_ease-out] flex-col overflow-hidden rounded-[11px] border border-(--d-border2) bg-(--d-card) text-(--d-text) shadow-(--d-shadow)"
    :style="{ left: `${position.left}px`, top: `${position.top}px` }"
  >
    <label
      v-if="request.filterPlaceholder !== undefined"
      class="flex h-8 shrink-0 items-center gap-[7px] border-b border-(--d-border) px-2.5"
    >
      <Search
        aria-hidden="true"
        class="size-3 text-(--d-faint)"
      />
      <input
        ref="filterInput"
        v-model="filter"
        type="text"
        data-testid="overlay-menu-filter"
        :aria-label="request.filterPlaceholder"
        :placeholder="request.filterPlaceholder"
        class="min-w-0 flex-1 border-0 bg-transparent text-xs text-(--d-text) outline-none placeholder:text-(--d-faint)"
        @keydown="onFilterKeydown"
      >
    </label>
    <div
      role="menu"
      :aria-label="request.label"
      class="min-h-0 flex-1 overflow-y-auto p-[5px]"
    >
      <template
        v-for="(row, index) in rows"
        :key="row.kind === 'item' ? `item:${row.id}` : `separator:${index}`"
      >
        <div
          v-if="row.kind === 'separator'"
          role="separator"
          class="mx-0.5 my-1 h-px bg-(--d-border)"
        />
        <div
          v-else
          data-menu-item
          :data-item-id="row.id"
          :role="row.checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
          :aria-checked="row.checked"
          :aria-disabled="row.disabled || undefined"
          tabindex="-1"
          class="group/item flex cursor-pointer items-center gap-[9px] rounded-[7px] px-[9px] py-1.5 text-[12.5px] outline-none hover:bg-(--d-hover) focus:bg-(--d-hover)"
          :class="[row.danger ? 'text-(--d-danger) hover:text-(--d-danger-text) focus:text-(--d-danger-text)' : '', row.disabled ? 'cursor-default opacity-50' : '']"
          @click="choose(row)"
          @keydown="onItemKeydown($event, row)"
          @mousemove="($event.currentTarget as HTMLElement).focus()"
        >
          <component
            :is="OVERLAY_ICON_COMPONENTS[row.icon]"
            v-if="row.icon"
            aria-hidden="true"
            class="size-[13px] shrink-0"
          />
          <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
          <span
            v-if="row.shortcut"
            class="shrink-0 font-mono text-[10.5px] text-(--d-faint) group-hover/item:text-(--d-faint-text) group-focus/item:text-(--d-faint-text)"
          >{{ row.shortcut }}</span>
          <Check
            v-if="row.checked !== undefined"
            aria-hidden="true"
            class="size-3 shrink-0 text-(--d-accent)"
            :class="row.checked ? '' : 'invisible'"
          />
        </div>
      </template>
    </div>
    <p
      v-if="items.length === 0"
      class="p-3 text-center text-xs text-(--d-faint)"
    >
      {{ t('overlay.noMatches') }}
    </p>
  </div>
</template>
