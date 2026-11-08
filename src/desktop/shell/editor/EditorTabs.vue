<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEventListener, useResizeObserver } from '@vueuse/core';
import { AppWindow, CloudOff, CloudUpload, FileDiff, GitCompare, GitMerge, Globe, History, LoaderCircle, MessageSquareDiff, Monitor, ScrollText, Search, Settings2, X } from 'lucide-vue-next';
import type { Component } from 'vue';
import type { DamoclesShellApi, FileRef, ShellEditorTab, ShellHost, ShellProject } from '../../preload/shell-channels';
import type { OverlayMenuItem } from '../../preload/overlay-channels';
import { useSlidingIndicator, type IndicatorBox } from '@/composables/useSlidingIndicator';
import { remPx } from '@/composables/useRemPx';
import { useOverflowStrip } from '@/composables/useOverflowStrip';
import SlidingIndicator from '@/components/SlidingIndicator.vue';
import OverflowSlider from '@/components/OverflowSlider.vue';
import { FILE_DRAG_MIME, serializeFileDragPayload } from '@shared/file-drag';
import { visibleText } from '@shared/visible-text';
import FileIcon from '../components/FileIcon.vue';
import { tidyMenu } from '../../preload/overlay-channels';
import { isServablePreviewPath } from '../../main/html-preview/serve-policy';
import { EDITOR_STORE } from './editor-store';
import { placeChipFolds, placeOf, tabPlaces } from './editor-place';
import TabPlaceChip from './TabPlaceChip.vue';
import { SCM_STORE } from '../scm/scm-store';
import { TONE_TEXT } from '../scm/scm-list';
import StatusLetter from '../scm/StatusLetter.vue';
import { isBlankPage, pageText, pageTitle } from './browser-page';
import { tabDescriptions, tabHostName } from './tab-labels';
import type { TerminalInfo } from '../../preload/terminal-channels';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import { TERMINAL_STORE } from '../terminal/terminal-store';
import { draggedTerminal, endTerminalDrag, startTerminalDrag, terminalDragOf, terminalDropOf } from '../terminal/terminal-drag';
import { terminalGlyph } from '../terminal/terminal-icons';
import { runTerminalTabAction, terminalProjectLabel, terminalStatusLabel, terminalTabMenuItems } from '../terminal/terminal-menu';
import TerminalRename from '../terminal/TerminalRename.vue';

const props = defineProps<{ api: DamoclesShellApi; closeShortcut: string; projects: readonly ShellProject[]; hosts: readonly ShellHost[] }>();
const emit = defineEmits<{ revealInFiles: [file: FileRef]; focusOverlay: [] }>();
const { t } = useI18n();
const store = inject(EDITOR_STORE)!;
const places = computed(() => tabPlaces(store.tabs.value));

const scm = inject(SCM_STORE)!;
const terminals = inject(TERMINAL_STORE)!;
// A terminal tab shows its terminal as the terminal pane does: glyph, colour, title and status, live from main's state.
const terminalOf = (tab: ShellEditorTab): TerminalInfo | undefined => (tab.terminal ? terminals.state.value?.terminals.find((terminal) => terminal.id === tab.terminal!.id) : undefined);
const terminalBusy = (terminal: TerminalInfo | undefined): boolean => terminal?.status === 'starting' || terminal?.status === 'reconnecting';
const renamingTerminal = (tab: ShellEditorTab): TerminalInfo | undefined => {
  const terminal = terminalOf(tab);
  return terminal && terminals.renaming.value?.id === terminal.id ? terminal : undefined;
};

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
  designPreview: { icon: Monitor, color: 'var(--d-design)' },
  htmlPreview: { icon: AppWindow, color: 'var(--d-accent)' },
  diff: { icon: GitCompare, color: 'var(--d-warning)' },
  changes: { icon: FileDiff, color: 'var(--d-warning)' },
  settings: { icon: Settings2, color: 'var(--d-muted)' },
  log: { icon: ScrollText, color: 'var(--d-muted)' },
  searchEditor: { icon: Search, color: 'var(--d-accent)' },
  review: { icon: MessageSquareDiff, color: 'var(--d-accent)' },
  timeline: { icon: History, color: 'var(--d-info)' },
  merge: { icon: GitMerge, color: 'var(--d-warning)' },
};
const titleOf = (tab: ShellEditorTab): string => (tab.browser ? pageTitle(tab, t('editor.browser.newPage')) : terminalOf(tab)?.title ?? tab.title);
const hostOf = (tab: ShellEditorTab): string | undefined => tabHostName(tab, props.projects, props.hosts);
// A same-named tab's description, as VS Code tells such tabs apart.
const descriptions = computed(() => tabDescriptions(store.tabs.value, hostOf, t('projects.group.local')));

// A tab is capped at 12.5rem; one with a place chip gets 9rem more, so the chip's label shows whole beside a fair title.
const TAB_WIDTH = 'max-w-50';
const PLACE_TAB_WIDTH = 'max-w-86';
// rem a title keeps before its tab's place chip folds to its icon
const MIN_TITLE_REM = 2;

// The tabs whose place chip shows only its icon. On any change to what the chips or titles say, or to the strip's size,
// every chip shows its label again and the ones that do not fit fold, all before the next paint.
const foldedChips = shallowRef<ReadonlySet<string>>(new Set());
const stripResizes = ref(0);
const chipInputs = computed(() => store.tabs.value.map((tab) => {
  const place = placeOf(tab, places.value);
  return place ? `${tab.id}\u0000${titleOf(tab)}\u0000${descriptions.value.get(tab.id) ?? ''}\u0000${place.kind === 'worktree' ? place.label ?? '' : ''}` : '';
}).join('\n'));
watch([chipInputs, stripResizes], async () => {
  foldedChips.value = new Set();
  await nextTick();
  const folded = new Set<string>();
  for (const element of strip.value?.querySelectorAll<HTMLElement>('[data-editor-tab]') ?? []) {
    const chip = element.querySelector<HTMLElement>('[data-place-chip]');
    const title = element.querySelector<HTMLElement>('[data-testid="editor-tab-title"]');
    const id = element.dataset['tabId'];
    if (chip && title && id && placeChipFolds(title, remPx(MIN_TITLE_REM))) folded.add(id);
  }
  foldedChips.value = folded;
}, { flush: 'post' });
const tooltipOf = (tab: ShellEditorTab): string => {
  if (tab.browser) return pageText(tab.displayPath);
  const terminal = terminalOf(tab);
  if (terminal) return [terminal.title, terminal.description, terminalProjectLabel(terminal, t)].filter((part) => part).join(' · ');
  const host = hostOf(tab);
  return host === undefined ? visibleText(tab.displayPath) : t('editor.tab.hostPath', { host, path: visibleText(tab.displayPath) });
};
// A deleted or conflicted file's tab says so under its path, as VS Code's "Deleted" decoration does.
const hoverOf = (tab: ShellEditorTab): string => {
  const terminal = terminalOf(tab);
  return [tooltipOf(tab), ...(terminal ? [terminalStatusLabel(terminal, t)] : []), ...(tab.deleted ? [t('editor.tab.deleted')] : []), ...(tab.conflict ? [t('editor.tab.conflict')] : [])].join('\n');
};
const badgeOf = (tab: ShellEditorTab): string | undefined => {
  if (tab.kind === 'markdownPreview') return t('editor.tab.preview');
  if (tab.kind === 'log') return t('editor.tab.readOnly');
  return undefined;
};
// B3: a project file's tab takes its source control letter and tint; the tab's own deleted and conflict states win over them.
const decorationOf = (tab: ShellEditorTab) => {
  if (tab.deleted || tab.conflict || NO_PATH_KINDS.has(tab.kind) || tab.kind === 'diff' || tab.relativePath === undefined) return undefined;
  const decoration = scm.decorationOf(tab.projectKey, tab.relativePath);
  return decoration?.letter === undefined ? undefined : { letter: decoration.letter, tone: decoration.tone, color: TONE_TEXT[decoration.tone], strike: decoration.strike, title: decoration.status ? t(`scm.status.${decoration.status}`) : undefined };
};
// An offline save names the host as ShellState names it now, so a rename shows at once.
const pendingText = (tab: ShellEditorTab): string => t('editor.tab.pendingUpload', { host: hostOf(tab) ?? '' });
// ms the cloud-up glyph shows after a pending save uploaded
const UPLOADED_MS = 2400;
const uploaded = ref<ReadonlySet<string>>(new Set());
const wasPending = new Set<string>();
const uploadedTimers = new Set<ReturnType<typeof setTimeout>>();
watch(() => store.tabs.value.map((tab) => [tab.id, tab.pendingUpload === true, tab.dirty || tab.conflict] as const), (tabs) => {
  // a tab closed while its save was pending never shows the glyph
  const open = new Set(tabs.map(([id]) => id));
  for (const id of wasPending) if (!open.has(id)) wasPending.delete(id);
  for (const [id, pending, unsettled] of tabs) {
    if (pending) {
      wasPending.add(id);
      continue;
    }
    if (!wasPending.delete(id) || unsettled) continue;
    uploaded.value = new Set([...uploaded.value, id]);
    const timer = setTimeout(() => {
      uploadedTimers.delete(timer);
      uploaded.value = new Set([...uploaded.value].filter((other) => other !== id));
    }, UPLOADED_MS);
    uploadedTimers.add(timer);
  }
}, { immediate: true });
onBeforeUnmount(() => {
  for (const timer of uploadedTimers) clearTimeout(timer);
});
const isMarkdown = (tab: ShellEditorTab): boolean => tab.kind === 'markdownPreview' || (tab.kind === 'code' && /\.md$/i.test(tab.title));
// Only a project's file previews, and only one its serve policy would serve: the preview serves the project's folder.
const previewsAsHtml = (tab: ShellEditorTab): boolean =>
  tab.kind === 'code' && tab.projectKey !== undefined && tab.relativePath !== undefined && /\.html?$/i.test(tab.relativePath) && isServablePreviewPath(tab.relativePath);
const fileOf = (tab: ShellEditorTab): FileRef | undefined =>
  (tab.projectKey !== undefined && tab.relativePath !== undefined ? { projectKey: tab.projectKey, relativePath: tab.relativePath } : undefined);

// Overflow: the strip scrolls sideways under VS Code's overlay slider and fades the edge that has more tabs beyond it.
const overflow = useOverflowStrip(strip, content);
const { fadeClass, onScroll, onWheel, onPointerEnter, onPointerLeave } = overflow;
// only a change of width can fold or unfold a chip, and each re-measure unfolds every chip for a frame
let stripWidth: number | undefined;
useResizeObserver(strip, (entries) => {
  const width = entries[0]?.contentRect.width;
  if (width === stripWidth) return;
  stripWidth = width;
  stripResizes.value++;
});

function tabElement(tabId: string | undefined): HTMLElement | null {
  return tabId === undefined ? null : content.value?.querySelector<HTMLElement>(`[data-editor-tab][data-tab-id="${CSS.escape(tabId)}"]`) ?? null;
}

watch(() => store.state.value?.activeTabId, (tabId) => void nextTick(() => {
  tabElement(tabId ?? undefined)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  overflow.measure();
}));

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
  } else if (tab.terminal && event.key === 'F2' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    terminals.startRename(tab.terminal.id, 'tab');
  } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    event.preventDefault();
    void openMenu(tab, (event.currentTarget as HTMLElement).getBoundingClientRect());
  }
}

// Tabs that are no file: no path to copy.
const NO_PATH_KINDS: ReadonlySet<ShellEditorTab['kind']> = new Set(['untitled', 'changes', 'review', 'timeline', 'merge']);

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
  const items: OverlayMenuItem[] = tab.terminal ? [
    ...closing,
    ...terminalTabMenuItems(t),
  ] : tab.browser ? [
    ...closing,
    item('reloadPage', t('editor.browser.menu.reload'), 'rotate-cw'),
    item('devTools', t('editor.browser.menu.devTools'), 'square-code'),
    item('copyUrl', t('editor.browser.menu.copyUrl'), 'copy', { disabled: isBlankPage(tab.browser.url) }),
  ] : tab.designPreview ? [
    ...closing,
    item('openInBrowser', t('editor.designPreview.menu.openInBrowser'), 'arrow-up-right'),
    item('focusOverlay', t('editor.menu.focusOverlay'), 'maximize-2'),
    item('mention', t('editor.menu.mention'), 'at-sign', { disabled: !tab.designPreview.info }),
    separator,
    item('copyPath', t('editor.menu.copyPath'), 'copy', { disabled: !tab.designPreview.info }),
  ] : tab.htmlPreview ? [
    ...closing,
    item('reloadPreview', t('editor.htmlPreview.reload'), 'rotate-cw'),
    item('openInBrowser', t('editor.htmlPreview.openInBrowser'), 'arrow-up-right'),
    separator,
    item('openSource', t('editor.menu.openSource'), 'code'),
    item('focusOverlay', t('editor.menu.focusOverlay'), 'maximize-2'),
    ...(file ? [item('mention', t('editor.menu.mention'), 'at-sign')] : []),
    separator,
    item('copyPath', t('editor.menu.copyPath'), 'copy'),
    ...(file ? [item('revealInFiles', t('editor.menu.revealInFiles'), 'list-tree')] : []),
    ...(tab.revealable ? [item('revealInExplorer', t('editor.menu.revealInExplorer'), 'folder-search')] : []),
  ] : [
    ...closing,
    ...(previewsAsHtml(tab) ? [item('openPreview', t('editor.menu.openPreview'), 'eye'), separator] : []),
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
    ...(tab.git ? [item('openTimeline', t('editor.menu.openTimeline'), 'history')] : []),
    separator,
    ...(NO_PATH_KINDS.has(tab.kind) ? [] : [item('copyPath', t('editor.menu.copyPath'), 'copy')]),
    ...(file ? [item('revealInFiles', t('editor.menu.revealInFiles'), 'list-tree')] : []),
    ...(tab.revealable ? [item('revealInExplorer', t('editor.menu.revealInExplorer'), 'folder-search')] : []),
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
  if (tab.terminal && runTerminalTabAction(id, tab.terminal.id, { api: props.api.terminal, store: terminals })) return;
  if (id === 'focusOverlay') {
    await store.activate(tab.id);
    emit('focusOverlay');
  } else if (id === 'mention') await props.api.mentionTab(tab.id);
  else if (id === 'openTimeline' && tab.git) await props.api.scm.run({ op: 'openTimeline', repoId: tab.git.repoId, path: tab.git.path });
  else if (id === 'revealInFiles' && file) emit('revealInFiles', file);
  // Main toasts a failure the user should see.
  else if (tab.htmlPreview && (id === 'reloadPreview' || id === 'openInBrowser')) {
    const action = id === 'reloadPreview' ? 'reload' : 'openInBrowser';
    await props.api.htmlPreviewAction({ tabId: tab.id, action }).catch((error: unknown) => console.error(`[html preview] main refused ${action}`, error));
  }
  // Main toasts an Open in browser failure itself, and refuses a preview that left the selected chat meanwhile.
  else if (id === 'openInBrowser') await props.api.designPreviewAction({ tabId: tab.id, action: 'openInBrowser' }).catch((error: unknown) => console.error('[design preview] main refused Open in browser', error));
  // Main tells the user of a failure they should see; a refusal for a page that closed meanwhile leaves nothing to do.
  else if (id === 'reloadPage' || id === 'devTools' || id === 'copyUrl') await props.api.browserAction({ tabId: tab.id, action: id === 'reloadPage' ? 'reload' : id }).catch(() => undefined);
  else if (id === 'close' || id === 'closeOthers' || id === 'closeRight' || id === 'closeAll' || id === 'openPreview' || id === 'openSource' || id === 'openFile' || id === 'copyPath' || id === 'revealInExplorer') {
    await props.api.editorTab({ action: id, tabId: tab.id });
  }
}

// A project file's tab drags like its Files row: the composer turns the drop into a mention. A terminal tab drags like its
// list row, onto the terminal list or a pane half. Other tabs have no file to name.
function onDragStart(event: DragEvent, tab: ShellEditorTab): void {
  if (tab.terminal) {
    startTerminalDrag(event, tab.terminal.id);
    return;
  }
  const file = fileOf(tab);
  if (!file || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData(FILE_DRAG_MIME, serializeFileDragPayload(file));
  event.dataTransfer.effectAllowed = 'copy';
}

// A panel terminal dragged over the strip moves into the editor area as its last tab, where a ghost tab shows it landing.
// A task terminal stays in the panel, and an editor terminal is in the strip already.
const stripDrop = shallowRef<TerminalInfo | null>(null);
const dropGhost = ref<HTMLElement | null>(null);
watch(draggedTerminal, (id) => {
  if (id === null) stripDrop.value = null;
});

function movableTerminal(id: string | null): TerminalInfo | null {
  const terminal = id === null ? undefined : terminals.state.value?.terminals.find((candidate) => candidate.id === id);
  return terminal?.placement === 'panel' && terminal.task !== true ? terminal : null;
}

function onStripDragOver(event: DragEvent): void {
  const terminal = movableTerminal(terminalDragOf(event));
  if (!terminal) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = 'move';
  if (stripDrop.value?.id === terminal.id) return;
  stripDrop.value = terminal;
  void nextTick(() => dropGhost.value?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }));
}

function onStripDragLeave(event: DragEvent): void {
  if (!strip.value?.contains(event.relatedTarget as Node | null)) stripDrop.value = null;
}

function onStripDrop(event: DragEvent): void {
  stripDrop.value = null;
  const terminal = movableTerminal(terminalDropOf(event));
  if (!terminal) return;
  event.preventDefault();
  endTerminalDrag();
  terminals.move({ kind: 'toEditor', id: terminal.id });
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
      class="d-overflow-strip flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
      :class="fadeClass"
      @wheel="onWheel"
      @scroll="onScroll"
      @dragenter="onStripDragOver"
      @dragover="onStripDragOver"
      @dragleave="onStripDragLeave"
      @drop="onStripDrop"
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
            :aria-keyshortcuts="tab.terminal ? 'F2 Shift+F10' : undefined"
            :draggable="tab.terminal ? !renamingTerminal(tab) : fileOf(tab) !== undefined"
            :data-terminal-id="tab.terminal?.id"
            :data-status="terminalOf(tab)?.status"
            :data-dragging="tab.terminal && draggedTerminal === tab.terminal.id ? 'true' : undefined"
            class="editor-tab group/tab relative flex shrink-0 cursor-pointer items-center gap-1.75 border-r border-(--d-border) pr-2 pl-3 outline-none select-none"
            :class="[tab.id === store.state.value?.activeTabId ? 'bg-(--d-bg) text-(--d-text)' : 'text-(--d-muted) hover:text-(--d-text)', placeOf(tab, places) ? PLACE_TAB_WIDTH : TAB_WIDTH]"
            @click="select(tab)"
            @mousedown="onMouseDown"
            @auxclick="onAuxClick($event, tab)"
            @keydown="onKeydown($event, index, tab)"
            @contextmenu="onContextMenu($event, tab)"
            @dragstart="onDragStart($event, tab)"
            @dragend="tab.terminal && endTerminalDrag()"
          >
            <LoaderCircle
              v-if="tab.browser?.loading || terminalBusy(terminalOf(tab))"
              aria-hidden="true"
              data-testid="editor-tab-loading"
              class="d-spinning size-3.25 shrink-0"
              :class="tab.browser ? 'text-(--d-info)' : 'text-(--d-muted)'"
            />
            <component
              :is="terminalGlyph(terminalOf(tab)!).icon"
              v-else-if="terminalOf(tab)"
              aria-hidden="true"
              data-testid="editor-tab-terminal-icon"
              :data-glyph="terminalOf(tab)!.customIcon ?? terminalOf(tab)!.icon"
              :data-color="terminalOf(tab)!.color ?? undefined"
              class="terminal-glyph size-3.25 shrink-0"
              :style="{ color: terminalGlyph(terminalOf(tab)!).color }"
            />
            <img
              v-else-if="tab.browser?.iconDataUrl"
              :src="tab.browser.iconDataUrl"
              alt=""
              data-testid="editor-tab-favicon"
              class="size-3.25 shrink-0 rounded-xs object-contain"
            >
            <component
              :is="KIND_ICONS[tab.kind]!.icon"
              v-else-if="KIND_ICONS[tab.kind]"
              aria-hidden="true"
              class="size-3.25 shrink-0"
              :style="{ color: KIND_ICONS[tab.kind]!.color }"
            />
            <FileIcon
              v-else
              :path="tab.displayPath || tab.title"
              class="size-3.25 shrink-0"
            />
            <TerminalRename
              v-if="renamingTerminal(tab)"
              :api="api"
              :terminal="renamingTerminal(tab)!"
              class="-mx-1.25 w-auto max-w-full flex-none text-12.5 field-sizing-content"
              @done="tabElement(tab.id)?.focus()"
            />
            <span
              v-else
              data-testid="editor-tab-title"
              class="truncate text-12.5"
              :class="tab.deleted ? 'text-(--d-danger-text) line-through' : tab.conflict ? 'text-(--d-warning-text)' : decorationOf(tab)?.strike ? 'line-through' : ''"
              :style="decorationOf(tab) ? { color: decorationOf(tab)!.color } : undefined"
            >{{ titleOf(tab) }}</span>
            <span
              v-if="descriptions.get(tab.id)"
              data-testid="editor-tab-description"
              class="min-w-0 shrink-4 truncate text-11 text-(--d-faint-text)"
            >{{ descriptions.get(tab.id) }}</span>
            <!-- D31: a worktree file's tab names the branch; the project folder's copy says so while its project has worktree tabs open. -->
            <Transition
              name="t-chip"
              appear
            >
              <TabPlaceChip
                v-if="placeOf(tab, places)"
                :place="placeOf(tab, places)!"
                :folded="foldedChips.has(tab.id)"
              />
            </Transition>
            <StatusLetter
              v-if="decorationOf(tab)"
              data-testid="editor-tab-decoration"
              aria-hidden="true"
              :letter="decorationOf(tab)!.letter"
              :tone="decorationOf(tab)!.tone"
              :title="decorationOf(tab)!.title"
            />
            <span
              v-if="decorationOf(tab)?.title"
              class="sr-only"
            >{{ decorationOf(tab)!.title }}</span>
            <span
              v-if="tab.deleted"
              class="sr-only"
            >{{ t('editor.tab.deleted') }}</span>
            <Transition name="t-icon">
              <span
                v-if="tab.pendingUpload"
                data-testid="editor-tab-pending-upload"
                class="flex shrink-0 text-(--d-warning-text)"
                :title="pendingText(tab)"
              ><CloudOff
                aria-hidden="true"
                class="size-3"
              /><span class="sr-only">{{ pendingText(tab) }}</span></span>
              <span
                v-else-if="uploaded.has(tab.id)"
                data-testid="editor-tab-uploaded"
                class="flex shrink-0 text-(--d-success-text)"
                :title="t('editor.tab.uploaded', { host: hostOf(tab) ?? '' })"
              ><CloudUpload
                aria-hidden="true"
                class="size-3"
              /><span class="sr-only">{{ t('editor.tab.uploaded', { host: hostOf(tab) ?? '' }) }}</span></span>
            </Transition>
            <span
              v-if="tab.conflict"
              class="sr-only"
            >{{ t('editor.tab.conflict') }}</span>
            <span
              v-if="tab.browser?.loading"
              class="sr-only"
            >{{ t('editor.browser.loading') }}</span>
            <span
              v-if="terminalOf(tab)"
              class="sr-only"
            >{{ terminalStatusLabel(terminalOf(tab)!, t) }}</span>
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
        <Transition name="editor-tab-drop">
          <div
            v-if="stripDrop"
            ref="dropGhost"
            aria-hidden="true"
            data-testid="editor-tab-drop"
            :data-terminal-id="stripDrop.id"
            class="editor-tab-drop pointer-events-none flex max-w-50 shrink-0 items-center gap-1.75 px-3"
          >
            <component
              :is="terminalGlyph(stripDrop).icon"
              class="terminal-glyph size-3.25 shrink-0"
              :style="{ color: terminalGlyph(stripDrop).color }"
            />
            <span class="truncate text-12.5">{{ stripDrop.title }}</span>
          </div>
        </Transition>
        <SlidingIndicator
          class="text-(--d-accent)"
          data-testid="editor-tab-indicator"
          :box="barBox"
          :radius="0"
          :animate="animate"
        />
      </div>
    </div>
    <OverflowSlider
      :strip="overflow"
      data-testid="editor-tab-scrollbar"
    />
  </div>
</template>
