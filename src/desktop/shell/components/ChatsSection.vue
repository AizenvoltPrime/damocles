<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { ChevronDown, MessageSquareDashed, Plus, Search, Tag, X } from 'lucide-vue-next';
import { MAX_SEARCH_LENGTH, type DamoclesShellApi, type ShellChat, type ShellChatList } from '../../preload/shell-channels';
import { MAX_OVERLAY_ITEMS, tidyMenu, type OverlayMenuItem, type OverlayRect } from '../../preload/overlay-channels';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import { chatListRows, chatOffers as offers, tagCounts, type ChatListRow } from '../chat-list';
import SidebarSection from './SidebarSection.vue';
import ChatRow from './ChatRow.vue';
import { finishActionOf, finishMenuItems } from '../worktree-menu';

const props = defineProps<{
  api: DamoclesShellApi;
  // the selected project, or the home folder when no project is open; absent until main knows either
  projectKey: string | undefined;
  // ShellState.revision of the state projectKey came from
  stateRevision: number;
  projectName: string;
  selectedChatId: string | undefined;
  newChatShortcut: string;
  newChatInWorktreeShortcut: string;
  collapsed: boolean;
}>();
const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();

// Fixed row heights in rem; the virtual list positions rows from their px.
const GROUP_ROW_REM = 1.625;
const CHAT_ROW_REM = 2.875;
const SEARCH_DEBOUNCE_MS = 150;
const STATE_ACTION = 'h-auto rounded-7 border-(--d-border2) bg-transparent px-2.5 py-1 text-xs font-normal text-(--d-text) transition-none hover:border-(--d-accent) hover:bg-transparent hover:text-(--d-accent)';

const listId = useId();
const helpId = useId();
const searchId = useId();
const optionId = (index: number): string => `${listId}-option-${index}`;

const list = shallowRef<ShellChatList | null>(null);
const found = shallowRef<ShellChatList | null>(null);
const searchOpen = ref(false);
const query = ref('');
const tagFilter = ref<string | undefined>();
const renamingId = ref<string | undefined>();
const now = ref(new Date());
const loadFailed = ref(false);

// A later refresh supersedes an earlier one still in flight.
let refreshSeq = 0;
async function refresh(): Promise<void> {
  const key = props.projectKey;
  const seq = ++refreshSeq;
  if (key === undefined) {
    list.value = null;
    found.value = null;
    loadFailed.value = false;
    return;
  }
  const trimmed = query.value.trim();
  const revision = props.stateRevision;
  try {
    const [full, matches] = await Promise.all([
      props.api.listChats(key, revision),
      trimmed ? props.api.searchChats(key, trimmed, revision) : Promise.resolve(undefined),
    ]);
    if (seq !== refreshSeq) return;
    // The project left main's list after this state; the state without it, already sent, refreshes the list as its key changes.
    if (full === null || matches === null) {
      dropOtherProject(key);
      return;
    }
    now.value = new Date();
    list.value = full;
    found.value = matches ?? null;
    loadFailed.value = false;
  } catch {
    if (seq !== refreshSeq) return;
    dropOtherProject(key);
    loadFailed.value = true;
  }
}

// Another project's chats never stay on screen under this project's name.
function dropOtherProject(key: string): void {
  if (list.value?.projectKey === key) return;
  list.value = null;
  found.value = null;
}

watch(() => props.projectKey, () => {
  searchOpen.value = false;
  query.value = '';
  tagFilter.value = undefined;
  renamingId.value = undefined;
  activeId.value = undefined;
  void refresh();
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void refresh(), SEARCH_DEBOUNCE_MS);
});

let stopChanged: (() => void) | undefined;
onMounted(() => {
  stopChanged = props.api.onChatsChanged((projectKey) => {
    if (projectKey === props.projectKey) void refresh();
  });
  void refresh();
});
onBeforeUnmount(() => {
  stopChanged?.();
  clearTimeout(searchTimer);
});

const allChats = computed(() => list.value?.chats ?? []);
const tags = computed(() => tagCounts(allChats.value));
const shown = computed(() => {
  const source = found.value?.chats ?? allChats.value;
  return tagFilter.value === undefined ? source : source.filter((chat) => chat.tag === tagFilter.value);
});
const rows = computed<ChatListRow[]>(() => chatListRows(shown.value, now.value));
const rowHeight = (row: ChatListRow | undefined): number => remPx(row?.kind === 'group' ? GROUP_ROW_REM : CHAT_ROW_REM);
const { list: visibleRows, containerProps, wrapperProps } = useVirtualList(rows, {
  itemHeight: (index) => rowHeight(rows.value[index]),
  overscan: 8,
});

const isEmpty = computed(() => list.value !== null && allChats.value.length === 0 && !query.value.trim());
const noMatch = computed(() => list.value !== null && !isEmpty.value && rows.value.length === 0);

// Keyboard position by chat id, so it survives refreshes; the selection itself is main's.
const activeId = ref<string | undefined>();
const activeIndex = computed(() => {
  const byId = (id: string | undefined): number => (id === undefined ? -1 : rows.value.findIndex((row) => row.kind === 'chat' && row.chat.id === id));
  const index = byId(activeId.value);
  if (index >= 0) return index;
  const selected = byId(props.selectedChatId);
  return selected >= 0 ? selected : rows.value.findIndex((row) => row.kind === 'chat');
});
const activeChat = computed(() => {
  const row = rows.value[activeIndex.value];
  return row?.kind === 'chat' ? row.chat : undefined;
});
// Names only a rendered option: a row virtualized out of view, or one replaced by the rename editor, has no element.
const activeDescendant = computed(() => {
  const chat = activeChat.value;
  if (!chat || chat.id === renamingId.value || !visibleRows.value.some((row) => row.index === activeIndex.value)) return undefined;
  return optionId(activeIndex.value);
});

function rowTop(index: number): number {
  let top = 0;
  for (let i = 0; i < index; i++) top += rowHeight(rows.value[i]);
  return top;
}

function reveal(index: number): void {
  const container = containerProps.ref.value;
  if (!container) return;
  const top = rowTop(index);
  const bottom = top + rowHeight(rows.value[index]);
  if (top < container.scrollTop) container.scrollTop = top;
  else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
}

function moveTo(index: number, direction: 1 | -1): void {
  let next = Math.min(Math.max(index, 0), rows.value.length - 1);
  while (rows.value[next]?.kind === 'group') next += direction;
  const row = rows.value[next];
  if (row?.kind !== 'chat') return;
  activeId.value = row.chat.id;
  reveal(next);
}

function rectOf(element: Element | null | undefined): OverlayRect {
  const rect = element?.getBoundingClientRect();
  return rect ? { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height } : { x: 0, y: 0, width: 0, height: 0 };
}

function select(chat: ShellChat): void {
  activeId.value = chat.id;
  void props.api.selectChat(chat.id);
}

function startRename(chat: ShellChat): void {
  activeId.value = chat.id;
  renamingId.value = chat.id;
}

async function commitRename(chat: ShellChat, name: string): Promise<void> {
  renamingId.value = undefined;
  focusList();
  const trimmed = name.trim();
  if (trimmed && trimmed !== chat.title) await props.api.renameChat(chat.id, trimmed);
}

function cancelRename(): void {
  renamingId.value = undefined;
  focusList();
}

async function pickTag(chat: ShellChat, anchor: OverlayRect): Promise<void> {
  const answer = await props.api.requestOverlay({
    kind: 'tagPicker',
    anchor,
    ...(chat.tag ? { current: chat.tag } : {}),
    tags: list.value?.tags ?? [],
    placeholder: t('chats.tagPlaceholder'),
  });
  if (answer.kind === 'tagPicker' && answer.tag !== (chat.tag ?? null)) await props.api.tagChat(chat.id, answer.tag);
}

async function confirmDelete(chat: ShellChat): Promise<void> {
  const answer = await props.api.requestOverlay({
    kind: 'confirm',
    title: t('chats.deleteTitle'),
    message: t('chats.deleteMessage'),
    detail: { label: t('chats.deleteDetail'), text: chat.title || t('chats.newChat') },
    ...(chat.status === 'idle'
      ? {}
      : { warning: { text: t(chat.status === 'running' ? 'chats.deleteRunning' : 'chats.deleteWaiting'), running: chat.status === 'running' } }),
    confirmLabel: t('chats.deleteConfirm'),
    cancelLabel: t('chats.cancel'),
    danger: true,
  });
  if (answer.kind === 'confirm' && answer.confirmed) await props.api.deleteChat(chat.id);
}

async function openMenu(chat: ShellChat, anchor: OverlayRect, rowElement: Element | null): Promise<void> {
  activeId.value = chat.id;
  const edits: OverlayMenuItem[] = [
    ...(offers(chat, 'rename') ? [{ kind: 'item', id: 'rename', label: t('chats.rename'), icon: 'pencil' } as const] : []),
    ...(offers(chat, 'tag')
      ? [
          { kind: 'item', id: 'tag', label: chat.tag ? t('chats.changeTag') : t('chats.tag'), icon: 'tag' } as const,
          ...(chat.tag ? [{ kind: 'item', id: 'removeTag', label: t('chats.removeTag'), icon: 'x' } as const] : []),
        ]
      : []),
    { kind: 'separator' },
  ];
  // D33: a chat that owns a worktree keeps New chat in this worktree and the finish actions in one Worktree submenu.
  const worktree = chat.worktree;
  const opensHere = canOpenHere(chat);
  // the shortcut acts on the selected chat's worktree, so only that row names it
  const shortcut = chat.id === props.selectedChatId ? { shortcut: props.newChatInWorktreeShortcut } : {};
  const worktreeItems: OverlayMenuItem[] = [
    ...(opensHere ? [{ kind: 'item', id: NEW_IN_WORKTREE, label: t('worktree.newChatHere'), icon: 'plus', ...shortcut } as const, { kind: 'separator' } as const] : []),
    ...(worktree?.worktreeId !== undefined && worktree.finish !== undefined ? finishMenuItems(t, worktree.finish, worktree.baseBranch) : []),
  ];
  const finish: OverlayMenuItem[] = worktreeItems.length > 0
    ? [{ kind: 'submenu', id: 'submenu:worktree', label: t('worktree.submenu'), icon: 'folder-tree', items: tidyMenu(worktreeItems) }, { kind: 'separator' }]
    : [];
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: t('chats.menuLabel', { title: chat.title || t('chats.newChat') }),
    anchor,
    items: tidyMenu([
      { kind: 'item', id: 'open', label: t('chats.open'), icon: 'message-square' },
      { kind: 'separator' },
      ...finish,
      ...edits,
      ...(offers(chat, 'delete') ? [{ kind: 'item', id: 'delete', label: t('chats.delete'), icon: 'trash-2', danger: true } as const] : []),
    ]),
  });
  if (answer.kind !== 'menu') return;
  if (answer.itemId === NEW_IN_WORKTREE) {
    await newChatHere(chat);
    return;
  }
  const action = finishActionOf(answer.itemId);
  if (action && props.projectKey !== undefined && worktree?.worktreeId !== undefined) {
    await props.api.worktreeFinish({ projectKey: props.projectKey, worktreeId: worktree.worktreeId, action });
    return;
  }
  if (answer.itemId === 'open') select(chat);
  else if (answer.itemId === 'rename') startRename(chat);
  else if (answer.itemId === 'tag') await pickTag(chat, rectOf(rowElement));
  else if (answer.itemId === 'removeTag') await props.api.tagChat(chat.id, null);
  else if (answer.itemId === 'delete') await confirmDelete(chat);
}

const NEW_IN_WORKTREE = 'newChatInWorktree';

// Main supplies the target only for a live chat worktree of an open, trusted project with no finish action running; the
// row, its menu and the shortcut then start another chat in that worktree, which main lists first.
const canOpenHere = (chat: ShellChat): boolean => chat.worktree?.newChatIn !== undefined;

async function newChatHere(chat: ShellChat): Promise<void> {
  const target = chat.worktree?.newChatIn;
  // A fresh object: a row's data can be a reactive proxy, which the context bridge cannot clone.
  if (target) await props.api.newChatInWorktree({ projectKey: target.projectKey, worktreeId: target.worktreeId });
}

const rowElement = (chat: ShellChat): Element | null => containerProps.ref.value?.querySelector(`[data-chat-id="${CSS.escape(chat.id)}"]`) ?? null;

function onRowMenu(chat: ShellChat, event: MouseEvent): void {
  void openMenu(chat, { x: Math.max(0, event.clientX), y: Math.max(0, event.clientY), width: 0, height: 0 }, event.currentTarget as Element | null);
}

function onKeydown(event: KeyboardEvent): void {
  const index = activeIndex.value;
  const chat = activeChat.value;
  if (!chat) return;
  if (event.key === 'ArrowDown') moveTo(index + 1, 1);
  else if (event.key === 'ArrowUp') moveTo(index - 1, -1);
  else if (event.key === 'Home') moveTo(0, 1);
  else if (event.key === 'End') moveTo(rows.value.length - 1, -1);
  else if (event.key === 'Enter' || event.key === ' ') select(chat);
  else if (event.key === 'F2' && offers(chat, 'rename')) startRename(chat);
  else if (event.key === 'Delete' && offers(chat, 'delete')) void confirmDelete(chat);
  else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    reveal(index);
    const element = rowElement(chat);
    void openMenu(chat, rectOf(element), element);
  } else return;
  event.preventDefault();
}

function focusList(): void {
  void nextTick(() => containerProps.ref.value?.focus());
}

function toggleSearch(): void {
  searchOpen.value = !searchOpen.value;
  query.value = '';
  if (searchOpen.value) void nextTick(() => document.getElementById(searchId)?.focus());
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    searchOpen.value = false;
    query.value = '';
    focusList();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    focusList();
  }
}

function toggleTagFilter(tag: string): void {
  tagFilter.value = tagFilter.value === tag ? undefined : tag;
}

// The chip row is one line; chips that wrap past it hide and the "all tags" button lists every tag.
const chipRow = ref<HTMLElement | null>(null);
const visibleChips = ref(Number.POSITIVE_INFINITY);
const orderedTags = computed(() => {
  const active = tagFilter.value;
  const byCount = tags.value;
  const pinned = active === undefined ? undefined : byCount.find((entry) => entry.tag === active);
  return pinned ? [pinned, ...byCount.filter((entry) => entry !== pinned)] : byCount;
});
const hiddenChips = computed(() => Math.max(0, orderedTags.value.length - visibleChips.value));

function measureChips(): void {
  const chips = [...(chipRow.value?.children ?? [])] as HTMLElement[];
  const firstTop = chips[0]?.offsetTop ?? 0;
  const fitting = chips.findIndex((chip) => chip.offsetTop > firstTop);
  visibleChips.value = fitting < 0 ? chips.length : fitting;
}
let chipObserver: ResizeObserver | undefined;
watch(chipRow, (element) => {
  chipObserver?.disconnect();
  if (!element) return;
  chipObserver = new ResizeObserver(measureChips);
  chipObserver.observe(element);
});
watch(orderedTags, () => void nextTick(measureChips), { flush: 'post' });
onBeforeUnmount(() => chipObserver?.disconnect());

// Main takes at most MAX_OVERLAY_ITEMS menu items, so the menu lists the most used tags, the active filter among them.
async function openAllTags(event: MouseEvent): Promise<void> {
  const sorted = orderedTags.value.slice(0, MAX_OVERLAY_ITEMS).sort((a, b) => a.tag.localeCompare(b.tag));
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: t('chats.allTags'),
    anchor: rectOf(event.currentTarget as Element | null),
    filterPlaceholder: t('chats.filterTags', { count: sorted.length }),
    items: sorted.map((entry, index) => ({
      kind: 'item',
      id: String(index),
      label: entry.tag,
      icon: 'tag',
      shortcut: String(entry.count),
      checked: entry.tag === tagFilter.value,
    })),
  });
  if (answer.kind !== 'menu') return;
  const picked = sorted[Number(answer.itemId)];
  if (picked) toggleTagFilter(picked.tag);
}

function newChat(): void {
  void props.api.newChat();
}

// The split button's menu (D30, D63) shows in the overlay, above the chat view; the worktree options load there.
const splitButton = ref<HTMLElement | null>(null);
const section = ref<InstanceType<typeof SidebarSection> | null>(null);
const newMenuOpen = ref(false);
async function openNewMenu(): Promise<void> {
  const projectKey = props.projectKey;
  if (projectKey === undefined || newMenuOpen.value) return;
  newMenuOpen.value = true;
  try {
    const asked = props.api.requestOverlay({ kind: 'newChatMenu', anchor: rectOf(splitButton.value), projectKey, projectName: props.projectName, shortcut: props.newChatShortcut });
    // the title actions stay shown while the menu their chevron opened is up
    const answer = await (section.value ? section.value.holdActions(asked) : asked);
    if (answer.kind !== 'newChatMenu') return;
    if (answer.choice === 'plain') await props.api.newChat(projectKey);
    else if (answer.choice === 'continueInWorktree') await props.api.newChatInWorktree({ projectKey, worktreeId: answer.worktreeId });
    else await props.api.newChat(projectKey, { startRef: answer.startRef, bringChanges: answer.bringChanges });
  } finally {
    newMenuOpen.value = false;
  }
}

defineExpose({
  focus: (): boolean => {
    const container = containerProps.ref.value;
    if (!container || props.collapsed || rows.value.length === 0) return false;
    activeId.value = props.selectedChatId;
    reveal(activeIndex.value);
    container.focus();
    return true;
  },
});
</script>

<template>
  <SidebarSection
    ref="section"
    section="chats"
    data-testid="sidebar-chats"
    :count="list ? allChats.length : undefined"
    :collapsed="collapsed"
    @toggle="emit('toggle')"
  >
    <template #actions>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="chat-search-toggle"
        class="size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
        :class="searchOpen ? 'bg-(--d-hover) text-(--d-text)' : ''"
        :aria-label="t('chats.search')"
        :title="t('chats.search')"
        :aria-expanded="searchOpen"
        :aria-controls="searchId"
        @click="toggleSearch"
      >
        <Search
          aria-hidden="true"
          class="size-3.25"
        />
      </Button>
      <!-- The split button (D30): the main part is plain New Chat, as Ctrl+N; the chevron opens the worktree menu. Each part
           rounds its own outer corners and raises itself while focused, so its focus ring shows whole over its neighbour. -->
      <div
        ref="splitButton"
        role="group"
        :aria-label="t('chats.newGroup')"
        class="flex h-5.5 shrink-0"
      >
        <Button
          type="button"
          size="sm"
          data-testid="new-chat"
          class="relative h-5.5 gap-1 rounded-s-md rounded-e-none px-1.75 text-11.5 hover:bg-[color-mix(in_srgb,var(--d-accent)_88%,var(--d-text))] focus-visible:z-1 [&_svg]:size-3"
          :aria-label="t('chats.newChat')"
          :title="t('chats.newTitle', { shortcut: newChatShortcut })"
          @click="newChat"
        >
          <Plus
            aria-hidden="true"
            class="size-3"
          />
          {{ t('chats.new') }}
        </Button>
        <!-- aria-disabled, not disabled: a disabled button shows no tooltip, and this one says why it waits. -->
        <Button
          type="button"
          size="sm"
          data-testid="new-chat-options"
          aria-haspopup="menu"
          :aria-expanded="newMenuOpen"
          class="relative h-5.5 rounded-s-none rounded-e-md border-l border-[color-mix(in_srgb,var(--d-on-accent)_25%,transparent)] px-1 hover:bg-[color-mix(in_srgb,var(--d-accent)_88%,var(--d-text))] focus-visible:z-1 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-primary [&_svg]:size-2.75"
          :class="newMenuOpen ? 'bg-[color-mix(in_srgb,var(--d-accent)_88%,var(--d-text))]' : ''"
          :aria-disabled="projectKey === undefined || undefined"
          :aria-label="t('chats.newOptions')"
          :title="projectKey === undefined ? t('chats.newOptionsNoProject') : t('chats.newOptions')"
          @click="openNewMenu"
        >
          <ChevronDown
            aria-hidden="true"
            class="size-2.75 transition-transform duration-200"
            :class="newMenuOpen ? 'rotate-180' : ''"
          />
        </Button>
      </div>
    </template>

    <div
      v-if="searchOpen"
      class="animate-[d-pop_.16s_ease-out] px-2.5 pt-0.5 pb-1.5"
    >
      <!-- The label draws the field around the icon and a bare input; Input's own box would be replaced wholesale. -->
      <label class="flex h-7 items-center gap-1.75 rounded-7 border border-(--d-border2) bg-(--d-input) px-2.25 focus-within:border-(--d-accent)">
        <Search
          aria-hidden="true"
          class="size-3 shrink-0 text-(--d-faint)"
        />
        <input
          :id="searchId"
          v-model="query"
          type="search"
          data-testid="chat-search"
          :maxlength="MAX_SEARCH_LENGTH"
          :aria-label="t('chats.search')"
          :aria-controls="listId"
          :placeholder="t('chats.searchPlaceholder', { project: projectName })"
          class="min-w-0 flex-1 border-0 bg-transparent text-xs text-(--d-text) outline-none placeholder:text-(--d-faint)"
          @keydown="onSearchKeydown"
        >
      </label>
    </div>

    <div
      v-if="tags.length > 0"
      class="flex min-w-0 items-center gap-1 px-2.5 pb-1.5"
    >
      <div
        ref="chipRow"
        role="group"
        :aria-label="t('chats.tagFilters')"
        class="flex h-5 min-w-0 flex-1 flex-wrap gap-1 overflow-hidden"
      >
        <Button
          v-for="(entry, index) in orderedTags"
          :key="entry.tag"
          type="button"
          variant="outline"
          size="sm"
          data-testid="tag-chip"
          :data-tag="entry.tag"
          :aria-pressed="entry.tag === tagFilter"
          :title="entry.tag === tagFilter ? t('chats.clearTagFilter') : t('chats.showTagged', { tag: entry.tag })"
          class="flex h-5 max-w-24 shrink-0 justify-start gap-1 rounded-full px-2 text-11 font-normal transition-none hover:border-(--d-accent) [&_svg]:size-2.5"
          :class="[
            entry.tag === tagFilter
              ? 'border-(--d-accent) bg-(--d-accent-soft) text-(--d-accent-text) hover:bg-(--d-accent-soft) hover:text-(--d-accent-text)'
              : 'border-(--d-border) bg-transparent text-(--d-muted) hover:bg-transparent hover:text-(--d-muted)',
            index >= visibleChips ? 'invisible' : '',
          ]"
          @click="toggleTagFilter(entry.tag)"
        >
          <X
            v-if="entry.tag === tagFilter"
            aria-hidden="true"
            class="size-2.5 shrink-0"
          />
          <Tag
            v-else
            aria-hidden="true"
            class="size-2.5 shrink-0"
          />
          <span class="min-w-0 truncate">{{ entry.tag }}</span>
          <span
            class="shrink-0 font-mono text-10"
            :class="entry.tag === tagFilter ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
          >{{ entry.count }}</span>
        </Button>
      </div>
      <Button
        v-if="hiddenChips > 0"
        type="button"
        variant="outline"
        size="sm"
        data-testid="all-tags"
        class="flex h-5 shrink-0 gap-0.75 rounded-full border-(--d-border) bg-transparent px-1.75 text-11 font-normal text-(--d-muted) transition-none hover:border-(--d-accent) hover:bg-transparent hover:text-(--d-text) [&_svg]:size-2.5"
        :aria-label="t('chats.moreTags', { count: hiddenChips })"
        :title="t('chats.allTags')"
        aria-haspopup="menu"
        @click="openAllTags"
      >
        +{{ hiddenChips }}
        <ChevronDown
          aria-hidden="true"
          class="size-2.5"
        />
      </Button>
    </div>

    <p
      v-if="noMatch"
      class="animate-[d-fade_.3s] px-4 py-3.5 text-center text-xs text-(--d-faint)"
      data-testid="chats-no-match"
    >
      {{ t('chats.noMatch') }}
    </p>
    <div
      v-if="isEmpty"
      class="flex animate-[d-fade_.3s] flex-col items-center gap-2 px-4 py-4.5 text-center text-xs text-(--d-muted)"
      data-testid="chats-empty"
    >
      <MessageSquareDashed
        aria-hidden="true"
        class="size-5.5 text-(--d-faint)"
      />
      {{ t('chats.empty', { project: projectName }) }}
      <Button
        type="button"
        variant="outline"
        :class="STATE_ACTION"
        @click="newChat"
      >
        {{ t('chats.startFirst') }}
      </Button>
    </div>
    <div
      v-if="loadFailed"
      class="flex animate-[d-fade_.3s] flex-col items-center gap-2 px-4 py-3.5 text-center text-xs"
      data-testid="chats-load-failed"
    >
      <p
        role="alert"
        class="text-(--d-danger)"
      >
        {{ t('chats.loadFailed') }}
      </p>
      <Button
        type="button"
        variant="outline"
        :class="STATE_ACTION"
        @click="refresh"
      >
        {{ t('chats.retry') }}
      </Button>
    </div>

    <!-- A virtualized listbox with aria-activedescendant; no shadcn part virtualizes its rows. -->
    <div
      v-bind="containerProps"
      :id="listId"
      role="listbox"
      :tabindex="rows.length > 0 ? 0 : -1"
      data-testid="chat-list"
      :aria-label="t('chats.listLabel', { project: projectName })"
      :aria-describedby="helpId"
      :aria-activedescendant="activeDescendant"
      class="group/list min-h-0 flex-1 overflow-x-hidden px-1.5 pb-2 focus-visible:outline-none"
      @keydown="onKeydown"
    >
      <div v-bind="wrapperProps">
        <div
          v-for="{ data: row, index } in visibleRows"
          :key="row.kind === 'chat' ? `chat:${row.chat.id}` : `group:${row.group}`"
          role="none"
          :style="{ height: `${rowHeight(row)}px` }"
          :class="row.kind === 'chat' ? 'py-px' : ''"
        >
          <div
            v-if="row.kind === 'group'"
            aria-hidden="true"
            class="px-2 pt-2 pb-0.75 text-10.5 font-medium text-(--d-faint)"
          >
            {{ t(`chats.${row.group}`) }}
          </div>
          <ChatRow
            v-else
            :chat="row.chat"
            :option-id="optionId(index)"
            :selected="row.chat.id === selectedChatId"
            :active="index === activeIndex"
            :renaming="row.chat.id === renamingId"
            :opens-here="canOpenHere(row.chat)"
            @select="select(row.chat)"
            @new-here="newChatHere(row.chat)"
            @menu="onRowMenu(row.chat, $event)"
            @rename="startRename(row.chat)"
            @tag="pickTag(row.chat, rectOf(rowElement(row.chat)))"
            @delete="confirmDelete(row.chat)"
            @filter-tag="toggleTagFilter"
            @commit-rename="commitRename(row.chat, $event)"
            @cancel-rename="cancelRename"
          />
        </div>
      </div>
    </div>
    <p
      :id="helpId"
      class="sr-only"
    >
      {{ t('chats.keyboardHelp') }}
    </p>
  </SidebarSection>
</template>
