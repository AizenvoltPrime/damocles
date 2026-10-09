<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEventListener, useResizeObserver } from '@vueuse/core';
import { GitCompare, Globe, Image as ImageIcon, LoaderCircle, ScrollText, Search, Settings2, X } from 'lucide-vue-next';
import type { Component } from 'vue';
import type { DamoclesShellApi, FileRef, ShellEditorTab } from '../../preload/shell-channels';
import type { OverlayMenuItem } from '../../preload/overlay-channels';
import { useSlidingIndicator, type IndicatorBox } from '@/composables/useSlidingIndicator';
import { remPx } from '@/composables/useRemPx';
import SlidingIndicator from '@/components/SlidingIndicator.vue';
import { FILE_DRAG_MIME, serializeFileDragPayload } from '@shared/file-drag';
import { fileIcon } from '../file-icons';
import { tidyMenu } from '../../preload/overlay-channels';
import { EDITOR_STORE } from './editor-store';
import { isBlankPage, pageText, pageTitle } from './browser-page';

const props = defineProps<{ api: DamoclesShellApi; closeShortcut: string }>();
const emit = defineEmits<{ revealInFiles: [file: FileRef]; focusOverlay: [] }>();
const { t } = useI18n();
const store = inject(EDITOR_STORE)!;

// The strip scrolls; the tabs and the active tab's bar sit in its content row, so the bar scrolls and clips with the tabs.
const strip = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const activeIndex = computed(() => store.tabs.value.findIndex((tab) => tab.id === store.state.value?.activeTabId));
// The active tab by its own attribute, never by position: a closing tab stays in the row while it leaves.
const ACTIVE_TAB = '[data-editor-tab][aria-selected="true"]:not(.editor-tab-leave-active)';
const { box, animate, measure } = useSlidingIndicator(content, ACTIVE_TAB, 0);
// The reference's selected tab: a 2px accent bar along its top edge, as wide as the tab without its right-hand separator
// (its border), sliding between tabs by transform. Its ends are the tab's painted edges: Chromium paints a tab with a
// fractional width on device-pixel-snapped edges, so the bar snaps the same way, from the tab's rendered box rather than its
// rounded offset size. SlidingIndicator's middle reaches 1px past each end to hide its seams, so the bar is drawn 1px in.
const barBox = shallowRef<IndicatorBox | null>(null);
function measureBar(): void {
  const row = content.value;
  const tab = box.value && row?.querySelector<HTMLElement>(ACTIVE_TAB);
  if (!row || !tab) {
    barBox.value = null;
    return;
  }
  // In device px: the tab's snapped edges, its separator as painted (a border is floored to whole device px, at least one),
  // and the row's snapped origin, which the indicator's layer is drawn from.
  const scale = window.devicePixelRatio;
  const edges = tab.getBoundingClientRect();
  const separator = Math.max(1, Math.floor(Number.parseFloat(getComputedStyle(tab).borderRightWidth) * scale));
  const origin = Math.round(row.getBoundingClientRect().left * scale);
  const left = (Math.round(edges.left * scale) - origin) / scale;
  const right = (Math.round(edges.right * scale) - separator - origin) / scale;
  barBox.value = { x: left + 1, y: 0, width: Math.max(0, right - left - 2), height: remPx(0.125) };
}
watch(box, measureBar);
// A tab's rendered box settles only when an animation or transition around it ends (a new tab's pop-in, the pane's zoom into
// the focus overlay, a pane swap), and those end events never reach the row from its ancestors, so the window hears them.
useEventListener(window, 'animationend', measureBar, { capture: true });
useEventListener(window, 'transitionend', measureBar, { capture: true });
// Opening, closing, reordering and activating tabs move the active tab without resizing the row, so each re-measures.
watch(() => [store.state.value?.activeTabId, store.tabs.value.map((tab) => tab.id).join('\n')], () => void nextTick(measure));

const KIND_ICONS: Partial<Record<ShellEditorTab['kind'], { icon: Component; color: string }>> = {
  browser: { icon: Globe, color: 'var(--d-info)' },
  diff: { icon: GitCompare, color: 'var(--d-warning)' },
  image: { icon: ImageIcon, color: 'var(--d-info)' },
  settings: { icon: Settings2, color: 'var(--d-muted)' },
  log: { icon: ScrollText, color: 'var(--d-muted)' },
  searchEditor: { icon: Search, color: 'var(--d-accent)' },
};
const iconOf = (tab: ShellEditorTab): { icon: Component; color: string } => KIND_ICONS[tab.kind] ?? fileIcon(tab.title);
const titleOf = (tab: ShellEditorTab): string => (tab.browser ? pageTitle(tab, t('editor.browser.newPage')) : tab.title);
const tooltipOf = (tab: ShellEditorTab): string => (tab.browser ? pageText(tab.displayPath) : tab.displayPath);
// A deleted or conflicted file's tab says so under its path, as VS Code's "Deleted" decoration does.
const hoverOf = (tab: ShellEditorTab): string =>
  [tooltipOf(tab), ...(tab.deleted ? [t('editor.tab.deleted')] : []), ...(tab.conflict ? [t('editor.tab.conflict')] : [])].join('\n');
const badgeOf = (tab: ShellEditorTab): string | undefined => {
  if (tab.kind === 'markdownPreview') return t('editor.tab.preview');
  if (tab.kind === 'log') return t('editor.tab.readOnly');
  return undefined;
};
const isMarkdown = (tab: ShellEditorTab): boolean => tab.kind === 'markdownPreview' || (tab.kind === 'code' && /\.md$/i.test(tab.title));
const fileOf = (tab: ShellEditorTab): FileRef | undefined =>
  (tab.projectKey !== undefined && tab.relativePath !== undefined ? { projectKey: tab.projectKey, relativePath: tab.relativePath } : undefined);

// Overflow: the strip scrolls sideways and fades the edge that has more tabs beyond it.
const fadeStart = ref(false);
const fadeEnd = ref(false);
// VS Code's tab scrollbar (multiEditorTabsControl.ts, base/browser/ui/scrollbar): a 3px slider over the strip's bottom edge,
// taking no layout height, shown while the strip is hovered or scrolls and faded out 500 ms after (HIDE_TIMEOUT).
const SLIDER_HIDE_MS = 500;
const SLIDER_MIN_REM = 1.25;
const slider = ref<{ left: number; width: number } | null>(null);
const sliderShown = ref(false);
const hovered = ref(false);
const sliderDrag = ref<{ pointerId: number; startX: number; startScroll: number } | null>(null);
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function measureOverflow(): void {
  const element = strip.value;
  if (!element) return;
  fadeStart.value = element.scrollLeft > 1;
  fadeEnd.value = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
  const { scrollLeft, clientWidth, scrollWidth } = element;
  if (scrollWidth <= clientWidth + 1) {
    slider.value = null;
    return;
  }
  const width = Math.max(remPx(SLIDER_MIN_REM), (clientWidth * clientWidth) / scrollWidth);
  slider.value = { width, left: ((clientWidth - width) * scrollLeft) / (scrollWidth - clientWidth) };
}
useResizeObserver([strip, content], measureOverflow);

function revealSlider(): void {
  sliderShown.value = true;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!hovered.value && !sliderDrag.value) sliderShown.value = false;
  }, SLIDER_HIDE_MS);
}

function onScroll(): void {
  measureOverflow();
  revealSlider();
}

function onPointerEnter(): void {
  hovered.value = true;
  sliderShown.value = true;
  clearTimeout(hideTimer);
}

function onPointerLeave(): void {
  hovered.value = false;
  revealSlider();
}

// Dragging the slider moves the strip by the same share of its scroll width.
function onSliderDown(event: PointerEvent): void {
  const element = strip.value;
  if (event.button !== 0 || !element) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  sliderDrag.value = { pointerId: event.pointerId, startX: event.clientX, startScroll: element.scrollLeft };
}

function onSliderMove(event: PointerEvent): void {
  const element = strip.value;
  const drag = sliderDrag.value;
  if (!element || !slider.value || drag?.pointerId !== event.pointerId) return;
  const ratio = (element.scrollWidth - element.clientWidth) / Math.max(1, element.clientWidth - slider.value.width);
  element.scrollLeft = drag.startScroll + (event.clientX - drag.startX) * ratio;
}

function onSliderUp(event: PointerEvent): void {
  if (sliderDrag.value?.pointerId !== event.pointerId) return;
  sliderDrag.value = null;
  revealSlider();
}
onBeforeUnmount(() => clearTimeout(hideTimer));

function onWheel(event: WheelEvent): void {
  const element = strip.value;
  if (!element || element.scrollWidth <= element.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  element.scrollLeft += event.deltaY;
}

function tabElement(tabId: string | undefined): HTMLElement | null {
  return tabId === undefined ? null : content.value?.querySelector<HTMLElement>(`[data-editor-tab][data-tab-id="${CSS.escape(tabId)}"]`) ?? null;
}

watch(() => store.state.value?.activeTabId, (tabId) => void nextTick(() => {
  tabElement(tabId ?? undefined)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  measureOverflow();
}));
onMounted(measureOverflow);

async function select(tab: ShellEditorTab): Promise<void> {
  await store.activate(tab.id);
  store.requestFocus(tab.id);
}

function close(tab: ShellEditorTab): void {
  void props.api.editorTab({ action: 'close', tabId: tab.id });
}

// Middle-click closes (VS Code); the press is cancelled so Chromium does not start autoscroll.
function onMouseDown(event: MouseEvent): void {
  if (event.button === 1) event.preventDefault();
}

function onAuxClick(event: MouseEvent, tab: ShellEditorTab): void {
  if (event.button !== 1) return;
  event.preventDefault();
  close(tab);
}

// Arrow keys move focus along the strip, as in the WAI-ARIA tabs pattern with manual activation; Enter or Space activates.
function onKeydown(event: KeyboardEvent, index: number, tab: ShellEditorTab): void {
  const count = store.tabs.value.length;
  const target = ({ ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: count - 1 } as Record<string, number>)[event.key];
  if (target !== undefined) {
    event.preventDefault();
    tabElement(store.tabs.value[(target + count) % count]?.id)?.focus();
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    void select(tab);
  } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    event.preventDefault();
    void openMenu(tab, (event.currentTarget as HTMLElement).getBoundingClientRect());
  }
}

async function openMenu(tab: ShellEditorTab, anchor: { left: number; top: number; width: number; height: number }): Promise<void> {
  const item = (id: string, label: string, icon: Extract<OverlayMenuItem, { kind: 'item' }>['icon'], extra: Partial<Extract<OverlayMenuItem, { kind: 'item' }>> = {}): OverlayMenuItem =>
    ({ kind: 'item', id, label, ...(icon ? { icon } : {}), ...extra });
  const separator: OverlayMenuItem = { kind: 'separator' };
  const index = store.tabs.value.indexOf(tab);
  const file = fileOf(tab);
  const closing: OverlayMenuItem[] = [
    item('close', t('editor.menu.close'), 'x', { shortcut: props.closeShortcut }),
    item('closeOthers', t('editor.menu.closeOthers'), 'copy-x', { disabled: store.tabs.value.length < 2 }),
    item('closeRight', t('editor.menu.closeRight'), 'arrow-right-to-line', { disabled: index === store.tabs.value.length - 1 }),
    item('closeAll', t('editor.menu.closeAll'), 'circle-x'),
    separator,
  ];
  const items: OverlayMenuItem[] = tab.browser ? [
    ...closing,
    item('reloadPage', t('editor.browser.menu.reload'), 'rotate-cw'),
    item('devTools', t('editor.browser.menu.devTools'), 'square-code'),
    item('copyUrl', t('editor.browser.menu.copyUrl'), 'copy', { disabled: isBlankPage(tab.browser.url) }),
  ] : [
    ...closing,
    ...(isMarkdown(tab)
      ? [
          item('openPreview', t('editor.menu.showPreview'), 'eye', { checked: tab.kind === 'markdownPreview' }),
          item('openSource', t('editor.menu.showSource'), 'code', { checked: tab.kind !== 'markdownPreview' }),
          separator,
        ]
      : []),
    ...(tab.kind === 'diff' && file ? [item('openFile', t('editor.menu.openFile'), 'file')] : []),
    item('focusOverlay', t('editor.menu.focusOverlay'), 'maximize-2'),
    ...(file ? [item('mention', t('editor.menu.mention'), 'at-sign')] : []),
    separator,
    ...(tab.kind === 'untitled' ? [] : [item('copyPath', t('editor.menu.copyPath'), 'copy')]),
    ...(file ? [item('revealInFiles', t('editor.menu.revealInFiles'), 'list-tree')] : []),
    ...(tab.kind === 'untitled' ? [] : [item('revealInExplorer', t('editor.menu.revealInExplorer'), 'folder-search')]),
  ];
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: t('editor.menu.label', { title: titleOf(tab) }),
    caption: tooltipOf(tab),
    anchor: { x: Math.max(0, anchor.left), y: Math.max(0, anchor.top), width: anchor.width, height: anchor.height },
    items: tidyMenu(items),
  });
  if (answer.kind !== 'menu') return;
  const id = answer.itemId;
  if (id === 'focusOverlay') {
    await store.activate(tab.id);
    emit('focusOverlay');
  } else if (id === 'mention') await props.api.mentionTab(tab.id);
  else if (id === 'revealInFiles' && file) emit('revealInFiles', file);
  // Main tells the user of a failure they should see; a refusal for a page that closed meanwhile leaves nothing to do.
  else if (id === 'reloadPage' || id === 'devTools' || id === 'copyUrl') await props.api.browserAction({ tabId: tab.id, action: id === 'reloadPage' ? 'reload' : id }).catch(() => undefined);
  else if (id === 'close' || id === 'closeOthers' || id === 'closeRight' || id === 'closeAll' || id === 'openPreview' || id === 'openSource' || id === 'openFile' || id === 'copyPath' || id === 'revealInExplorer') {
    await props.api.editorTab({ action: id, tabId: tab.id });
  }
}

// A project file's tab drags like its Files row: the composer turns the drop into a mention. Other tabs have no file to name.
function onDragStart(event: DragEvent, tab: ShellEditorTab): void {
  const file = fileOf(tab);
  if (!file || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData(FILE_DRAG_MIME, serializeFileDragPayload(file));
  event.dataTransfer.effectAllowed = 'copy';
}

function onContextMenu(event: MouseEvent, tab: ShellEditorTab): void {
  event.preventDefault();
  void openMenu(tab, { left: event.clientX, top: event.clientY, width: 0, height: 0 });
}
</script>

<template>
  <div
    class="relative flex min-w-0 flex-1"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
  >
    <div
      ref="strip"
      role="tablist"
      :aria-label="t('editor.tabsLabel')"
      data-testid="editor-tabs"
      class="editor-tab-strip flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
      :class="{ 'editor-tab-strip-fade-start': fadeStart, 'editor-tab-strip-fade-end': fadeEnd }"
      @wheel="onWheel"
      @scroll="onScroll"
    >
      <div
        ref="content"
        data-testid="editor-tab-row"
        class="relative flex min-w-full shrink-0 items-stretch"
      >
        <TransitionGroup name="editor-tab">
          <div
            v-for="(tab, index) in store.tabs.value"
            :id="`editor-tab-${tab.id}`"
            :key="tab.id"
            data-editor-tab
            role="tab"
            data-testid="editor-tab"
            :data-tab-id="tab.id"
            :data-kind="tab.kind"
            :data-dirty="tab.dirty || undefined"
            :data-deleted="tab.deleted || undefined"
            :aria-selected="tab.id === store.state.value?.activeTabId"
            aria-controls="editor-panel"
            :tabindex="tab.id === store.state.value?.activeTabId || (activeIndex < 0 && index === 0) ? 0 : -1"
            :title="hoverOf(tab)"
            :draggable="fileOf(tab) !== undefined"
            class="editor-tab group/tab relative flex max-w-50 shrink-0 cursor-pointer items-center gap-1.75 border-r border-(--d-border) pr-2 pl-3 outline-none select-none"
            :class="tab.id === store.state.value?.activeTabId ? 'bg-(--d-bg) text-(--d-text)' : 'text-(--d-muted) hover:text-(--d-text)'"
            @click="select(tab)"
            @mousedown="onMouseDown"
            @auxclick="onAuxClick($event, tab)"
            @keydown="onKeydown($event, index, tab)"
            @contextmenu="onContextMenu($event, tab)"
            @dragstart="onDragStart($event, tab)"
          >
            <LoaderCircle
              v-if="tab.browser?.loading"
              aria-hidden="true"
              data-testid="editor-tab-loading"
              class="d-spinning size-3.25 shrink-0 text-(--d-info)"
            />
            <img
              v-else-if="tab.browser?.iconDataUrl"
              :src="tab.browser.iconDataUrl"
              alt=""
              data-testid="editor-tab-favicon"
              class="size-3.25 shrink-0 rounded-xs object-contain"
            >
            <component
              :is="iconOf(tab).icon"
              v-else
              aria-hidden="true"
              class="size-3.25 shrink-0"
              :style="{ color: iconOf(tab).color }"
            />
            <span
              data-testid="editor-tab-title"
              class="truncate text-12.5"
              :class="tab.deleted ? 'text-(--d-danger-text) line-through' : tab.conflict ? 'text-(--d-warning-text)' : ''"
            >{{ titleOf(tab) }}</span>
            <span
              v-if="tab.deleted"
              class="sr-only"
            >{{ t('editor.tab.deleted') }}</span>
            <span
              v-if="tab.conflict"
              class="sr-only"
            >{{ t('editor.tab.conflict') }}</span>
            <span
              v-if="tab.browser?.loading"
              class="sr-only"
            >{{ t('editor.browser.loading') }}</span>
            <span
              v-if="tab.diff"
              class="shrink-0 font-mono text-10 text-(--d-faint-text)"
            >{{ t('editor.tab.diff') }}</span>
            <span
              v-else-if="badgeOf(tab)"
              class="shrink-0 text-10 text-(--d-faint-text)"
            >{{ badgeOf(tab) }}</span>
            <span
              v-if="tab.dirty"
              class="sr-only"
            >{{ t('editor.tab.unsaved') }}</span>
            <!-- The close control: a dirty tab shows a dot that turns into the X while the tab is hovered or focused. -->
            <button
              type="button"
              tabindex="-1"
              aria-hidden="true"
              data-testid="editor-tab-close"
              class="editor-tab-close relative flex size-4.5 shrink-0 items-center justify-center rounded-5 hover:bg-(--d-hover)"
              :class="tab.dirty ? 'editor-tab-close-dirty' : ''"
              :title="t('editor.tab.closeTitle', { shortcut: closeShortcut })"
              @click.stop="close(tab)"
            >
              <span
                aria-hidden="true"
                class="editor-tab-dot absolute size-2 rounded-full bg-(--d-text)"
              />
              <X
                aria-hidden="true"
                class="editor-tab-x size-3"
              />
            </button>
          </div>
        </TransitionGroup>
        <SlidingIndicator
          class="text-(--d-accent)"
          data-testid="editor-tab-indicator"
          :box="barBox"
          :radius="0"
          :animate="animate"
        />
      </div>
    </div>
    <!-- VS Code's slider: no shadcn part draws an overlay scrollbar. Hidden from AT; the tabs are reached by arrow keys. -->
    <div
      v-if="slider"
      aria-hidden="true"
      data-testid="editor-tab-scrollbar"
      class="editor-tab-scrollbar pointer-events-none absolute inset-x-0 bottom-0 h-0.75"
      :class="sliderShown || sliderDrag ? 'editor-tab-scrollbar-shown' : ''"
    >
      <div
        class="editor-tab-slider pointer-events-auto absolute top-0 left-0 h-full"
        :data-active="sliderDrag !== null || undefined"
        :style="{ width: `${slider.width}px`, transform: `translateX(${slider.left}px)` }"
        @pointerdown="onSliderDown"
        @pointermove="onSliderMove"
        @pointerup="onSliderUp"
        @pointercancel="onSliderUp"
      />
    </div>
  </div>
</template>
