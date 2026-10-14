<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, reactive, ref, shallowRef, triggerRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { Check, Ellipsis, List, ListTree, RefreshCw, TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import { FILE_DRAG_MIME, serializeFileDragPayload } from '@shared/file-drag';
import { SCM_STATUS_LIMIT, type ScmChange, type ScmCommitVariant, type ScmGroup, type ScmRepoSnapshot, type ScmArtifactsResult, type ScmRunRequest, type ScmStashArtifact } from '../../preload/scm-channels';
import type { DamoclesShellApi, ShellPlatform } from '../../preload/shell-channels';
import SidebarSection from '../components/SidebarSection.vue';
import { SCM_STORE } from './scm-store';
import { changeCount, changesUnder, flattenChanges, groupKey, STASH_GROUP_KEY, type ScmRow, type StashList } from './scm-list';
import { visibleText } from '@shared/visible-text';
import { actionOf, actionsMenu, COMMIT_VARIANTS, folderMenu, groupActions, groupMenu, isStashRowAction, moreActionsMenu, rowMenu, STASH_GROUP_ACTIONS, stashRowCall, stashRowMenu, toOverlayMenu, type ScmAction, type ScmMenuNode, type ScmSortKey, type ScmViewMode, type StashRowAction } from './scm-menus';
import RepoPicker from './RepoPicker.vue';
import CommitBox from './CommitBox.vue';
import ChangeGroup from './ChangeGroup.vue';
import ChangeRow from './ChangeRow.vue';
import ScmProgress from './ScmProgress.vue';
import SyncButton from './SyncButton.vue';
import BranchButton from './BranchButton.vue';
import StashRow from './StashRow.vue';
import ScmStateCard from './ScmStateCard.vue';
import { scmStateCard } from './scm-state';

const props = defineProps<{
  api: DamoclesShellApi;
  projectKey: string | undefined;
  projectName: string;
  platform: ShellPlatform;
  viewMode: ScmViewMode;
  sortKey: ScmSortKey;
  collapsed: boolean;
  bodySize?: number | undefined;
}>();
const emit = defineEmits<{ toggle: []; expand: []; viewOptions: [patch: { viewMode?: ScmViewMode; sortKey?: ScmSortKey }] }>();
const { t } = useI18n();
const store = inject(SCM_STORE)!;

// rem of a group header (the prototype's 24px) and of a change row (26px).
const GROUP_REM = 1.5;
const ROW_REM = 1.625;
// rem the tree keeps when the section is shorter than its controls: three change rows and its pb-2. The body scrolls instead.
const TREE_MIN_REM = 3 * ROW_REM + 0.5;
// ms a small change keeps the list's leave and move transitions armed, past their .22s
const ARMED_MS = 600;
// More added and removed rows than this in one update snap into place instead of animating (a checkout, a big stage).
const ARM_LIMIT = 20;
// ms between refreshes of the stash rows' ages
const AGE_TICK_MS = 60_000;

const section = ref<InstanceType<typeof SidebarSection> | null>(null);
const treeId = useId();
const helpId = useId();
const commitBox = ref<InstanceType<typeof CommitBox> | null>(null);
const listWrapper = ref<HTMLElement | null>(null);
const body = ref<HTMLElement | null>(null);
const refreshing = ref(false);
// keys of collapsed groups and folders per repository, for the run
const collapsedKeys = shallowRef(new Map<string, Set<string>>());
const focusedKey = ref<string | null>(null);
const selectedKey = ref<string | null>(null);

const view = computed(() => (props.projectKey === undefined ? undefined : store.views.value.get(props.projectKey)));
const repoId = computed(() => view.value?.selectedRepoId ?? undefined);
const snapshot = computed<ScmRepoSnapshot | undefined>(() => (repoId.value === undefined ? undefined : store.snapshots.value.get(repoId.value)));
const repo = computed(() => view.value?.repos.find((each) => each.repoId === repoId.value));
const ready = computed(() => view.value?.state === 'ready' && snapshot.value !== undefined);
const busy = computed(() => snapshot.value?.busy === true);
const committing = computed(() => repoId.value !== undefined && store.committing.value.has(repoId.value));
const amending = computed(() => repoId.value !== undefined && store.amendingIn(repoId.value));
// Main titles the palette's and the menu's commit commands by the selected repository's amend mode.
watch([repoId, amending], ([id, on]) => {
  if (id !== undefined) void store.api.reportAmend({ repoId: id, amending: on });
}, { immediate: true });
const commitLabel = computed(() => t('scm.commit.withShortcut', { label: amending.value ? t('scm.commit.amend') : t('scm.commit.commit'), shortcut: props.platform === 'darwin' ? '⌘Enter' : 'Ctrl+Enter' }));
const untrackedChanges = computed(() => store.settings.value.untrackedChanges);
// VS Code's count badge (scm.countBadge 'all'): every change of every open repository of the project.
const total = computed(() => (view.value?.repos ?? []).reduce((sum, each) => {
  const repoSnapshot = store.snapshots.value.get(each.repoId);
  return sum + (repoSnapshot ? changeCount(repoSnapshot) : 0);
}, 0));

const statusText = (change: ScmChange): string => t(`scm.status.${change.status}`);
const collapsedOf = (id: string | undefined): ReadonlySet<string> => (id === undefined ? new Set() : collapsedKeys.value.get(id) ?? new Set());
// The Stashes group's rows for the shown repository, read through damocles:scm:artifacts and again on its artifactsChanged.
const stashes = shallowRef<StashList>({ state: 'loading' });
let stashRead = 0;
// The list a live reread just produced: the rows update it causes slides new stash rows in and collapses gone ones out. It
// lasts that one flush, so a list no rows update showed (no snapshot yet) never animates a later one.
let liveList: StashList | null = null;
// counts the live rises of the Stashes count, each bumping it once
const stashBumps = ref(0);
const now = ref(Date.now());
const ageTimer = setInterval(() => {
  now.value = Date.now();
}, AGE_TICK_MS);

async function loadStashes(id: string, live: boolean): Promise<void> {
  const read = ++stashRead;
  // A refused invoke shows the failure line too, rather than a group that never stops loading.
  const result = await store.api.artifacts({ repoId: id, group: 'stashes' }).catch((): ScmArtifactsResult => ({ ok: false, reason: 'failed' }));
  if (read !== stashRead || repoId.value !== id) return;
  const previous = stashes.value;
  const next: StashList = result.ok && result.artifacts.group === 'stashes' ? { state: 'ready', rows: result.artifacts.rows } : { state: 'failed' };
  if (live && previous.state === 'ready') {
    liveList = next;
    if (next.state === 'ready' && next.rows.length > previous.rows.length) stashBumps.value++;
  }
  now.value = Date.now();
  stashes.value = next;
  void nextTick(() => {
    if (liveList === next) liveList = null;
  });
}
watch(repoId, (id) => {
  stashRead++;
  stashes.value = { state: 'loading' };
  if (id !== undefined) void loadStashes(id, false);
}, { immediate: true });
const stopArtifacts = store.onArtifactsChanged((changed) => {
  if (changed.repoId === repoId.value && changed.groups.includes('stashes')) void loadStashes(changed.repoId, true);
});
const stashCount = computed(() => (stashes.value.state === 'ready' ? stashes.value.rows.length : null));

const rows = computed<ScmRow[]>(() => (snapshot.value
  ? flattenChanges(snapshot.value, { viewMode: props.viewMode, sortKey: props.sortKey, collapsed: collapsedOf(repoId.value), statusText }, stashes.value)
  : []));
const rowHeight = (row: ScmRow | undefined): number => remPx(row?.kind === 'group' || row?.kind === 'stashGroup' ? GROUP_REM : ROW_REM);
const { list: visibleRows, containerProps, wrapperProps } = useVirtualList(rows, { itemHeight: (index) => rowHeight(rows.value[index]), overscan: 10 });

const branchOf = (id: string): string => {
  const head = store.snapshots.value.get(id)?.head;
  if (!head) return '';
  return visibleText(head.type === 'detached' ? head.commit.slice(0, 8) : head.name);
};

// The list animates a change the user caused or watched, never a row scrolling into view.
const armed = ref(false);
const arriving = reactive(new Map<string, 'd-row-arrive' | 'd-fade-in' | 'd-row-return' | 'd-row-drop'>());
let armTimer: ReturnType<typeof setTimeout> | undefined;
let seenKeys: ReadonlySet<string> | null = null;
// every change's path in the previous list, whatever its group
let seenPaths: ReadonlySet<string> = new Set();
let seenRepo: string | undefined;
// set by a user expand, so the rows it reveals fade in rather than slide
let revealing = false;
// set by a user expand or collapse, which moves stash rows as it moves change rows
let toggling = false;

watch(rows, (list) => {
  const keys = new Set(list.map((row) => row.key));
  const previous = seenRepo === repoId.value ? seenKeys : null;
  const previousPaths = seenPaths;
  seenKeys = keys;
  seenPaths = new Set(list.flatMap((row) => (row.kind === 'change' ? [row.change.path] : [])));
  seenRepo = repoId.value;
  const reveal = revealing;
  const toggled = toggling;
  revealing = false;
  toggling = false;
  const live = liveList !== null && liveList === stashes.value;
  liveList = null;
  if (!previous) return;
  // Stash rows a first read or a repository switch brings in appear in place; a live change or the user's toggle moves them.
  const counts = (key: string): boolean => live || toggled || !isStashRow(key);
  const added = [...keys].filter((key) => !previous.has(key) && counts(key));
  const removed = [...previous].filter((key) => !keys.has(key) && counts(key)).length;
  if (added.length + removed === 0 || added.length + removed > ARM_LIMIT) return;
  armed.value = true;
  // A staged change that was in no group before came back from a commit (Undo Last Commit): the reverse of its leaving.
  const returned = new Set(list.flatMap((row) => (row.kind === 'change' && row.group === 'index' && !previousPaths.has(row.change.path) ? [row.key] : [])));
  for (const key of added) arriving.set(key, reveal ? 'd-fade-in' : isStashRow(key) ? 'd-row-drop' : returned.has(key) ? 'd-row-return' : 'd-row-arrive');
  clearTimeout(armTimer);
  armTimer = setTimeout(() => {
    armed.value = false;
    arriving.clear();
  }, ARMED_MS);
});

function isStashRow(key: string): boolean {
  return key.startsWith('stash:') || key === 'stashes:note';
}

// A repository switch cross-fades the list rather than jumping it.
watch(repoId, () => {
  focusedKey.value = null;
  selectedKey.value = null;
  const element = listWrapper.value;
  if (!element) return;
  element.classList.remove('d-fade-in');
  void element.offsetWidth;
  element.classList.add('d-fade-in');
});

function toggleCollapsed(key: string): void {
  const id = repoId.value;
  if (id === undefined) return;
  const keys = new Set(collapsedOf(id));
  if (!keys.delete(key)) keys.add(key);
  else revealing = true;
  toggling = true;
  collapsedKeys.value.set(id, keys);
  triggerRef(collapsedKeys);
}

const run = (request: ScmRunRequest): Promise<unknown> => store.api.run(request);

async function refresh(): Promise<void> {
  const id = repoId.value;
  if (id === undefined || refreshing.value) return;
  refreshing.value = true;
  try {
    await run({ op: 'refresh', repoId: id });
  } finally {
    refreshing.value = false;
  }
}

function setViewMode(viewMode: ScmViewMode): void {
  emit('viewOptions', { viewMode });
}

// No variant is the box's primary button; no repository is the shown one.
async function commit(variant?: ScmCommitVariant, id?: string): Promise<void> {
  if (props.collapsed) emit('expand');
  await nextTick();
  await commitBox.value?.commit(variant, id);
}

// The paths a change or folder row acts on.
function pathsOf(row: Extract<ScmRow, { kind: 'change' | 'folder' }>): string[] {
  if (row.kind === 'change') return [row.change.path];
  return snapshot.value ? changesUnder(snapshot.value, row.group, row.path).map((change) => change.path) : [];
}

async function runAction(action: ScmAction, target?: { group: ScmGroup; row?: Extract<ScmRow, { kind: 'change' | 'folder' }> }): Promise<void> {
  const id = repoId.value;
  const key = props.projectKey;
  switch (action) {
    case 'viewAsTree': setViewMode('tree'); return;
    case 'viewAsList': setViewMode('list'); return;
    case 'sortByName': emit('viewOptions', { sortKey: 'name' }); return;
    case 'sortByPath': emit('viewOptions', { sortKey: 'path' }); return;
    case 'sortByStatus': emit('viewOptions', { sortKey: 'status' }); return;
    case 'showOutput': await run({ op: 'showOutput' }); return;
    case 'reopenClosed': if (key !== undefined) await run({ op: 'reopenClosed', projectKey: key }); return;
    case 'clone': await run({ op: 'clone', recursive: false }); return;
  }
  if (action in COMMIT_VARIANTS) {
    await commit(COMMIT_VARIANTS[action as keyof typeof COMMIT_VARIANTS]);
    return;
  }
  if (id === undefined) return;
  const row = target?.row;
  const path = row?.kind === 'change' ? row.change.path : undefined;
  switch (action) {
    case 'stageAll': await run({ op: 'stageAll', repoId: id, scope: 'all' }); break;
    case 'stageAllTracked': await run({ op: 'stageAll', repoId: id, scope: 'tracked' }); break;
    case 'stageAllUntracked': await run({ op: 'stageAll', repoId: id, scope: 'untracked' }); break;
    case 'stageAllMerge': await run({ op: 'stageAll', repoId: id, scope: 'merge' }); break;
    case 'unstageAll': await run({ op: 'unstageAll', repoId: id }); break;
    case 'discardAll': await run({ op: 'discardAll', repoId: id, scope: 'all' }); break;
    case 'discardAllTracked': await run({ op: 'discardAll', repoId: id, scope: 'tracked' }); break;
    case 'discardAllUntracked': await run({ op: 'discardAll', repoId: id, scope: 'untracked' }); break;
    case 'openGroupChanges': if (target) await run({ op: 'openGroupChanges', repoId: id, group: target.group }); break;
    case 'closeRepository': await run({ op: 'closeRepository', repoId: id }); break;
    case 'closeOtherRepositories': await run({ op: 'closeOtherRepositories', repoId: id }); break;
    case 'undoLastCommit': await run({ op: 'undoLastCommit', repoId: id }); break;
    case 'restoreCommitTemplate': await run({ op: 'restoreCommitTemplate', repoId: id }); break;
    case 'abortRebase': await run({ op: 'abortOperation', repoId: id }); break;
    case 'sync': await run({ op: 'sync', repoId: id, rebase: false }); break;
    case 'syncRebase': await run({ op: 'sync', repoId: id, rebase: true }); break;
    case 'pull': await run({ op: 'pull', repoId: id, rebase: false }); break;
    case 'pullRebase': await run({ op: 'pull', repoId: id, rebase: true }); break;
    case 'pullFrom': await run({ op: 'pullFrom', repoId: id }); break;
    case 'push': await run({ op: 'push', repoId: id, to: false, force: false, followTags: false }); break;
    case 'pushTo': await run({ op: 'push', repoId: id, to: true, force: false, followTags: false }); break;
    case 'pushForce': await run({ op: 'push', repoId: id, to: false, force: true, followTags: false }); break;
    case 'pushToForce': await run({ op: 'push', repoId: id, to: true, force: true, followTags: false }); break;
    case 'fetch': await run({ op: 'fetch', repoId: id, scope: 'default' }); break;
    case 'fetchPrune': await run({ op: 'fetch', repoId: id, scope: 'prune' }); break;
    case 'fetchAll': await run({ op: 'fetch', repoId: id, scope: 'all' }); break;
    case 'addRemote': await run({ op: 'addRemote', repoId: id }); break;
    case 'removeRemote': await run({ op: 'removeRemote', repoId: id }); break;
    case 'checkout': await run({ op: 'checkout', repoId: id, detached: false }); break;
    case 'merge': await run({ op: 'merge', repoId: id }); break;
    case 'rebase': await run({ op: 'rebase', repoId: id }); break;
    case 'createBranch': await run({ op: 'createBranch', repoId: id, from: false }); break;
    case 'createBranchFrom': await run({ op: 'createBranch', repoId: id, from: true }); break;
    case 'renameBranch': await run({ op: 'renameBranch', repoId: id }); break;
    case 'deleteBranch': await run({ op: 'deleteBranch', repoId: id }); break;
    case 'deleteRemoteBranch': await run({ op: 'deleteRemoteBranch', repoId: id }); break;
    case 'publish': await run({ op: 'publish', repoId: id }); break;
    case 'stash': await run({ op: 'stash', repoId: id, scope: 'default' }); break;
    case 'stashIncludeUntracked': await run({ op: 'stash', repoId: id, scope: 'includeUntracked' }); break;
    case 'stashStaged': await run({ op: 'stash', repoId: id, scope: 'staged' }); break;
    case 'stashApplyLatest': await run({ op: 'stashApply', repoId: id, pop: false, target: 'latest' }); break;
    case 'stashApply': await run({ op: 'stashApply', repoId: id, pop: false, target: 'pick' }); break;
    case 'stashPopLatest': await run({ op: 'stashApply', repoId: id, pop: true, target: 'latest' }); break;
    case 'stashPop': await run({ op: 'stashApply', repoId: id, pop: true, target: 'pick' }); break;
    case 'stashDrop': await run({ op: 'stashDrop', repoId: id, target: 'pick' }); break;
    case 'stashDropAll': await run({ op: 'stashDropAll', repoId: id }); break;
    case 'stashView': await run({ op: 'viewStash', repoId: id, target: 'pick' }); break;
    case 'createTag': await run({ op: 'createTag', repoId: id }); break;
    case 'deleteTag': await run({ op: 'deleteTag', repoId: id }); break;
    case 'deleteRemoteTag': await run({ op: 'deleteRemoteTag', repoId: id }); break;
    case 'pushTags': await run({ op: 'pushTags', repoId: id }); break;
    case 'createWorktree': await run({ op: 'createWorktree', repoId: id }); break;
    case 'deleteWorktree': await run({ op: 'deleteWorktree', repoId: id }); break;
    case 'stashChanges': {
      const paths = row ? pathsOf(row) : [];
      if (paths.length > 0) await run({ op: 'stashChanges', repoId: id, paths });
      break;
    }
    case 'stage':
    case 'unstage':
    case 'discard':
    case 'addToGitignore': {
      const paths = row ? pathsOf(row) : [];
      if (paths.length > 0) await run({ op: action, repoId: id, paths });
      break;
    }
    case 'openChanges': if (path !== undefined && target) await run({ op: 'openChanges', repoId: id, path, group: target.group }); break;
    case 'openFile': if (path !== undefined) await run({ op: 'openFile', repoId: id, path }); break;
    case 'openFileHead': if (path !== undefined) await run({ op: 'openFileHead', repoId: id, path }); break;
    case 'reveal': if (path !== undefined) await run({ op: 'reveal', repoId: id, path }); break;
    case 'mention': if (path !== undefined) await run({ op: 'mention', repoId: id, path }); break;
    case 'copyPath': if (path !== undefined) await store.api.copy({ repoId: id, kind: 'path', value: path }); break;
    case 'copyRelativePath': if (path !== undefined) await store.api.copy({ repoId: id, kind: 'relativePath', value: path }); break;
  }
}

// A stash row's action on that row's stash (D58), the call the Repositories section's stash rows make too.
async function runStashAction(action: StashRowAction, stash: ScmStashArtifact): Promise<void> {
  const id = repoId.value;
  if (id === undefined) return;
  const call = stashRowCall(action, id, stash);
  await ('run' in call ? run(call.run) : store.api.copy(call.copy));
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

// true while More Actions' menu is open: its button reports aria-expanded and the section keeps its title actions shown
const moreOpen = ref(false);

async function openMoreActions(event: MouseEvent): Promise<void> {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  moreOpen.value = true;
  const asked = showMenu(
    moreActionsMenu({
      viewMode: props.viewMode,
      sortKey: props.sortKey,
      untrackedChanges: untrackedChanges.value,
      openRepos: view.value?.repos.length ?? 0,
      closedCount: view.value?.closedCount ?? 0,
      commit: {
        operation: snapshot.value?.operation ?? null,
        hasCommit: (snapshot.value?.commit ?? null) !== null,
        hasTemplate: repoId.value !== undefined && (store.inputs.value.get(repoId.value)?.template ?? null) !== null,
        allowNoVerifyCommit: store.settings.value.allowNoVerifyCommit,
        amending: amending.value,
      },
      remote: {
        hasRemotes: (snapshot.value?.remotes.length ?? 0) > 0,
        allowForcePush: store.settings.value.allowForcePush,
        operation: snapshot.value?.operation ?? null,
      },
      refs: {
        head: snapshot.value?.head?.type ?? null,
        stashStaged: store.capabilities.value.stashStaged,
        stashes: stashCount.value,
      },
    }),
    t('scm.moreActions'),
    rect,
  );
  let action: ScmAction | undefined;
  try {
    action = await (section.value ? section.value.holdActions(asked) : asked);
  } finally {
    moreOpen.value = false;
  }
  if (action) await runAction(action);
}

const pointAnchor = (event: MouseEvent): Anchor => ({ left: event.clientX, top: event.clientY, width: 0, height: 0 });

async function openRowMenu(row: ScmRow, anchor: Anchor | undefined): Promise<void> {
  if (!anchor || row.kind === 'empty' || row.kind === 'stashNote') return;
  focusedKey.value = row.key;
  if (row.kind === 'stashGroup') {
    const action = await showMenu(actionsMenu(STASH_GROUP_ACTIONS), t('scm.groupMenu', { name: t('scm.group.stashes') }), anchor);
    if (action) await runAction(action);
    return;
  }
  if (row.kind === 'stash') {
    const name = `stash@{${row.stash.index}}`;
    const action = await showMenu(stashRowMenu(row.stash), t('scm.rowMenu', { name }), anchor, `${name}: ${visibleText(row.stash.description)}`);
    if (action && isStashRowAction(action)) await runStashAction(action, row.stash);
    return;
  }
  if (row.kind === 'group') {
    const action = await showMenu(row.count === 0 ? [] : groupMenu(row.group, untrackedChanges.value), t('scm.groupMenu', { name: t(`scm.group.${row.group}`) }), anchor);
    if (action) await runAction(action, { group: row.group });
    return;
  }
  const nodes: ScmMenuNode[] = row.kind === 'change' ? rowMenu(row.group, row.change) : folderMenu(row.group);
  const caption = row.kind === 'change' ? visibleText(row.change.path) : visibleText(row.path);
  const action = await showMenu(nodes, t('scm.rowMenu', { name: visibleText(row.name) }), anchor, caption);
  if (action) await runAction(action, { group: row.group, row });
}

// A click opens the change's diff (VS Code's Open Changes on a resource); a folder or group toggles.
function activate(row: ScmRow): void {
  if (row.kind === 'empty' || row.kind === 'stashNote') return;
  focusedKey.value = row.key;
  if (row.kind === 'stashGroup') toggleCollapsed(STASH_GROUP_KEY);
  else if (row.kind === 'stash') void runStashAction('viewStash', row.stash);
  else if (row.kind === 'group') toggleCollapsed(groupKey(row.group));
  else if (row.kind === 'folder') toggleCollapsed(row.key);
  else {
    selectedKey.value = row.key;
    void runAction('openChanges', { group: row.group, row });
  }
}

// Dragging a change carries its project-relative path, as a Files row does; a parent repository's file has none.
function onDragStart(event: DragEvent, row: Extract<ScmRow, { kind: 'change' | 'folder' }>): void {
  const current = repo.value;
  if (row.kind !== 'change' || !event.dataTransfer || props.projectKey === undefined || !current || current.kind === 'parent') {
    event.preventDefault();
    return;
  }
  const relativePath = current.displayPath === '' ? row.change.path : `${current.displayPath}/${row.change.path}`;
  event.dataTransfer.setData(FILE_DRAG_MIME, serializeFileDragPayload({ projectKey: props.projectKey, relativePath }));
  event.dataTransfer.effectAllowed = 'copy';
}

// The keyboard: a tree with roving tabindex over the flattened rows.
const focusedIndex = computed(() => {
  const index = rows.value.findIndex((row) => row.key === focusedKey.value);
  return index >= 0 ? index : 0;
});
const rowElement = (key: string): HTMLElement | null =>
  containerProps.ref.value?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`) ?? null;

function revealIndex(index: number): void {
  const container = containerProps.ref.value;
  if (!container || index < 0) return;
  const top = rows.value.slice(0, index).reduce((sum, row) => sum + rowHeight(row), 0);
  const height = rowHeight(rows.value[index]);
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
  const element = rowElement(row.key);
  if (!element) return;
  element.focus({ preventScroll: true });
  revealInBody(element);
}

// A row the tree shows can still sit past the body's edge while the body is scrolled.
function revealInBody(element: HTMLElement): void {
  const scroller = body.value;
  if (!scroller) return;
  const view = scroller.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  if (box.top < view.top) scroller.scrollTop -= view.top - box.top;
  else if (box.bottom > view.bottom) scroller.scrollTop += box.bottom - view.bottom;
}

// A focused row the list scrolls out of view unmounts; the tree keeps focus so the keys still reach it. This runs before the
// patch, so it reads the rendered window, not the DOM, which still holds the row.
watch(visibleRows, (list) => {
  const container = containerProps.ref.value;
  const key = focusedKey.value;
  if (!container || key === null || !container.contains(document.activeElement) || document.activeElement === container) return;
  if (!list.some(({ data }) => data.key === key)) container.focus({ preventScroll: true });
});

// Focus a progress row's Cancel held as the row ended: the tree's current row, else the section's header.
function reclaimFocus(): void {
  if (ready.value && rows.value.length > 0) void focusRow(focusedIndex.value);
  else (section.value?.$el as HTMLElement | undefined)?.querySelector<HTMLElement>('h2 button')?.focus();
}

function parentIndex(index: number): number {
  const level = rows.value[index]?.level ?? 1;
  for (let candidate = index - 1; candidate >= 0; candidate--) if (rows.value[candidate]!.level < level) return candidate;
  return index;
}

function onKeydown(event: KeyboardEvent): void {
  const index = focusedIndex.value;
  const row = rows.value[index];
  if (!row || event.ctrlKey || event.metaKey || event.altKey) return;
  const page = Math.max(1, Math.floor((containerProps.ref.value?.clientHeight ?? 0) / remPx(ROW_REM)) - 1);
  const expandable = row.kind === 'group' || row.kind === 'folder' || row.kind === 'stashGroup';
  switch (event.key) {
    case 'ArrowDown': void focusRow(index + 1); break;
    case 'ArrowUp': void focusRow(index - 1); break;
    case 'PageDown': void focusRow(index + page); break;
    case 'PageUp': void focusRow(index - page); break;
    case 'Home': void focusRow(0); break;
    case 'End': void focusRow(rows.value.length - 1); break;
    case 'ArrowRight':
      if (!expandable) return;
      if (!row.expanded) activate(row);
      else void focusRow(index + 1);
      break;
    case 'ArrowLeft':
      if (expandable && row.expanded) activate(row);
      else void focusRow(parentIndex(index));
      break;
    case 'Enter':
    case ' ':
      activate(row);
      break;
    case 'ContextMenu': void openRowMenu(row, rowElement(row.key)?.getBoundingClientRect()); break;
    case 'F10':
      if (!event.shiftKey) return;
      void openRowMenu(row, rowElement(row.key)?.getBoundingClientRect());
      break;
    default:
      return;
  }
  event.preventDefault();
}

const card = computed(() => scmStateCard(view.value, props.projectKey, props.platform, t, { grantTrust: (key) => props.api.grantTrust(key), run }));

// With repositories open, unsafe and parent repositories still waiting show as one line each above the changes.
const notices = computed(() => {
  const current = view.value;
  if (!current || !ready.value) return [];
  return [
    ...(current.unsafePaths.length > 0 ? [{ id: 'unsafe', text: t('scm.state.unsafe.text', current.unsafePaths.length), label: t('scm.state.unsafe.manage'), op: 'manageUnsafeRepositories' as const }] : []),
    ...(current.parentCount > 0 ? [{ id: 'parent', text: t('scm.state.parent.text', current.parentCount), label: t('scm.state.parent.open'), op: 'openParentRepositories' as const }] : []),
  ];
});

async function select(id: string): Promise<void> {
  if (props.projectKey !== undefined && id !== repoId.value) await store.api.select({ projectKey: props.projectKey, repoId: id });
}

// Palette commits run here, where the drafts are, on the repository main named; the view naming it may arrive later.
const stopCommand = store.onCommand((command) => {
  if (command.command !== 'commit' || !view.value?.repos.some((each) => each.repoId === command.repoId)) return;
  void (async () => {
    await select(command.repoId);
    await commit(command.variant, command.repoId);
  })();
});
onBeforeUnmount(() => {
  stopCommand();
  stopArtifacts();
  clearTimeout(armTimer);
  clearInterval(ageTimer);
});

const toolbarButton = 'size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25';
</script>

<template>
  <SidebarSection
    ref="section"
    section="scm"
    :collapsed="collapsed"
    :body-size="bodySize"
    data-testid="scm-section"
    @toggle="emit('toggle')"
  >
    <template #badge>
      <Transition name="t-badge">
        <span
          v-if="total > 0"
          data-testid="scm-count"
          :aria-label="t('scm.countAria', total)"
          class="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-(--d-accent) px-1.25 font-mono text-10 font-semibold text-(--d-on-accent)"
        >
          <Transition
            name="t-swap"
            mode="out-in"
          >
            <span :key="total">{{ total }}</span>
          </Transition>
        </span>
      </Transition>
    </template>
    <template
      v-if="ready"
      #actions
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="scm-view-mode"
        :data-view-mode="viewMode"
        :class="toolbarButton"
        :aria-label="viewMode === 'list' ? t('scm.action.viewAsTree') : t('scm.action.viewAsList')"
        :title="viewMode === 'list' ? t('scm.action.viewAsTree') : t('scm.action.viewAsList')"
        @click="setViewMode(viewMode === 'list' ? 'tree' : 'list')"
      >
        <Transition name="t-letter">
          <ListTree
            v-if="viewMode === 'list'"
            key="tree"
            aria-hidden="true"
          />
          <List
            v-else
            key="list"
            aria-hidden="true"
          />
        </Transition>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="scm-title-commit"
        :class="toolbarButton"
        :aria-label="commitLabel"
        :title="commitLabel"
        @click="commit()"
      >
        <Check aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="scm-refresh"
        :class="toolbarButton"
        :aria-label="t('scm.refresh')"
        :title="t('scm.refresh')"
        :aria-busy="refreshing || undefined"
        @click="refresh"
      >
        <RefreshCw
          aria-hidden="true"
          :class="refreshing ? 'd-spinning' : ''"
        />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="scm-more-actions"
        aria-haspopup="menu"
        :aria-expanded="moreOpen"
        :class="toolbarButton"
        :aria-label="t('scm.moreActions')"
        :title="t('scm.moreActions')"
        @click="openMoreActions"
      >
        <Ellipsis aria-hidden="true" />
      </Button>
    </template>

    <ScmProgress
      :repo-id="ready ? repoId : undefined"
      :running="ready ? (snapshot?.running ?? null) : null"
      :last-remote="ready ? (snapshot?.lastRemote ?? null) : null"
      @release-focus="reclaimFocus"
    >
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
        <!-- One scroll container when the section is shorter than the controls and the tree's minimum, as VS Code's SCM view
             scrolls its input with its changes, so every change stays reachable. -->
        <div
          v-else-if="ready && snapshot && view"
          ref="body"
          :key="'ready'"
          data-testid="scm-body"
          class="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
        >
          <div class="flex shrink-0 flex-col gap-2 px-2.5 pt-0.5 pb-2">
            <RepoPicker
              v-if="view.repos.length > 1"
              :api="api"
              :view="view"
              :branch-of="branchOf"
              @select="select"
              @action="runAction"
            />
            <!-- The prototype's branch row: the branch button (Checkout to...) takes the free space before the sync button. -->
            <div
              v-if="snapshot.head"
              data-testid="scm-branch-row"
              class="flex items-center gap-1.5"
            >
              <BranchButton
                :snapshot="snapshot"
                :head="snapshot.head"
              />
              <SyncButton
                v-if="snapshot.remotes.length > 0"
                :snapshot="snapshot"
                :committing="committing"
              />
            </div>
            <p
              v-for="notice in notices"
              :key="notice.id"
              data-testid="scm-notice"
              class="flex items-start gap-1.5 text-11 text-(--d-warning-text)"
            >
              <TriangleAlert
                aria-hidden="true"
                class="mt-0.5 size-3 shrink-0"
              />
              <span class="min-w-0 flex-1">{{ notice.text }} <button
                type="button"
                class="cursor-pointer text-(--d-accent-text) underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                @click="projectKey !== undefined && run({ op: notice.op, projectKey })"
              >{{ notice.label }}</button></span>
            </p>
            <CommitBox
              ref="commitBox"
              :snapshot="snapshot"
              :platform="platform"
              :api="api"
            />
            <p
              v-if="snapshot.tooManyChanges"
              data-testid="scm-too-many"
              class="flex items-start gap-1.5 text-11 text-(--d-warning-text)"
            >
              <TriangleAlert
                aria-hidden="true"
                class="mt-0.5 size-3 shrink-0"
              />{{ t('scm.tooManyChanges', { limit: String(SCM_STATUS_LIMIT) }) }}
            </p>
          </div>
          <!-- A virtualized tree (groups, folders and changes flattened, roving tabindex); no shadcn part virtualizes a tree. -->
          <div
            v-bind="containerProps"
            :id="treeId"
            role="tree"
            tabindex="-1"
            data-testid="scm-tree"
            :data-view-mode="viewMode"
            :aria-label="t('scm.treeLabel', { name: repo ? visibleText(repo.label) : projectName })"
            :aria-describedby="helpId"
            :aria-busy="busy || undefined"
            :style="{ minHeight: `${TREE_MIN_REM}rem` }"
            class="flex-1 overflow-x-hidden px-1.5 pb-2 outline-none"
            @keydown="onKeydown"
          >
            <div
              ref="listWrapper"
              v-bind="wrapperProps"
            >
              <!-- css off unless armed: a CSS-mode leave keeps a row a scroll unmounted in the DOM for two frames, and Chromium's
                 scroll anchoring then pulls the scroll position back. -->
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
                  <ChangeGroup
                    v-if="row.kind === 'group'"
                    :id="`${treeId}-${index}`"
                    :row="row"
                    :current="index === focusedIndex"
                    :height="rowHeight(row)"
                    :actions="row.count === 0 ? [] : groupActions(row.group, untrackedChanges)"
                    :busy="busy"
                    @toggle="activate(row)"
                    @focus="focusedKey = row.key"
                    @action="runAction($event, { group: row.group })"
                    @menu="openRowMenu(row, pointAnchor($event))"
                  />
                  <ChangeGroup
                    v-else-if="row.kind === 'stashGroup'"
                    :id="`${treeId}-${index}`"
                    :row="row"
                    :current="index === focusedIndex"
                    :height="rowHeight(row)"
                    :actions="STASH_GROUP_ACTIONS"
                    :busy="busy"
                    :bump="stashBumps"
                    @toggle="activate(row)"
                    @focus="focusedKey = row.key"
                    @action="runAction($event)"
                    @menu="openRowMenu(row, pointAnchor($event))"
                  />
                  <p
                    v-else-if="row.kind === 'stashNote'"
                    role="treeitem"
                    aria-level="2"
                    :aria-posinset="row.position"
                    :aria-setsize="row.setSize"
                    :data-row-key="row.key"
                    data-testid="scm-stash-note"
                    :data-note="row.text"
                    :tabindex="index === focusedIndex ? 0 : -1"
                    class="flex items-center px-1.5 text-xs outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
                    :class="[row.text === 'failed' ? 'text-(--d-danger-text)' : 'text-(--d-faint)', arriving.get(row.key) ?? '']"
                    :style="{ height: `${rowHeight(row)}px` }"
                    @focus="focusedKey = row.key"
                  >
                    {{ t(`scm.empty.${row.text === 'failed' ? 'stashesFailed' : 'stashes'}`) }}
                  </p>
                  <StashRow
                    v-else-if="row.kind === 'stash'"
                    :id="`${treeId}-${index}`"
                    :row="row"
                    :current="index === focusedIndex"
                    :height="rowHeight(row)"
                    :now="now"
                    :arrival="arriving.get(row.key)"
                    :busy="busy"
                    @activate="activate(row)"
                    @focus="focusedKey = row.key"
                    @apply="runStashAction('applyStash', row.stash)"
                    @menu="openRowMenu(row, pointAnchor($event))"
                  />
                  <p
                    v-else-if="row.kind === 'empty'"
                    role="treeitem"
                    aria-level="2"
                    :aria-posinset="row.position"
                    :aria-setsize="row.setSize"
                    :data-row-key="row.key"
                    data-testid="scm-empty"
                    :tabindex="index === focusedIndex ? 0 : -1"
                    class="flex items-center px-1.5 text-xs text-(--d-faint) outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
                    :style="{ height: `${rowHeight(row)}px` }"
                    @focus="focusedKey = row.key"
                  >
                    {{ t(`scm.empty.${row.text}`) }}
                  </p>
                  <ChangeRow
                    v-else
                    :id="`${treeId}-${index}`"
                    :row="row"
                    :current="index === focusedIndex"
                    :selected="row.key === selectedKey"
                    :height="rowHeight(row)"
                    :view-mode="viewMode"
                    :status-text="row.kind === 'change' ? statusText(row.change) : ''"
                    :arrival="arriving.get(row.key)"
                    :busy="busy"
                    @activate="activate(row)"
                    @focus="focusedKey = row.key"
                    @action="runAction($event, { group: row.group, row })"
                    @menu="openRowMenu(row, pointAnchor($event))"
                    @dragstart="onDragStart($event, row)"
                  />
                </div>
              </TransitionGroup>
            </div>
          </div>
          <p
            :id="helpId"
            class="sr-only"
          >
            {{ t('scm.keyboardHelp') }}
          </p>
        </div>
      </Transition>
    </ScmProgress>
  </SidebarSection>
</template>
