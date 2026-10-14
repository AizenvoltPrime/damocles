<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Archive, ArchiveRestore, ArrowUpRight, Check, ChevronRight, Folder, FolderGit2, FolderTree, GitBranch, Plus, Tag, Target, X } from 'lucide-vue-next';
import type { Component } from 'vue';
import { Button } from '@/components/ui/button';
import { visibleText } from '@shared/visible-text';
import { isExpandable, type RepositoryGroup, type RepositoryRow } from './repositories-tree';
import { REPOSITORY_GROUP_ACTIONS, type ScmAction } from './scm-menus';

// One row of the Repositories section's virtualized tree; custom markup, since no shadcn part virtualizes a tree.
const props = defineProps<{
  row: RepositoryRow;
  id: string;
  // the roving tabindex position
  current: boolean;
  selected: boolean;
  // the row's repository is the one Source control shows
  selectedRepo: boolean;
  // CSS px, fixed so the virtual list can place the row
  height: number;
  // the entrance of a row a user's expand revealed or that arrived live, never of one a scroll mounted
  arrival?: { readonly cls: string; readonly index: number } | undefined;
  // set for a moment after a group's count changed live
  bump?: boolean | undefined;
  busy: boolean;
}>();
const emit = defineEmits<{ select: []; toggle: []; action: [action: ScmAction, anchor: DOMRect]; menu: [event: MouseEvent]; focus: [] }>();
const { t } = useI18n();

const GROUP_ICONS: Readonly<Record<RepositoryGroup, Component>> = { branches: GitBranch, stashes: Archive, tags: Tag, worktrees: FolderTree };
const ACTION_ICONS: Readonly<Record<string, Component>> = { plus: Plus, archive: Archive };

interface Inline {
  readonly action: ScmAction;
  readonly icon: Component;
  readonly label: string;
  readonly title: string;
}

const head = computed(() => (props.row.kind === 'branch' ? props.row.branch.current : props.row.kind === 'tag' ? props.row.tag.current : false));
const icon = computed<Component | undefined>(() => {
  const row = props.row;
  switch (row.kind) {
    case 'repo': return FolderGit2;
    case 'group': return GROUP_ICONS[row.group];
    case 'folder': return Folder;
    case 'branch': return head.value ? Target : GitBranch;
    case 'tag': return head.value ? Target : Tag;
    case 'stash': return Archive;
    case 'worktree': return row.worktree.main ? FolderGit2 : FolderTree;
    default: return undefined;
  }
});
const iconTone = computed(() => {
  if (head.value || (props.row.kind === 'repo' && props.selectedRepo)) return 'text-(--d-accent-text)';
  if (props.row.kind === 'stash') return 'text-(--d-info)';
  return 'text-(--d-muted)';
});

const label = computed(() => {
  const row = props.row;
  if (row.kind === 'repo') return visibleText(row.repo.label);
  if (row.kind === 'group') return t(`repositories.group.${row.group}`);
  if (row.kind === 'note') return row.text === 'failed' ? t('repositories.note.failed') : t(`repositories.note.empty.${row.group}`);
  return visibleText(row.label);
});
const description = computed(() => {
  const row = props.row;
  if (row.kind === 'repo') return visibleText(row.repo.head);
  return row.kind === 'branch' || row.kind === 'tag' || row.kind === 'stash' || row.kind === 'worktree' ? visibleText(row.description) : '';
});
const count = computed(() => (props.row.kind === 'group' ? props.row.count : props.row.kind === 'folder' ? props.row.count : null));
const time = computed(() => (props.row.kind === 'branch' || props.row.kind === 'tag' || props.row.kind === 'stash' ? { text: props.row.time, hidden: props.row.timeHidden } : undefined));

// What Open on a worktree row does (A.5): its tooltip says it.
const openTitle = computed(() => (props.row.kind === 'worktree' ? t(`repositories.open.${props.row.worktree.opens}`) : ''));

// VS Code's inline group of scm/artifactGroup/context and scm/artifact/context, plus the prototype's Close on a repository.
const inline = computed<Inline[]>(() => {
  const row = props.row;
  const action = (name: ScmAction, rowIcon: Component, title?: string): Inline => ({ action: name, icon: rowIcon, label: t(`scm.action.${name}`), title: title ?? t(`scm.action.${name}`) });
  switch (row.kind) {
    case 'repo': return [action('closeRepository', X)];
    case 'group': {
      const entry = REPOSITORY_GROUP_ACTIONS[row.group];
      return [action(entry.action, ACTION_ICONS[entry.icon] ?? Plus)];
    }
    case 'branch':
    case 'tag': return head.value ? [] : [action('checkoutRef', Check)];
    case 'stash': return [action('applyStash', ArchiveRestore)];
    case 'worktree': return [action('openWorktree', ArrowUpRight, openTitle.value)];
    default: return [];
  }
});

const ariaLabel = computed(() => {
  const parts = [label.value, description.value, time.value?.text ?? '', count.value === null ? '' : String(count.value), head.value ? t('repositories.head') : ''];
  return parts.filter((part) => part !== '').join(', ');
});
const tooltip = computed(() => {
  const row = props.row;
  if (row.kind === 'repo') return row.repo.displayPath === '' ? visibleText(row.repo.label) : visibleText(row.repo.displayPath);
  if (row.kind === 'branch') return visibleText(row.branch.name);
  if (row.kind === 'tag') return visibleText(row.tag.name);
  if (row.kind === 'stash') return `stash@{${row.stash.index}}: ${visibleText(row.stash.description)}`;
  if (row.kind === 'worktree') return visibleText(row.worktree.path);
  if (row.kind === 'folder') return visibleText(row.path);
  return undefined;
});
// rem: a level indents by the twistie's width, as VS Code's tree indents
const indent = computed(() => `${0.25 + (props.row.level - 1)}rem`);

function onAction(event: MouseEvent, action: ScmAction): void {
  emit('action', action, (event.currentTarget as HTMLElement).getBoundingClientRect());
}
</script>

<template>
  <div
    :id="id"
    role="treeitem"
    :data-row-key="row.key"
    data-testid="repositories-row"
    :data-kind="row.kind"
    :data-name="row.kind === 'branch' ? row.branch.name : row.kind === 'tag' ? row.tag.name : row.kind === 'group' ? row.group : row.kind === 'folder' ? row.path : row.kind === 'worktree' ? row.worktree.path : row.kind === 'stash' ? row.stash.hash : row.kind === 'repo' ? row.repo.label : undefined"
    :data-head="head || undefined"
    :aria-level="row.level"
    :aria-posinset="row.position"
    :aria-setsize="row.setSize"
    :aria-expanded="isExpandable(row) ? row.expanded : undefined"
    :aria-selected="row.kind === 'note' ? undefined : selected"
    :aria-busy="row.kind === 'group' && row.loading ? true : undefined"
    :aria-label="ariaLabel"
    :tabindex="current ? 0 : -1"
    :title="tooltip"
    class="group/row relative flex items-center gap-1.5 rounded-6 pr-1 outline-none select-none focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
    :class="[row.kind === 'note' ? 'cursor-default' : 'cursor-pointer hover:bg-(--d-hover)', arrival?.cls ?? '']"
    :style="{ height: `${height}px`, paddingLeft: indent, ...(arrival ? { '--reveal-index': String(arrival.index) } : {}) }"
    @click="row.kind !== 'note' && emit('select')"
    @dblclick="isExpandable(row) && emit('toggle')"
    @focus="emit('focus')"
    @contextmenu.prevent="emit('menu', $event)"
  >
    <!-- The twistie expands without selecting, as VS Code's expandOnlyOnTwistieClick tree does; leaves keep its width. -->
    <span
      v-if="isExpandable(row)"
      data-testid="repositories-twistie"
      aria-hidden="true"
      class="flex size-3.5 shrink-0 items-center justify-center text-(--d-faint) hover:text-(--d-text)"
      @click.stop="emit('toggle')"
      @dblclick.stop
    >
      <ChevronRight
        class="size-3 transition-transform duration-200 ease-out"
        :class="row.expanded ? 'rotate-90' : ''"
      />
    </span>
    <span
      v-else
      aria-hidden="true"
      class="w-3.5 shrink-0"
    />
    <span
      v-if="icon"
      class="relative flex size-3.25 shrink-0"
    >
      <Transition name="t-icon">
        <component
          :is="icon"
          :key="head ? 'head' : row.kind"
          aria-hidden="true"
          data-testid="repositories-icon"
          class="size-3.25"
          :class="iconTone"
        />
      </Transition>
    </span>
    <span
      data-testid="repositories-label"
      class="min-w-0 shrink truncate"
      :class="[
        row.kind === 'group' ? 'text-11.5 font-semibold text-(--d-muted)' : 'text-xs',
        row.kind === 'note' ? (row.text === 'failed' ? 'text-(--d-danger-text)' : 'text-(--d-faint)') : '',
        row.kind === 'repo' || head ? 'font-medium' : '',
      ]"
    >{{ label }}</span>
    <span
      v-if="count !== null"
      data-testid="repositories-count"
      class="relative inline-flex shrink-0 font-mono text-10.5 text-(--d-faint) tabular-nums group-hover/row:text-(--d-faint-text)"
      :class="bump ? 'd-count-bump' : ''"
    >
      <Transition
        name="t-swap"
        mode="out-in"
      >
        <span :key="count">{{ count }}</span>
      </Transition>
    </span>
    <span
      data-testid="repositories-description"
      class="min-w-0 flex-1 truncate font-mono text-11 group-hover/row:text-(--d-faint-text)"
      :class="selected ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
    >{{ description }}</span>
    <!-- VS Code's repeated time: a faint rule in its place until the row is hovered. -->
    <span
      v-if="time && time.text !== ''"
      data-testid="repositories-time"
      :data-hidden="time.hidden || undefined"
      class="flex shrink-0 items-center text-10.5 whitespace-nowrap text-(--d-faint) group-hover/row:text-(--d-faint-text)"
      :class="time.hidden ? 'h-3.5 min-w-1.5 border-l border-(--d-border2) group-hover/row:border-l-0 group-focus/row:border-l-0' : ''"
    >
      <span :class="time.hidden ? 'hidden group-hover/row:inline group-focus/row:inline' : ''">{{ time.text }}</span>
    </span>
    <!-- Out of the row's flow until hover or focus, as VS Code's actions bar: revealing them moves no control. -->
    <span
      v-if="inline.length > 0"
      data-testid="repositories-actions"
      class="d-actions-in hidden shrink-0 items-center group-focus-within/row:flex group-hover/row:flex"
    >
      <Button
        v-for="entry in inline"
        :key="entry.action"
        type="button"
        variant="ghost"
        size="icon-sm"
        tabindex="-1"
        :data-testid="`repositories-action-${entry.action}`"
        class="d-press size-5 rounded-5 text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3"
        :disabled="busy && entry.action !== 'openWorktree'"
        :aria-label="entry.label"
        :title="entry.title"
        @click.stop="onAction($event, entry.action)"
        @dblclick.stop
      >
        <component
          :is="entry.icon"
          aria-hidden="true"
        />
      </Button>
    </span>
  </div>
</template>
