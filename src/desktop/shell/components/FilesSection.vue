<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, triggerRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { Ban, ChevronRight, Copy, CopyMinus, FilePlus, FolderInput, FolderPlus } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { remPx } from '@/composables/useRemPx';
import { useDragAutoScroll } from '@/composables/useDragAutoScroll';
import { FILE_DRAG_MIME, FILES_ROW_DRAG_MIME, parseFileDragPayload, serializeFileDragPayload } from '@shared/file-drag';
import { visibleText } from '@shared/visible-text';
import { MAX_FILE_NAME_LENGTH, type DamoclesShellApi, type FileRef, type FilesPasteResult, type FilesTransferStartResult, type ShellPlatform, type ShownFolder } from '../../preload/shell-channels';
import type { OverlayMenuItem } from '../../preload/overlay-channels';
import type { ScmDecoration, ScmLetter, ScmResource, ScmTone } from '../../preload/scm-channels';
import { parseRootKey } from '../../preload/folder-root';
import { fileNameProblem } from '../../preload/file-names';
import { isServablePreviewPath } from '../../main/html-preview/serve-policy';
import { ancestorsOf, autoRevealExcluded, childPath, flattenTree, nameOf, parentOf, type Listing, type TreeEdit, type TreeRow } from '../files-tree';
import FileIcon from './FileIcon.vue';
import { tidyMenu } from '../../preload/overlay-channels';
import { EDITOR_STORE } from '../editor/editor-store';
import { SCM_STORE } from '../scm/scm-store';
import { TONE_TEXT } from '../scm/scm-list';
import StatusLetter from '../scm/StatusLetter.vue';
import SidebarSection from './SidebarSection.vue';
import { TOOLBAR_BUTTON } from './sidebar-section';
import FilesBranchChip from './FilesBranchChip.vue';
import WslNotice from './WslNotice.vue';
import FilesTransferRow from './FilesTransferRow.vue';

const props = defineProps<{
  api: DamoclesShellApi;
  // the root key of the shown folder (D31): the project's, or its selected chat's worktree's
  projectKey: string | undefined;
  // the selected project's shown folder, for the branch chip
  shown?: ShownFolder | undefined;
  // the New Chat in This Worktree shortcut the branch chip's menu shows
  newChatInWorktreeShortcut?: string | undefined;
  projectName: string;
  // this computer's OS, for shortcut labels
  platform: ShellPlatform;
  // the OS the project's files are on, whose file name rules a typed name follows
  projectPlatform: ShellPlatform;
  // false: the project's host has no trash, so a delete is permanent
  trash: boolean;
  collapsed: boolean;
  bodySize?: number | undefined;
  // the project's host is away: the tree stays readable, dimmed
  away?: boolean | undefined;
  // a local project in a WSL distro's file system, whose Reopen in WSL notice tops the tree
  wslNotice?: { readonly projectKey: string; readonly projectName: string; readonly distro: string } | undefined;
  // a project on another computer, whose menu offers Download...
  remote?: boolean | undefined;
  // the remote project's host is not connected: Download... is disabled
  offline?: boolean | undefined;
  // the host's name while its Damocles server cannot copy files: drops, Paste, Copy files here... and Download... are off
  transfersUnsupportedOn?: string | undefined;
}>();
const emit = defineEmits<{ toggle: []; expand: [] }>();
const { t } = useI18n();
const editor = inject(EDITOR_STORE)!;
const scm = inject(SCM_STORE)!;

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
const unsupportedId = useId();
const unsupportedText = computed(() => (props.transfersUnsupportedOn === undefined ? '' : t('files.transfersUnsupported', { host: visibleText(props.transfersUnsupportedOn) })));

const rows = computed(() => flattenTree(listings.value, expanded.value, edit.value));
const rowKey = (row: TreeRow): string => (row.kind === 'entry' ? `entry:${row.path}` : `input:${row.edit.mode}`);
// The name being typed placed in its folder, so parent-qualified icons match; a folder being renamed stays open while expanded.
const inputIcon = (row: Extract<TreeRow, { kind: 'input' }>): { path: string; open: boolean } => {
  const name = editName.value || row.name;
  return row.edit.mode === 'rename'
    ? { path: childPath(parentOf(row.edit.path), name), open: expanded.value.has(row.edit.path) }
    : { path: childPath(row.edit.parentDir, name), open: false };
};
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

type RowDecoration = { readonly own: ScmDecoration | undefined; readonly ignored: boolean; readonly letter: ScmLetter | undefined; readonly dot: ScmTone | undefined; readonly title: string | undefined };
// B3: source control's decoration of a row: a file's (or a submodule folder's) letter, a folder's dot for its changed descendants,
// and ignored entries faded. Main computes the files; the folder dots come from them here.
function decorationOf(row: Extract<TreeRow, { kind: 'entry' }>): RowDecoration {
  const own = scm.decorationOf(props.projectKey, row.path);
  const ignored = row.ignored || own?.tone === 'ignored';
  const letter = own?.letter;
  const dot = row.directory && letter === undefined && !ignored ? scm.folderToneOf(props.projectKey, row.path) : undefined;
  return { own, ignored, letter, dot, title: own?.status ? t(`scm.status.${own.status}`) : own?.submodule ? t('files.decoration.submodule') : undefined };
}
// The rendered rows' decorations, worked out once per render.
const decorations = computed(() => new Map(visibleRows.value.flatMap(({ data }) => (data.kind === 'entry' ? [[data.path, decorationOf(data)] as const] : []))));
const decoration = (row: Extract<TreeRow, { kind: 'entry' }>): RowDecoration => decorations.value.get(row.path) ?? decorationOf(row);

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
  const request: Promise<void> = props.api.listFiles({ projectKey: key, relativeDir: dir, ...(report ? { report } : {}) }).then((result): Promise<void> | undefined => {
    // Answers may arrive out of order: only the newest request's is shown, and an older request settles with it.
    const newest = requests.get(dir);
    if (newest !== request) return newest;
    // The project changed while the listing was on its way.
    if (key !== props.projectKey) return undefined;
    setListing(dir, result.ok ? { state: 'loaded', entries: result.entries } : { state: 'failed' });
    if (!result.ok && dir !== '') collapse(dir);
    return undefined;
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

// The tree fades in afresh when it shows another folder, so a switch between a worktree and the project folder reads as one.
watch(() => props.projectKey, (key, previous) => {
  const tree = containerProps.ref.value;
  if (tree && previous !== undefined && key !== undefined) {
    tree.classList.remove('d-fade-in');
    void tree.offsetWidth;
    tree.classList.add('d-fade-in');
  }
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
  if (event.key === 'Escape' && cut.value?.projectKey === props.projectKey) {
    event.preventDefault();
    void props.api.clearFilesClipboard();
    return;
  }
  if (!row) {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      void openRootMenu(containerProps.ref.value?.getBoundingClientRect());
    }
    return;
  }
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
// Only a file the preview's serve policy would serve: a dot folder's page would only fail to load.
const previewsAsHtml = (path: string): boolean => /\.html?$/i.test(path) && isServablePreviewPath(path);

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

// The box holds the real name, never its escapes, which a commit would write as the new name (VS Code's explorerViewer.ts).
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
const editProblem = computed(() => (edit.value ? fileNameProblem(editName.value.trim(), editSiblings.value, props.projectPlatform) : undefined));
// Shown once the user has typed or pressed Enter, so a new entry's empty box opens without an error.
const editMessage = computed(() => (editTouched.value && editProblem.value ? t(`files.error.${editProblem.value}`, { name: visibleText(editName.value.trim()) }) : null));

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
  // A file of an open repository has Open Timeline (VS Code's explorer files.openTimeline); main resolves its repository.
  const resource = row.directory ? null : await resourceOf(file);
  const items: OverlayMenuItem[] = row.directory
    ? [
        item('newFile', t('files.newFile'), 'file-plus'),
        item('newFolder', t('files.newFolder'), 'folder-plus'),
        copyHereItem(),
        separator,
        item('findInFolder', t('files.menu.findInFolder'), 'search', props.platform === 'darwin' ? '⇧⌥F' : 'Shift+Alt+F'),
        item('openAsProject', t('files.menu.openAsProject'), 'folder-plus'),
        separator,
      ]
    : [
        ...(markdown
          ? [item('openPreview', t('files.menu.openPreview'), 'eye', t('files.menu.click')), item('openSource', t('files.menu.openSource'), 'code')]
          : [
              item('open', t('files.menu.open'), 'file', t('files.menu.click')),
              ...(previewsAsHtml(row.path) ? [item('openPreview', t('files.menu.openPreview'), 'eye')] : []),
            ]),
        item('focusOverlay', t('files.menu.focusOverlay'), 'maximize-2'),
        item('mention', t('files.menu.mention'), 'at-sign', t('files.menu.drag')),
        ...(resource ? [item('openTimeline', t('files.menu.openTimeline'), 'history')] : []),
        separator,
      ];
  items.push(
    ...clipboardItems(true),
    separator,
    ...(props.remote ? [downloadItem(), separator] : []),
    item('rename', t('files.menu.rename'), 'pencil', 'F2'),
    { kind: 'item', id: 'delete', label: props.trash ? t('files.menu.delete') : t('files.menu.deletePermanently'), icon: 'trash-2', shortcut: 'Del', danger: true },
    separator,
    item('copyPath', t('files.menu.copyPath'), 'copy'),
    item('copyRelativePath', t('files.menu.copyRelativePath'), 'copy'),
    item('reveal', t('files.menu.reveal'), 'folder-search'),
  );
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: t('files.menu.label', { name: visibleText(row.name) }),
    caption: visibleText(row.path),
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
    case 'openAsProject': await props.api.openAsProject({ projectKey: file.projectKey, relativePath: file.relativePath }); break;
    case 'rename': startRename(row.path); break;
    case 'delete': await remove(row.path); break;
    case 'copyPath': await props.api.copyFilePath(file, false); break;
    case 'copyRelativePath': await props.api.copyFilePath(file, true); break;
    case 'reveal': await props.api.revealFile(file); break;
    case 'openTimeline': if (resource) await props.api.scm.run({ op: 'openTimeline', repoId: resource.repoId, path: resource.path }); break;
    case 'copyHere': await pickCopyIn(row.path); break;
    case 'download': await props.api.downloadFile(file); break;
  }
}

// Main runs a pick of these on the focused row or tree, as the cut, copy and paste events Ctrl+X, C and V send (Cmd on macOS).
function clipboardItems(onEntry: boolean): OverlayMenuItem[] {
  const key = (letter: string): string => (props.platform === 'darwin' ? `⌘${letter}` : `Ctrl+${letter}`);
  const paste: OverlayMenuItem = { kind: 'item', id: 'paste', label: t('files.menu.paste'), icon: 'clipboard-paste', shortcut: key('V'), clipboard: 'paste', ...(unsupportedText.value ? { disabled: true } : {}) };
  if (!onEntry) return [paste];
  return [
    { kind: 'item', id: 'cut', label: t('files.menu.cut'), icon: 'scissors', shortcut: key('X'), clipboard: 'cut' },
    { kind: 'item', id: 'copy', label: t('files.menu.copy'), icon: 'copy', shortcut: key('C'), clipboard: 'copy' },
    paste,
  ];
}

const unsupportedItem = (): Partial<Extract<OverlayMenuItem, { kind: 'item' }>> => (unsupportedText.value ? { disabled: true, disabledReason: t('files.menu.transfersUnsupported') } : {});

const downloadItem = (): OverlayMenuItem => ({
  kind: 'item',
  id: 'download',
  label: t('files.menu.download'),
  icon: 'download',
  ...(props.offline ? { disabled: true, disabledReason: t('files.menu.offline') } : unsupportedItem()),
});

const copyHereItem = (): OverlayMenuItem => ({ kind: 'item', id: 'copyHere', label: t('files.menu.copyHere'), icon: 'folder-input', ...unsupportedItem() });

// The project folder's menu, on the tree's empty space, or from the keyboard on a tree with no rows.
async function openRootMenu(rect: DOMRect | { left: number; top: number; width: number; height: number } | undefined): Promise<void> {
  if (props.projectKey === undefined || !rect) return;
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: t('files.menu.label', { name: props.projectName }),
    anchor: { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height },
    items: [
      { kind: 'item', id: 'newFile', label: t('files.newFile'), icon: 'file-plus' },
      { kind: 'item', id: 'newFolder', label: t('files.newFolder'), icon: 'folder-plus' },
      copyHereItem(),
      { kind: 'separator' },
      ...clipboardItems(false),
    ],
  });
  if (answer.kind !== 'menu') return;
  switch (answer.itemId) {
    case 'newFile': await startCreate('newFile', ''); break;
    case 'newFolder': await startCreate('newFolder', ''); break;
    case 'copyHere': await pickCopyIn(''); break;
  }
}

function onTreeContextMenu(event: MouseEvent): void {
  const target = event.target;
  if (event.defaultPrevented || !(target instanceof Element) || target.closest('[data-tree-path], input')) return;
  event.preventDefault();
  void openRootMenu({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
}

// --- copy in, move and the Files clipboard --------------------------------------------------------------------------

// A folder that took a transfer opens, so what arrives shows; main's FilesChanged refreshes it.
async function revealArrival(dir: string, start: Promise<FilesTransferStartResult | FilesPasteResult>): Promise<void> {
  if ((await start).ok && dir !== '') await expand(dir);
}

async function pickCopyIn(dir: string): Promise<void> {
  const folder = fileRef(dir);
  if (folder) await revealArrival(dir, props.api.pickFilesToCopyIn(folder));
}

// OS files from a drop or a paste: main checks each path, and refuses those with none (a web page's image), counted.
async function copyIn(files: readonly File[], dir: string, origin: 'drop' | 'paste'): Promise<void> {
  const key = props.projectKey;
  if (key === undefined || files.length === 0) return;
  const found = props.api.pathsForFiles(files);
  const paths = found.filter((path) => path !== '');
  await revealArrival(dir, props.api.copyFilesIn({ projectKey: key, relativeDir: dir, paths, withoutPath: found.length - paths.length, origin }));
}

// The window's cut item, whose row shows dimmed.
const cut = ref<FileRef | undefined>();
const stopClipboard = props.api.onFilesClipboardChanged((change) => {
  cut.value = change.cut;
});
onBeforeUnmount(stopClipboard);
const isCut = (path: string): boolean => cut.value !== undefined && cut.value.projectKey === props.projectKey && cut.value.relativePath === path;

// The row path a clipboard event reached, '' for the tree itself (the project folder), undefined for the name box.
function clipboardPlace(event: ClipboardEvent): string | undefined {
  const target = event.target;
  if (target === containerProps.ref.value) return '';
  return target instanceof HTMLElement && target.dataset.treePath !== undefined ? target.dataset.treePath : undefined;
}

// Cancelled with no data, which empties the OS clipboard: the next paste takes this row, not files copied earlier in Explorer.
function onClipboardSet(event: ClipboardEvent, op: 'cut' | 'copy'): void {
  const path = clipboardPlace(event);
  const file = path ? fileRef(path) : undefined;
  if (!file) return;
  event.preventDefault();
  void props.api.setFilesClipboard({ op, ref: file });
}

const isDirectory = (path: string): boolean => rows.value.some((row) => row.kind === 'entry' && row.path === path && row.directory);

// Into the row's folder, or the folder holding the row's file: OS files on the clipboard first, else the Files clipboard.
function onPaste(event: ClipboardEvent): void {
  const path = clipboardPlace(event);
  const key = props.projectKey;
  if (path === undefined || key === undefined) return;
  event.preventDefault();
  const dir = path === '' || isDirectory(path) ? path : parentOf(path);
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length > 0) void copyIn(files, dir, 'paste');
  else void revealArrival(dir, props.api.pasteFiles({ toDir: { projectKey: key, relativePath: dir } }));
}

// --- drop target ------------------------------------------------------------------------------------------------------

const HOVER_OPEN_MS = 800;
// The folder a drop lands in while an accepted drag is over the tree: '' is the project folder; null, no drag.
const dropTarget = ref<string | null>(null);
// What the drop will do, which the hint under the pointer names, as the dropEffect tells the OS.
const dropCopies = ref(true);
// An accepted drag kind over a project whose host cannot copy files: the hint says why nothing lands.
const dropRefused = ref(false);
const dropHint = computed(() => {
  if (dropRefused.value) return unsupportedText.value;
  const target = dropTarget.value;
  if (target === null) return '';
  return t(dropCopies.value ? 'files.drop.copy' : 'files.drop.move', { folder: target === '' ? props.projectName : visibleText(target) });
});
// The row this tree's own drag carries, set at dragstart: a row drop is taken only while it is live and names the same row.
let rowDrag: FileRef | null = null;
let hoverOpen: { readonly path: string; readonly timer: ReturnType<typeof setTimeout> } | undefined;
const autoScroll = useDragAutoScroll(containerProps.ref);

// OS files and Files rows only: an editor tab or a source control row carries FILE_DRAG_MIME alone and stays a chat mention.
function dragKind(event: DragEvent): 'row' | 'files' | undefined {
  const types = event.dataTransfer?.types ?? [];
  if (types.includes(FILES_ROW_DRAG_MIME)) return 'row';
  return types.includes('Files') ? 'files' : undefined;
}

const copyHeld = (event: DragEvent): boolean => (props.platform === 'darwin' ? event.altKey : event.ctrlKey);

// The row under the pointer, read from the DOM: a folder row is the one with aria-expanded.
function rowUnder(event: DragEvent): { readonly path: string; readonly directory: boolean; readonly expanded: boolean } | undefined {
  const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tree-path]') : null;
  const path = element?.dataset.treePath;
  if (!element || path === undefined) return undefined;
  const expanded = element.getAttribute('aria-expanded');
  return { path, directory: expanded !== null, expanded: expanded === 'true' };
}

// A row never moves into the folder it is in, nor a folder into itself or a folder inside it; main refuses those too.
function droppable(from: FileRef, target: string, copy: boolean): boolean {
  if (from.projectKey !== props.projectKey) return true;
  const path = from.relativePath;
  if (target === path || target.startsWith(`${path}/`)) return false;
  return copy || parentOf(path) !== target;
}

function stopHoverOpen(): void {
  if (hoverOpen) clearTimeout(hoverOpen.timer);
  hoverOpen = undefined;
}

// A closed folder held under a drag opens, as VS Code's explorer does.
function holdToOpen(path: string | undefined): void {
  if (hoverOpen?.path === path) return;
  stopHoverOpen();
  if (path === undefined) return;
  hoverOpen = {
    path,
    timer: setTimeout(() => {
      hoverOpen = undefined;
      void expand(path, true);
    }, HOVER_OPEN_MS),
  };
}

function clearDrop(): void {
  dropTarget.value = null;
  dropRefused.value = false;
  stopHoverOpen();
  autoScroll.stop();
}

function onTreeDragOver(event: DragEvent): void {
  const kind = dragKind(event);
  // Another app or page can put FILES_ROW_DRAG_MIME on its own drag: only this tree's live row drag is taken.
  if (!kind || (kind === 'row' && !rowDrag) || props.projectKey === undefined || !event.dataTransfer) return;
  // Before the drop checks: a spot that takes no drop still scrolls on to one that does.
  autoScroll.onDragOver(event);
  if (unsupportedText.value) {
    stopHoverOpen();
    dropTarget.value = null;
    dropRefused.value = true;
    event.dataTransfer.dropEffect = 'none';
    return;
  }
  const under = rowUnder(event);
  const target = !under ? '' : under.directory ? under.path : parentOf(under.path);
  const copy = kind === 'files' || copyHeld(event);
  if (kind === 'row' && rowDrag && !droppable(rowDrag, target, copy)) {
    stopHoverOpen();
    dropTarget.value = null;
    event.dataTransfer.dropEffect = 'none';
    return;
  }
  holdToOpen(under?.directory && !under.expanded ? under.path : undefined);
  event.preventDefault();
  event.dataTransfer.dropEffect = copy ? 'copy' : 'move';
  dropCopies.value = copy;
  dropTarget.value = target;
}

function onTreeDragLeave(event: DragEvent): void {
  if (!containerProps.ref.value?.contains(event.relatedTarget as Node | null)) clearDrop();
}

function onTreeDrop(event: DragEvent): void {
  const kind = dragKind(event);
  const target = dropTarget.value;
  const key = props.projectKey;
  clearDrop();
  if (!kind || target === null || key === undefined || !event.dataTransfer) return;
  if (kind === 'files') {
    event.preventDefault();
    void copyIn(Array.from(event.dataTransfer.files), target, 'drop');
    return;
  }
  const copy = copyHeld(event);
  const from = parseFileDragPayload(event.dataTransfer.getData(FILES_ROW_DRAG_MIME));
  const own = rowDrag;
  if (!from || !own || from.projectKey !== own.projectKey || from.relativePath !== own.relativePath || !droppable(from, target, copy)) return;
  event.preventDefault();
  rowDrag = null;
  void revealArrival(target, props.api.dropFilesRow({ from, toDir: { projectKey: key, relativePath: target }, copy }));
}

function onRowDragEnd(): void {
  rowDrag = null;
  clearDrop();
}

onBeforeUnmount(stopHoverOpen);

// The transfer row's Cancel left with focus on it: the tree takes it back.
function focusTree(): void {
  const path = focusedPath.value;
  if (path !== null && indexOf(path) >= 0) void focusRow(path);
  else containerProps.ref.value?.focus({ preventScroll: true });
}

// Open Timeline is the one item that needs the lookup: when it fails the menu still opens, without that item.
async function resourceOf(file: FileRef): Promise<ScmResource | null> {
  try {
    return await props.api.scm.resource({ projectKey: file.projectKey, relativePath: file.relativePath });
  } catch (error) {
    console.error('[files] looking up the file\'s repository failed', error);
    return null;
  }
}

function onContextMenu(event: MouseEvent, row: Extract<TreeRow, { kind: 'entry' }>): void {
  event.preventDefault();
  void openMenu(row, { left: event.clientX, top: event.clientY, width: 0, height: 0 });
}

// Dragging a row carries its project and relative path: onto a folder of Files it moves or copies, and a file dropped on the
// chat composer becomes a mention (core resolves it).
const dragImage = ref<HTMLElement | null>(null);
const dragLabel = ref('');
const dragMention = ref(false);
function onDragStart(event: DragEvent, row: Extract<TreeRow, { kind: 'entry' }>): void {
  const file = fileRef(row.path);
  if (!file || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  const payload = serializeFileDragPayload(file);
  event.dataTransfer.setData(FILES_ROW_DRAG_MIME, payload);
  if (!row.directory) event.dataTransfer.setData(FILE_DRAG_MIME, payload);
  event.dataTransfer.effectAllowed = 'copyMove';
  rowDrag = file;
  dragLabel.value = visibleText(row.name);
  dragMention.value = !row.directory;
  if (dragImage.value) event.dataTransfer.setDragImage(dragImage.value, remPx(0.75), remPx(0.75));
}

/**
 * Expands every folder above the file, focuses its row and scrolls it into view (Reveal in Files). A file of the selected
 * project's other folder (its project folder while the worktree shows, or the reverse) shows that folder first (D31).
 */
async function reveal(file: FileRef): Promise<void> {
  if (file.projectKey !== props.projectKey && !(await showFolderOf(file))) return;
  if (props.collapsed) emit('expand');
  // The project root has no row of its own, so the tree itself takes focus.
  if (file.relativePath === '') {
    await nextTick();
    containerProps.ref.value?.focus({ preventScroll: true });
  } else if (await expandTo(file.relativePath)) await focusRow(file.relativePath, 'center');
}

// The shown folder's root key reaches this section in the state main sends before it answers showFolder.
async function showFolderOf(file: FileRef): Promise<boolean> {
  const shown = props.shown;
  const root = parseRootKey(file.projectKey);
  if (!shown?.worktree || root?.projectKey !== shown.projectKey) return false;
  if (root.worktreeId !== undefined && root.worktreeId !== shown.worktree.worktreeId) return false;
  await props.api.showFolder({ projectKey: shown.projectKey, show: root.worktreeId === undefined ? 'project' : 'worktree' });
  await nextTick();
  return file.projectKey === props.projectKey;
}

// VS Code's explorer.autoReveal: the active editor's file is expanded to and becomes the tree's focused row, scrolled to
// the middle when out of view. Keyboard focus stays in the editor unless a tree row holds it. A collapsed section waits
// until it opens; each newer run supersedes the one before it.
let autoRevealRun = 0;
watch(
  [() => editor.activeTab.value?.projectKey, () => editor.activeTab.value?.relativePath, () => props.projectKey, () => props.collapsed],
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
    section="files"
    :collapsed="collapsed"
    :body-size="bodySize"
    data-testid="files-section"
    :has-chip="!!shown?.worktree"
    @toggle="emit('toggle')"
  >
    <template #chip>
      <Transition name="t-chip">
        <FilesBranchChip
          v-if="shown?.worktree"
          :api="api"
          :shown="shown"
          :new-chat-shortcut="newChatInWorktreeShortcut"
        />
      </Transition>
    </template>
    <template #actions>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="files-new-file"
        :class="TOOLBAR_BUTTON"
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
        :class="TOOLBAR_BUTTON"
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
        data-testid="files-copy-here"
        :class="TOOLBAR_BUTTON"
        :disabled="projectKey === undefined || !!unsupportedText"
        :aria-label="t('files.copyHere')"
        :aria-describedby="unsupportedText ? unsupportedId : undefined"
        :title="unsupportedText || t('files.copyHere')"
        @click="pickCopyIn(targetDir())"
      >
        <FolderInput aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="files-collapse-all"
        :class="TOOLBAR_BUTTON"
        :disabled="expanded.size === 0"
        :aria-label="t('files.collapseAll')"
        :title="t('files.collapseAll')"
        @click="collapseAll"
      >
        <CopyMinus aria-hidden="true" />
      </Button>
    </template>

    <FilesTransferRow
      :api="api"
      :project-key="projectKey"
      @release-focus="focusTree"
    />
    <Transition
      name="t-banner"
      appear
    >
      <WslNotice
        v-if="wslNotice"
        :key="wslNotice.projectKey"
        :api="api"
        :project-key="wslNotice.projectKey"
        :project-name="wslNotice.projectName"
        :distro="wslNotice.distro"
        place="files"
        class="mx-1.5 mb-1.5 shrink-0"
      />
    </Transition>
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

    <!-- The drop target: OS files and Files rows land in the folder under the pointer, or the project folder over empty space. -->
    <div class="relative flex min-h-0 flex-1 flex-col">
      <!-- A virtualized tree (flattened visible rows, roving tabindex); no shadcn part virtualizes a tree. -->
      <div
        v-bind="containerProps"
        :id="treeId"
        role="tree"
        tabindex="-1"
        data-testid="files-tree"
        :aria-label="t('files.treeLabel', { project: projectName })"
        :aria-describedby="helpId"
        :data-away="away || undefined"
        :data-drop-target="dropTarget ?? undefined"
        class="d-dim-transition min-h-0 flex-1 overflow-x-hidden pb-2 outline-none"
        :class="{ 'opacity-(--d-opacity-disabled)': away, 'overflow-y-hidden! [scrollbar-gutter:stable]': autoScroll.holding.value }"
        @keydown="onKeydown"
        @contextmenu="onTreeContextMenu"
        @dragenter="onTreeDragOver"
        @dragover="onTreeDragOver"
        @dragleave="onTreeDragLeave"
        @drop="onTreeDrop"
        @cut="onClipboardSet($event, 'cut')"
        @copy="onClipboardSet($event, 'copy')"
        @paste="onPaste"
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
              <FileIcon
                :path="inputIcon(row).path"
                :directory="row.directory"
                :open="inputIcon(row).open"
                class="size-3.5 shrink-0"
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
              :title="visibleText(row.path)"
              draggable="true"
              :data-cut="isCut(row.path) || undefined"
              class="files-row relative flex cursor-pointer items-center gap-1.25 pr-2.5 outline-none select-none hover:bg-(--d-hover) focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
              :class="row.path === selectedPath ? 'bg-(--d-accent-soft) hover:bg-(--d-accent-soft)' : ''"
              :style="{ height: `${remPx(ROW_REM)}px`, paddingLeft: `${INDENT_START_REM + row.depth * INDENT_REM}rem` }"
              @click="activate(row)"
              @focus="focusedPath = row.path"
              @contextmenu="onContextMenu($event, row)"
              @dragstart="onDragStart($event, row)"
              @dragend="onRowDragEnd"
            >
              <!-- The drop highlight: the row's focus outline over the accent tint. -->
              <span
                v-if="dropTarget === row.path"
                aria-hidden="true"
                data-testid="files-drop-highlight"
                class="d-fade-in pointer-events-none absolute inset-0 bg-(--d-accent-soft) shadow-[inset_0_0_0_1px_var(--d-accent)]"
              />
              <span class="flex w-3.5 shrink-0 text-(--d-faint)">
                <ChevronRight
                  v-if="row.directory"
                  aria-hidden="true"
                  class="size-3 transition-transform duration-150 ease-out"
                  :class="row.expanded ? 'rotate-90' : ''"
                />
              </span>
              <FileIcon
                :path="row.path"
                :directory="row.directory"
                :open="row.expanded"
                class="size-3.5 shrink-0"
              />
              <span
                data-testid="files-name"
                class="min-w-0 flex-1 truncate"
                :data-ignored="decoration(row).ignored || undefined"
                :class="decoration(row).ignored ? (row.path === selectedPath ? 'text-(--d-faint-text)' : 'text-(--d-faint)') : ''"
                :style="decoration(row).letter && !row.directory && decoration(row).own ? { color: TONE_TEXT[decoration(row).own!.tone] } : undefined"
              >{{ visibleText(row.name) }}</span>
              <StatusLetter
                v-if="decoration(row).letter"
                data-testid="files-decoration"
                aria-hidden="true"
                :letter="decoration(row).letter!"
                :tone="decoration(row).own!.tone"
                :title="decoration(row).title"
              />
              <span
                v-else-if="decoration(row).dot"
                data-testid="files-folder-dot"
                :data-tone="decoration(row).dot"
                class="mx-1.25 size-1.5 shrink-0 rounded-full"
                :style="{ backgroundColor: TONE_TEXT[decoration(row).dot!] }"
              />
              <span
                v-if="decoration(row).title"
                class="sr-only"
              >{{ decoration(row).title }}</span>
            </div>
          </template>
        </div>
      </div>
      <span
        v-if="dropTarget === ''"
        aria-hidden="true"
        data-testid="files-drop-root"
        class="d-fade-in pointer-events-none absolute inset-0 bg-(--d-accent-soft) shadow-[inset_0_0_0_1px_var(--d-accent)]"
      />
      <!-- Says where the drop lands and whether it copies or moves; the drag is a pointer gesture, so it stays out of the tree. -->
      <Transition name="t-pop">
        <div
          v-if="dropHint"
          aria-hidden="true"
          data-testid="files-drop-hint"
          :data-action="dropRefused ? 'refused' : dropCopies ? 'copy' : 'move'"
          class="pointer-events-none absolute inset-x-1.5 bottom-1.5 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-11 font-semibold shadow-(--d-shadow)"
          :class="dropRefused ? 'border border-(--d-border2) bg-(--d-card) text-(--d-text)' : 'bg-(--d-accent) text-(--d-on-accent)'"
        >
          <component
            :is="dropRefused ? Ban : dropCopies ? Copy : FolderInput"
            class="size-3.25 shrink-0"
            :class="dropRefused ? 'text-(--d-danger-text)' : ''"
          />
          <span
            class="min-w-0"
            :class="dropRefused ? 'text-pretty' : 'truncate'"
          >{{ dropHint }}</span>
        </div>
      </Transition>
    </div>
    <p
      :id="helpId"
      class="sr-only"
    >
      {{ t('files.keyboardHelp') }}
      <span
        v-if="unsupportedText"
        :id="unsupportedId"
        data-testid="files-transfers-unsupported"
      >{{ unsupportedText }}</span>
    </p>
    <!-- The drag image: a chip naming the file, drawn off screen for setDragImage. -->
    <div
      ref="dragImage"
      aria-hidden="true"
      class="files-drag-image pointer-events-none fixed -top-40 left-0 flex items-center gap-1.5 rounded-7 border border-(--d-accent) bg-(--d-card) px-2 py-1 text-12 text-(--d-text) shadow-(--d-shadow)"
    >
      <span
        v-if="dragMention"
        class="text-(--d-accent-text)"
      >@</span>{{ dragLabel }}
    </div>
  </SidebarSection>
</template>
