<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, triggerRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { ChevronRight, CopyMinus, FilePlus, FolderPlus } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { remPx } from '@/composables/useRemPx';
import { FILE_DRAG_MIME, serializeFileDragPayload } from '@shared/file-drag';
import { MAX_FILE_NAME_LENGTH, type DamoclesShellApi, type FileRef, type ShellPlatform } from '../../preload/shell-channels';
import type { OverlayMenuItem } from '../../preload/overlay-channels';
import { fileNameProblem } from '../../preload/file-names';
import { ancestorsOf, autoRevealExcluded, flattenTree, nameOf, parentOf, type Listing, type TreeEdit, type TreeRow } from '../files-tree';
import { fileIcon } from '../file-icons';
import { tidyMenu } from '../../preload/overlay-channels';
import { EDITOR_STORE } from '../editor/editor-store';
import SidebarSection from './SidebarSection.vue';

const props = defineProps<{
  api: DamoclesShellApi;
  projectKey: string | undefined;
  projectName: string;
  platform: ShellPlatform;
  collapsed: boolean;
  bodySize?: number | undefined;
}>();
const emit = defineEmits<{ toggle: []; expand: [] }>();
const { t } = useI18n();
const editor = inject(EDITOR_STORE)!;

// rem of a tree row (the reference's 24px) and of each level's indent (14px), from its 8px start.
const ROW_REM = 1.5;
const INDENT_REM = 0.875;
const INDENT_START_REM = 0.5;

const listings = shallowRef(new Map<string, Listing>());
const expanded = shallowRef(new Set<string>());
const edit = ref<TreeEdit | null>(null);
const editName = ref('');
const editTouched = ref(false);
// The keyboard position (roving tabindex), by path so it survives refreshes.
const focusedPath = ref<string | null>(null);
const treeId = useId();
const helpId = useId();

const rows = computed(() => flattenTree(listings.value, expanded.value, edit.value));
const rowKey = (row: TreeRow): string => (row.kind === 'entry' ? `entry:${row.path}` : `input:${row.edit.mode}`);
const { list: visibleRows, containerProps, wrapperProps, scrollTo } = useVirtualList(rows, { itemHeight: () => remPx(ROW_REM), overscan: 10 });

const focusedIndex = computed(() => {
  const index = rows.value.findIndex((row) => row.kind === 'entry' && row.path === focusedPath.value);
  return index >= 0 ? index : rows.value.findIndex((row) => row.kind === 'entry');
});
// The active editor tab's file is the tree's selection.
const selectedPath = computed(() => {
  const tab = editor.activeTab.value;
  return tab?.projectKey === props.projectKey ? tab?.relativePath : undefined;
});
const rootListing = computed(() => listings.value.get(''));

function setListing(dir: string, listing: Listing): void {
  listings.value.set(dir, listing);
  triggerRef(listings);
}

// The listing request in flight per directory, so a reveal waits for the folder it walks through.
let pending = new Map<string, Promise<void>>();

// report: a user action waits on the listing, so main reports a failure in the Files toast.
function load(dir: string, report = false): Promise<void> {
  const key = props.projectKey;
  if (key === undefined) return Promise.resolve();
  if (!listings.value.has(dir)) setListing(dir, { state: 'loading' });
  const requests = pending;
  const request: Promise<void> = props.api.listFiles({ projectKey: key, relativeDir: dir, ...(report ? { report } : {}) }).then((result) => {
    // The project changed while the listing was on its way.
    if (key !== props.projectKey) return;
    setListing(dir, result.ok ? { state: 'loaded', entries: result.entries } : { state: 'failed' });
    if (!result.ok && dir !== '') collapse(dir);
  }).finally(() => {
    if (requests.get(dir) === request) requests.delete(dir);
  });
  requests.set(dir, request);
  return request;
}

function expand(dir: string, report = false): Promise<void> {
  if (expanded.value.has(dir)) return pending.get(dir) ?? Promise.resolve();
  expanded.value.add(dir);
  triggerRef(expanded);
  return load(dir, report);
}

// Whether the folder's loaded listing has the entry; files.exclude keeps some entries out.
function listed(path: string): boolean {
  const listing = listings.value.get(parentOf(path));
  return listing?.state === 'loaded' && listing.entries.some((entry) => entry.name === nameOf(path));
}

/** Expands every folder above `path` while each is listed, as VS Code's explorer walks to a resource; true if the row shows. */
async function expandTo(path: string): Promise<boolean> {
  await pending.get('');
  for (const dir of ancestorsOf(path)) {
    if (!listed(dir)) return false;
    await expand(dir);
  }
  return listed(path);
}

function collapse(dir: string): void {
  if (!expanded.value.delete(dir)) return;
  triggerRef(expanded);
}

function collapseAll(): void {
  expanded.value.clear();
  triggerRef(expanded);
  scrollTo(0);
}

watch(() => props.projectKey, () => {
  listings.value = new Map();
  pending = new Map();
  expanded.value = new Set();
  edit.value = null;
  focusedPath.value = null;
  void load('');
}, { immediate: true });

// No directories named means the exclude settings changed: every listing shown may differ.
const stopChanges = props.api.onFilesChanged((change) => {
  if (change.projectKey !== props.projectKey) return;
  const dirs = change.relativeDirs.length === 0 ? ['', ...expanded.value] : change.relativeDirs;
  for (const dir of dirs) if (dir === '' || expanded.value.has(dir)) void load(dir);
});
onBeforeUnmount(stopChanges);

// --- keyboard and focus --------------------------------------------------------------------------------------------

const rowElement = (path: string): HTMLElement | null =>
  containerProps.ref.value?.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(path)}"]`) ?? null;

const indexOf = (path: string): number => rows.value.findIndex((row) => row.kind === 'entry' && row.path === path);

// A row in view stays put. Out of view, 'nearest' scrolls it to the closer edge (keyboard), 'center' to the middle (a
// reveal, VS Code's tree.reveal(item, 0.5)).
function revealIndex(index: number, align: 'nearest' | 'center' = 'nearest'): void {
  const container = containerProps.ref.value;
  if (!container || index < 0) return;
  const height = remPx(ROW_REM);
  const top = index * height;
  const above = top < container.scrollTop;
  if (!above && top + height <= container.scrollTop + container.clientHeight) return;
  if (align === 'center') container.scrollTop = top - Math.max(0, (container.clientHeight - height) / 2);
  else container.scrollTop = above ? top : top + height - container.clientHeight;
}

async function focusRow(path: string, align: 'nearest' | 'center' = 'nearest'): Promise<void> {
  focusedPath.value = path;
  revealIndex(indexOf(path), align);
  await nextTick();
  rowElement(path)?.focus({ preventScroll: true });
}

const rowHasFocus = (): boolean => {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.dataset.treePath !== undefined && containerProps.ref.value?.contains(active) === true;
};

// A focused row the list scrolls out of view unmounts; the tree keeps focus so the keys still reach it.
watch(visibleRows, () => {
  const container = containerProps.ref.value;
  const path = focusedPath.value;
  if (!container || path === null || !container.contains(document.activeElement)) return;
  if (!rowElement(path) && document.activeElement !== container && !edit.value) container.focus({ preventScroll: true });
});

function entryAt(index: number): Extract<TreeRow, { kind: 'entry' }> | undefined {
  const row = rows.value[index];
  return row?.kind === 'entry' ? row : undefined;
}

function moveFocus(index: number): void {
  const entries = rows.value;
  const clamped = Math.min(Math.max(index, 0), entries.length - 1);
  const row = entryAt(clamped) ?? entryAt(clamped + 1) ?? entryAt(clamped - 1);
  if (row) void focusRow(row.path);
}

function onKeydown(event: KeyboardEvent): void {
  if (edit.value) return;
  const index = focusedIndex.value;
  const row = entryAt(index);
  if (!row) return;
  // Shift+Alt+F: VS Code's Find in Folder... on a folder row of the explorer.
  if (row.directory && event.code === 'KeyF' && event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    const folder = fileRef(row.path);
    if (folder) void props.api.findInFolder(folder);
    return;
  }
  const page = Math.max(1, Math.floor((containerProps.ref.value?.clientHeight ?? 0) / remPx(ROW_REM)) - 1);
  switch (event.key) {
    case 'ArrowDown': moveFocus(index + 1); break;
    case 'ArrowUp': moveFocus(index - 1); break;
    case 'PageDown': moveFocus(index + page); break;
    case 'PageUp': moveFocus(index - page); break;
    case 'Home': moveFocus(0); break;
    case 'End': moveFocus(rows.value.length - 1); break;
    case 'ArrowRight':
      if (!row.directory) return;
      if (!row.expanded) void expand(row.path, true);
      else moveFocus(index + 1);
      break;
    case 'ArrowLeft':
      if (row.directory && row.expanded) collapse(row.path);
      else if (row.path.includes('/')) void focusRow(parentOf(row.path));
      else return;
      break;
    case 'Enter':
    case ' ':
      activate(row);
      break;
    case 'F2': startRename(row.path); break;
    case 'Delete': void remove(row.path); break;
    case 'ContextMenu': void openMenu(row, rowElement(row.path)?.getBoundingClientRect()); break;
    case 'F10':
      if (!event.shiftKey) return;
      void openMenu(row, rowElement(row.path)?.getBoundingClientRect());
      break;
    default:
      return;
  }
  event.preventDefault();
}

// --- actions --------------------------------------------------------------------------------------------------------

const fileRef = (relativePath: string): FileRef | undefined => (props.projectKey === undefined ? undefined : { projectKey: props.projectKey, relativePath });
const isMarkdown = (path: string): boolean => /\.md$/i.test(path);

async function open(path: string, as?: 'preview' | 'source', preserveFocus = false): Promise<boolean> {
  const file = fileRef(path);
  if (!file) return false;
  const result = await props.api.openEditor({ ...file, ...(as ? { as } : isMarkdown(path) ? { as: 'preview' as const } : {}), ...(preserveFocus ? { preserveFocus } : {}) });
  return result.ok;
}

function activate(row: Extract<TreeRow, { kind: 'entry' }>): void {
  focusedPath.value = row.path;
  if (!row.directory) void open(row.path);
  else if (row.expanded) collapse(row.path);
  else void expand(row.path, true);
}

// New entries go into the focused folder, or the focused file's folder, as in VS Code.
function targetDir(): string {
  const row = entryAt(focusedIndex.value);
  if (!row || focusedPath.value === null) return '';
  return row.directory ? row.path : parentOf(row.path);
}

async function startCreate(mode: 'newFile' | 'newFolder', dir = targetDir()): Promise<void> {
  if (props.projectKey === undefined) return;
  if (props.collapsed) emit('expand');
  if (dir !== '') await expand(dir, true);
  // The box renders only inside a listed, expanded folder; main has reported a listing that failed.
  if (dir !== '' && (listings.value.get(dir)?.state !== 'loaded' || !expanded.value.has(dir))) return;
  edit.value = { mode, parentDir: dir };
  editName.value = '';
  editTouched.value = false;
}

function startRename(path: string): void {
  edit.value = { mode: 'rename', path };
  editName.value = nameOf(path);
  editTouched.value = false;
}

// The names already in the box's folder, the renamed entry's own excluded; main checks the disk again on commit.
const editSiblings = computed<readonly string[]>(() => {
  const current = edit.value;
  if (!current) return [];
  const listing = listings.value.get(current.mode === 'rename' ? parentOf(current.path) : current.parentDir);
  const own = current.mode === 'rename' ? nameOf(current.path) : undefined;
  return listing?.state === 'loaded' ? listing.entries.flatMap((entry) => (entry.name === own ? [] : [entry.name])) : [];
});
const editProblem = computed(() => (edit.value ? fileNameProblem(editName.value.trim(), editSiblings.value, props.platform) : undefined));
// Shown once the user has typed or pressed Enter, so a new entry's empty box opens without an error.
const editMessage = computed(() => (editTouched.value && editProblem.value ? t(`files.error.${editProblem.value}`, { name: editName.value.trim() }) : null));

// The input row renders inside the virtual list's v-for, so it is found in the list rather than through a template ref.
const editInput = (): HTMLInputElement | null => containerProps.ref.value?.querySelector<HTMLInputElement>('[data-testid="files-edit-input"]') ?? null;
watch(edit, (current) => {
  if (!current) return;
  void nextTick(() => {
    const index = rows.value.findIndex((row) => row.kind === 'input');
    revealIndex(index);
    void nextTick(() => {
      const input = editInput();
      input?.focus();
      // A rename selects the name without its extension, as VS Code does.
      const dot = current.mode === 'rename' ? editName.value.lastIndexOf('.') : -1;
      input?.setSelectionRange(0, dot > 0 ? dot : editName.value.length);
    });
  });
});

// The renamed row, or the tree for a new entry, takes focus back from the box a key closed.
function returnFocus(closed: TreeEdit): void {
  if (closed.mode === 'rename') void focusRow(closed.path);
  else containerProps.ref.value?.focus({ preventScroll: true });
}

/**
 * Closes the box as VS Code's explorer does (explorerViewer.ts): Enter commits a valid name and does nothing while it is
 * invalid, Escape cancels, and leaving the box commits a valid name and cancels an invalid one. Leaving the box moved focus
 * elsewhere, so only Enter and Escape move it. Main checks the disk again and tells the user when it refuses.
 */
async function finishEdit(how: 'enter' | 'escape' | 'blur'): Promise<void> {
  const current = edit.value;
  const key = props.projectKey;
  if (!current || key === undefined) return;
  if (how === 'enter' && editProblem.value) {
    editTouched.value = true;
    return;
  }
  const name = editName.value.trim();
  const commit = how !== 'escape' && !editProblem.value && !(current.mode === 'rename' && name === nameOf(current.path));
  const refocus = how !== 'blur';
  edit.value = null;
  editTouched.value = false;
  if (!commit) {
    if (refocus) returnFocus(current);
    return;
  }
  const result = current.mode === 'rename'
    ? await props.api.renameFile({ projectKey: key, relativePath: current.path, newName: name })
    : await props.api.createFile({ projectKey: key, relativeDir: current.parentDir, name, kind: current.mode === 'newFolder' ? 'dir' : 'file' });
  if (!result.ok) {
    if (refocus) returnFocus(current);
    return;
  }
  await load(current.mode === 'rename' ? parentOf(current.path) : current.parentDir);
  if (refocus) await focusRow(result.relativePath);
  else focusedPath.value = result.relativePath;
  if (current.mode === 'newFile') await open(result.relativePath, undefined, !refocus);
}

function onEditKeydown(event: KeyboardEvent): void {
  event.stopPropagation();
  if (event.key === 'Enter') {
    event.preventDefault();
    void finishEdit('enter');
  } else if (event.key === 'Escape') {
    event.preventDefault();
    void finishEdit('escape');
  }
}

// VS Code waits a tick, so focus that comes straight back to the box keeps it open.
function onEditBlur(event: FocusEvent): void {
  const box = event.target;
  const current = edit.value;
  setTimeout(() => {
    if (edit.value !== current || (document.hasFocus() && document.activeElement === box)) return;
    void finishEdit('blur');
  });
}

async function remove(path: string): Promise<void> {
  const file = fileRef(path);
  if (!file) return;
  const result = await props.api.deleteFile(file);
  // A failure main reported may still have changed the disk (a folder trashed in part, an entry already gone).
  if (result.ok || result.reason !== 'cancelled') await load(parentOf(path));
}

async function openMenu(row: Extract<TreeRow, { kind: 'entry' }>, rect: DOMRect | { left: number; top: number; width: number; height: number } | undefined): Promise<void> {
  const file = fileRef(row.path);
  if (!file || !rect) return;
  focusedPath.value = row.path;
  type Icon = Extract<OverlayMenuItem, { kind: 'item' }>['icon'];
  const item = (id: string, label: string, icon: Icon, shortcut?: string): OverlayMenuItem => ({ kind: 'item', id, label, ...(icon ? { icon } : {}), ...(shortcut ? { shortcut } : {}) });
  const separator: OverlayMenuItem = { kind: 'separator' };
  const markdown = isMarkdown(row.path);
  const items: OverlayMenuItem[] = row.directory
    ? [
        item('newFile', t('files.newFile'), 'file-plus'),
        item('newFolder', t('files.newFolder'), 'folder-plus'),
        separator,
        item('findInFolder', t('files.menu.findInFolder'), 'search', props.platform === 'darwin' ? '⇧⌥F' : 'Shift+Alt+F'),
        separator,
      ]
    : [
        ...(markdown
          ? [item('openPreview', t('files.menu.openPreview'), 'eye', t('files.menu.click')), item('openSource', t('files.menu.openSource'), 'code')]
          : [item('open', t('files.menu.open'), 'file', t('files.menu.click'))]),
        item('focusOverlay', t('files.menu.focusOverlay'), 'maximize-2'),
        item('mention', t('files.menu.mention'), 'at-sign', t('files.menu.drag')),
        separator,
      ];
  items.push(
    item('rename', t('files.menu.rename'), 'pencil', 'F2'),
    { kind: 'item', id: 'delete', label: t('files.menu.delete'), icon: 'trash-2', shortcut: 'Del', danger: true },
    separator,
    item('copyPath', t('files.menu.copyPath'), 'copy'),
    item('copyRelativePath', t('files.menu.copyRelativePath'), 'copy'),
    item('reveal', t('files.menu.reveal'), 'folder-search'),
  );
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: t('files.menu.label', { name: row.name }),
    caption: row.path,
    anchor: { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height },
    items: tidyMenu(items),
  });
  if (answer.kind !== 'menu') return;
  switch (answer.itemId) {
    case 'open': await open(row.path); break;
    case 'openPreview': await open(row.path, 'preview'); break;
    case 'openSource': await open(row.path, 'source'); break;
    case 'focusOverlay': if (await open(row.path)) await editor.setFocusOverlay(true); break;
    case 'mention': await props.api.mentionFile(file); break;
    case 'newFile': await startCreate('newFile', row.path); break;
    case 'newFolder': await startCreate('newFolder', row.path); break;
    case 'findInFolder': await props.api.findInFolder(file); break;
    case 'rename': startRename(row.path); break;
    case 'delete': await remove(row.path); break;
    case 'copyPath': await props.api.copyFilePath(file, false); break;
    case 'copyRelativePath': await props.api.copyFilePath(file, true); break;
    case 'reveal': await props.api.revealFile(file); break;
  }
}

function onContextMenu(event: MouseEvent, row: Extract<TreeRow, { kind: 'entry' }>): void {
  event.preventDefault();
  void openMenu(row, { left: event.clientX, top: event.clientY, width: 0, height: 0 });
}

// Dragging a file carries its project and relative path; the chat composer turns the drop into a mention (core resolves it).
const dragImage = ref<HTMLElement | null>(null);
const dragLabel = ref('');
function onDragStart(event: DragEvent, row: Extract<TreeRow, { kind: 'entry' }>): void {
  const file = fileRef(row.path);
  if (!file || !event.dataTransfer || row.directory) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData(FILE_DRAG_MIME, serializeFileDragPayload(file));
  event.dataTransfer.effectAllowed = 'copy';
  dragLabel.value = row.name;
  if (dragImage.value) event.dataTransfer.setDragImage(dragImage.value, remPx(0.75), remPx(0.75));
}

/** Expands every folder above the file, focuses its row and scrolls it into view (Reveal in Files). */
async function reveal(file: FileRef): Promise<void> {
  if (file.projectKey !== props.projectKey) return;
  if (props.collapsed) emit('expand');
  // The project root has no row of its own, so the tree itself takes focus.
  if (file.relativePath === '') {
    await nextTick();
    containerProps.ref.value?.focus({ preventScroll: true });
  } else if (await expandTo(file.relativePath)) await focusRow(file.relativePath, 'center');
}

// VS Code's explorer.autoReveal: the active editor's file is expanded to and becomes the tree's focused row, scrolled to
// the middle when out of view. Keyboard focus stays in the editor unless a tree row holds it. A collapsed section waits
// until it opens; each newer run supersedes the one before it.
let autoRevealRun = 0;
watch(
  () => [editor.activeTab.value?.projectKey, editor.activeTab.value?.relativePath, props.projectKey, props.collapsed] as const,
  async ([tabProject, path, project, collapsed]) => {
    const run = ++autoRevealRun;
    if (collapsed || path === undefined || tabProject !== project || autoRevealExcluded(path)) return;
    if (!(await expandTo(path)) || run !== autoRevealRun) return;
    if (rowHasFocus()) await focusRow(path, 'center');
    else {
      focusedPath.value = path;
      revealIndex(indexOf(path), 'center');
    }
  },
  { immediate: true },
);

defineExpose({ reveal, startCreate, collapseAll });
</script>

<template>
  <SidebarSection
    :title="t('files.heading')"
    :collapsed="collapsed"
    :body-size="bodySize"
    data-testid="files-section"
    @toggle="emit('toggle')"
  >
    <template #actions>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="files-new-file"
        class="size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
        :disabled="projectKey === undefined"
        :aria-label="t('files.newFile')"
        :title="t('files.newFile')"
        @click="startCreate('newFile')"
      >
        <FilePlus aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="files-new-folder"
        class="size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
        :disabled="projectKey === undefined"
        :aria-label="t('files.newFolder')"
        :title="t('files.newFolder')"
        @click="startCreate('newFolder')"
      >
        <FolderPlus aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="files-collapse-all"
        class="size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
        :disabled="expanded.size === 0"
        :aria-label="t('files.collapseAll')"
        :title="t('files.collapseAll')"
        @click="collapseAll"
      >
        <CopyMinus aria-hidden="true" />
      </Button>
    </template>

    <p
      v-if="projectKey === undefined"
      class="px-3 py-2 text-12 text-(--d-faint)"
    >
      {{ t('files.noProject') }}
    </p>
    <div
      v-else-if="rootListing?.state === 'failed'"
      class="flex items-center gap-2 px-3 py-2 text-12 text-(--d-muted)"
    >
      {{ t('files.loadFailed') }}
      <Button
        size="sm"
        variant="link"
        class="h-auto p-0 text-12"
        @click="load('')"
      >
        {{ t('chats.retry') }}
      </Button>
    </div>
    <p
      v-else-if="rootListing?.state === 'loaded' && rows.length === 0"
      class="px-3 py-2 text-12 text-(--d-faint)"
    >
      {{ t('files.empty', { project: projectName }) }}
    </p>

    <!-- A virtualized tree (flattened visible rows, roving tabindex); no shadcn part virtualizes a tree. -->
    <div
      v-bind="containerProps"
      :id="treeId"
      role="tree"
      tabindex="-1"
      data-testid="files-tree"
      :aria-label="t('files.treeLabel', { project: projectName })"
      :aria-describedby="helpId"
      class="min-h-0 flex-1 overflow-x-hidden pb-2 outline-none"
      @keydown="onKeydown"
    >
      <div v-bind="wrapperProps">
        <template
          v-for="{ data: row, index } in visibleRows"
          :key="rowKey(row)"
        >
          <div
            v-if="row.kind === 'input'"
            role="none"
            class="flex items-center gap-1.25 pr-2.5"
            :style="{ height: `${remPx(ROW_REM)}px`, paddingLeft: `${INDENT_START_REM + row.depth * INDENT_REM}rem` }"
          >
            <span class="w-3.5 shrink-0" />
            <component
              :is="fileIcon(editName || row.name, row.directory).icon"
              aria-hidden="true"
              class="size-3.5 shrink-0"
              :style="{ color: fileIcon(editName || row.name, row.directory).color }"
            />
            <div class="relative min-w-0 flex-1">
              <Input
                v-model="editName"
                data-testid="files-edit-input"
                :maxlength="MAX_FILE_NAME_LENGTH"
                :aria-label="t(`files.inputLabel.${row.edit.mode}`)"
                :aria-invalid="editMessage !== null"
                :aria-describedby="editMessage ? `${treeId}-edit-message` : undefined"
                class="h-5.5 rounded-5 border-(--d-accent) bg-(--d-input) px-1.5 py-0 text-12.5 focus-visible:ring-0 focus-visible:ring-offset-0"
                :class="editMessage ? 'border-(--d-danger)' : ''"
                @input="editTouched = true"
                @keydown="onEditKeydown"
                @blur="onEditBlur"
              />
              <p
                v-if="editMessage"
                :id="`${treeId}-edit-message`"
                role="alert"
                data-testid="files-edit-message"
                class="absolute inset-x-0 top-full z-10 mt-0.5 rounded-5 border border-(--d-danger) bg-(--d-card) px-1.5 py-0.5 text-11 text-(--d-danger-text) shadow-(--d-shadow)"
              >
                {{ editMessage }}
              </p>
            </div>
          </div>
          <div
            v-else
            :id="`${treeId}-${index}`"
            role="treeitem"
            :data-tree-path="row.path"
            data-testid="files-row"
            :aria-level="row.depth + 1"
            :aria-posinset="row.position"
            :aria-setsize="row.setSize"
            :aria-expanded="row.directory ? row.expanded : undefined"
            :aria-selected="row.path === selectedPath"
            :aria-busy="row.loading || undefined"
            :tabindex="index === focusedIndex ? 0 : -1"
            :title="row.path"
            :draggable="!row.directory"
            class="files-row flex cursor-pointer items-center gap-1.25 pr-2.5 outline-none select-none hover:bg-(--d-hover) focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
            :class="row.path === selectedPath ? 'bg-(--d-accent-soft) hover:bg-(--d-accent-soft)' : ''"
            :style="{ height: `${remPx(ROW_REM)}px`, paddingLeft: `${INDENT_START_REM + row.depth * INDENT_REM}rem` }"
            @click="activate(row)"
            @focus="focusedPath = row.path"
            @contextmenu="onContextMenu($event, row)"
            @dragstart="onDragStart($event, row)"
          >
            <span class="flex w-3.5 shrink-0 text-(--d-faint)">
              <ChevronRight
                v-if="row.directory"
                aria-hidden="true"
                class="size-3 transition-transform duration-150 ease-out"
                :class="row.expanded ? 'rotate-90' : ''"
              />
            </span>
            <component
              :is="fileIcon(row.name, row.directory, row.expanded).icon"
              aria-hidden="true"
              class="size-3.5 shrink-0"
              :style="{ color: fileIcon(row.name, row.directory, row.expanded).color }"
            />
            <span class="min-w-0 flex-1 truncate">{{ row.name }}</span>
          </div>
        </template>
      </div>
    </div>
    <p
      :id="helpId"
      class="sr-only"
    >
      {{ t('files.keyboardHelp') }}
    </p>
    <!-- The drag image: a chip naming the file, drawn off screen for setDragImage. -->
    <div
      ref="dragImage"
      aria-hidden="true"
      class="files-drag-image pointer-events-none fixed -top-40 left-0 flex items-center gap-1.5 rounded-7 border border-(--d-accent) bg-(--d-card) px-2 py-1 text-12 text-(--d-text) shadow-(--d-shadow)"
    >
      <span class="text-(--d-accent-text)">@</span>{{ dragLabel }}
    </div>
  </SidebarSection>
</template>
