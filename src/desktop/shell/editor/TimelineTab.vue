<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { FileClock, GitCommitHorizontal, GitCompare, GitCompareArrows, History, ListChecks, LoaderCircle, RotateCw, TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import { commitTime } from '@/utils/clock';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import type { OverlayMenuItem } from '../../preload/overlay-channels';
import { tidyMenu } from '../../preload/overlay-channels';
import type { ScmTimelineEntry } from '../../preload/scm-channels';
import type { DamoclesShellApi, ShellEditorTab } from '../../preload/shell-channels';
import { fromNow } from '../scm/scm-list';
import { SCM_STORE } from '../scm/scm-store';
import { visibleText } from '@shared/visible-text';

// A file's Timeline tab (B30, B47): the commits that touched it (log --follow) 50 at a time, newest first, led by Staged
// Changes while the index holds changes to it; VS Code's timelinePane.ts and git's timelineProvider.ts.
const props = defineProps<{ api: DamoclesShellApi; tab: ShellEditorTab & { timeline: NonNullable<ShellEditorTab['timeline']> } }>();
const { t, locale } = useI18n();
const scm = inject(SCM_STORE)!;

// rem of a row (the prototype's 30px) and the ms a newly loaded page's rows take to arrive, after which they stay still
const ROW_REM = 1.875;
const ARRIVE_MS = 700;

type Row = { readonly kind: 'staged' } | { readonly kind: 'commit'; readonly entry: ScmTimelineEntry } | { readonly kind: 'more' };

const entries = shallowRef<readonly ScmTimelineEntry[]>([]);
const cursor = ref<string | undefined>();
const hasStaged = ref(false);
const committed = ref(true);
const state = ref<'loading' | 'ready' | 'failed'>('loading');
const loadingMore = ref(false);
// the commit chosen with Select for Compare, which Compare with Selected diffs against
const compareWith = ref<ScmTimelineEntry | null>(null);
const active = ref(0);
// rows from this index arrived with the last page and stagger in once
const arrivedFrom = ref<number | null>(null);
let arriveTimer: ReturnType<typeof setTimeout> | undefined;
let serial = 0;

const target = computed(() => props.tab.timeline);
const name = computed(() => target.value.path.slice(target.value.path.lastIndexOf('/') + 1));
const rows = computed<Row[]>(() => [
  ...(hasStaged.value ? [{ kind: 'staged' as const }] : []),
  ...entries.value.map((entry) => ({ kind: 'commit' as const, entry })),
  ...(cursor.value !== undefined ? [{ kind: 'more' as const }] : []),
]);
const { list: visible, containerProps, wrapperProps } = useVirtualList(rows, { itemHeight: () => remPx(ROW_REM), overscan: 10 });

function arrive(from: number): void {
  clearTimeout(arriveTimer);
  if (prefersReducedMotion()) return;
  arrivedFrom.value = from;
  arriveTimer = setTimeout(() => {
    arrivedFrom.value = null;
  }, ARRIVE_MS);
}

async function load(more: boolean): Promise<void> {
  const asked = ++serial;
  if (more) loadingMore.value = true;
  else state.value = entries.value.length === 0 ? 'loading' : state.value;
  try {
    const result = await props.api.scm.timeline({ ...target.value, ...(more && cursor.value !== undefined ? { cursor: cursor.value } : {}) });
    if (asked !== serial) return;
    if (!result.ok) {
      if (!more) state.value = 'failed';
      return;
    }
    const before = more ? entries.value.length : 0;
    const firstLoad = !more && state.value !== 'ready';
    entries.value = more ? [...entries.value, ...result.entries] : result.entries;
    cursor.value = result.cursor;
    hasStaged.value = result.hasStaged;
    committed.value = result.committed;
    state.value = 'ready';
    if (more || firstLoad) arrive(before + (hasStaged.value ? 1 : 0));
  } catch (err) {
    console.error('[timeline] reading the timeline failed', err);
    if (asked === serial && !more) state.value = 'failed';
  } finally {
    if (asked === serial) loadingMore.value = false;
    if (more && reloadQueued) {
      reloadQueued = false;
      void load(false);
    }
  }
}

// set when HEAD moved while Load more ran, so the first page is read once that page landed
let reloadQueued = false;
void load(false);
// Only a commit (HEAD moving) changes the history, so only it reads the first page again; a stage or an unstage only adds or
// drops Staged Changes, which the status already says, and any other status changes nothing here.
const snapshot = computed(() => scm.snapshots.value.get(target.value.repoId));
watch(() => snapshot.value?.commit?.hash, () => {
  if (loadingMore.value) reloadQueued = true;
  else void load(false);
});
watch(() => snapshot.value?.groups.index.some((change) => change.path === target.value.path), (staged) => {
  if (staged !== undefined && state.value === 'ready') hasStaged.value = staged;
});
onBeforeUnmount(() => clearTimeout(arriveTimer));

const ago = (entry: ScmTimelineEntry): string => fromNow(entry.committerDate, Date.now(), locale.value);
const when = (entry: ScmTimelineEntry): string => commitTime(entry.committerDate, locale.value).full;

async function openChanges(row: Row): Promise<void> {
  if (row.kind === 'staged') await props.api.scm.run({ op: 'openChanges', repoId: target.value.repoId, path: target.value.path, group: 'index' });
  else if (row.kind === 'commit') await props.api.scm.run({ op: 'openCommit', repoId: target.value.repoId, commit: row.entry.hash, path: row.entry.path });
  else await load(true);
}

async function openCommit(entry: ScmTimelineEntry): Promise<void> {
  await props.api.scm.run({ op: 'openCommit', repoId: target.value.repoId, commit: entry.hash });
}

async function compare(entry: ScmTimelineEntry): Promise<void> {
  const selected = compareWith.value;
  if (!selected || selected.hash === entry.hash) {
    compareWith.value = entry;
    return;
  }
  compareWith.value = null;
  await props.api.scm.run({ op: 'compareCommits', repoId: target.value.repoId, left: { commit: selected.hash, path: selected.path }, right: { commit: entry.hash, path: entry.path } });
}

const comparing = (entry: ScmTimelineEntry): boolean => compareWith.value !== null && compareWith.value.hash !== entry.hash;

async function openMenu(row: Row, anchor: DOMRect): Promise<void> {
  if (row.kind === 'more') return;
  const item = (id: string, label: string, icon: Extract<OverlayMenuItem, { kind: 'item' }>['icon']): OverlayMenuItem => ({ kind: 'item', id, label, ...(icon ? { icon } : {}) });
  const separator: OverlayMenuItem = { kind: 'separator' };
  const items: OverlayMenuItem[] = row.kind === 'staged'
    ? [item('openChanges', t('timeline.openChanges'), 'git-compare')]
    : [
        item('openChanges', t('timeline.openChanges'), 'git-compare'),
        item('openCommit', t('timeline.openCommit'), 'git-commit-horizontal'),
        separator,
        comparing(row.entry) ? item('compare', t('timeline.compareWithSelected'), 'git-compare') : item('compare', t('timeline.selectForCompare'), 'check'),
        separator,
        item('copyCommitId', t('timeline.copyCommitId'), 'copy'),
        item('copyCommitMessage', t('timeline.copyCommitMessage'), 'copy'),
      ];
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: row.kind === 'staged' ? t('timeline.staged') : visibleText(row.entry.subject),
    anchor: { x: Math.max(0, anchor.left), y: Math.max(0, anchor.top), width: anchor.width, height: anchor.height },
    items: tidyMenu(items),
  });
  if (answer.kind !== 'menu') return;
  if (answer.itemId === 'openChanges') await openChanges(row);
  else if (row.kind === 'commit') {
    if (answer.itemId === 'openCommit') await openCommit(row.entry);
    else if (answer.itemId === 'compare') await compare(row.entry);
    else if (answer.itemId === 'copyCommitId' || answer.itemId === 'copyCommitMessage') {
      await props.api.scm.copy({ repoId: target.value.repoId, kind: answer.itemId === 'copyCommitId' ? 'commitId' : 'commitMessage', value: row.entry.hash });
    }
  }
}

function focusRow(index: number): void {
  const clamped = Math.min(Math.max(index, 0), rows.value.length - 1);
  active.value = clamped;
  const container = containerProps.ref.value;
  if (!container) return;
  const height = remPx(ROW_REM);
  const top = clamped * height;
  if (top < container.scrollTop) container.scrollTop = top;
  else if (top + height > container.scrollTop + container.clientHeight) container.scrollTop = top + height - container.clientHeight;
  void nextTick(() => container.querySelector<HTMLElement>(`[data-index="${clamped}"]`)?.focus({ preventScroll: true }));
}

function onKeydown(event: KeyboardEvent, row: Row, index: number): void {
  const page = Math.max(1, Math.floor((containerProps.ref.value?.clientHeight ?? 0) / remPx(ROW_REM)) - 1);
  const next = ({ ArrowDown: index + 1, ArrowUp: index - 1, PageDown: index + page, PageUp: index - page, Home: 0, End: rows.value.length - 1 } as Record<string, number>)[event.key];
  if (next !== undefined) {
    event.preventDefault();
    focusRow(next);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    void openChanges(row);
  } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    event.preventDefault();
    void openMenu(row, (event.currentTarget as HTMLElement).getBoundingClientRect());
  }
}

const count = computed(() => (cursor.value !== undefined ? t('timeline.countMore', { count: entries.value.length }) : t('timeline.count', entries.value.length, { named: { count: entries.value.length } })));
const branch = computed(() => {
  const head = scm.snapshots.value.get(target.value.repoId)?.head;
  return head?.type === 'detached' ? head.commit.slice(0, 7) : head?.name;
});
const ICON_BUTTON = 'd-press size-5.5 rounded-5 text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25';
</script>

<template>
  <div
    data-testid="timeline-tab"
    class="absolute inset-0 flex min-h-0 flex-col"
  >
    <div class="flex h-7.5 shrink-0 items-center gap-2 border-b border-(--d-border) bg-(--d-bg) px-3 text-11.5 whitespace-nowrap text-(--d-faint-text)">
      <History
        aria-hidden="true"
        class="size-3.25 shrink-0"
      />
      <span class="min-w-0 truncate font-mono text-(--d-text)">{{ visibleText(target.path) }}</span>
      <template v-if="state === 'ready' && committed">
        <span aria-hidden="true">·</span>
        <span data-testid="timeline-count">{{ count }}</span>
      </template>
      <template v-if="branch">
        <span aria-hidden="true">·</span>
        <span class="truncate font-mono">{{ visibleText(branch) }}</span>
      </template>
      <span class="flex-1" />
      <span
        v-if="entries.length > 0"
        class="truncate"
      >{{ t('timeline.hint') }}</span>
    </div>

    <div
      v-if="state === 'loading'"
      class="flex flex-1 items-center justify-center gap-2 text-12.5 text-(--d-muted)"
      role="status"
    >
      <LoaderCircle
        aria-hidden="true"
        class="d-spinning size-4"
      />{{ t('timeline.loading') }}
    </div>
    <div
      v-else-if="state === 'failed'"
      class="pane-empty d-fade-in flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center"
      role="alert"
    >
      <span class="d-state-icon flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-panel) text-(--d-warning-text)">
        <TriangleAlert
          aria-hidden="true"
          class="size-5"
        />
      </span>
      <p class="text-12.5 text-(--d-muted)">
        {{ t('timeline.failed') }}
      </p>
      <Button
        size="sm"
        variant="outline"
        class="d-press h-7 gap-1.5 rounded-7 border-(--d-border2) bg-(--d-card) px-3 text-12 hover:border-(--d-accent) hover:bg-(--d-card) [&_svg]:size-3.5"
        @click="load(false)"
      >
        <RotateCw aria-hidden="true" />{{ t('timeline.retry') }}
      </Button>
    </div>
    <div
      v-else-if="!committed && !hasStaged"
      data-testid="timeline-empty"
      class="pane-empty d-fade-in flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center"
    >
      <span class="d-state-icon flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-panel) text-(--d-faint)">
        <FileClock
          aria-hidden="true"
          class="size-5"
        />
      </span>
      <p class="text-12.5 text-(--d-muted)">
        {{ t('timeline.notCommitted') }}
      </p>
    </div>
    <!-- A virtualized listbox of the commits; no shadcn part virtualizes a list. -->
    <div
      v-else
      v-bind="containerProps"
      role="listbox"
      data-testid="timeline-list"
      :aria-label="t('timeline.listLabel', { name })"
      class="min-h-0 flex-1 overflow-x-hidden px-2 py-1.5"
    >
      <div v-bind="wrapperProps">
        <div
          v-for="{ data: row, index } in visible"
          :key="row.kind === 'commit' ? row.entry.hash : row.kind"
          role="option"
          :aria-selected="row.kind === 'commit' && compareWith?.hash === row.entry.hash"
          :aria-posinset="index + 1"
          :aria-setsize="rows.length"
          :data-index="index"
          :data-testid="row.kind === 'commit' ? 'timeline-entry' : row.kind === 'staged' ? 'timeline-staged' : 'timeline-more'"
          :data-hash="row.kind === 'commit' ? row.entry.hash : undefined"
          :tabindex="index === active ? 0 : -1"
          :title="row.kind === 'commit' ? `${row.entry.hash.slice(0, 7)}: ${visibleText(row.entry.subject)}\n${visibleText(row.entry.author)} · ${when(row.entry)}` : undefined"
          class="group/row flex cursor-pointer items-center gap-2 rounded-7 pr-1.5 pl-2 text-12.5 outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
          :class="[
            row.kind === 'commit' && compareWith?.hash === row.entry.hash ? 'bg-(--d-accent-soft)' : 'hover:bg-(--d-hover)',
            arrivedFrom !== null && index >= arrivedFrom ? 'd-row-reveal' : '',
          ]"
          :style="{ height: `${remPx(ROW_REM)}px`, ...(arrivedFrom !== null && index >= arrivedFrom ? { '--reveal-index': String(index - arrivedFrom) } : {}) }"
          @click="openChanges(row)"
          @focus="active = index"
          @keydown="onKeydown($event, row, index)"
          @contextmenu.prevent="openMenu(row, ($event.currentTarget as HTMLElement).getBoundingClientRect())"
        >
          <template v-if="row.kind === 'staged'">
            <GitCompare
              aria-hidden="true"
              class="size-3.5 shrink-0 text-(--d-success-text)"
            />
            <span class="min-w-0 flex-1 truncate font-medium">{{ t('timeline.staged') }}</span>
          </template>
          <template v-else-if="row.kind === 'more'">
            <LoaderCircle
              v-if="loadingMore"
              aria-hidden="true"
              class="d-spinning size-3.5 shrink-0 text-(--d-muted)"
            />
            <span class="min-w-0 flex-1 truncate text-(--d-accent-text)">{{ loadingMore ? t('timeline.loadingMore') : t('timeline.loadMore') }}</span>
          </template>
          <template v-else>
            <GitCommitHorizontal
              aria-hidden="true"
              class="size-3.5 shrink-0 text-(--d-accent-text)"
            />
            <span class="min-w-0 flex-1 truncate">{{ visibleText(row.entry.subject) }}</span>
            <Transition name="t-chip">
              <span
                v-if="compareWith?.hash === row.entry.hash"
                class="shrink-0 rounded-5 bg-(--d-accent-soft) px-1.5 text-10.5/4 text-(--d-accent-text)"
              >{{ t('timeline.selected') }}</span>
            </Transition>
            <span class="max-w-[40%] shrink-0 truncate text-11 text-(--d-faint-text)">{{ visibleText(row.entry.author) }} · {{ ago(row.entry) }}</span>
            <span class="shrink-0 font-mono text-10.5 text-(--d-faint-text)">{{ row.entry.hash.slice(0, 7) }}</span>
            <span class="flex shrink-0 items-center gap-0.5">
              <Button
                size="icon"
                variant="ghost"
                tabindex="-1"
                data-testid="timeline-open-changes"
                :class="ICON_BUTTON"
                :aria-label="t('timeline.openChanges')"
                :title="t('timeline.openChanges')"
                @click.stop="openChanges(row)"
              >
                <GitCompare aria-hidden="true" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                tabindex="-1"
                data-testid="timeline-open-commit"
                :class="ICON_BUTTON"
                :aria-label="t('timeline.openCommit')"
                :title="t('timeline.openCommit')"
                @click.stop="openCommit(row.entry)"
              >
                <GitCommitHorizontal aria-hidden="true" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                tabindex="-1"
                data-testid="timeline-compare"
                :class="ICON_BUTTON"
                :aria-label="comparing(row.entry) ? t('timeline.compareWithSelected') : t('timeline.selectForCompare')"
                :title="comparing(row.entry) ? t('timeline.compareWithSelected') : t('timeline.selectForCompare')"
                @click.stop="compare(row.entry)"
              >
                <GitCompareArrows
                  v-if="comparing(row.entry)"
                  aria-hidden="true"
                />
                <ListChecks
                  v-else
                  aria-hidden="true"
                />
              </Button>
            </span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
