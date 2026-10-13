<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, ChevronRight, Search } from 'lucide-vue-next';
import type { OverlayAnswer, OverlayMenuItem, OverlayRequest } from '../../../preload/overlay-channels';
import { remPx } from '@/composables/useRemPx';
import { OVERLAY_ICON_COMPONENTS } from '../icons';
import { glyphLook } from '../../terminal/terminal-icons';
import { placePopup } from '../placement';
import { createPointerMoveFilter } from '../pointer-moved';

type MenuRequest = Extract<OverlayRequest, { kind: 'menu' }>;
type MenuEntry = Extract<OverlayMenuItem, { kind: 'item' }>;
type SubmenuEntry = Extract<OverlayMenuItem, { kind: 'submenu' }>;
type Focusable = MenuEntry | SubmenuEntry;

const props = defineProps<{ request: MenuRequest }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

// Type-ahead keystrokes further apart than this start a new search.
const TYPE_AHEAD_RESET_MS = 500;
// rem a submenu overlaps its parent menu's edge, as a cascading menu does
const SUBMENU_OVERLAP_REM = 0.25;

const root = ref<HTMLElement | null>(null);
const submenuElement = ref<HTMLElement | null>(null);
const filterInput = ref<HTMLInputElement | null>(null);
const position = ref<{ left: number; top: number }>({ left: props.request.anchor.x, top: props.request.anchor.y + props.request.anchor.height });
const filter = ref('');
// the open submenu and where it sits; null while none is open
const openSubmenu = ref<{ entry: SubmenuEntry; left: number; top: number; placed: boolean } | null>(null);

// A filter searches the leaves of every submenu as well.
const rows = computed<OverlayMenuItem[]>(() => {
  const needle = filter.value.trim().toLocaleLowerCase();
  if (!needle) return [...props.request.items];
  const leaves = props.request.items.flatMap((item) => (item.kind === 'submenu' ? item.items : [item]));
  return leaves.filter((item) => item.kind === 'item' && item.label.toLocaleLowerCase().includes(needle));
});
const items = computed(() => rows.value.filter((row): row is Focusable => row.kind !== 'separator'));
const submenuItems = computed(() => openSubmenu.value?.entry.items.filter((row): row is MenuEntry => row.kind === 'item') ?? []);
// A row without an icon keeps the icon column when others have one, so every label starts at the same edge.
const hasIcon = (list: readonly OverlayMenuItem[]): boolean => list.some((item) => item.kind !== 'separator' && (item.icon !== undefined || (item.kind === 'item' && item.glyph !== undefined)));
const iconColumn = computed(() => hasIcon(rows.value));
const submenuIconColumn = computed(() => hasIcon(openSubmenu.value?.entry.items ?? []));

const levelElements = (inSubmenu: boolean): HTMLElement[] =>
  [...((inSubmenu ? submenuElement.value : root.value)?.querySelectorAll<HTMLElement>(inSubmenu ? '[data-submenu-item]' : '[data-menu-item]') ?? [])];

function focusItem(index: number, inSubmenu = false): void {
  const elements = levelElements(inSubmenu);
  if (elements.length === 0) return;
  elements[(index + elements.length) % elements.length]?.focus();
}

const focusedIndex = (inSubmenu: boolean): number => levelElements(inSubmenu).indexOf(document.activeElement as HTMLElement);

// While a submenu is open, a hovered row elsewhere takes over only after the pointer stays this long, so a diagonal move into
// the submenu may cross other rows; reaching the submenu cancels it.
const SUBMENU_HOVER_DELAY_MS = 300;
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
// the row whose takeover is pending
let hoverTarget: string | undefined;

function cancelHoverIntent(): void {
  clearTimeout(hoverTimer);
  hoverTimer = undefined;
  hoverTarget = undefined;
}

const pointerMoved = createPointerMoveFilter();
function onItemMouseMove(event: MouseEvent, row: Focusable): void {
  if (!pointerMoved(event)) return;
  const element = event.currentTarget as HTMLElement;
  element.focus();
  const take = (): void => {
    if (row.kind === 'submenu') void showSubmenu(row, element, false);
    else openSubmenu.value = null;
  };
  const open = openSubmenu.value;
  if (open?.entry.id === row.id) cancelHoverIntent();
  else if (!open) take();
  else if (hoverTarget !== row.id) {
    cancelHoverIntent();
    hoverTarget = row.id;
    hoverTimer = setTimeout(() => {
      cancelHoverIntent();
      take();
    }, SUBMENU_HOVER_DELAY_MS);
  }
}

function onSubmenuItemMouseMove(event: MouseEvent): void {
  cancelHoverIntent();
  if (pointerMoved(event)) (event.currentTarget as HTMLElement).focus();
}

const roleOf = (item: MenuEntry): string => (item.checked === undefined ? 'menuitem' : item.radio ? 'menuitemradio' : 'menuitemcheckbox');

function choose(item: MenuEntry): void {
  if (item.disabled) return;
  emit('answer', { kind: 'menu', itemId: item.id });
}

// The submenu opens beside its row, on the right unless it would overflow, then on the left; it is measured before it shows.
async function showSubmenu(entry: SubmenuEntry, row: HTMLElement, focusFirst: boolean): Promise<void> {
  cancelHoverIntent();
  if (openSubmenu.value?.entry.id !== entry.id) {
    const rect = row.getBoundingClientRect();
    openSubmenu.value = { entry, left: rect.right, top: rect.top, placed: false };
    await nextTick();
    const panel = submenuElement.value;
    const menu = root.value?.getBoundingClientRect();
    if (!panel || !menu || openSubmenu.value?.entry.id !== entry.id) return;
    const overlap = remPx(SUBMENU_OVERLAP_REM);
    const width = panel.offsetWidth;
    const right = menu.right - overlap;
    const left = right + width <= window.innerWidth - remPx(0.5) ? right : Math.max(remPx(0.5), menu.left + overlap - width);
    const top = Math.max(remPx(0.5), Math.min(rect.top - remPx(0.3125), window.innerHeight - panel.offsetHeight - remPx(0.5)));
    openSubmenu.value = { entry, left, top, placed: true };
  }
  if (focusFirst) {
    await nextTick();
    focusItem(0, true);
  }
}

function closeSubmenu(): void {
  cancelHoverIntent();
  const entry = openSubmenu.value?.entry;
  openSubmenu.value = null;
  if (!entry) return;
  void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(entry.id)}"]`)?.focus());
}

let typed = '';
let typedAt = 0;
function typeAhead(char: string, list: readonly Focusable[], inSubmenu: boolean): void {
  const now = Date.now();
  typed = now - typedAt > TYPE_AHEAD_RESET_MS ? char : typed + char;
  typedAt = now;
  // Repeating one letter cycles through the items that start with it.
  const needle = ([...typed].every((c) => c === char) ? char : typed).toLocaleLowerCase();
  const start = focusedIndex(inSubmenu);
  for (let step = 1; step <= list.length; step++) {
    const index = (start + step) % list.length;
    if (list[index]?.label.toLocaleLowerCase().startsWith(needle)) {
      focusItem(index, inSubmenu);
      return;
    }
  }
}

function onItemKeydown(event: KeyboardEvent, item: Focusable): void {
  cancelHoverIntent();
  const index = focusedIndex(false);
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  if (!printable) typed = '';
  const opens = item.kind === 'submenu' && (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ');
  if (opens) void showSubmenu(item, event.currentTarget as HTMLElement, true);
  else if (event.key === 'ArrowDown') focusItem(index + 1);
  else if (event.key === 'ArrowUp') {
    if (index === 0 && filterInput.value) filterInput.value.focus();
    else focusItem(index - 1);
  } else if (event.key === 'Home') focusItem(0);
  else if (event.key === 'End') focusItem(-1);
  else if ((event.key === 'Enter' || event.key === ' ') && item.kind === 'item') choose(item);
  else if (event.key === 'Tab') emit('answer', { kind: 'dismissed' });
  else if (printable) typeAhead(event.key, items.value, false);
  else return;
  if (!opens && event.key !== 'ArrowRight') openSubmenu.value = null;
  event.preventDefault();
}

// Inside a submenu: ArrowLeft and Escape return to its row, and Escape stops here so the menu stays open.
function onSubmenuKeydown(event: KeyboardEvent, item: MenuEntry): void {
  const index = focusedIndex(true);
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  if (!printable) typed = '';
  if (event.key === 'ArrowDown') focusItem(index + 1, true);
  else if (event.key === 'ArrowUp') focusItem(index - 1, true);
  else if (event.key === 'Home') focusItem(0, true);
  else if (event.key === 'End') focusItem(-1, true);
  else if (event.key === 'Enter' || event.key === ' ') choose(item);
  else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
    event.stopPropagation();
    closeSubmenu();
  } else if (event.key === 'Tab') emit('answer', { kind: 'dismissed' });
  else if (printable) typeAhead(event.key, submenuItems.value, true);
  else return;
  event.preventDefault();
}

function onFilterKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') focusItem(0);
  else if (event.key === 'Enter') {
    const first = items.value.find((item): item is MenuEntry => item.kind === 'item' && !item.disabled);
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
onBeforeUnmount(cancelHoverIntent);

const rowClass = 'group/item flex cursor-pointer items-center gap-2.25 rounded-7 px-2.25 py-1.5 text-12.5 outline-none hover:bg-(--d-hover) focus:bg-(--d-hover)';
</script>

<!-- DropdownMenu needs its trigger in this document; its anchor is in the shell view, so this menu places itself at the rect it is sent. -->
<template>
  <div
    ref="root"
    data-testid="overlay-menu"
    class="fixed flex max-h-[min(32rem,calc(100vh-1rem))] w-max max-w-80 min-w-57.5 animate-[d-pop_.14s_ease-out] flex-col overflow-hidden rounded-11 border border-(--d-border2) bg-(--d-card) text-(--d-text) shadow-(--d-shadow)"
    :style="{ left: `${position.left}px`, top: `${position.top}px` }"
  >
    <label
      v-if="request.filterPlaceholder !== undefined"
      class="flex h-8 shrink-0 items-center gap-1.75 border-b border-(--d-border) px-2.5"
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
    <p
      v-if="request.caption"
      data-testid="overlay-menu-caption"
      class="shrink-0 truncate px-3.5 pt-2.25 pb-0.5 font-mono text-11 text-(--d-faint-text)"
      :title="request.caption"
    >
      {{ request.caption }}
    </p>
    <div
      role="menu"
      :aria-label="request.label"
      class="min-h-0 flex-1 overflow-y-auto p-1.25"
    >
      <template
        v-for="(row, index) in rows"
        :key="row.kind === 'separator' ? `separator:${index}` : `${row.kind}:${row.id}`"
      >
        <div
          v-if="row.kind === 'separator'"
          role="separator"
          class="mx-0.5 my-1 h-px bg-(--d-border)"
        />
        <div
          v-else-if="row.kind === 'submenu'"
          data-menu-item
          :data-item-id="row.id"
          role="menuitem"
          aria-haspopup="menu"
          :aria-expanded="openSubmenu?.entry.id === row.id"
          tabindex="-1"
          :class="[rowClass, openSubmenu?.entry.id === row.id ? 'bg-(--d-hover)' : '']"
          @click="showSubmenu(row, $event.currentTarget as HTMLElement, true)"
          @keydown="onItemKeydown($event, row)"
          @mousemove="onItemMouseMove($event, row)"
        >
          <component
            :is="OVERLAY_ICON_COMPONENTS[row.icon]"
            v-if="row.icon"
            aria-hidden="true"
            class="size-3.25 shrink-0"
          />
          <span
            v-else-if="iconColumn"
            aria-hidden="true"
            class="size-3.25 shrink-0"
          />
          <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
          <ChevronRight
            aria-hidden="true"
            class="size-3 shrink-0 text-(--d-faint)"
          />
        </div>
        <div
          v-else
          data-menu-item
          :data-item-id="row.id"
          :role="roleOf(row)"
          :aria-checked="row.checked"
          :aria-disabled="row.disabled || undefined"
          tabindex="-1"
          :class="[rowClass, row.danger ? 'text-(--d-danger) hover:text-(--d-danger-text) focus:text-(--d-danger-text)' : '', row.disabled ? 'cursor-default opacity-50' : '']"
          @click="choose(row)"
          @keydown="onItemKeydown($event, row)"
          @mousemove="onItemMouseMove($event, row)"
        >
          <component
            :is="glyphLook(row.glyph, row.color).icon"
            v-if="row.glyph"
            aria-hidden="true"
            class="size-3.25 shrink-0"
            :style="{ color: glyphLook(row.glyph, row.color).color }"
          />
          <component
            :is="OVERLAY_ICON_COMPONENTS[row.icon]"
            v-else-if="row.icon"
            aria-hidden="true"
            class="size-3.25 shrink-0"
          />
          <span
            v-else-if="iconColumn"
            aria-hidden="true"
            class="size-3.25 shrink-0"
          />
          <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
          <span
            v-if="row.shortcut"
            class="shrink-0 font-mono text-10.5 text-(--d-faint) group-hover/item:text-(--d-faint-text) group-focus/item:text-(--d-faint-text)"
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
  <!-- The open submenu: fixed beside its row, hidden until measured so it never shows at its first guess. -->
  <div
    v-if="openSubmenu"
    :key="openSubmenu.entry.id"
    ref="submenuElement"
    role="menu"
    data-testid="overlay-submenu"
    :aria-label="openSubmenu.entry.label"
    class="fixed flex max-h-[min(32rem,calc(100vh-1rem))] w-max max-w-80 min-w-50 animate-[d-pop_.14s_ease-out] flex-col overflow-y-auto rounded-11 border border-(--d-border2) bg-(--d-card) p-1.25 text-(--d-text) shadow-(--d-shadow)"
    :class="openSubmenu.placed ? '' : 'invisible'"
    :style="{ left: `${openSubmenu.left}px`, top: `${openSubmenu.top}px` }"
    @mouseenter="cancelHoverIntent"
  >
    <template
      v-for="(row, index) in openSubmenu.entry.items"
      :key="row.kind === 'item' ? `item:${row.id}` : `separator:${index}`"
    >
      <div
        v-if="row.kind !== 'item'"
        role="separator"
        class="mx-0.5 my-1 h-px bg-(--d-border)"
      />
      <div
        v-else
        data-submenu-item
        :data-item-id="row.id"
        :role="roleOf(row)"
        :aria-checked="row.checked"
        :aria-disabled="row.disabled || undefined"
        tabindex="-1"
        :class="[rowClass, row.danger ? 'text-(--d-danger) hover:text-(--d-danger-text) focus:text-(--d-danger-text)' : '', row.disabled ? 'cursor-default opacity-50' : '']"
        @click="choose(row)"
        @keydown="onSubmenuKeydown($event, row)"
        @mousemove="onSubmenuItemMouseMove"
      >
        <component
          :is="OVERLAY_ICON_COMPONENTS[row.icon]"
          v-if="row.icon"
          aria-hidden="true"
          class="size-3.25 shrink-0"
        />
        <span
          v-else-if="submenuIconColumn"
          aria-hidden="true"
          class="size-3.25 shrink-0"
        />
        <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
        <span
          v-if="row.shortcut"
          class="shrink-0 font-mono text-10.5 text-(--d-faint) group-hover/item:text-(--d-faint-text) group-focus/item:text-(--d-faint-text)"
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
</template>
