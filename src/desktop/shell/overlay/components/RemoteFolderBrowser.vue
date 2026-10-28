<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { File, Folder, FolderOpen, House, Search } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { visibleText } from '@shared/visible-text';
import type { RemoteBrowseResult } from '../../../preload/overlay-channels';
import { breadcrumbs, childPath } from '../remote-paths';

type Listing = Extract<RemoteBrowseResult, { ok: true }>;
type Entry = { readonly name: string; readonly kind: 'folder' | 'file'; readonly projectKey?: string };

// A host's folders through its workspace: home, breadcrumbs, a filter, the host's recent folders and a listbox with
// type-ahead. A folder that is a project already is marked, and picking it selects that project. As a remote core's picker
// it lists only inside its roots (no crumb above the root), offers the roots as chips and, in file mode, picks a file.
const props = defineProps<{
  hostName: string;
  recentFolders: readonly string[];
  // undefined: the dialog is closing
  browse: (path?: string) => Promise<RemoteBrowseResult | undefined>;
  pick?: { readonly mode: 'file' | 'folder'; readonly buttonLabel?: string } | undefined;
}>();
const emit = defineEmits<{ pick: [path: string]; cancel: [] }>();
const { t } = useI18n();

const listId = useId();
const optionId = (index: number): string => `${listId}-option-${index}`;
const listbox = ref<HTMLElement | null>(null);

const listing = ref<Listing | undefined>();
const loading = ref(false);
const problem = ref<string | undefined>();
const filter = ref('');
const selected = ref<string | undefined>();

const fileMode = computed(() => props.pick?.mode === 'file');
const shown = computed<readonly Entry[]>(() => {
  const entries: Entry[] = [
    ...(listing.value?.folders ?? []).map((folder): Entry => ({ ...folder, kind: 'folder' })),
    ...(listing.value?.files ?? []).map((name): Entry => ({ name, kind: 'file' })),
  ];
  const query = filter.value.trim().toLocaleLowerCase();
  return query === '' ? entries : entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query));
});
const activeIndex = computed(() => shown.value.findIndex((entry) => entry.name === selected.value));
const active = computed(() => shown.value[activeIndex.value]);
// A file picker picks only a file; a folder pick takes the selected folder, else the folder shown.
const target = computed(() => {
  const current = listing.value;
  if (!current) return undefined;
  if (fileMode.value) return active.value?.kind === 'file' ? childPath(current.path, active.value.name, current.separator) : undefined;
  return active.value ? childPath(current.path, active.value.name, current.separator) : current.path;
});
// a picker's root is the first crumb, since nothing above it is listed
const crumbs = computed(() => {
  const current = listing.value;
  if (!current) return [];
  const all = breadcrumbs(current.path, current.separator);
  const root = current.root;
  return root === undefined ? all : all.filter((crumb) => crumb.path.length >= root.length);
});

// Listings cross the wire and can answer out of order; only the newest request's answer shows.
let requested = 0;
async function go(path?: string): Promise<void> {
  const ticket = ++requested;
  loading.value = true;
  let result: RemoteBrowseResult | undefined;
  try {
    result = await props.browse(path);
  } catch {
    if (ticket !== requested) return;
    loading.value = false;
    problem.value = t('remote.folders.failed');
    return;
  }
  if (ticket !== requested) return;
  loading.value = false;
  if (!result) return;
  if (!result.ok) {
    problem.value = result.error === 'eperm-privacy'
      ? t('remote.folders.privacy', { folder: visibleText(result.folder), helper: '/usr/libexec/sshd-keygen-wrapper' })
      : t(`remote.folders.${result.error}`, { name: props.hostName });
    return;
  }
  problem.value = undefined;
  listing.value = result;
  filter.value = '';
  selected.value = undefined;
}

function select(index: number): void {
  const entry = shown.value[Math.min(Math.max(index, 0), shown.value.length - 1)];
  if (!entry) return;
  selected.value = entry.name;
  void nextTick(() => document.getElementById(optionId(activeIndex.value))?.scrollIntoView({ block: 'nearest' }));
}

function descend(name: string): void {
  const current = listing.value;
  if (current) void go(childPath(current.path, name, current.separator));
}

// A folder opens; a file is picked.
function enter(entry: Entry): void {
  if (entry.kind === 'folder') descend(entry.name);
  else if (target.value !== undefined) emit('pick', target.value);
}

// WAI-ARIA listbox type-ahead: characters typed within TYPE_AHEAD_MS of each other form one prefix; a repeated single
// character cycles through the folders that start with it.
const TYPE_AHEAD_MS = 500;
let typed = '';
let typedAt = 0;

function typeAhead(key: string): void {
  const now = Date.now();
  typed = now - typedAt > TYPE_AHEAD_MS ? key : typed + key;
  typedAt = now;
  const prefix = typed.toLocaleLowerCase();
  const names = shown.value.map((entry) => entry.name.toLocaleLowerCase());
  const cycling = [...prefix].every((character) => character === prefix[0]);
  const start = cycling ? activeIndex.value + 1 : activeIndex.value;
  const order = [...names.keys()].map((offset) => (Math.max(start, 0) + offset) % names.length);
  const match = order.find((index) => names[index]!.startsWith(cycling ? prefix[0]! : prefix));
  if (match !== undefined) select(match);
}

function onListKeydown(event: KeyboardEvent): void {
  const index = activeIndex.value;
  if (event.key === 'ArrowDown') select(index + 1);
  else if (event.key === 'ArrowUp') select(index - 1);
  else if (event.key === 'Home') select(0);
  else if (event.key === 'End') select(shown.value.length - 1);
  else if (event.key === 'ArrowRight' && active.value?.kind === 'folder') descend(active.value.name);
  else if ((event.key === 'ArrowLeft' || event.key === 'Backspace') && listing.value?.parent !== undefined) void go(listing.value.parent);
  else if (event.key === 'Enter' && fileMode.value && active.value) enter(active.value);
  else if (event.key === 'Enter' && target.value !== undefined) emit('pick', target.value);
  else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) typeAhead(event.key);
  else return;
  event.preventDefault();
}

onMounted(async () => {
  await go();
  listbox.value?.focus();
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div
      v-if="recentFolders.length > 0"
      role="group"
      :aria-label="pick ? t('remote.pick.roots') : t('remote.folders.recent')"
      class="flex flex-wrap items-center gap-1.5 px-4.5 pb-1"
    >
      <span
        aria-hidden="true"
        class="text-11 text-(--d-faint-text)"
      >{{ pick ? t('remote.pick.roots') : t('remote.folders.recent') }}</span>
      <Button
        v-for="folder in recentFolders"
        :key="folder"
        type="button"
        variant="outline"
        size="sm"
        dir="ltr"
        data-testid="recent-folder"
        class="h-6 max-w-64 rounded-7 border-(--d-border2) bg-(--d-card) px-2 font-mono text-11"
        @click="pick ? go(folder) : emit('pick', folder)"
      >
        <Folder aria-hidden="true" />
        <span class="truncate">{{ visibleText(folder) }}</span>
      </Button>
    </div>
    <div class="flex items-center gap-2 px-4.5 py-2">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        class="size-7 rounded-7 text-(--d-muted)"
        :aria-label="pick ? t('remote.pick.root') : t('remote.folders.home')"
        :title="pick ? t('remote.pick.root') : t('remote.folders.home')"
        :disabled="listing === undefined"
        @click="go(listing?.home)"
      >
        <House
          aria-hidden="true"
          class="size-3.5"
        />
      </Button>
      <nav
        :aria-label="t('remote.folders.path')"
        dir="ltr"
        class="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 font-mono text-12"
      >
        <template
          v-for="(crumb, index) in crumbs"
          :key="crumb.path"
        >
          <span
            v-if="index > 0 && !crumbs[index - 1]!.label.endsWith(listing?.separator ?? '/')"
            aria-hidden="true"
            class="text-(--d-faint)"
          >{{ listing?.separator }}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="h-6 rounded-5 px-1 font-mono text-12 text-(--d-accent-text)"
            :aria-current="index === crumbs.length - 1 ? 'location' : undefined"
            @click="go(crumb.path)"
          >
            {{ visibleText(crumb.label) }}
          </Button>
        </template>
      </nav>
      <span class="relative flex w-44 shrink-0 items-center">
        <Search
          aria-hidden="true"
          class="pointer-events-none absolute left-2 size-3.25 text-(--d-faint)"
        />
        <Input
          v-model="filter"
          :aria-label="fileMode ? t('remote.pick.filter') : t('remote.folders.filter')"
          :placeholder="fileMode ? t('remote.pick.filter') : t('remote.folders.filter')"
          autocomplete="off"
          spellcheck="false"
          class="h-7 rounded-7 border-(--d-border2) bg-(--d-input) pr-2 pl-6.5 text-12 text-(--d-text) focus-visible:border-(--d-accent) focus-visible:ring-3 focus-visible:ring-(--d-accent-soft) focus-visible:ring-offset-0"
          @update:model-value="select(0)"
        />
      </span>
    </div>
    <p
      v-if="problem"
      role="alert"
      data-testid="folder-browser-problem"
      class="mx-4.5 mb-2 rounded-8 bg-(--d-warning)/12 px-2.5 py-2 text-12 text-(--d-warning-text)"
    >
      {{ problem }}
    </p>
    <!-- A listbox with aria-activedescendant and type-ahead, which no shadcn part provides outside a popup. -->
    <div
      :id="listId"
      ref="listbox"
      role="listbox"
      tabindex="0"
      data-testid="folder-list"
      data-view-focus
      :aria-label="fileMode ? t('remote.pick.list') : t('remote.folders.list')"
      :aria-busy="loading ? 'true' : undefined"
      :aria-activedescendant="activeIndex >= 0 ? optionId(activeIndex) : undefined"
      class="group/list mx-4.5 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto rounded-10 border border-(--d-border) p-1 focus-visible:border-(--d-accent) focus-visible:outline-none"
      @keydown="onListKeydown"
    >
      <p
        v-if="listing && shown.length === 0"
        class="px-2.5 py-2 text-12 text-(--d-faint-text)"
      >
        {{ filter.trim() === '' ? (fileMode ? t('remote.pick.empty') : t('remote.folders.empty')) : (fileMode ? t('remote.pick.noMatch') : t('remote.folders.noMatch')) }}
      </p>
      <div
        v-for="(entry, index) in shown"
        :id="optionId(index)"
        :key="`${listing?.path}\n${entry.kind}\n${entry.name}`"
        role="option"
        data-testid="folder-entry"
        :data-kind="entry.kind"
        :aria-selected="entry.name === selected"
        :data-project-key="entry.projectKey"
        class="folder-row flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-8 px-2.5 text-13 transition-colors select-none hover:bg-(--d-hover)"
        :class="entry.name === selected ? 'bg-(--d-accent-soft) group-focus-visible/list:outline group-focus-visible/list:-outline-offset-1 group-focus-visible/list:outline-(--d-accent)' : ''"
        :style="{ '--row-index': Math.min(index, 8) }"
        @click="selected = entry.name"
        @dblclick="enter(entry)"
      >
        <File
          v-if="entry.kind === 'file'"
          aria-hidden="true"
          class="size-3.5 shrink-0 text-(--d-muted)"
        />
        <FolderOpen
          v-else-if="entry.projectKey"
          aria-hidden="true"
          class="size-3.5 shrink-0 text-(--d-accent-text)"
        />
        <Folder
          v-else
          aria-hidden="true"
          class="size-3.5 shrink-0 text-(--d-muted)"
        />
        <span class="min-w-0 truncate">{{ visibleText(entry.name) }}</span>
        <span
          v-if="entry.projectKey"
          data-testid="already-project"
          class="ml-1 shrink-0 rounded-full bg-(--d-accent-soft) px-1.5 py-px text-10 font-semibold text-(--d-accent-text)"
        >{{ t('remote.folders.alreadyProject') }}</span>
      </div>
    </div>
    <div class="flex items-center gap-2 px-4.5 pt-3 pb-4">
      <span
        dir="ltr"
        data-testid="folder-target"
        class="min-w-0 flex-1 truncate font-mono text-11 text-(--d-faint-text)"
      >{{ target === undefined ? '' : visibleText(target) }}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="h-8 rounded-9 px-3.5 text-12.5"
        data-testid="folder-browser-cancel"
        @click="emit('cancel')"
      >
        {{ t('remote.folders.cancel') }}
      </Button>
      <Button
        type="button"
        size="sm"
        class="h-8 rounded-9 px-3.5 text-12.5 font-semibold"
        data-testid="folder-browser-confirm"
        :disabled="target === undefined"
        @click="target !== undefined && emit('pick', target)"
      >
        {{ pick ? (pick.buttonLabel ?? t('remote.pick.choose')) : t('remote.folders.open') }}
      </Button>
    </div>
  </div>
</template>
