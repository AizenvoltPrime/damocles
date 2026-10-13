<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { FileSymlink, FileX2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import SlidingIndicator from '@/components/SlidingIndicator.vue';
import { buildFileDiff, type DiffLine, type FileDiff } from '@/utils/parseUnifiedDiff';
import type { ScmChange, ScmChangesTab } from '../../preload/scm-channels';
import type { ShellEditorTab } from '../../preload/shell-channels';
import { fileIcon } from '../file-icons';
import { SCM_STORE } from '../scm/scm-store';
import { TONE_TEXT, visibleText } from '../scm/scm-list';

// The multi-file diff tab: a group's changes beside one file's unified diff, for whatever `source` main names.
const props = defineProps<{ tab: ShellEditorTab & { changes: ScmChangesTab } }>();
const { t } = useI18n();
const store = inject(SCM_STORE)!;

// rem of a file row (the prototype's 24px) and of a diff line.
const ENTRY_REM = 1.5;
const LINE_REM = 1.25;
// ms a diff may take before its loading bar shows, so a fast one never flickers it
const LOADING_BAR_DELAY_MS = 150;

type Shown =
  | { readonly kind: 'diff'; readonly diff: FileDiff }
  | { readonly kind: 'binary' | 'tooLarge' | 'missing' | 'unreadable' };

const listId = useId();
const entries = computed(() => props.tab.changes.entries);
const selectedPath = ref<string | undefined>(entries.value[0]?.path);
const selectedIndex = computed(() => entries.value.findIndex((entry) => entry.path === selectedPath.value));
const selected = computed<ScmChange | undefined>(() => entries.value[selectedIndex.value]);
// the diff on screen and the path it belongs to; the old one stays until the next arrives
const shown = shallowRef<{ path: string; value: Shown } | null>(null);
const loading = ref(false);
const loadingBar = ref(false);
let serial = 0;
let barTimer: ReturnType<typeof setTimeout> | undefined;

const { list: visibleEntries, containerProps, wrapperProps } = useVirtualList(entries, { itemHeight: () => remPx(ENTRY_REM), overscan: 8 });
const lineList = computed(() => (shown.value?.value.kind === 'diff' ? shown.value.value.diff.lines : []));
const { list: visibleLines, containerProps: diffContainer, wrapperProps: diffWrapper } = useVirtualList(lineList, { itemHeight: () => remPx(LINE_REM), overscan: 30 });

const wrapper = ref<HTMLElement | null>(null);
const renderedSelected = computed(() => visibleEntries.value.findIndex(({ index }) => index === selectedIndex.value));
const { box, animate } = useSlidingIndicator(wrapper, '[data-changes-entry]', renderedSelected);

// A file that left the list (staged, discarded) hands the selection to the one now in its place.
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
  barTimer = setTimeout(() => {
    if (asked === serial) loadingBar.value = true;
  }, LOADING_BAR_DELAY_MS);
  try {
    const result = await store.api.fileDiff({ repoId: props.tab.changes.repoId, source: props.tab.changes.source, path });
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
    shown.value = { path, value };
    if (!samePath) diffContainer.ref.value?.scrollTo({ top: 0 });
  } catch {
    // A failed read must not leave the previous file's diff under this file's name.
    if (asked === serial) shown.value = { path, value: { kind: 'unreadable' } };
  } finally {
    if (asked === serial) {
      clearTimeout(barTimer);
      loading.value = false;
      loadingBar.value = false;
    }
  }
}

// Main keeps the entries current while the tab is open; only a change of the selected entry reloads its diff, since every
// editor state push brings new arrays of the same entries.
const selectedState = computed(() => (selected.value ? JSON.stringify(selected.value) : undefined));
watch([selectedPath, selectedState], ([path]) => void load(path), { immediate: true });
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

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const statusText = (entry: ScmChange): string => t(`scm.status.${entry.status}`);
const stats = computed(() => (shown.value?.value.kind === 'diff' ? shown.value.value.diff.stats : undefined));
const empty = computed(() => (shown.value?.value.kind === 'diff' ? shown.value.value.diff.empty : undefined));

const lineClass = (line: DiffLine): string =>
  line.type === 'addition' ? 'bg-(--d-add)' : line.type === 'deletion' ? 'bg-(--d-del)' : line.type === 'gap' ? 'text-(--d-faint-text) bg-(--d-panel)' : '';
// Faint text on an add or del row takes its -text shade (D48).
const numberClass = (line: DiffLine): string => (line.type === 'addition' || line.type === 'deletion' ? 'text-(--d-faint-text)' : 'text-(--d-faint)');
const sign = (line: DiffLine): string => (line.type === 'addition' ? '+' : line.type === 'deletion' ? '−' : '');
</script>

<template>
  <div
    data-testid="changes-tab"
    :data-source="tab.changes.source.kind"
    class="absolute inset-0 flex min-h-0 flex-col"
  >
    <div class="flex h-8 shrink-0 items-center gap-2 border-b border-(--d-border) bg-(--d-bg) px-3 text-11.5 whitespace-nowrap text-(--d-faint)">
      <span class="truncate text-(--d-text)">{{ tab.title }}</span>
      <span aria-hidden="true">·</span>
      <span data-testid="changes-count">{{ t('changesTab.files', entries.length, { named: { count: entries.length } }) }}</span>
    </div>
    <div class="flex min-h-0 flex-1">
      <!-- A virtualized listbox of the files, with the sliding selection; no shadcn part virtualizes a list. -->
      <div
        v-bind="containerProps"
        :id="listId"
        role="listbox"
        tabindex="-1"
        data-testid="changes-list"
        :aria-label="t('changesTab.listLabel')"
        class="w-55 shrink-0 overflow-x-hidden border-r border-(--d-border) bg-(--d-panel) p-1 outline-none"
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
            :title="`${visibleText(entry.path)} • ${statusText(entry)}`"
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
              class="shrink-0 truncate"
              :class="entry.strike ? 'line-through' : ''"
            >{{ visibleText(nameOf(entry.path)) }}</span>
            <span
              class="min-w-0 flex-1 truncate text-11"
              :class="index === selectedIndex ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
            >{{ visibleText(dirOf(entry.path)) }}</span>
            <span
              class="w-3 shrink-0 text-center font-mono text-10.5 font-bold"
              :style="{ color: TONE_TEXT[entry.tone] }"
            >{{ entry.letter }}</span>
          </div>
        </div>
      </div>

      <div class="relative flex min-w-0 flex-1 flex-col">
        <div
          v-if="selected"
          class="relative flex h-7.5 shrink-0 items-center gap-1.75 border-b border-(--d-border) bg-(--d-panel) pr-1.5 pl-3 text-11.5"
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
          <span class="shrink-0 text-(--d-faint)">{{ statusText(selected) }}</span>
          <span
            v-if="stats"
            class="shrink-0 font-mono"
          ><span class="text-(--d-success-text)">+{{ stats.added }}</span> <span class="text-(--d-danger-text)">−{{ stats.removed }}</span></span>
          <span class="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="changes-open-file"
            class="size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
            :aria-label="t('scm.action.openFile')"
            :title="t('scm.action.openFile')"
            @click="store.api.run({ op: 'openFile', repoId: tab.changes.repoId, path: selected.path })"
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
          class="pane-empty d-fade-in flex flex-1 items-center justify-center p-6 text-12.5 text-(--d-muted)"
        >
          {{ t('changesTab.noFiles') }}
        </div>
        <Transition
          v-else
          name="t-diff"
        >
          <!-- Absolute, so the outgoing diff overlaps the incoming one while it leaves; top-7.5 is the file header's h-7.5. -->
          <div
            v-if="shown"
            :key="shown.path"
            class="absolute inset-x-0 top-7.5 bottom-0 flex flex-col"
          >
            <!-- The diff's lines as text nodes, virtualized; git's text never becomes markup. -->
            <div
              v-if="shown.value.kind === 'diff' && !empty"
              v-bind="diffContainer"
              data-testid="changes-diff"
              class="min-h-0 flex-1 overflow-auto bg-(--d-bg) py-1 font-mono text-xs"
              :aria-busy="loading || undefined"
            >
              <div
                v-bind="diffWrapper"
                class="w-max min-w-full"
              >
                <div
                  v-for="{ data: line, index } in visibleLines"
                  :key="index"
                  data-testid="changes-line"
                  :data-type="line.type"
                  class="flex items-center whitespace-pre"
                  :class="lineClass(line)"
                  :style="{ height: `${remPx(LINE_REM)}px` }"
                >
                  <template v-if="line.type === 'gap'">
                    <span class="px-3 text-11">{{ t('changesTab.hidden', line.hiddenCount ?? 0, { named: { count: line.hiddenCount ?? 0 } }) }}</span>
                  </template>
                  <template v-else-if="line.type === 'noNewline'">
                    <span class="px-3 text-11 text-(--d-faint-text)">{{ t('changesTab.noNewline') }}</span>
                  </template>
                  <template v-else>
                    <span
                      class="w-12 shrink-0 pr-2 text-right select-none"
                      :class="numberClass(line)"
                    >{{ line.oldLineNum ?? '' }}</span>
                    <span
                      class="w-12 shrink-0 pr-2 text-right select-none"
                      :class="numberClass(line)"
                    >{{ line.newLineNum ?? '' }}</span>
                    <span
                      class="w-4 shrink-0 text-center select-none"
                      :class="line.type === 'addition' ? 'text-(--d-success-text)' : line.type === 'deletion' ? 'text-(--d-danger-text)' : ''"
                    >{{ sign(line) }}</span>
                    <span class="pr-4 text-(--d-text)">{{ line.content }}</span>
                  </template>
                </div>
              </div>
            </div>
            <div
              v-else
              data-testid="changes-notice"
              class="pane-empty flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center"
            >
              <span class="flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-panel) text-(--d-faint)">
                <FileX2
                  aria-hidden="true"
                  class="size-5"
                />
              </span>
              <p class="max-w-80 text-12.5 text-(--d-muted)">
                {{ t(`changesTab.notice.${shown.value.kind === 'diff' ? (empty ?? 'noChanges') : shown.value.kind}`) }}
              </p>
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </div>
</template>
