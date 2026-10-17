<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, reactive, ref, shallowRef, triggerRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { CopyMinus, History } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import type { ScmArtifactsResult, ScmRunRequest } from '../../preload/scm-channels';
import type { DamoclesShellApi, ShellPlatform } from '../../preload/shell-channels';
import SidebarSection from '../components/SidebarSection.vue';
import ArtifactRow from './ArtifactRow.vue';
import ScmStateCard from './ScmStateCard.vue';
import { SCM_STORE } from './scm-store';
import { scmStateCard } from './scm-state';
import { fromNow } from './scm-list';
import { visibleText } from '@shared/visible-text';
import {
  artifactRowCall,
  actionOf,
  branchRowMenu,
  isStashRowAction,
  repositoryRowMenu,
  repositoryStashMenu,
  REPOSITORY_GROUP_ACTIONS,
  stashRowCall,
  stashRowMenu,
  tagRowMenu,
  toOverlayMenu,
  worktreeRowMenu,
  type ArtifactAction,
  type ScmAction,
  type ScmMenuNode,
  type ScmRowCall,
} from './scm-menus';
import {
  buildRepositoryRows,
  expandedGroups,
  isExpandable,
  missingFolderIds,
  typeAheadIndex,
  type GroupList,
  type GroupRowsMemo,
  type RepositoryEntry,
  type RepositoryGroup,
  type RepositoryRow,
} from './repositories-tree';

// The Repositories section (D58): VS Code's Source Control Repositories view with its repository explorer. Every row action
// calls the damocles:scm:* operation Source control's menus call for it.
const props = defineProps<{
  api: DamoclesShellApi;
  projectKey: string | undefined;
  platform: ShellPlatform;
  // the project's expanded row ids as the layout keeps them (AD8)
  expanded: readonly string[] | undefined;
  collapsed: boolean;
  bodySize?: number | undefined;
}>();
const emit = defineEmits<{ toggle: []; expanded: [rows: string[]] }>();
const { t, locale } = useI18n();
const store = inject(SCM_STORE)!;

// rem of every row (the prototype's 24px)
const ROW_REM = 1.5;
// ms between refreshes of the rows' relative times
const AGE_TICK_MS = 60_000;
// ms the list keeps its leave and move transitions armed after a change, past the reveal's stagger and .2s
const ARMED_MS = 600;
// More added and removed rows than this in one change snap into place instead of animating.
const ARM_LIMIT = 24;
// ms a user's expand or collapse, or a live reread, waits for the rows it changes (a group's first read answers later)
const MOTION_WAIT_MS = 2000;
// ms a group's count keeps its bump class, past d-count-bump's .42s
const BUMP_MS = 450;
// Type-ahead keystrokes further apart than this start a new search.
const TYPE_AHEAD_RESET_MS = 500;

const section = ref<InstanceType<typeof SidebarSection> | null>(null);
const treeId = useId();
const helpId = useId();

const view = computed(() => (props.projectKey === undefined ? undefined : store.views.value.get(props.projectKey)));
const ready = computed(() => view.value?.state === 'ready' && view.value.repos.length > 0);
const selectedRepoId = computed(() => view.value?.selectedRepoId ?? null);
const run = (request: ScmRunRequest): Promise<unknown> => store.api.run(request);
const card = computed(() => scmStateCard(view.value, props.projectKey, props.platform, t, { grantTrust: (key) => props.api.grantTrust(key), run }));

// A repository's HEAD as its row describes it: the branch, or the detached commit.
function headOf(repoId: string): string {
  const head = store.snapshots.value.get(repoId)?.head;
  if (!head) return '';
  return head.type === 'detached' ? head.commit.slice(0, 8) : head.name;
}

const sameEntry = (a: RepositoryEntry, b: RepositoryEntry): boolean => a.repoId === b.repoId && a.label === b.label && a.displayPath === b.displayPath && a.head === b.head;
// Every status push of every repository triggers the snapshots; the previous array stays while the entries are the same, so
// the rows are built again only when a repository or its HEAD changed.
const repos = computed<RepositoryEntry[]>((previous) => {
  const next = ready.value && view.value
    ? view.value.repos.map((repo) => ({ repoId: repo.repoId, label: repo.label, displayPath: repo.displayPath, head: headOf(repo.repoId) }))
    : [];
  return previous && previous.length === next.length && next.every((entry, index) => sameEntry(entry, previous[index]!)) ? previous : next;
});
const expandedSet = computed<ReadonlySet<string>>(() => new Set(props.expanded ?? []));

// Each group's rows by repository, read through damocles:scm:artifacts when the group is first expanded (D58: one data source).
const lists = shallowRef(new Map<string, GroupList>());
const listKey = (repoId: string, group: RepositoryGroup): string => `${repoId}\0${group}`;
// lists a change made out of date while their group was hidden; they are read again when it shows
const stale = new Set<string>();
const reads = new Map<string, number>();
let readCount = 0;
const now = ref(Date.now());
const ageTimer = setInterval(() => {
  now.value = Date.now();
}, AGE_TICK_MS);
// One function per minute tick and language, keeping each date's text: a build asks for most dates three times.
const timeOf = computed(() => {
  const at = now.value;
  const language = locale.value;
  const texts = new Map<number, string>();
  return (date: number): string => {
    let text = texts.get(date);
    if (text === undefined) texts.set(date, (text = fromNow(date, at, language)));
    return text;
  };
});
const memo: GroupRowsMemo = new WeakMap();

const rows = computed<RepositoryRow[]>(() => buildRepositoryRows({
  repos: repos.value,
  expanded: expandedSet.value,
  lists: (repoId, group) => lists.value.get(listKey(repoId, group)),
  timeOf: timeOf.value,
  detached: t('repositories.detached'),
  memo,
}));
const rowHeight = (): number => remPx(ROW_REM);
const { list: visibleRows, containerProps, wrapperProps } = useVirtualList(rows, { itemHeight: rowHeight, overscan: 10 });

// Folder rows each ready Branches or Tags list no longer holds, by list key; the next expanded report leaves them out.
const missingFolders = new Map<string, readonly string[]>();

function setList(key: string, list: GroupList | undefined): void {
  if (list === undefined) {
    lists.value.delete(key);
    missingFolders.delete(key);
  } else {
    lists.value.set(key, list);
  }
  triggerRef(lists);
}

function emitExpanded(next: readonly string[]): void {
  const missing = new Set([...missingFolders.values()].flat());
  emit('expanded', next.filter((key) => !missing.has(key)));
}

// A group's count rose or fell live: it bumps for a moment.
const bumped = reactive(new Set<string>());
const bumpTimers = new Map<string, ReturnType<typeof setTimeout>>();
const isBumped = (row: RepositoryRow): boolean => row.kind === 'group' && bumped.has(listKey(row.repoId, row.group));
function bump(key: string): void {
  bumped.delete(key);
  clearTimeout(bumpTimers.get(key));
  void nextTick(() => {
    bumped.add(key);
    bumpTimers.set(key, setTimeout(() => bumped.delete(key), BUMP_MS));
  });
}

async function load(repoId: string, group: RepositoryGroup): Promise<void> {
  const key = listKey(repoId, group);
  const previous = lists.value.get(key);
  stale.delete(key);
  const read = ++readCount;
  reads.set(key, read);
  if (!previous) setList(key, { state: 'loading' });
  // A refused invoke shows the failure note too, rather than a group that never stops loading.
  const result = await store.api.artifacts({ repoId, group }).catch((): ScmArtifactsResult => ({ ok: false, reason: 'failed' }));
  if (reads.get(key) !== read) return;
  // closed or removed meanwhile: gone, not read again, until the next view drops its rows
  if (!result.ok && result.reason === 'unknown') {
    setList(key, { state: 'gone' });
    return;
  }
  const next: GroupList = result.ok && result.artifacts.group === group ? { state: 'ready', artifacts: result.artifacts } : { state: 'failed' };
  const repo = repos.value.find((entry) => entry.repoId === repoId);
  if (next.state === 'ready' && repo && (next.artifacts.group === 'branches' || next.artifacts.group === 'tags')) {
    missingFolders.set(key, missingFolderIds(props.expanded ?? [], repo, next.artifacts.group, next.artifacts.rows.map((ref) => ref.name)));
  }
  if (previous?.state === 'ready') {
    awaitMotion('live');
    if (next.state === 'ready' && next.artifacts.rows.length !== previous.artifacts.rows.length) bump(listKey(repoId, group));
  }
  setList(key, next);
}

// The groups shown expanded while the section is open; each is read once, and again after a change made it stale or when it
// shows again after a failed read.
const wanted = computed(() => (props.collapsed ? [] : expandedGroups(rows.value)));
let shown: ReadonlySet<string> = new Set();
watch(wanted, (groups) => {
  const previous = shown;
  shown = new Set(groups.map(({ repoId, group }) => listKey(repoId, group)));
  for (const { repoId, group } of groups) {
    const key = listKey(repoId, group);
    const retry = !previous.has(key) && lists.value.get(key)?.state === 'failed';
    if (!lists.value.has(key) || stale.has(key) || retry) void load(repoId, group);
  }
}, { immediate: true });

const stopArtifacts = store.onArtifactsChanged((changed) => {
  const shown = new Set(wanted.value.map(({ repoId, group }) => listKey(repoId, group)));
  for (const group of changed.groups) {
    if (group === 'remoteBranches') continue;
    const key = listKey(changed.repoId, group);
    if (!lists.value.has(key)) continue;
    if (shown.has(key)) void load(changed.repoId, group);
    else stale.add(key);
  }
});

// A closed or removed repository's lists go with it.
watch(() => new Set((view.value?.repos ?? []).map((repo) => repo.repoId)), (open) => {
  for (const key of [...lists.value.keys()]) if (!open.has(key.slice(0, key.indexOf('\0')))) setList(key, undefined);
});

function setExpanded(row: RepositoryRow, expanded: boolean): void {
  if (!isExpandable(row) || row.expanded === expanded) return;
  awaitMotion(expanded ? 'reveal' : 'toggle');
  const rest = (props.expanded ?? []).filter((key) => key !== row.key);
  emitExpanded(expanded ? [...rest, row.key] : rest);
}

function collapseAll(): void {
  if ((props.expanded ?? []).length === 0) return;
  awaitMotion('toggle');
  emitExpanded([]);
}

// Motion: a row animates only for a change the user made or watched, never for one a scroll mounts or a project switch brings.
const armed = ref(false);
const arriving = reactive(new Map<string, { readonly cls: string; readonly index: number }>());
let armTimer: ReturnType<typeof setTimeout> | undefined;
let motion: { readonly kind: 'reveal' | 'toggle' | 'live'; readonly until: number } | undefined;
let seenKeys: ReadonlySet<string> | null = null;
let seenProject: string | undefined;

function awaitMotion(kind: 'reveal' | 'toggle' | 'live'): void {
  // a user's own change wins over a reread landing in the same moment
  if (kind === 'live' && motion && motion.kind !== 'live' && motion.until > Date.now()) return;
  motion = { kind, until: Date.now() + MOTION_WAIT_MS };
}

watch(rows, (list) => {
  const keys = new Set(list.map((row) => row.key));
  const previous = seenProject === props.projectKey ? seenKeys : null;
  seenKeys = keys;
  seenProject = props.projectKey;
  const pending = motion && motion.until > Date.now() ? motion : undefined;
  if (!previous || !pending) return;
  const added = list.filter((row) => !previous.has(row.key));
  const removed = [...previous].filter((key) => !keys.has(key)).length;
  // the expanded group's first read is still under way: its rows come with the next change
  if (added.length + removed === 0) return;
  motion = undefined;
  const small = added.length + removed <= ARM_LIMIT;
  if (!small && pending.kind !== 'reveal') return;
  // A big reveal tucks in its first rows only and leaves the list unarmed, so a scroll right after it keeps no leaving rows.
  armed.value = small;
  added.slice(0, ARM_LIMIT).forEach((row, index) => arriving.set(row.key, pending.kind === 'live' ? { cls: 'd-row-drop', index: 0 } : { cls: 'd-row-reveal', index }));
  clearTimeout(armTimer);
  armTimer = setTimeout(() => {
    armed.value = false;
    arriving.clear();
  }, ARMED_MS);
});

// One selection (D58): main's selected repository per project, which a row's click sets and Source control's picker moves.
const selectedKey = ref<string | null>(null);
const focusedKey = ref<string | null>(null);
watch(() => props.projectKey, () => {
  selectedKey.value = null;
  focusedKey.value = null;
});
// Another repository selected elsewhere moves the selection to its row, as VS Code's updateTreeSelection does.
watch(selectedRepoId, (id) => {
  const row = rows.value.find((candidate) => candidate.key === selectedKey.value);
  if (row && row.repoId === id) return;
  selectedKey.value = id === null ? null : rows.value.find((candidate) => candidate.kind === 'repo' && candidate.repoId === id)?.key ?? null;
});
const highlightedIndex = computed(() => {
  const index = rows.value.findIndex((row) => row.key === selectedKey.value);
  if (index >= 0 && rows.value[index]!.repoId === selectedRepoId.value) return index;
  return rows.value.findIndex((row) => row.kind === 'repo' && row.repoId === selectedRepoId.value);
});
const highlightedKey = computed(() => rows.value[highlightedIndex.value]?.key ?? null);
// The highlight slides only when the selection moves; a row above it expanding or collapsing moves it at once.
const sliding = ref(false);
let slideTimer: ReturnType<typeof setTimeout> | undefined;
watch(highlightedKey, (next, previous) => {
  sliding.value = next !== null && previous !== null;
  clearTimeout(slideTimer);
  slideTimer = setTimeout(() => {
    sliding.value = false;
  }, 260);
});
const indicatorStyle = computed(() => ({
  height: `${remPx(ROW_REM)}px`,
  transform: `translateY(${highlightedIndex.value * remPx(ROW_REM)}px)`,
  transition: sliding.value ? 'transform .22s var(--ease-out)' : 'none',
}));

async function select(row: RepositoryRow): Promise<void> {
  if (row.kind === 'note') return;
  selectedKey.value = row.key;
  focusedKey.value = row.key;
  if (props.projectKey !== undefined && row.repoId !== selectedRepoId.value) await store.api.select({ projectKey: props.projectKey, repoId: row.repoId });
  // a stash row opens View Stash, as the artifact's command does
  if (row.kind === 'stash') await call(stashRowCall('viewStash', row.repoId, row.stash));
}

async function call(entry: ScmRowCall | undefined): Promise<void> {
  if (!entry) return;
  await ('run' in entry ? run(entry.run) : store.api.copy(entry.copy));
}

type Anchor = { left: number; top: number; width: number; height: number };
async function showMenu(nodes: readonly ScmMenuNode[], label: string, anchor: Anchor, caption?: string): Promise<ScmAction | undefined> {
  const items = toOverlayMenu(nodes, (key) => t(`scm.${key}`));
  if (items.length === 0) return undefined;
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label,
    anchor: { x: Math.max(0, anchor.left), y: Math.max(0, anchor.top), width: anchor.width, height: anchor.height },
    items,
    ...(caption !== undefined ? { caption } : {}),
  });
  return answer.kind === 'menu' ? actionOf(answer.itemId) : undefined;
}

const STASH_SCOPES = { stash: 'default', stashStaged: 'staged', stashIncludeUntracked: 'includeUntracked' } as const;

// A row's action: a group's create or stash, a repository's close, a stash row's or a ref or worktree row's own.
async function runAction(row: RepositoryRow, action: ScmAction, anchor?: Anchor): Promise<void> {
  const repoId = row.repoId;
  switch (row.kind) {
    case 'repo':
      if (action === 'closeRepository' || action === 'closeOtherRepositories') await run({ op: action, repoId });
      return;
    case 'group':
      // the inline Stash opens VS Code's git.repositories.stash submenu and stashes only what the user picks there
      if (action === 'stash' && anchor) {
        const picked = await showMenu(repositoryStashMenu(store.capabilities.value.stashStaged), t('repositories.stashMenu'), anchor);
        if (picked) await runAction(row, picked);
        return;
      }
      if (action === 'createBranch') await run({ op: 'createBranch', repoId, from: false });
      else if (action === 'createTag') await run({ op: 'createTag', repoId });
      else if (action === 'createWorktree') await run({ op: 'createWorktree', repoId });
      else if (Object.hasOwn(STASH_SCOPES, action)) await run({ op: 'stash', repoId, scope: STASH_SCOPES[action as keyof typeof STASH_SCOPES] });
      return;
    case 'stash':
      if (isStashRowAction(action)) await call(stashRowCall(action, repoId, row.stash));
      return;
    case 'worktree':
      if (action === 'newChatInWorktree') {
        const target = row.worktree.newChatIn;
        // a fresh object: a row can be a reactive proxy, which the context bridge cannot clone
        if (target) await props.api.newChatInWorktree({ projectKey: target.projectKey, worktreeId: target.worktreeId });
        return;
      }
      await call(artifactRowCall(action as ArtifactAction, repoId, row));
      return;
    case 'branch':
    case 'tag':
      await call(artifactRowCall(action as ArtifactAction, repoId, row));
      return;
    default:
  }
}

// The inline Stash on the Stashes group opens its menu at the button; every other inline action runs at once.
function onInline(row: RepositoryRow, action: ScmAction, rect: DOMRect): void {
  focusedKey.value = row.key;
  void runAction(row, action, row.kind === 'group' && row.group === 'stashes' ? rect : undefined);
}

const groupMenu = (group: RepositoryGroup): ScmMenuNode[] => {
  if (group === 'stashes') return repositoryStashMenu(store.capabilities.value.stashStaged);
  const entry = REPOSITORY_GROUP_ACTIONS[group];
  return [{ action: entry.action, label: entry.label, icon: entry.icon }];
};

function menuOf(row: RepositoryRow): readonly ScmMenuNode[] {
  switch (row.kind) {
    case 'repo': return repositoryRowMenu(repos.value.length);
    case 'group': return groupMenu(row.group);
    case 'branch': return branchRowMenu(row.branch);
    case 'tag': return tagRowMenu(row.tag);
    case 'stash': return stashRowMenu(row.stash);
    case 'worktree': return worktreeRowMenu(row.worktree);
    default: return [];
  }
}

const rowName = (row: RepositoryRow): string => {
  if (row.kind === 'repo') return visibleText(row.repo.label);
  if (row.kind === 'group') return t(`repositories.group.${row.group}`);
  if (row.kind === 'branch') return visibleText(row.branch.name);
  if (row.kind === 'tag') return visibleText(row.tag.name);
  if (row.kind === 'stash') return `stash@{${row.stash.index}}`;
  if (row.kind === 'worktree') return visibleText(row.worktree.name);
  return '';
};

async function openRowMenu(row: RepositoryRow, anchor: Anchor | undefined): Promise<void> {
  const nodes = menuOf(row);
  if (!anchor || nodes.length === 0) return;
  focusedKey.value = row.key;
  const caption = row.kind === 'stash' ? `stash@{${row.stash.index}}: ${visibleText(row.stash.description)}` : row.kind === 'worktree' ? visibleText(row.worktree.path) : undefined;
  const action = await showMenu(nodes, t('repositories.rowMenu', { name: rowName(row) }), anchor, caption);
  if (action) await runAction(row, action);
}

const pointAnchor = (event: MouseEvent): Anchor => ({ left: event.clientX, top: event.clientY, width: 0, height: 0 });

// The keyboard: a tree with roving tabindex over the flattened rows.
const focusedIndex = computed(() => {
  const index = rows.value.findIndex((row) => row.key === focusedKey.value);
  if (index >= 0) return index;
  return Math.max(0, highlightedIndex.value);
});
// Row ids are JSON, which no attribute selector needs to quote: the rendered rows are few, so they are compared directly.
const rowElement = (key: string): HTMLElement | null =>
  [...(containerProps.ref.value?.querySelectorAll<HTMLElement>('[data-row-key]') ?? [])].find((element) => element.dataset['rowKey'] === key) ?? null;

function revealIndex(index: number): void {
  const container = containerProps.ref.value;
  if (!container || index < 0) return;
  const height = remPx(ROW_REM);
  const top = index * height;
  if (top < container.scrollTop) container.scrollTop = top;
  else if (top + height > container.scrollTop + container.clientHeight) container.scrollTop = top + height - container.clientHeight;
}

async function focusRow(index: number): Promise<void> {
  const clamped = Math.min(Math.max(index, 0), rows.value.length - 1);
  const row = rows.value[clamped];
  if (!row) return;
  focusedKey.value = row.key;
  revealIndex(clamped);
  await nextTick();
  rowElement(row.key)?.focus({ preventScroll: true });
}

// A focused row the list scrolls out of view unmounts; the tree keeps focus so the keys still reach it.
watch(visibleRows, (list) => {
  const container = containerProps.ref.value;
  const key = focusedKey.value;
  if (!container || key === null || !container.contains(document.activeElement) || document.activeElement === container) return;
  if (!list.some(({ data }) => data.key === key)) container.focus({ preventScroll: true });
});

function parentIndex(index: number): number {
  const level = rows.value[index]?.level ?? 1;
  for (let candidate = index - 1; candidate >= 0; candidate--) if (rows.value[candidate]!.level < level) return candidate;
  return index;
}

let typed = '';
let typedAt = 0;
const rowLabel = (row: RepositoryRow): string => (row.kind === 'branch' || row.kind === 'tag' || row.kind === 'stash' || row.kind === 'worktree' || row.kind === 'folder' ? row.label : rowName(row));

function onKeydown(event: KeyboardEvent): void {
  const index = focusedIndex.value;
  const row = rows.value[index];
  if (!row || event.ctrlKey || event.metaKey || event.altKey) return;
  const page = Math.max(1, Math.floor((containerProps.ref.value?.clientHeight ?? 0) / remPx(ROW_REM)) - 1);
  const printable = event.key.length === 1 && event.key !== ' ';
  if (!printable) typed = '';
  switch (event.key) {
    case 'ArrowDown': void focusRow(index + 1); break;
    case 'ArrowUp': void focusRow(index - 1); break;
    case 'PageDown': void focusRow(index + page); break;
    case 'PageUp': void focusRow(index - page); break;
    case 'Home': void focusRow(0); break;
    case 'End': void focusRow(rows.value.length - 1); break;
    case 'ArrowRight':
      if (!isExpandable(row)) return;
      if (!row.expanded) setExpanded(row, true);
      else void focusRow(index + 1);
      break;
    case 'ArrowLeft':
      if (isExpandable(row) && row.expanded) setExpanded(row, false);
      else void focusRow(parentIndex(index));
      break;
    // Enter selects the row and opens it (a stash's View Stash, a group's or folder's children); Space selects or toggles.
    case 'Enter':
      void select(row);
      if (isExpandable(row)) setExpanded(row, !row.expanded);
      break;
    case ' ':
      if (isExpandable(row)) setExpanded(row, !row.expanded);
      else void select(row);
      break;
    case 'ContextMenu': void openRowMenu(row, rowElement(row.key)?.getBoundingClientRect()); break;
    case 'F10':
      if (!event.shiftKey) return;
      void openRowMenu(row, rowElement(row.key)?.getBoundingClientRect());
      break;
    default: {
      if (!printable) return;
      const at = Date.now();
      typed = at - typedAt > TYPE_AHEAD_RESET_MS ? event.key : typed + event.key;
      typedAt = at;
      const match = typeAheadIndex(rows.value.map(rowLabel), index, typed);
      if (match !== undefined) void focusRow(match);
    }
  }
  event.preventDefault();
}

const reopenOpen = ref(false);
async function reopenClosed(): Promise<void> {
  const key = props.projectKey;
  if (key === undefined) return;
  reopenOpen.value = true;
  const asked = run({ op: 'reopenClosed', projectKey: key });
  try {
    await (section.value ? section.value.holdActions(asked) : asked);
  } finally {
    reopenOpen.value = false;
  }
}

onBeforeUnmount(() => {
  stopArtifacts();
  clearTimeout(armTimer);
  clearTimeout(slideTimer);
  clearInterval(ageTimer);
  for (const timer of bumpTimers.values()) clearTimeout(timer);
});

const toolbarButton = 'size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25';
</script>

<template>
  <SidebarSection
    ref="section"
    section="repos"
    :count="ready ? repos.length : undefined"
    :collapsed="collapsed"
    :body-size="bodySize"
    data-testid="repositories-section"
    @toggle="emit('toggle')"
  >
    <template
      v-if="(view?.closedCount ?? 0) > 0 || ready"
      #actions
    >
      <Transition name="t-badge">
        <Button
          v-if="(view?.closedCount ?? 0) > 0"
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="repositories-reopen-closed"
          :aria-busy="reopenOpen || undefined"
          :class="toolbarButton"
          :aria-label="t('scm.action.reopenClosed')"
          :title="t('scm.action.reopenClosed')"
          @click="reopenClosed"
        >
          <History aria-hidden="true" />
        </Button>
      </Transition>
      <Button
        v-if="ready"
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="repositories-collapse-all"
        :class="toolbarButton"
        :aria-label="t('repositories.collapseAll')"
        :title="t('repositories.collapseAll')"
        @click="collapseAll"
      >
        <CopyMinus aria-hidden="true" />
      </Button>
    </template>

    <p
      v-if="projectKey === undefined"
      class="px-3 py-2 text-xs text-(--d-faint)"
    >
      {{ t('scm.noProject') }}
    </p>
    <Transition
      name="t-fade"
      mode="out-in"
    >
      <ScmStateCard
        v-if="card"
        :key="card.id"
        :card="card"
      />
      <div
        v-else-if="ready"
        :key="'tree'"
        class="flex min-h-0 flex-1 flex-col"
      >
        <!-- A virtualized tree (repositories, groups, folders and items flattened, roving tabindex); no shadcn part virtualizes a tree. -->
        <div
          v-bind="containerProps"
          :id="treeId"
          role="tree"
          tabindex="-1"
          data-testid="repositories-tree"
          :aria-label="t('repositories.treeLabel')"
          :aria-describedby="helpId"
          class="relative min-h-0 flex-1 overflow-x-hidden px-1.5 pb-2 outline-none"
          @keydown="onKeydown"
        >
          <!-- One highlight that slides between rows as the selection moves (plan section 7, Moving selection). -->
          <div
            v-if="highlightedIndex >= 0"
            aria-hidden="true"
            data-testid="repositories-selection"
            class="pointer-events-none absolute inset-x-1.5 top-0 rounded-6 bg-(--d-accent-soft)"
            :style="indicatorStyle"
          />
          <div v-bind="wrapperProps">
            <!-- css off unless armed: a CSS-mode leave keeps a row a scroll unmounted in the DOM, and scroll anchoring then pulls back. -->
            <TransitionGroup
              :name="armed ? 't-row' : 't-row-off'"
              :css="armed"
              tag="div"
              class="relative"
            >
              <div
                v-for="{ data: row, index } in visibleRows"
                :key="row.key"
                role="none"
              >
                <ArtifactRow
                  :id="`${treeId}-${index}`"
                  :row="row"
                  :current="index === focusedIndex"
                  :selected="row.key === highlightedKey"
                  :selected-repo="row.repoId === selectedRepoId"
                  :height="rowHeight()"
                  :arrival="arriving.get(row.key)"
                  :bump="isBumped(row)"
                  :busy="store.snapshots.value.get(row.repoId)?.busy === true"
                  @select="select(row)"
                  @toggle="setExpanded(row, !(isExpandable(row) && row.expanded))"
                  @focus="focusedKey = row.key"
                  @action="(action, rect) => onInline(row, action, rect)"
                  @menu="openRowMenu(row, pointAnchor($event))"
                />
              </div>
            </TransitionGroup>
          </div>
        </div>
        <p
          :id="helpId"
          class="sr-only"
        >
          {{ t('repositories.keyboardHelp') }}
        </p>
      </div>
    </Transition>
  </SidebarSection>
</template>
