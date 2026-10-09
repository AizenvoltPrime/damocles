<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, FilePen, Folder, Replace, ReplaceAll, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { fileIcon } from '../file-icons';
import type { ResultRow } from './search-store';

const props = defineProps<{
  row: ResultRow;
  id: string;
  // the roving tabindex position
  current: boolean;
  // the match last opened
  selected: boolean;
  // CSS px, fixed so the virtual list can place the row
  height: number;
  // replace mode with a replacement typed: matches show the struck match and the inserted text (VS Code's renderElement)
  replacing: boolean;
  replaceMode: boolean;
  showLineNumbers: boolean;
  // search.actionsPosition auto: in a wide results view a match row's actions follow its text instead of the row's end
  inlineActions: boolean;
  // list mode names a file's folder beside it; in tree mode its folder row above does
  showFolder: boolean;
  // the text a replace puts in place of a match row's match
  inserted?: string | undefined;
}>();
const emit = defineEmits<{ activate: [event: MouseEvent]; open: []; replace: []; dismiss: []; menu: [event: MouseEvent]; focus: [] }>();
const { t, locale } = useI18n();

// rem of each level's indent and of the start padding, as the Files tree.
const INDENT_REM = 0.875;
const INDENT_START_REM = 0.5;
// Characters of the line VS Code's aria label keeps past the match's end.
const ARIA_LINE_TAIL = 150;

const path = computed(() => (props.row.kind === 'folder' ? props.row.node.path : props.row.file.relativePath));
const untitled = computed(() => props.row.kind !== 'folder' && props.row.file.untitled);
const name = computed(() => (untitled.value ? path.value : path.value.slice(path.value.lastIndexOf('/') + 1)));
const dir = computed(() => {
  if (untitled.value) return '';
  const slash = path.value.lastIndexOf('/');
  return slash < 0 ? '' : path.value.slice(0, slash);
});
const icon = computed(() => (untitled.value ? { icon: FilePen, color: 'var(--d-muted)' } : fileIcon(name.value)));
const count = computed(() => (props.row.kind === 'folder' ? props.row.node.files.length : props.row.kind === 'file' ? props.row.file.matches.length : 0));
const badgeTitle = computed(() => (props.row.kind === 'folder' ? t('search.filesFound', count.value, { named: { count: count.value } }) : t('search.matchesFound', count.value, { named: { count: count.value } })));

// A match row's preview cut around its match; the text before it is trimmed to its last words so the match stays in view.
const preview = computed(() => {
  if (props.row.kind !== 'match') return undefined;
  const { text, matchStart, matchEnd } = props.row.match.preview;
  const before = text.slice(0, matchStart);
  const lead = before.length > 26 ? `…${before.slice(before.length - 26).trimStart()}` : before.trimStart();
  return { before: lead, match: text.slice(matchStart, matchEnd), after: text.slice(matchEnd) };
});

// VS Code's lineNumber cell: `12:` with search.showLineNumbers, `+2` for a match over more lines.
const extraLines = computed(() => (props.row.kind === 'match' ? props.row.match.range.endLine - props.row.match.range.startLine : 0));
const lineCell = computed(() => {
  if (props.row.kind !== 'match') return '';
  return `${props.showLineNumbers ? `${props.row.match.range.startLine}:` : ''}${extraLines.value > 0 ? `+${extraLines.value}` : ''}`;
});
const lineTitle = computed(() => {
  if (props.row.kind !== 'match') return '';
  const from = props.showLineNumbers ? `${t('search.fromLine', { line: props.row.match.range.startLine })} ` : '';
  return `${from}${extraLines.value > 0 ? `+ ${t('search.moreLines', { count: extraLines.value })}` : ''}`.trim();
});

const label = computed(() => {
  const { row } = props;
  if (row.kind === 'folder') return t('search.folderAria', { count: row.node.count, name: row.node.label });
  if (row.kind === 'file') return t('search.fileAria', { count: row.file.matches.length, name: name.value, folder: dir.value === '' ? '.' : dir.value });
  const { text, matchStart, matchEnd } = row.match.preview;
  const line = text.slice(0, matchEnd + ARIA_LINE_TAIL);
  const found = text.slice(matchStart, matchEnd);
  const column = row.match.range.startColumn;
  if (props.replacing) return t('search.replacePreviewAria', { line, column, match: found, replacement: props.inserted ?? '' });
  return t('search.matchAria', { line, column, match: found });
});

const indent = computed(() => `${INDENT_START_REM + (props.row.level - 1) * INDENT_REM}rem`);
</script>

<template>
  <!-- A virtualized tree row: no shadcn part virtualizes a tree. Its actions stay mounted and only fade, so hover moves nothing. -->
  <div
    :id="id"
    role="treeitem"
    data-testid="search-row"
    :data-row-kind="row.kind"
    :data-path="row.kind === 'folder' ? row.node.path : row.file.relativePath"
    :aria-level="row.level"
    :aria-posinset="row.position"
    :aria-setsize="row.setSize"
    :aria-expanded="row.kind === 'match' ? undefined : row.expanded"
    :aria-selected="selected"
    :aria-label="label"
    :tabindex="current ? 0 : -1"
    :title="row.kind === 'match' ? undefined : path"
    class="search-row group relative flex cursor-pointer items-center gap-1.25 pr-2 outline-none select-none hover:bg-(--d-hover) focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
    :class="selected ? 'bg-(--d-accent-soft) hover:bg-(--d-accent-soft)' : ''"
    :style="{ height: `${height}px`, paddingLeft: indent }"
    @click="emit('activate', $event)"
    @dblclick="row.kind === 'match' && emit('open')"
    @focus="emit('focus')"
    @contextmenu.prevent="emit('menu', $event)"
  >
    <template v-if="row.kind !== 'match'">
      <span class="flex w-3.5 shrink-0 text-(--d-faint)">
        <ChevronRight
          aria-hidden="true"
          class="size-3 transition-transform duration-150 ease-out"
          :class="row.expanded ? 'rotate-90' : ''"
        />
      </span>
      <Folder
        v-if="row.kind === 'folder'"
        aria-hidden="true"
        class="size-3.5 shrink-0 text-(--d-muted)"
      />
      <component
        :is="icon.icon"
        v-else
        aria-hidden="true"
        class="size-3.5 shrink-0"
        :style="{ color: icon.color }"
      />
      <span class="shrink-0 truncate text-12.5 text-(--d-text)">{{ row.kind === 'folder' ? row.node.label : name }}</span>
      <span
        v-if="row.kind === 'file' && showFolder && dir !== ''"
        class="min-w-0 flex-1 truncate text-11 text-(--d-faint-text)"
      >{{ dir }}</span>
      <span
        v-else
        class="flex-1"
      />
      <span
        data-testid="search-row-count"
        :title="badgeTitle"
        class="shrink-0 rounded-full bg-(--d-border2) px-1.5 font-mono text-10.5/4 text-(--d-muted) tabular-nums transition-opacity duration-150 group-focus-within:opacity-0 group-hover:opacity-0"
      >{{ count.toLocaleString(locale) }}</span>
    </template>
    <template v-else-if="preview">
      <span
        v-if="lineCell !== ''"
        data-testid="search-row-line"
        :title="lineTitle"
        class="shrink-0 font-mono text-10.5 text-(--d-faint-text) tabular-nums"
      >{{ lineCell }}</span>
      <span
        class="min-w-0 flex-1 truncate text-12 text-(--d-muted)"
        :class="inlineActions ? '@min-[30rem]/results:flex-initial' : ''"
      >
        <span>{{ preview.before }}</span><template v-if="replacing"><del
          data-testid="search-row-removed"
          class="rounded-xs bg-(--d-del) text-(--d-danger-text) line-through decoration-1"
        >{{ preview.match }}</del><ins
          data-testid="search-row-inserted"
          class="rounded-xs bg-(--d-add) text-(--d-success-text) no-underline"
        >{{ inserted }}</ins></template><mark
          v-else
          data-testid="search-row-match"
          class="rounded-xs bg-(--d-accent-soft) font-semibold text-(--d-accent-text)"
        >{{ preview.match }}</mark><span>{{ preview.after }}</span>
      </span>
    </template>
    <span
      class="absolute inset-y-px right-px flex items-center gap-0.5 bg-(--d-panel) pr-1 pl-1.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:bg-[linear-gradient(var(--d-hover),var(--d-hover))] group-hover:opacity-100"
      :class="inlineActions && row.kind === 'match' ? '@min-[30rem]/results:static @min-[30rem]/results:bg-transparent @min-[30rem]/results:group-hover:bg-none' : ''"
    >
      <Button
        v-if="replaceMode"
        type="button"
        variant="ghost"
        size="icon-sm"
        tabindex="-1"
        data-testid="search-row-replace"
        class="size-5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
        :aria-label="row.kind === 'match' ? t('search.replaceOne') : t('search.replaceAll')"
        :title="row.kind === 'match' ? t('search.replaceOne') : t('search.replaceAll')"
        @click.stop="emit('replace')"
      >
        <Replace
          v-if="row.kind === 'match'"
          aria-hidden="true"
        />
        <ReplaceAll
          v-else
          aria-hidden="true"
        />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        tabindex="-1"
        data-testid="search-row-dismiss"
        class="size-5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
        :aria-label="t('search.dismiss')"
        :title="t('search.dismiss')"
        @click.stop="emit('dismiss')"
      >
        <X aria-hidden="true" />
      </Button>
    </span>
  </div>
</template>
