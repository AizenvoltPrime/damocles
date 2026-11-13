<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, triggerRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { ArrowDown, ChevronRight } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import type { CiLogLevel, CiLogRow, CiLogSection } from '@shared/forge/ci-log';
import TerminalFind from '../terminal/TerminalFind.vue';
import { createLogSearch, MAX_LOG_MATCHES, type LogMatch } from './log-find';
import { ciDuration } from './ci-view';
import { hiddenLines, rowPieces, sectionsAround, spanClass, spanStyle, stampText, visibleIndexOf, visibleRowIndexes, type RowPiece } from './log-model';

/**
 * A job's log: a windowed list of the parser's rows (useVirtualList, as GraphSection.vue is), so a 16 MiB log keeps a screenful
 * of rows in the DOM. Folded sections leave the visible-rows array; Find searches every row, the provisional ones too. Custom
 * markup: no shadcn part is a virtualized log. The parent remounts it on a new log (reset) and when 1rem changes, since the list's row height is fixed px.
 */
const props = defineProps<{
  // the parser's arrays, appended in place; revision changes after every push
  rows: readonly CiLogRow[];
  // the parser's held lines (peekHeld), shown after rows until they become rows
  provisional: readonly CiLogRow[];
  sections: readonly CiLogSection[];
  revision: number;
  name: string;
  // the job runs and appends arrive
  live: boolean;
  // the finished line under the log ("Passed in 3m 41s."), with its tone class
  tail?: { readonly text: string; readonly tone: string } | undefined;
  // rows from this index arrived with the last append and slide in
  arrivedFrom: number | null;
}>();
const follow = defineModel<boolean>('follow', { required: true });
const timestamps = defineModel<boolean>('timestamps', { required: true });
const { t, locale } = useI18n();
const translate = (key: string, values?: Record<string, unknown>): string => (values ? t(key, values) : t(key));

// rem of a log line (the reference's 20px), fixed in px for the list while this view lives
const ROW_REM = 1.25;
const rowPx = Math.round(remPx(ROW_REM));
// rows rendered past each edge of the viewport
const OVERSCAN = 20;

const sectionMap = computed(() => {
  void props.revision;
  return new Map(props.sections.map((section) => [section.id, section]));
});
// Folded sections by id; a section starts as the log says ([collapsed=true]) the first time it appears.
const folded = shallowRef(new Set<number>());
let seenSections = 0;
watch(() => props.revision, () => {
  const fresh = props.sections.slice(seenSections).filter((section) => section.collapsed);
  seenSections = props.sections.length;
  if (fresh.length === 0) return;
  for (const section of fresh) folded.value.add(section.id);
  triggerRef(folded);
}, { immediate: true });

// an index past rows is a provisional row's
const rowAt = (index: number): CiLogRow => props.rows[index] ?? props.provisional[index - props.rows.length]!;
const rowCount = computed(() => {
  void props.revision;
  return props.rows.length + props.provisional.length;
});

const visible = computed(() => {
  void props.revision;
  const shown = visibleRowIndexes(props.rows, sectionMap.value, folded.value);
  props.provisional.forEach((row, at) => {
    if (!sectionsAround(row, sectionMap.value).some((id) => folded.value.has(id))) shown.push(props.rows.length + at);
  });
  return shown;
});
const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(visible, { itemHeight: rowPx, overscan: OVERSCAN });

function setFolded(id: number, fold: boolean): void {
  if (folded.value.has(id) === fold) return;
  if (fold) folded.value.add(id);
  else folded.value.delete(id);
  triggerRef(folded);
}

function foldAll(): void {
  for (const section of props.sections) folded.value.add(section.id);
  triggerRef(folded);
}

const stampFormat = computed(() => new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));

// Following: the end stays in view as rows arrive; scrolling away turns it off and New output says more arrived below.
const newOutput = ref(false);
const atEnd = (element: HTMLElement): boolean => element.scrollHeight - element.scrollTop - element.clientHeight <= rowPx / 2;

function toEnd(): void {
  const element = containerProps.ref.value;
  if (element) element.scrollTop = element.scrollHeight;
}

function onScroll(): void {
  const element = containerProps.ref.value;
  if (!element) return;
  if (atEnd(element)) newOutput.value = false;
  else if (follow.value) follow.value = false;
}

watch([() => props.revision, rowCount], ([, count], [, before]) => {
  if (count <= before) return;
  if (follow.value) void nextTick(toEnd);
  else newOutput.value = true;
});
watch(follow, (on) => {
  if (!on) return;
  newOutput.value = false;
  void nextTick(toEnd);
});
if (follow.value) void nextTick(toEnd);

function jumpToLatest(): void {
  follow.value = true;
  containerProps.ref.value?.focus();
}

// Find (Ctrl+F) over the whole row model, the provisional rows included, through the terminal's find bar.
const finding = ref(false);
const findBar = ref<InstanceType<typeof TerminalFind> | null>(null);
const matches = shallowRef<readonly LogMatch[]>([]);
const currentMatch = shallowRef<LogMatch | null>(null);
const marks = computed(() => {
  const byRow = new Map<number, { start: number; end: number; current: boolean }[]>();
  const current = currentMatch.value;
  let marked = false;
  for (const match of matches.value) {
    const isCurrent = current !== null && match.row === current.row && match.start === current.start;
    marked ||= isCurrent;
    const ranges = byRow.get(match.row) ?? [];
    ranges.push({ start: match.start, end: match.end, current: isCurrent });
    byRow.set(match.row, ranges);
  }
  // a match past MAX_LOG_MATCHES comes after every highlighted one, its own row's included
  if (current !== null && !marked) byRow.set(current.row, [...(byRow.get(current.row) ?? []), { start: current.start, end: current.end, current: true }]);
  return byRow;
});

function reveal(match: LogMatch): void {
  if (match.row >= rowCount.value) return;
  const row = rowAt(match.row);
  let unfolded = false;
  for (const id of sectionsAround(row, sectionMap.value)) unfolded = folded.value.delete(id) || unfolded;
  if (unfolded) triggerRef(folded);
  void nextTick(() => {
    const index = visibleIndexOf(visible.value, match.row);
    const element = containerProps.ref.value;
    if (index < 0 || !element) return;
    follow.value = false;
    const above = Math.floor(element.clientHeight / rowPx / 2);
    scrollTo(Math.max(0, index - above));
  });
}

const search = createLogSearch({
  rows: () => ({ count: rowCount.value, at: rowAt }),
  revision: () => props.revision,
  show: (found, current) => {
    matches.value = found;
    currentMatch.value = current;
    if (current !== null) reveal(current);
  },
});

function openFind(): void {
  if (finding.value) findBar.value?.focus();
  else finding.value = true;
}

function closeFind(): void {
  finding.value = false;
  containerProps.ref.value?.focus();
}

defineExpose({ foldAll, openFind, focus: () => containerProps.ref.value?.focus() });

// The window's rows as they render: a section header carries its section, whether it is folded and what it hides.
function pieceClass(piece: RowPiece): string[] {
  // a marked piece drops its log colours (no inline style), so the mark reads the same on any colour
  const mark = piece.mark === 'current' ? 'rounded-xs bg-(--d-accent) text-(--d-on-accent)' : piece.mark === 'match' ? 'rounded-xs bg-(--d-accent-soft) text-(--d-text)' : '';
  if (!piece.control) return [spanClass(piece.span), mark];
  return ['mx-px rounded-xs border border-(--d-border2) px-0.5 text-10', piece.mark === 'current' ? mark : `${mark} text-(--d-faint-text)`];
}

const LEVEL_TONE: Readonly<Record<CiLogLevel, string>> = { error: 'text-(--d-danger-text)', warning: 'text-(--d-warning-text)', notice: 'text-(--d-info-text)' };

const shown = computed(() => list.value.map(({ data: index }) => {
  const row = rowAt(index);
  const section = row.header === undefined ? undefined : sectionMap.value.get(row.header);
  const isFolded = section !== undefined && folded.value.has(section.id);
  return {
    index,
    row,
    provisional: index >= props.rows.length,
    tone: row.level === undefined ? 'text-(--d-text)' : LEVEL_TONE[row.level],
    pieces: rowPieces(row.spans, marks.value.get(index) ?? []),
    stamp: row.timestamp === undefined ? '' : stampText(row.timestamp, stampFormat.value),
    section: section && {
      id: section.id,
      folded: isFolded,
      label: t(isFolded ? 'forge.log.unfold' : 'forge.log.fold', { title: section.title }),
      duration: section.durationSeconds === undefined ? undefined : ciDuration(section.durationSeconds, translate),
      hidden: isFolded ? hiddenLines(section, props.rows.length) : 0,
    },
  };
}));
</script>

<template>
  <div
    data-testid="job-log-view"
    class="relative flex min-h-0 flex-1 flex-col"
  >
    <div
      v-bind="containerProps"
      role="log"
      aria-live="off"
      tabindex="0"
      data-testid="job-log"
      :aria-label="t('forge.log.label', { job: name })"
      :data-follow="follow"
      class="min-h-0 flex-1 overflow-auto bg-(--d-bg) pt-2 pb-6 font-mono text-12 outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
      @scroll.passive="onScroll"
    >
      <div v-bind="wrapperProps">
        <div
          v-for="item in shown"
          :key="item.index"
          data-testid="job-log-row"
          :data-line="item.row.line"
          :data-provisional="item.provisional || undefined"
          :data-level="item.row.level"
          class="flex min-w-max items-center pe-4 hover:bg-[color-mix(in_srgb,var(--d-hover)_60%,transparent)]"
          :class="arrivedFrom !== null && item.index >= arrivedFrom ? 'd-row-arrive' : ''"
          :style="{ height: `${rowPx}px` }"
        >
          <span
            aria-hidden="true"
            class="w-14 shrink-0 pe-2 text-end text-(--d-faint) select-none"
          >{{ item.row.line }}</span>
          <span class="flex w-5 shrink-0 justify-center">
            <Button
              v-if="item.section"
              type="button"
              variant="ghost"
              size="icon"
              data-testid="job-log-fold"
              class="d-press size-5 rounded-5 text-(--d-faint) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)] focus-visible:ring-0 focus-visible:ring-offset-0 [&_svg]:size-3"
              :aria-expanded="!item.section.folded"
              :aria-label="item.section.label"
              @click="setFolded(item.section.id, !item.section.folded)"
            >
              <ChevronRight
                aria-hidden="true"
                class="transition-transform duration-200 ease-out"
                :class="item.section.folded ? '' : 'rotate-90'"
              />
            </Button>
          </span>
          <span
            v-if="timestamps"
            data-testid="job-log-stamp"
            class="w-18 shrink-0 truncate pe-3 text-(--d-faint-text) select-none"
          >{{ item.stamp }}</span>
          <span
            data-testid="job-log-text"
            class="whitespace-pre"
            :class="[item.tone, item.section ? 'font-semibold' : '']"
          ><span
            v-if="item.row.level"
            data-testid="job-log-level"
            class="me-1.5 font-semibold"
          >{{ t(`forge.log.level.${item.row.level}`) }}</span><span
            v-for="(piece, at) in item.pieces"
            :key="at"
            :role="piece.control ? 'img' : undefined"
            :aria-label="piece.control ? t('forge.log.directionControl', { name: piece.control.name, code: piece.control.code }) : undefined"
            :title="piece.control?.code"
            :data-control="piece.control?.code"
            :class="pieceClass(piece)"
            :style="piece.mark || piece.control ? undefined : spanStyle(piece.span)"
          >{{ piece.control ? piece.control.name : piece.text }}</span><span
            v-if="item.section?.duration !== undefined"
            data-testid="job-log-duration"
            class="ms-3 font-normal text-(--d-faint-text)"
          >{{ item.section.duration }}</span><span
            v-if="item.section?.folded"
            data-testid="job-log-folded"
            class="ms-2 rounded-5 bg-(--d-hover) px-1.5 font-normal text-(--d-faint-text)"
          >{{ t('forge.log.foldedLines', { n: item.section.hidden }, item.section.hidden) }}</span></span>
        </div>
      </div>
      <p
        v-if="live"
        data-testid="job-log-running"
        class="flex items-center gap-2 ps-17 pt-2 font-sans text-11.5 text-(--d-faint-text)"
      >
        <span
          aria-hidden="true"
          class="d-pulsing size-1.75 shrink-0 rounded-full bg-(--d-accent)"
        />{{ t('forge.log.running') }}
      </p>
      <p
        v-else-if="tail"
        data-testid="job-log-tail"
        class="ps-17 pt-2 font-sans text-11.5"
        :class="tail.tone"
      >
        {{ tail.text }}
      </p>
    </div>
    <TerminalFind
      v-if="finding"
      ref="findBar"
      :search="search"
      :label="t('forge.log.find')"
      :count-limit="MAX_LOG_MATCHES"
      @close="closeFind"
    />
    <Transition name="t-pop">
      <Button
        v-if="newOutput"
        type="button"
        data-testid="job-log-new-output"
        class="d-press absolute inset-e-5 bottom-4 h-7 gap-1.5 rounded-full bg-(--d-accent) ps-2.5 pe-3 py-0 text-12 font-medium text-(--d-on-accent) shadow-[0_6px_20px_color-mix(in_srgb,var(--d-accent)_35%,transparent)] hover:bg-(--d-accent) hover:brightness-110 focus-visible:ring-1 focus-visible:ring-(--d-on-accent) focus-visible:ring-offset-0 [&_svg]:size-3.5"
        @click="jumpToLatest"
      >
        <ArrowDown aria-hidden="true" />{{ t('forge.log.newOutput') }}
      </Button>
    </Transition>
  </div>
</template>
