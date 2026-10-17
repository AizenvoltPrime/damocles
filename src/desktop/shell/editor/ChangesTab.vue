<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, toRaw, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize, useVirtualList } from '@vueuse/core';
import { FileCheck2, FileSymlink, FileX2, MessageSquare, Trash2, TriangleAlert } from 'lucide-vue-next';
import RollingNumber from '@/components/RollingNumber.vue';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { remPx } from '@/composables/useRemPx';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import SlidingIndicator from '@/components/SlidingIndicator.vue';
import { buildFileDiff, type DiffLine, type FileDiff } from '@/utils/parseUnifiedDiff';
import type { ChatReviewComment } from '../../preload/review-channels';
import { MAX_REVIEW_COMMENT_CHARS, MAX_REVIEW_COMMENTS } from '../../preload/review-channels';
import { fileIcon } from '../file-icons';
import StatusLetter from '../scm/StatusLetter.vue';
import { visibleText } from '@shared/visible-text';
import type { ChangesEntry, ChangesSource } from './changes-source';

// The multi-file diff tab: a source's files beside one file's unified diff (D60's one diff design). Source control's
// changes, View Stash, Compare and the chat review share it through `source`; only the review's has line comments.
const props = defineProps<{ source: ChangesSource; lead: string; stats?: { readonly added: number; readonly removed: number } }>();
const { t } = useI18n();

// rem of a file row (the prototype's 24px), a diff line, a comment card and the open comment box; the virtual list needs them fixed
const ENTRY_REM = 1.5;
const LINE_REM = 1.25;
const COMMENT_REM = 5.25;
// a card that cannot be sent (unsendable or stale) adds up to three 1rem lines saying why and their 0.25rem gap
const NOTE_REM = 3.25;
// the box fills its row less the card's 0.25rem margins: padding 1rem, two 1.25rem rows, 0.25rem gap, 1.5rem buttons, 2px border
const EDITOR_REM = 6;
// a full review's box adds its notice above the buttons: three 1rem lines and a 0.25rem gap
const EDITOR_FULL_REM = 3.25;
// below this diff width the box's two buttons take a row each, which adds a 1.5rem button and its 0.375rem gap
const EDITOR_STACK_REM = 16;
const EDITOR_STACKED_REM = 1.875;
// ms a diff may take before its loading bar shows, so a fast one never flickers it
const LOADING_BAR_DELAY_MS = 150;

type Shown =
  | { readonly kind: 'diff'; readonly diff: FileDiff }
  | { readonly kind: 'binary' | 'tooLarge' | 'missing' | 'unreadable' };

type Side = ChatReviewComment['side'];
type Row =
  | { readonly kind: 'line'; readonly key: string; readonly line: DiffLine; readonly at: { side: Side; line: number } | null }
  // note: why the card cannot be sent. unsendable: its file's lines no longer take comments; stale: its line changed since.
  // above: listed above the diff, for a file that takes no comments or a line the diff no longer shows
  | { readonly kind: 'comment'; readonly key: string; readonly comment: ChatReviewComment; readonly note?: 'unsendable' | 'stale'; readonly above?: true }
  | { readonly kind: 'editor'; readonly key: string; readonly side: Side; readonly line: number };

const listId = useId();
const entries = computed(() => props.source.entries);
const selectedPath = ref<string | undefined>(entries.value[0]?.path);
const selectedIndex = computed(() => entries.value.findIndex((entry) => entry.path === selectedPath.value));
const selected = computed<ChangesEntry | undefined>(() => entries.value[selectedIndex.value]);
// the diff on screen, the path it belongs to and its entry's comment fields as loaded; the old one stays until the next arrives
const shown = shallowRef<{ path: string; value: Shown; revision: string; commentable: boolean } | null>(null);
const loading = ref(false);
const loadingBar = ref(false);
let serial = 0;
let barTimer: ReturnType<typeof setTimeout> | undefined;

const comments = computed(() => props.source.comments);
// the open comment box: where it is, its text, and whether the user just opened it (it expands only then)
const editing = ref<{ side: Side; line: number; text: string } | null>(null);
// the box's field scrolls only once its text passes the two rows it shows, so a short comment draws no scrollbar
const editorScrolls = ref(false);
// the card or box that arrived by the user's action, which alone plays its entrance; a virtual row scrolled back in stays still
const arrived = ref<string | null>(null);
// the focused diff line (roving tabindex), by its line row's key, which a card coming or going above it does not move
const focusedKey = ref<string | null>(null);

const { list: visibleEntries, containerProps, wrapperProps } = useVirtualList(entries, { itemHeight: () => remPx(ENTRY_REM), overscan: 8 });

const sideOf = (line: DiffLine): Side => (line.type === 'addition' ? 'added' : line.type === 'deletion' ? 'removed' : 'context');
const numberOf = (line: DiffLine): number | null => (line.type === 'deletion' ? line.oldLineNum : line.newLineNum);
const commentKey = (side: Side, line: number): string => `${side}:${line}`;

const rows = computed<Row[]>(() => {
  const value = shown.value?.value;
  if (value?.kind !== 'diff') return [];
  const own = comments.value && shown.value ? comments.value.of(shown.value.path) : [];
  const byLine = new Map<string, ChatReviewComment[]>();
  for (const comment of own) byLine.set(commentKey(comment.side, comment.line), [...(byLine.get(commentKey(comment.side, comment.line)) ?? []), comment]);
  const out: Row[] = [];
  const placed = new Set<ChatReviewComment>();
  const staleNote = (comment: ChatReviewComment): { note?: 'stale' } => (comments.value?.stale(comment) ? { note: 'stale' } : {});
  if (!shown.value?.commentable) for (const [order, comment] of own.entries()) out.push({ kind: 'comment', key: `s${order}`, comment, note: 'unsendable', above: true });
  value.diff.lines.forEach((line, index) => {
    const number = numberOf(line);
    const at = comments.value && shown.value?.commentable && value.diff.numbered && number !== null && (line.type === 'addition' || line.type === 'deletion' || line.type === 'context') ? { side: sideOf(line), line: number } : null;
    out.push({ kind: 'line', key: `l${index}`, line, at });
    if (!at) return;
    const key = commentKey(at.side, at.line);
    for (const [order, comment] of (byLine.get(key) ?? []).entries()) {
      placed.add(comment);
      out.push({ kind: 'comment', key: `c${key}:${order}`, comment, ...staleNote(comment) });
    }
    if (editing.value && commentKey(editing.value.side, editing.value.line) === key) out.push({ kind: 'editor', key: `e${key}`, side: at.side, line: at.line });
  });
  // A comment whose line the diff no longer shows keeps its card, listed above the diff with its stale mark.
  if (shown.value?.commentable) {
    const gone = own.filter((comment) => !placed.has(comment));
    out.unshift(...gone.map((comment, order): Row => ({ kind: 'comment', key: `g${order}`, comment, ...staleNote(comment), above: true })));
  }
  return out;
});
const rowHeight = (index: number): number => {
  const row = rows.value[index];
  if (row?.kind === 'comment') return remPx(COMMENT_REM + (row.note ? NOTE_REM : 0));
  return remPx(row?.kind === 'editor' ? EDITOR_REM + (comments.value?.full ? EDITOR_FULL_REM : 0) + (editorStacked.value ? EDITOR_STACKED_REM : 0) : LINE_REM);
};
const { list: visibleRows, containerProps: diffContainer, wrapperProps: diffWrapper, scrollTo } = useVirtualList(rows, { itemHeight: rowHeight, overscan: 30 });
const { width: diffWidth } = useElementSize(diffContainer.ref);
const editorStacked = computed(() => diffWidth.value > 0 && diffWidth.value < remPx(EDITOR_STACK_REM));
// The focused line's row index; the first row (always a line) before any line was focused.
const focusedRow = computed(() => Math.max(0, rows.value.findIndex((row) => row.key === focusedKey.value)));
// The roving tab stop: the focused line while it is rendered, else the first rendered line, so the diff always has one.
const tabStop = computed(() => {
  if (visibleRows.value.some(({ index }) => index === focusedRow.value)) return focusedRow.value;
  return visibleRows.value.find(({ data }) => data.kind === 'line')?.index ?? focusedRow.value;
});

const wrapper = ref<HTMLElement | null>(null);
const renderedSelected = computed(() => visibleEntries.value.findIndex(({ index }) => index === selectedIndex.value));
const { box, animate } = useSlidingIndicator(wrapper, '[data-changes-entry]', renderedSelected);

// A file that left the list (staged, discarded, reverted) hands the selection to the one now in its place.
watch(entries, (next, previous) => {
  if (next.some((entry) => entry.path === selectedPath.value)) return;
  const was = previous?.findIndex((entry) => entry.path === selectedPath.value) ?? 0;
  selectedPath.value = next[Math.min(Math.max(was, 0), next.length - 1)]?.path;
});

async function load(path: string | undefined): Promise<void> {
  const asked = ++serial;
  clearTimeout(barTimer);
  if (path === undefined) {
    shown.value = null;
    loading.value = false;
    loadingBar.value = false;
    return;
  }
  loading.value = true;
  const commentable = selected.value?.commentable === true;
  barTimer = setTimeout(() => {
    if (asked === serial) loadingBar.value = true;
  }, LOADING_BAR_DELAY_MS);
  try {
    const result = await props.source.fileDiff(path);
    if (asked !== serial) return;
    let value: Shown;
    if (result.kind !== 'patch') value = { kind: result.kind };
    else {
      // jsdiff throws on a patch it cannot read; the pane says so rather than showing nothing.
      try {
        value = { kind: 'diff', diff: buildFileDiff({ kind: 'patch', patch: result.patch }) };
      } catch {
        value = { kind: 'unreadable' };
      }
    }
    const samePath = shown.value?.path === path;
    // the revision of the diff served, which may be newer than the entry that asked for it
    shown.value = { path, value, revision: result.kind === 'patch' && 'revision' in result ? result.revision : '', commentable };
    if (!samePath) {
      leave?.();
      editing.value = null;
      focusedKey.value = null;
      diffContainer.ref.value?.scrollTo({ top: 0 });
    }
  } catch {
    // A failed read must not leave the previous file's diff under this file's name.
    if (asked === serial) shown.value = { path, value: { kind: 'unreadable' }, revision: '', commentable: false };
  } finally {
    if (asked === serial) {
      clearTimeout(barTimer);
      loading.value = false;
      loadingBar.value = false;
    }
  }
}

// Only a change of the selected entry's version reloads its diff, since every push brings new arrays of the same entries.
watch([selectedPath, () => selected.value?.version], ([path]) => void load(path), { immediate: true });
onBeforeUnmount(() => clearTimeout(barTimer));

function select(index: number, focus: boolean): void {
  const clamped = Math.min(Math.max(index, 0), entries.value.length - 1);
  const entry = entries.value[clamped];
  if (!entry) return;
  selectedPath.value = entry.path;
  const container = containerProps.ref.value;
  if (container) {
    const height = remPx(ENTRY_REM);
    const top = clamped * height;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (top + height > container.scrollTop + container.clientHeight) container.scrollTop = top + height - container.clientHeight;
  }
  if (focus) void nextTick(() => containerProps.ref.value?.querySelector<HTMLElement>(`[data-path="${CSS.escape(entry.path)}"]`)?.focus({ preventScroll: true }));
}

function onListKeydown(event: KeyboardEvent): void {
  const index = Math.max(0, selectedIndex.value);
  const page = Math.max(1, Math.floor((containerProps.ref.value?.clientHeight ?? 0) / remPx(ENTRY_REM)) - 1);
  const target = ({ ArrowDown: index + 1, ArrowUp: index - 1, PageDown: index + page, PageUp: index - page, Home: 0, End: entries.value.length - 1 } as Record<string, number>)[event.key];
  if (target === undefined) return;
  event.preventDefault();
  select(target, true);
}

// Comments: a line number click or Enter on a focused line opens the box; Enter adds, Escape cancels (D60).
function openEditor(at: { side: Side; line: number }, rowIndex: number): void {
  if (!comments.value) return;
  // a box or card still leaving goes now, so its exit never lands on the new box
  leave?.();
  editing.value = { ...at, text: '' };
  editorScrolls.value = false;
  arrived.value = `e${commentKey(at.side, at.line)}`;
  focusedKey.value = rows.value[rowIndex]?.key ?? null;
  void nextTick(() => diffContainer.ref.value?.querySelector<HTMLTextAreaElement>('[data-testid="review-comment-input"]')?.focus());
}

// A card or box that leaves plays its exit first; with motion reduced it goes at once, as its exit animation is not seen.
const leaving = ref<string | null>(null);
let leave: (() => void) | null = null;

function leaveThen(key: string, done: () => void): void {
  if (prefersReducedMotion()) {
    done();
    return;
  }
  leave?.();
  leaving.value = key;
  leave = () => {
    leave = null;
    leaving.value = null;
    done();
  };
}

function onCardAnimationEnd(key: string): void {
  if (arrived.value === key) arrived.value = null;
  if (leaving.value === key) leave?.();
}

function closeEditor(refocus: boolean): void {
  const was = editing.value;
  if (!was) return;
  leaveThen(`e${commentKey(was.side, was.line)}`, () => {
    if (editing.value === was) editing.value = null;
    if (refocus) void nextTick(() => focusLine(focusedRow.value));
  });
}

// The virtual list hands its rows out as reactive proxies; the source matches its own drafts, so it gets the raw one.
// Focus goes to the card's line, or for a card above the diff to what now stands in its place, never to the document.
function removeComment(row: Extract<Row, { kind: 'comment' }>, index: number): void {
  leaveThen(row.key, () => {
    comments.value?.remove(toRaw(row.comment));
    void nextTick(() => {
      if (!row.above) focusLine(index - 1, -1);
      else if (rows.value[index]?.kind === 'comment') diffContainer.ref.value?.querySelector<HTMLElement>(`[data-row="${index}"] [data-testid="review-comment-delete"]`)?.focus();
      else focusLine(index, 1);
    });
  });
}

/** Adds the open box's comment; nothing for an empty box or a full review, whose box keeps its text and says so. */
function addComment(): void {
  const open = editing.value;
  const path = shown.value?.path;
  const text = open?.text.trim() ?? '';
  if (!open || !path || !comments.value || text === '' || comments.value.full) return;
  const order = comments.value.of(path).filter((comment) => comment.side === open.side && comment.line === open.line).length;
  comments.value.add({ path, line: open.line, side: open.side, text: text.slice(0, MAX_REVIEW_COMMENT_CHARS), revision: shown.value!.revision });
  arrived.value = `c${commentKey(open.side, open.line)}:${order}`;
  editing.value = null;
  void nextTick(() => focusLine(focusedRow.value));
}

// Shift+Enter writes the model without an input event, so this follows the text rather than the field's events
watch(
  () => editing.value?.text,
  () => void nextTick(() => {
    const field = diffContainer.ref.value?.querySelector<HTMLTextAreaElement>('[data-testid="review-comment-input"]');
    editorScrolls.value = field ? field.scrollHeight > field.clientHeight : false;
  }),
);

function onEditorKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
    event.preventDefault();
    addComment();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeEditor(true);
  }
}

// The line row nearest index in the direction of travel (step -1 or 1), else the nearest the other way; comment cards and the
// open box take no focus stop.
function lineRowNear(index: number, step: number): number {
  const clamped = Math.min(Math.max(index, 0), rows.value.length - 1);
  for (let at = clamped; at >= 0 && at < rows.value.length; at += step) if (rows.value[at]?.kind === 'line') return at;
  for (let at = clamped; at >= 0 && at < rows.value.length; at -= step) if (rows.value[at]?.kind === 'line') return at;
  return clamped;
}

function focusLine(rowIndex: number, step = 1): void {
  const clamped = lineRowNear(rowIndex, step);
  focusedKey.value = rows.value[clamped]?.key ?? null;
  const container = diffContainer.ref.value;
  if (!container) return;
  let top = 0;
  for (let index = 0; index < clamped; index++) top += rowHeight(index);
  const height = rowHeight(clamped);
  if (top < container.scrollTop) container.scrollTop = top;
  else if (top + height > container.scrollTop + container.clientHeight) container.scrollTop = top + height - container.clientHeight;
  void nextTick(() => container.querySelector<HTMLElement>(`[data-row="${clamped}"]`)?.focus({ preventScroll: true }));
}

function onLineKeydown(event: KeyboardEvent, row: Row, index: number): void {
  if (event.target !== event.currentTarget) return;
  if (event.key === 'Enter' && row.kind === 'line' && row.at) {
    event.preventDefault();
    openEditor(row.at, index);
    return;
  }
  const step = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[event.key];
  if (step !== undefined) {
    event.preventDefault();
    focusLine(index + step, step);
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    if (event.key === 'Home') focusLine(0, 1);
    else focusLine(rows.value.length - 1, -1);
  }
}

// A file outside the chat's folder is listed by its native absolute path, so both separators split it.
const lastSeparator = (path: string): number => Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
const nameOf = (path: string): string => path.slice(lastSeparator(path) + 1);
const dirOf = (path: string): string => path.slice(0, Math.max(0, lastSeparator(path)));
const fileStats = computed(() => (shown.value?.value.kind === 'diff' ? shown.value.value.diff.stats : undefined));
const empty = computed(() => (shown.value?.value.kind === 'diff' ? shown.value.value.diff.empty : undefined));
const commentCount = (path: string): number => comments.value?.of(path).length ?? 0;

const lineClass = (line: DiffLine): string =>
  line.type === 'addition' ? 'bg-(--d-add)' : line.type === 'deletion' ? 'bg-(--d-del)' : line.type === 'gap' ? 'text-(--d-faint-text) bg-(--d-panel)' : '';
// Faint text on an add or del row takes its -text shade (D48).
const numberClass = (line: DiffLine): string => (line.type === 'addition' || line.type === 'deletion' ? 'text-(--d-faint-text)' : 'text-(--d-faint)');
const sign = (line: DiffLine): string => (line.type === 'addition' ? '+' : line.type === 'deletion' ? '−' : '');
const lineLabel = (row: Extract<Row, { kind: 'line' }>): string =>
  row.at ? t(`review.lineLabel.${row.at.side}`, { line: row.at.line, text: row.line.content }) : row.line.content;
const commentWhere = (comment: ChatReviewComment): string => t(comment.side === 'removed' ? 'review.removedLine' : 'review.line', { line: comment.line });

defineExpose({ scrollTo, addComment });
</script>

<template>
  <div
    data-testid="changes-tab"
    class="@container/changes absolute inset-0 flex min-h-0 flex-col"
  >
    <!-- The actions wrap onto their own line only when they and the whole lead do not fit side by side: the heading's
         flex basis is its min-content width, the wider of the lead and the summary, which wraps out of sight first. -->
    <div
      data-testid="changes-top"
      class="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 border-b border-(--d-border) bg-(--d-bg) px-3 text-11.5 whitespace-nowrap text-(--d-faint-text)"
    >
      <!-- One line: the summary, its dot with it, wraps out of sight before the lead truncates, whatever the language's widths. -->
      <div
        data-testid="changes-heading"
        class="flex h-8 w-min min-w-0 grow flex-wrap content-start items-center gap-x-2 overflow-hidden"
      >
        <span
          data-testid="changes-lead"
          class="flex h-8 max-w-full min-w-0 items-center"
        ><span class="truncate text-(--d-text)">{{ lead }}</span></span>
        <span
          data-testid="changes-summary"
          class="flex h-8 shrink-0 items-center gap-2"
        >
          <span aria-hidden="true">·</span>
          <span data-testid="changes-count">{{ t('changesTab.files', entries.length, { named: { count: entries.length } }) }}</span>
          <template v-if="stats">
            <span class="font-mono text-(--d-success-text)">+{{ stats.added }}</span>
            <span class="font-mono text-(--d-danger-text)">−{{ stats.removed }}</span>
          </template>
        </span>
      </div>
      <div
        v-if="$slots.actions"
        data-testid="changes-actions"
        class="flex min-h-8 items-center gap-x-2"
      >
        <slot name="actions" />
      </div>
    </div>
    <slot name="notice" />
    <!-- Below 30rem the files list stacks above the diff at full width, so the diff and its comment cards keep the pane's width. -->
    <div
      data-testid="changes-body"
      class="flex min-h-0 flex-1 @max-[30rem]/changes:flex-col"
    >
      <!-- A virtualized listbox of the files, with the sliding selection; no shadcn part virtualizes a list. -->
      <div
        v-bind="containerProps"
        :id="listId"
        role="listbox"
        tabindex="-1"
        data-testid="changes-list"
        :aria-label="t('changesTab.listLabel')"
        class="w-55 shrink-0 overflow-x-hidden border-(--d-border) bg-(--d-panel) p-1 outline-none @min-[30rem]/changes:border-r @max-[40rem]/changes:w-40 @max-[30rem]/changes:max-h-[min(8rem,40%)] @max-[30rem]/changes:w-full @max-[30rem]/changes:border-b"
        @keydown="onListKeydown"
      >
        <div
          ref="wrapper"
          v-bind="wrapperProps"
          class="relative"
        >
          <SlidingIndicator
            class="text-(--d-accent-soft)"
            :box="box"
            :radius="6"
            :animate="animate"
            variant="soft"
          />
          <div
            v-for="{ data: entry, index } in visibleEntries"
            :key="entry.path"
            role="option"
            data-changes-entry
            data-testid="changes-entry"
            :data-path="entry.path"
            :aria-selected="index === selectedIndex"
            :aria-posinset="index + 1"
            :aria-setsize="entries.length"
            :tabindex="index === Math.max(0, selectedIndex) ? 0 : -1"
            :title="`${visibleText(entry.path)} • ${entry.status}${entry.note ? ` • ${entry.note}` : ''}`"
            class="relative flex cursor-pointer items-center gap-1.75 rounded-6 px-2 text-xs outline-none select-none focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
            :class="index === selectedIndex ? '' : 'hover:bg-(--d-hover)'"
            :style="{ height: `${remPx(ENTRY_REM)}px` }"
            @click="select(index, false)"
          >
            <component
              :is="fileIcon(entry.path).icon"
              aria-hidden="true"
              class="size-3.25 shrink-0"
              :style="{ color: fileIcon(entry.path).color }"
            />
            <span
              class="min-w-0 truncate"
              :class="entry.strike ? 'line-through' : ''"
            >{{ visibleText(nameOf(entry.path)) }}</span>
            <span
              class="min-w-0 flex-1 truncate text-11"
              :class="index === selectedIndex ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
            >{{ visibleText(dirOf(entry.path)) }}</span>
            <template v-if="entry.note">
              <TriangleAlert
                data-testid="changes-entry-note"
                aria-hidden="true"
                class="size-3 shrink-0 text-(--d-warning-text)"
              />
              <span class="sr-only">{{ entry.note }}</span>
            </template>
            <Transition name="t-badge">
              <span
                v-if="commentCount(entry.path) > 0"
                data-testid="changes-entry-comments"
                class="flex shrink-0 items-center gap-0.5 font-mono text-10 text-(--d-accent-text)"
              >
                <MessageSquare
                  aria-hidden="true"
                  class="size-2.5"
                /><RollingNumber :value="commentCount(entry.path)" />
                <span class="sr-only">{{ t('review.fileComments', commentCount(entry.path), { named: { count: commentCount(entry.path) } }) }}</span>
              </span>
            </Transition>
            <StatusLetter
              :letter="entry.letter"
              :tone="entry.tone"
              :title="entry.status"
            />
          </div>
        </div>
      </div>

      <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          v-if="selected"
          class="@container/file relative flex h-7.5 shrink-0 items-center gap-1.75 border-b border-(--d-border) bg-(--d-panel) pr-1.5 pl-3 text-11.5"
        >
          <component
            :is="fileIcon(selected.path).icon"
            aria-hidden="true"
            class="size-3.25 shrink-0"
            :style="{ color: fileIcon(selected.path).color }"
          />
          <span
            data-testid="changes-path"
            class="min-w-0 truncate font-mono text-(--d-text)"
          >{{ visibleText(selected.path) }}</span>
          <!-- The name comes first: as the header narrows the status word goes, then the counts, then the note's words. -->
          <span class="shrink-0 text-(--d-faint-text) @max-[20rem]/file:hidden">{{ selected.status }}</span>
          <span
            v-if="fileStats"
            class="shrink-0 font-mono @max-[14rem]/file:hidden"
          ><span class="text-(--d-success-text)">+{{ fileStats.added }}</span> <span class="text-(--d-danger-text)">−{{ fileStats.removed }}</span></span>
          <span
            v-if="selected.note"
            data-testid="changes-note"
            class="flex shrink-0 items-center gap-1 text-11 text-(--d-warning-text)"
            :title="selected.note"
          ><TriangleAlert
            aria-hidden="true"
            class="size-3 shrink-0"
          /><span class="@max-[26rem]/file:sr-only">{{ selected.note }}</span></span>
          <!-- The hint takes only the room the name and its marks leave (basis 0), so the name never shortens for it. -->
          <span
            v-if="comments && shown?.commentable && shown.value.kind === 'diff' && !empty"
            data-testid="changes-hint"
            class="min-w-0 flex-1 basis-0 truncate text-right text-11 text-(--d-faint-text)"
          >{{ comments.hint }}</span>
          <span
            v-else
            class="flex-1"
          />
          <Button
            v-if="source.openFile"
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="changes-open-file"
            class="size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
            :aria-label="t('scm.action.openFile')"
            :title="t('scm.action.openFile')"
            @click="source.openFile(selected.path)"
          >
            <FileSymlink aria-hidden="true" />
          </Button>
          <div
            v-if="loadingBar"
            role="progressbar"
            :aria-label="t('changesTab.loading')"
            class="d-sweep-bar absolute inset-x-0 -bottom-px h-0.5 text-(--d-accent)"
          />
        </div>
        <div
          v-if="entries.length === 0"
          data-testid="changes-empty"
          class="pane-empty d-fade-in flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center"
        >
          <span class="d-state-icon flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-panel) text-(--d-faint)">
            <FileCheck2
              aria-hidden="true"
              class="size-5"
            />
          </span>
          <p class="max-w-80 text-12.5 text-(--d-muted)">
            {{ source.emptyText }}
          </p>
        </div>
        <Transition
          v-else
          name="t-diff"
        >
          <!-- Absolute, so the outgoing diff overlaps the incoming one while it leaves; top-7.5 is the file header's h-7.5.
               The previous file's diff stays on screen while the next loads, inert, so no comment lands on it. -->
          <div
            v-if="shown"
            :key="shown.path"
            :inert="shown.path !== selectedPath || undefined"
            class="absolute inset-x-0 top-7.5 bottom-0 flex flex-col"
          >
            <!-- The diff's lines as text nodes, virtualized; git's text never becomes markup. -->
            <div
              v-if="shown.value.kind === 'diff' && !empty"
              v-bind="diffContainer"
              role="list"
              data-testid="changes-diff"
              :data-path="shown.path"
              :aria-label="t('review.diffLabel', { path: visibleText(shown.path) })"
              class="@container min-h-0 flex-1 overflow-auto bg-(--d-bg) py-1 font-mono text-xs"
              :aria-busy="loading || undefined"
            >
              <div
                v-bind="diffWrapper"
                class="w-max min-w-full"
              >
                <template
                  v-for="{ data: row, index } in visibleRows"
                  :key="row.key"
                >
                  <div
                    v-if="row.kind === 'line'"
                    role="listitem"
                    data-testid="changes-line"
                    :data-type="row.line.type"
                    :data-row="index"
                    :data-line="row.at?.line"
                    :tabindex="comments ? (index === tabStop ? 0 : -1) : undefined"
                    :aria-label="comments ? lineLabel(row) : undefined"
                    class="flex items-center whitespace-pre outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
                    :class="lineClass(row.line)"
                    :style="{ height: `${remPx(LINE_REM)}px` }"
                    @keydown="onLineKeydown($event, row, index)"
                    @focus="focusedKey = row.key"
                  >
                    <template v-if="row.line.type === 'gap'">
                      <span class="px-3 text-11">{{ t('changesTab.hidden', row.line.hiddenCount ?? 0, { named: { count: row.line.hiddenCount ?? 0 } }) }}</span>
                    </template>
                    <template v-else-if="row.line.type === 'noNewline'">
                      <span class="px-3 text-11 text-(--d-faint-text)">{{ t('changesTab.noNewline') }}</span>
                    </template>
                    <template v-else>
                      <template
                        v-for="column in (['old', 'new'] as const)"
                        :key="column"
                      >
                        <!-- The number a comment names opens the box: the new side's, or a removed line's old one. The row keeps the focus stop. -->
                        <button
                          v-if="row.at && (column === 'old') === (row.at.side === 'removed')"
                          type="button"
                          tabindex="-1"
                          data-testid="review-line-number"
                          class="w-12 shrink-0 cursor-pointer pr-2 text-right select-none hover:text-(--d-accent-text)"
                          :class="numberClass(row.line)"
                          :title="t('review.commentOn', { line: row.at.line })"
                          :aria-label="t('review.commentOn', { line: row.at.line })"
                          @click="openEditor(row.at, index)"
                        >
                          {{ row.at.line }}
                        </button>
                        <span
                          v-else
                          class="w-12 shrink-0 pr-2 text-right select-none"
                          :class="numberClass(row.line)"
                        >{{ (column === 'old' ? row.line.oldLineNum : row.line.newLineNum) ?? '' }}</span>
                      </template>
                      <span
                        class="w-4 shrink-0 text-center select-none"
                        :class="row.line.type === 'addition' ? 'text-(--d-success-text)' : row.line.type === 'deletion' ? 'text-(--d-danger-text)' : ''"
                      >{{ sign(row.line) }}</span>
                      <span class="pr-4 text-(--d-text)">{{ row.line.content }}</span>
                    </template>
                  </div>
                  <div
                    v-else-if="row.kind === 'comment'"
                    role="listitem"
                    data-testid="review-comment"
                    :data-row="index"
                    class="sticky left-0 flex w-[100cqw] items-start px-3 @min-[24rem]:pl-28"
                    :style="{ height: `${rowHeight(index)}px` }"
                  >
                    <div
                      class="mt-1 flex h-[calc(100%-0.5rem)] w-full max-w-160 flex-col rounded-9 border bg-(--d-card) px-2.5 py-2 font-sans text-12.5 whitespace-normal"
                      :class="[row.note === 'stale' ? 'border-(--d-warning)' : 'border-(--d-border2)', leaving === row.key ? 'review-comment-out' : arrived === row.key ? 'review-comment-in' : '']"
                      :data-stale="row.note === 'stale' || undefined"
                      @animationend="onCardAnimationEnd(row.key)"
                    >
                      <div class="flex items-center gap-1.5 text-11 text-(--d-faint-text)">
                        <span
                          class="flex size-4 items-center justify-center rounded-5 bg-(--d-accent-soft) text-[0.5625rem] font-bold text-(--d-accent-text)"
                          aria-hidden="true"
                        >{{ t('review.youInitial') }}</span>
                        <span
                          class="min-w-0 truncate"
                          :title="`${t('review.you')}, ${commentWhere(row.comment)}`"
                        >{{ t('review.you') }}, {{ commentWhere(row.comment) }}</span>
                        <span class="flex-1" />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          data-testid="review-comment-delete"
                          class="d-press size-5 rounded-5 text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-2.75"
                          :aria-label="t('review.deleteComment')"
                          :title="t('review.deleteComment')"
                          @click="removeComment(row, index)"
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>
                      <p
                        class="mt-0.5 line-clamp-2 wrap-break-word text-(--d-text)"
                        :title="row.comment.text"
                      >
                        {{ row.comment.text }}
                      </p>
                      <p
                        v-if="row.note"
                        :data-testid="row.note === 'stale' ? 'review-comment-stale' : 'review-comment-unsendable'"
                        class="mt-1 flex items-start gap-1 text-11/4 text-(--d-warning-text)"
                        :title="t(row.note === 'stale' ? 'review.staleComment' : 'review.unsendable')"
                      >
                        <TriangleAlert
                          aria-hidden="true"
                          class="mt-0.5 size-3 shrink-0"
                        />
                        <span class="line-clamp-3">{{ t(row.note === 'stale' ? 'review.staleComment' : 'review.unsendable') }}</span>
                      </p>
                    </div>
                  </div>
                  <div
                    v-else-if="editing"
                    role="listitem"
                    :data-row="index"
                    class="sticky left-0 flex w-[100cqw] items-start px-3 @min-[24rem]:pl-28"
                    :style="{ height: `${rowHeight(index)}px` }"
                  >
                    <div
                      class="mt-1 flex h-[calc(100%-0.5rem)] w-full max-w-160 flex-col rounded-9 border border-(--d-accent) bg-(--d-input) p-2 font-sans whitespace-normal"
                      :class="leaving === row.key ? 'review-comment-out' : arrived === row.key ? 'review-comment-in' : ''"
                      @animationend="onCardAnimationEnd(row.key)"
                    >
                      <Textarea
                        v-model="editing.text"
                        data-testid="review-comment-input"
                        rows="2"
                        :maxlength="MAX_REVIEW_COMMENT_CHARS"
                        :placeholder="t('review.placeholder', { line: row.line })"
                        :aria-label="t('review.placeholder', { line: row.line })"
                        class="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-0 text-12.5/5 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                        :class="editorScrolls ? 'overflow-y-auto' : 'overflow-hidden'"
                        @keydown="onEditorKeydown"
                      />
                      <p
                        v-if="comments?.full"
                        role="alert"
                        data-testid="review-comment-refused"
                        class="mt-1 line-clamp-3 h-12 text-11.5/4 text-(--d-warning-text)"
                        :title="t('review.full', { count: MAX_REVIEW_COMMENTS })"
                      >
                        {{ t('review.full', { count: MAX_REVIEW_COMMENTS }) }}
                      </p>
                      <div
                        class="mt-1 flex gap-1.5"
                        :class="editorStacked ? 'flex-col items-stretch' : 'justify-end-safe'"
                      >
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid="review-comment-cancel"
                          class="d-press h-6 rounded-7 border-(--d-border2) bg-transparent px-2.5 text-12 hover:bg-(--d-hover)"
                          @click="closeEditor(true)"
                        >
                          {{ t('review.cancel') }}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          data-testid="review-comment-add"
                          class="d-press h-6 gap-1.5 rounded-7 bg-(--d-accent) px-2.5 text-12 font-semibold text-(--d-on-accent) hover:bg-(--d-accent) hover:brightness-110"
                          :disabled="editing.text.trim() === ''"
                          @click="addComment"
                        >
                          {{ t('review.addComment') }}<kbd class="rounded-5 border border-current px-1 font-mono text-10 @max-[26rem]:hidden">Enter</kbd>
                        </Button>
                      </div>
                    </div>
                  </div>
                </template>
              </div>
            </div>
            <div
              v-else
              data-testid="changes-notice"
              class="pane-empty flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center"
            >
              <span class="d-state-icon flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-panel) text-(--d-faint)">
                <FileX2
                  aria-hidden="true"
                  class="size-5"
                />
              </span>
              <p class="max-w-80 text-12.5 text-(--d-muted)">
                {{ shown.value.kind === 'missing' && source.missingText ? source.missingText : t(`changesTab.notice.${shown.value.kind === 'diff' ? (empty ?? 'noChanges') : shown.value.kind}`) }}
              </p>
            </div>
          </div>
        </Transition>
      </div>
    </div>
    <slot name="footer" />
  </div>
</template>
