<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, FileSymlink, Minus, Plus, Undo2 } from 'lucide-vue-next';
import type { Component } from 'vue';
import { Button } from '@/components/ui/button';
import FileIcon from '../components/FileIcon.vue';
import { rowActions, type RowInlineAction } from './scm-menus';
import type { ScmRow } from './scm-list';
import StatusLetter from './StatusLetter.vue';
import { visibleText } from '@shared/visible-text';

type ItemRow = Extract<ScmRow, { kind: 'change' | 'folder' }>;

const props = defineProps<{
  row: ItemRow;
  id: string;
  // the roving tabindex position
  current: boolean;
  // the change last opened from this view
  selected: boolean;
  // CSS px, fixed so the virtual list can place the row
  height: number;
  viewMode: 'list' | 'tree';
  // the change's status text (the letter's title), localized by the section
  statusText: string;
  // the entrance class of a row that arrived live (stage, discard, an edit), never one mounted by scroll
  arrival?: string | undefined;
  busy: boolean;
}>();
const emit = defineEmits<{ activate: []; action: [action: RowInlineAction['action']]; menu: [event: MouseEvent]; focus: []; dragstart: [event: DragEvent] }>();
const { t } = useI18n();

// rem: the list's start padding, each tree level's indent, and a file row's extra indent past its folder's chevron.
const START_REM = 0.375;
const LEVEL_REM = 0.75;
const FILE_IN_TREE_REM = 1.0625;

const ACTION_ICONS: Readonly<Record<RowInlineAction['icon'], Component>> = { 'file-symlink': FileSymlink, plus: Plus, minus: Minus, 'undo-2': Undo2 };

const indent = computed(() => {
  const depth = props.row.level - 2;
  if (props.viewMode === 'list') return `${START_REM}rem`;
  return `${START_REM + depth * LEVEL_REM + (props.row.kind === 'change' ? FILE_IN_TREE_REM : 0)}rem`;
});
const change = computed(() => (props.row.kind === 'change' ? props.row.change : undefined));
const name = computed(() => visibleText(props.row.name));
const actions = computed(() => rowActions(props.row.group));
const title = computed(() => {
  const current = change.value;
  if (!current) return visibleText(props.row.kind === 'folder' ? props.row.path : '');
  const path = visibleText(current.path);
  const renamed = current.originalPath === undefined ? path : `${visibleText(current.originalPath)} → ${path}`;
  return `${renamed} • ${props.statusText}`;
});
</script>

<template>
  <div
    :id="id"
    role="treeitem"
    :data-row-key="row.key"
    :data-testid="row.kind === 'change' ? 'scm-change' : 'scm-folder'"
    :data-group="row.group"
    :data-path="row.kind === 'change' ? row.change.path : row.path"
    :data-letter="change?.letter"
    :aria-level="row.level"
    :aria-posinset="row.position"
    :aria-setsize="row.setSize"
    :aria-expanded="row.kind === 'folder' ? row.expanded : undefined"
    :aria-selected="selected"
    :aria-label="row.kind === 'change' ? t('scm.rowAria', { name, status: statusText, path: visibleText(row.change.path) }) : t('scm.folderAria', { name, count: row.count })"
    :tabindex="current ? 0 : -1"
    :title="title"
    :draggable="row.kind === 'change'"
    class="scm-row group/row flex cursor-pointer items-center gap-1.75 rounded-6 pr-1 outline-none select-none hover:bg-(--d-hover) focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
    :class="[selected ? 'bg-(--d-accent-soft) hover:bg-(--d-accent-soft)' : '', arrival ?? '']"
    :style="{ height: `${height}px`, paddingLeft: indent }"
    @click="emit('activate')"
    @focus="emit('focus')"
    @contextmenu.prevent="emit('menu', $event)"
    @dragstart="emit('dragstart', $event)"
  >
    <ChevronRight
      v-if="row.kind === 'folder'"
      aria-hidden="true"
      class="size-2.75 shrink-0 text-(--d-faint) transition-transform duration-150 ease-out"
      :class="row.expanded ? 'rotate-90' : ''"
    />
    <FileIcon
      :path="row.kind === 'folder' ? row.path : change?.path ?? row.name"
      :directory="row.kind === 'folder'"
      :open="row.kind === 'folder' && row.expanded"
      class="size-3.25 shrink-0"
    />
    <span
      class="min-w-0 shrink truncate text-12.5"
      :class="[change?.strike ? 'line-through' : '', row.kind === 'folder' ? 'text-(--d-muted)' : '']"
    >{{ name }}</span>
    <span
      v-if="row.kind === 'change' && row.dir !== ''"
      class="min-w-0 flex-1 truncate text-11"
      :class="selected ? 'text-(--d-faint-text)' : 'text-(--d-faint) group-hover/row:text-(--d-faint-text)'"
    >{{ visibleText(row.dir) }}</span>
    <span
      v-else
      class="flex-1"
    />
    <span
      v-if="row.kind === 'folder'"
      class="shrink-0 pr-1 font-mono text-10 text-(--d-faint)"
    >{{ row.count }}</span>
    <!-- Inline actions take no space until the row is hovered, focused or selected, as in VS Code; the menu reaches them by keyboard.
         A selected row's stay shown, so scrolling it back into view replays nothing. -->
    <span
      v-if="row.kind === 'change'"
      class="shrink-0 items-center gap-px group-focus-within/row:flex group-hover/row:flex"
      :class="selected ? 'flex' : 'd-actions-in hidden'"
    >
      <Button
        v-for="action in actions"
        :key="action.action"
        type="button"
        variant="ghost"
        size="icon-sm"
        tabindex="-1"
        :data-testid="`scm-row-${action.action}`"
        class="size-5 rounded-5 text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3"
        :disabled="busy && action.action !== 'openFile'"
        :aria-label="t(`scm.action.${action.label}`)"
        :title="t(`scm.action.${action.label}`)"
        @click.stop="emit('action', action.action)"
      >
        <component
          :is="ACTION_ICONS[action.icon]"
          aria-hidden="true"
        />
      </Button>
    </span>
    <StatusLetter
      v-if="change"
      :letter="change.letter"
      :tone="change.tone"
      :title="statusText"
      letter-test-id="scm-letter"
    />
  </div>
</template>
