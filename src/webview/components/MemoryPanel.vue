<script setup lang="ts">
import { ref, computed, watch, reactive } from 'vue';
import type { MemoryTier, MemoryEntry, SearchResult } from '@shared/types/memory';
import { useMemoryStore, type KindFilter, type ScopeFilter } from '@/stores/useMemoryStore';
import { useVSCode } from '@/composables/useVSCode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { IconArrowLeft, IconBrain, IconSearch, IconTrash } from '@/components/icons';
import { Plus, Pin, PinOff, History, Network, EyeOff, RotateCcw, User, Save, ChevronDown, ChevronRight } from 'lucide-vue-next';
import { useOverlayEscape } from '@/composables/useOverlayEscape';
import MarkdownRenderer from './MarkdownRenderer.vue';

type TabId = 'all' | 'note' | 'observations' | 'search';

const props = defineProps<{
  notes: MemoryEntry[];
  observations: MemoryEntry[];
  searchResults: SearchResult[];
  hasMoreObservations: boolean;
  loadingObservations: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'create', tier: MemoryTier, content: string): void;
  (e: 'delete', id: string): void;
  (e: 'pin', id: string): void;
  (e: 'unpin', id: string): void;
  (e: 'loadMoreObservations'): void;
}>();

useOverlayEscape(() => {
  if (historyDialogId.value !== null || relatedDialogId.value !== null) return;
  emit('close');
});

const store = useMemoryStore();
const { postMessage } = useVSCode();

const activeTab = ref<TabId>('all');
const newMemoryContent = ref('');
const newMemoryTier = ref<MemoryTier>('project');
const searchInput = ref('');
const scrollContainerRef = ref<HTMLElement | null>(null);

const historyDialogId = ref<string | null>(null);
const relatedDialogId = ref<string | null>(null);
const profileExpanded = ref(false);

const kindOptions: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'fact', label: 'Fact' },
  { id: 'preference', label: 'Preference' },
  { id: 'episode', label: 'Episode' },
];

const scopeOptions: { id: ScopeFilter; label: string }[] = [
  { id: 'all', label: 'All scopes' },
  { id: 'session', label: 'Session' },
  { id: 'project', label: 'Project' },
  { id: 'global', label: 'Global' },
];

const tierOptions: { id: MemoryTier; label: string }[] = [
  { id: 'session', label: 'Session' },
  { id: 'project', label: 'Project' },
  { id: 'global', label: 'Global' },
  { id: 'note', label: 'Note' },
];

const historyEntries = computed<MemoryEntry[]>(() =>
  historyDialogId.value ? store.versionHistory[historyDialogId.value] ?? [] : []
);

const relatedEntries = computed<MemoryEntry[]>(() =>
  relatedDialogId.value ? store.relatedMemories[relatedDialogId.value] ?? [] : []
);

const profileStaticProject = ref('');
const profileDynamicProject = ref('');
const profileStaticGlobal = ref('');
const profileDynamicGlobal = ref('');

const profileDirty = reactive({
  projectStatic: false,
  projectDynamic: false,
  globalStatic: false,
  globalDynamic: false,
});

/**
 * Re-seed only the textareas the user has NOT edited. The post-save profileData broadcast reassigns
 * store.profile and re-fires this watcher, so without the dirty guard saving one section would
 * overwrite unsaved edits in the other three.
 */
function syncProfileDrafts() {
  if (!profileDirty.projectStatic) profileStaticProject.value = store.profile.project.static;
  if (!profileDirty.projectDynamic) profileDynamicProject.value = store.profile.project.dynamic;
  if (!profileDirty.globalStatic) profileStaticGlobal.value = store.profile.global.static;
  if (!profileDirty.globalDynamic) profileDynamicGlobal.value = store.profile.global.dynamic;
}

watch(() => store.profile, syncProfileDrafts, { immediate: true });

function handleScroll() {
  if (activeTab.value !== 'observations' || !props.hasMoreObservations || props.loadingObservations) return;
  const container = scrollContainerRef.value;
  if (!container) return;
  const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (scrollBottom < 50) {
    emit('loadMoreObservations');
  }
}

const tabs = computed(() => {
  const base: { id: TabId; label: string; count: number; hasMore?: boolean }[] = [
    { id: 'all', label: 'Memories', count: store.filteredMemories.length },
    { id: 'note', label: 'Notes', count: props.notes.length },
    { id: 'observations', label: 'Observations', count: props.observations.length, hasMore: props.hasMoreObservations },
  ];
  if (props.searchResults.length > 0) {
    base.push({ id: 'search', label: 'Results', count: props.searchResults.length });
  }
  return base;
});

function handleAdd() {
  if (!newMemoryContent.value.trim()) return;
  emit('create', newMemoryTier.value, newMemoryContent.value.trim());
  newMemoryContent.value = '';
}

function handleAddKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleAdd();
  }
}

function handleSearch() {
  const query = searchInput.value.trim();
  if (query) {
    postMessage({ type: 'searchMemories', query: { query, includeForgotten: store.showForgotten } });
    activeTab.value = 'search';
  }
}

function handleSearchKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleSearch();
  }
}

function handleShowForgotten(value: boolean) {
  store.setShowForgotten(value);
}

function handleForget(id: string) {
  postMessage({ type: 'forgetMemory', id, scope: 'chain' });
}

function handleUnforget(id: string) {
  postMessage({ type: 'unforgetMemory', id, scope: 'chain' });
}

function openHistory(id: string) {
  postMessage({ type: 'getMemoryHistory', id });
  historyDialogId.value = id;
}

function openRelated(id: string) {
  postMessage({ type: 'getRelatedMemories', id });
  relatedDialogId.value = id;
}

function toggleProfile() {
  profileExpanded.value = !profileExpanded.value;
  if (profileExpanded.value) {
    postMessage({ type: 'getProfile' });
  } else {
    profileDirty.projectStatic = false;
    profileDirty.projectDynamic = false;
    profileDirty.globalStatic = false;
    profileDirty.globalDynamic = false;
    syncProfileDrafts();
  }
}

function saveProfileSection(scope: 'project' | 'global', section: 'static' | 'dynamic', content: string) {
  postMessage({ type: 'setProfileSection', scope, section, content });
  const key = `${scope}${section === 'static' ? 'Static' : 'Dynamic'}` as keyof typeof profileDirty;
  profileDirty[key] = false;
}

function formatTimestamp(epoch: number): string {
  const now = Date.now();
  const diff = now - epoch;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epoch).toLocaleDateString();
}
</script>

<template>
  <div class="absolute inset-0 z-50 flex flex-col bg-background overflow-hidden">
    <header class="flex items-center gap-3 px-4 py-3 bg-muted border-b border-border/30 shrink-0">
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground hover:bg-background shrink-0"
        @click="emit('close')"
      >
        <IconArrowLeft :size="18" />
      </Button>

      <IconBrain
        :size="20"
        class="text-primary shrink-0"
      />

      <div class="flex-1 min-w-0">
        <h2 class="text-sm font-medium text-foreground">
          Memory
        </h2>
        <p class="text-xs text-muted-foreground">
          Browse and manage memories
        </p>
      </div>
    </header>

    <div class="px-4 py-2 flex gap-2 border-b border-border/30">
      <Input
        v-model="searchInput"
        placeholder="Search all memories..."
        class="h-8 text-xs"
        @keydown="handleSearchKeyDown"
      />
      <Button
        variant="ghost"
        size="icon-sm"
        :disabled="!searchInput.trim()"
        @click="handleSearch"
      >
        <IconSearch :size="14" />
      </Button>
    </div>

    <div class="px-4 py-1.5 flex gap-0.5 overflow-x-auto border-b border-border/30">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="px-2 py-1 text-xs rounded-md transition-colors shrink-0 flex items-center gap-1 cursor-pointer"
        :class="activeTab === tab.id
          ? 'bg-primary/15 text-primary font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted'"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
        <span
          v-if="tab.count"
          class="bg-muted text-muted-foreground text-xs px-1 rounded"
        >{{ tab.count }}{{ tab.hasMore ? '+' : '' }}</span>
      </button>
    </div>

    <div
      v-if="activeTab === 'all'"
      class="px-4 py-2 flex flex-col gap-2 border-b border-border/30 shrink-0"
    >
      <div class="flex gap-0.5 overflow-x-auto">
        <button
          v-for="opt in kindOptions"
          :key="opt.id"
          class="px-2 py-0.5 text-xs rounded-md transition-colors shrink-0 cursor-pointer"
          :class="store.kindFilter === opt.id
            ? 'bg-primary/15 text-primary font-medium'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted'"
          @click="store.setKindFilter(opt.id)"
        >
          {{ opt.label }}
        </button>
      </div>
      <div class="flex items-center gap-2 justify-between">
        <div class="flex gap-0.5 overflow-x-auto">
          <button
            v-for="opt in scopeOptions"
            :key="opt.id"
            class="px-2 py-0.5 text-xs rounded-md transition-colors shrink-0 cursor-pointer"
            :class="store.scopeFilter === opt.id
              ? 'bg-secondary text-secondary-foreground font-medium'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'"
            @click="store.setScopeFilter(opt.id)"
          >
            {{ opt.label }}
          </button>
        </div>
        <span class="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
          <Switch
            :checked="store.showForgotten"
            aria-label="Forgotten"
            @update:checked="handleShowForgotten"
          />
          Forgotten
        </span>
      </div>
    </div>

    <div
      ref="scrollContainerRef"
      class="flex-1 overflow-y-auto p-4"
      @scroll="handleScroll"
    >
      <template v-if="activeTab === 'all'">
        <div class="mb-3">
          <button
            class="flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-primary transition-colors cursor-pointer"
            @click="toggleProfile"
          >
            <component
              :is="profileExpanded ? ChevronDown : ChevronRight"
              :size="14"
            />
            <User :size="14" />
            User Profile
          </button>
          <div
            v-if="profileExpanded"
            class="mt-2 space-y-3 pl-1"
          >
            <div class="space-y-2 p-2 rounded-md border border-border/50 bg-card">
              <p class="text-xs font-medium text-muted-foreground">
                Project
              </p>
              <div>
                <p class="text-xs text-muted-foreground/70 mb-1">
                  Static
                </p>
                <Textarea
                  v-model="profileStaticProject"
                  rows="3"
                  class="text-xs"
                  placeholder="Stable facts about the user/project..."
                  @update:model-value="profileDirty.projectStatic = true"
                />
                <Button
                  variant="outline"
                  size="sm"
                  class="mt-1 h-6 text-xs"
                  @click="saveProfileSection('project', 'static', profileStaticProject)"
                >
                  <Save
                    :size="12"
                    class="mr-1"
                  /> Save
                </Button>
              </div>
              <div>
                <p class="text-xs text-muted-foreground/70 mb-1">
                  Dynamic
                </p>
                <Textarea
                  v-model="profileDynamicProject"
                  rows="3"
                  class="text-xs"
                  placeholder="Recent activity..."
                  @update:model-value="profileDirty.projectDynamic = true"
                />
                <Button
                  variant="outline"
                  size="sm"
                  class="mt-1 h-6 text-xs"
                  @click="saveProfileSection('project', 'dynamic', profileDynamicProject)"
                >
                  <Save
                    :size="12"
                    class="mr-1"
                  /> Save
                </Button>
              </div>
            </div>
            <div class="space-y-2 p-2 rounded-md border border-border/50 bg-card">
              <p class="text-xs font-medium text-muted-foreground">
                Global
              </p>
              <div>
                <p class="text-xs text-muted-foreground/70 mb-1">
                  Static
                </p>
                <Textarea
                  v-model="profileStaticGlobal"
                  rows="3"
                  class="text-xs"
                  placeholder="Stable facts that apply everywhere..."
                  @update:model-value="profileDirty.globalStatic = true"
                />
                <Button
                  variant="outline"
                  size="sm"
                  class="mt-1 h-6 text-xs"
                  @click="saveProfileSection('global', 'static', profileStaticGlobal)"
                >
                  <Save
                    :size="12"
                    class="mr-1"
                  /> Save
                </Button>
              </div>
              <div>
                <p class="text-xs text-muted-foreground/70 mb-1">
                  Dynamic
                </p>
                <Textarea
                  v-model="profileDynamicGlobal"
                  rows="3"
                  class="text-xs"
                  placeholder="Recent activity..."
                  @update:model-value="profileDirty.globalDynamic = true"
                />
                <Button
                  variant="outline"
                  size="sm"
                  class="mt-1 h-6 text-xs"
                  @click="saveProfileSection('global', 'dynamic', profileDynamicGlobal)"
                >
                  <Save
                    :size="12"
                    class="mr-1"
                  /> Save
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div
          v-if="store.filteredMemories.length === 0"
          class="text-center text-xs text-muted-foreground py-8"
        >
          No memories match the current filters.
        </div>
        <div
          v-for="memory in store.filteredMemories"
          :key="memory.id"
          class="group mb-2 p-2 rounded-md border border-border/50 hover:border-border bg-card"
          :class="[memory.pinned && 'border-l-2 border-l-amber-500', memory.forgotten && 'opacity-60']"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="text-xs leading-relaxed flex-1 memory-content overflow-hidden">
              <MarkdownRenderer :content="memory.content" />
            </div>
            <div class="flex items-center gap-0.5 shrink-0">
              <Button
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100"
                title="Version history"
                @click="openHistory(memory.id)"
              >
                <History :size="12" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100"
                title="Related memories"
                @click="openRelated(memory.id)"
              >
                <Network :size="12" />
              </Button>
              <Button
                v-if="memory.forgotten"
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100 text-emerald-500"
                title="Restore"
                @click="handleUnforget(memory.id)"
              >
                <RotateCcw :size="12" />
              </Button>
              <Button
                v-else
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100"
                title="Forget"
                @click="handleForget(memory.id)"
              >
                <EyeOff :size="12" />
              </Button>
              <Button
                v-if="memory.pinned"
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100 text-amber-500"
                title="Unpin"
                @click="emit('unpin', memory.id)"
              >
                <PinOff :size="12" />
              </Button>
              <Button
                v-else
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100"
                title="Pin"
                @click="emit('pin', memory.id)"
              >
                <Pin :size="12" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100"
                title="Delete"
                @click="emit('delete', memory.id)"
              >
                <IconTrash :size="12" />
              </Button>
            </div>
          </div>
          <div class="flex items-center gap-1 mt-1.5 flex-wrap">
            <Badge
              v-if="memory.kind"
              variant="secondary"
              class="text-xs h-4 px-1.5 capitalize"
            >
              {{ memory.kind }}
            </Badge>
            <Badge
              v-if="memory.scope"
              variant="outline"
              class="text-xs h-4 px-1.5 capitalize"
            >
              {{ memory.scope }}
            </Badge>
            <Badge
              v-if="memory.isInference"
              variant="outline"
              class="text-xs h-4 px-1.5 text-violet-400 border-violet-400/40"
            >
              inferred
            </Badge>
            <Badge
              v-if="(memory.sourceCount ?? 0) > 1"
              variant="outline"
              class="text-xs h-4 px-1.5"
            >
              {{ memory.sourceCount }} sources
            </Badge>
            <Badge
              v-if="memory.forgotten"
              variant="outline"
              class="text-xs h-4 px-1.5 text-muted-foreground"
              :title="memory.forgetReason ?? undefined"
            >
              forgotten
            </Badge>
            <Badge
              v-for="tag in memory.tags"
              :key="tag"
              variant="outline"
              class="text-xs h-4 px-1"
            >
              {{ tag }}
            </Badge>
            <span class="text-xs text-muted-foreground ml-auto">{{ formatTimestamp(memory.createdAt) }}</span>
          </div>
        </div>
      </template>

      <template v-if="activeTab === 'note'">
        <div
          v-if="notes.length === 0"
          class="text-center text-xs text-muted-foreground py-8"
        >
          No notes yet. Use <code class="bg-muted px-1 rounded">/note text</code> to save one.
        </div>
        <div
          v-for="memory in notes"
          :key="memory.id"
          class="group mb-2 p-2 rounded-md border border-border/50 hover:border-border bg-card"
          :class="memory.pinned && 'border-l-2 border-l-amber-500'"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="text-xs leading-relaxed flex-1 memory-content overflow-hidden">
              <MarkdownRenderer :content="memory.content" />
            </div>
            <div class="flex items-center gap-0.5 shrink-0">
              <Button
                v-if="memory.pinned"
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100 text-amber-500"
                @click="emit('unpin', memory.id)"
              >
                <PinOff :size="12" />
              </Button>
              <Button
                v-else
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100"
                @click="emit('pin', memory.id)"
              >
                <Pin :size="12" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100"
                @click="emit('delete', memory.id)"
              >
                <IconTrash :size="12" />
              </Button>
            </div>
          </div>
          <div class="flex items-center gap-1 mt-1.5">
            <Badge
              v-for="tag in memory.tags"
              :key="tag"
              variant="outline"
              class="text-xs h-4 px-1"
            >
              {{ tag }}
            </Badge>
            <span class="text-xs text-muted-foreground ml-auto">{{ formatTimestamp(memory.createdAt) }}</span>
          </div>
        </div>
      </template>

      <template v-if="activeTab === 'observations'">
        <div
          v-if="observations.length === 0"
          class="text-center text-xs text-muted-foreground py-8"
        >
          No observations yet. Claude will record observations as it works.
        </div>
        <div
          v-for="memory in observations"
          :key="memory.id"
          class="group mb-2 p-2 rounded-md border border-border/50 hover:border-border bg-card"
          :class="memory.pinned && 'border-l-2 border-l-amber-500'"
        >
          <div class="flex items-center gap-1.5 mb-1">
            <Badge
              v-if="memory.observationType"
              variant="secondary"
              class="text-xs h-4 px-1.5"
            >
              {{ memory.observationType }}
            </Badge>
            <span
              v-if="memory.title"
              class="text-xs font-medium truncate flex-1"
            >{{ memory.title }}</span>
            <div class="flex items-center gap-0.5 shrink-0">
              <Button
                v-if="memory.pinned"
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100 text-amber-500"
                @click="emit('unpin', memory.id)"
              >
                <PinOff :size="12" />
              </Button>
              <Button
                v-else
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100"
                @click="emit('pin', memory.id)"
              >
                <Pin :size="12" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                class="opacity-0 group-hover:opacity-100"
                @click="emit('delete', memory.id)"
              >
                <IconTrash :size="12" />
              </Button>
            </div>
          </div>
          <div class="text-xs text-muted-foreground leading-relaxed memory-content overflow-hidden">
            <MarkdownRenderer :content="memory.content" />
          </div>
          <div
            v-if="memory.facts && memory.facts.length > 0"
            class="mt-1.5 space-y-0.5"
          >
            <p
              v-for="(fact, i) in memory.facts.slice(0, 3)"
              :key="i"
              class="text-xs text-muted-foreground/80 pl-2 border-l border-border"
            >
              {{ fact }}
            </p>
          </div>
          <div class="flex items-center gap-1 mt-1.5 flex-wrap">
            <Badge
              v-for="tag in (memory.observationTags ?? [])"
              :key="tag"
              variant="outline"
              class="text-xs h-3.5 px-1"
            >
              {{ tag }}
            </Badge>
            <span class="text-xs text-muted-foreground ml-auto">{{ formatTimestamp(memory.createdAt) }}</span>
          </div>
        </div>
        <div
          v-if="loadingObservations"
          class="text-center text-xs text-muted-foreground py-3 animate-pulse"
        >
          Loading more...
        </div>
        <div
          v-else-if="hasMoreObservations"
          class="text-center py-2"
        >
          <Button
            variant="link"
            size="sm"
            class="text-xs text-primary hover:text-foreground"
            @click="emit('loadMoreObservations')"
          >
            Load more observations
          </Button>
        </div>
      </template>

      <template v-if="activeTab === 'search'">
        <div
          v-if="searchResults.length === 0"
          class="text-center text-xs text-muted-foreground py-8"
        >
          No results found.
        </div>
        <div
          v-for="result in searchResults"
          :key="result.id"
          class="mb-2 p-2 rounded-md border border-border/50 bg-card"
          :title="result.reason ?? undefined"
        >
          <div class="flex items-center gap-1.5 mb-1">
            <Badge
              variant="secondary"
              class="text-xs h-4 px-1.5"
            >
              {{ result.tier }}
            </Badge>
            <Badge
              v-if="result.rerankRelevance"
              variant="outline"
              class="text-xs h-4 px-1.5 capitalize"
            >
              {{ result.rerankRelevance }}
            </Badge>
            <span
              v-if="result.title"
              class="text-xs font-medium truncate"
            >{{ result.title }}</span>
            <span
              v-if="result.observationType"
              class="text-xs text-muted-foreground"
            >({{ result.observationType }})</span>
          </div>
          <div class="text-xs text-muted-foreground leading-relaxed memory-content overflow-hidden">
            <MarkdownRenderer :content="result.snippet" />
          </div>
          <p
            v-if="result.reason"
            class="text-xs text-violet-400/80 italic mt-1"
          >
            {{ result.reason }}
          </p>
          <span class="text-xs text-muted-foreground">{{ formatTimestamp(result.timestamp) }}</span>
        </div>
      </template>
    </div>

    <div
      v-if="activeTab === 'all'"
      class="px-4 py-3 border-t border-border/30 shrink-0"
    >
      <div class="flex gap-2">
        <div class="flex gap-0.5 shrink-0">
          <button
            v-for="opt in tierOptions"
            :key="opt.id"
            class="px-1.5 py-1 text-xs rounded-md transition-colors cursor-pointer"
            :class="newMemoryTier === opt.id
              ? 'bg-primary/15 text-primary font-medium'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'"
            @click="newMemoryTier = opt.id"
          >
            {{ opt.label }}
          </button>
        </div>
        <Input
          v-model="newMemoryContent"
          :placeholder="`Add ${newMemoryTier} memory...`"
          class="h-8 text-xs flex-1"
          @keydown="handleAddKeyDown"
        />
        <Button
          variant="default"
          size="icon-sm"
          :disabled="!newMemoryContent.trim()"
          @click="handleAdd"
        >
          <Plus :size="14" />
        </Button>
      </div>
    </div>

    <Dialog
      :open="historyDialogId !== null"
      @update:open="(v: boolean) => { if (!v) historyDialogId = null; }"
    >
      <DialogContent class="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>Earlier versions of this memory, from root to latest.</DialogDescription>
        </DialogHeader>
        <div
          v-if="historyEntries.length === 0"
          class="text-xs text-muted-foreground py-4 text-center"
        >
          No version history.
        </div>
        <div class="space-y-2">
          <div
            v-for="entry in historyEntries"
            :key="entry.id"
            class="p-2 rounded-md border border-border/50 bg-card"
            :class="entry.isLatest && 'border-l-2 border-l-primary'"
          >
            <div class="flex items-center gap-1.5 mb-1">
              <Badge
                variant="outline"
                class="text-xs h-4 px-1.5"
              >
                v{{ entry.version ?? 1 }}
              </Badge>
              <Badge
                v-if="entry.isLatest"
                variant="secondary"
                class="text-xs h-4 px-1.5"
              >
                latest
              </Badge>
              <Badge
                v-if="entry.kind"
                variant="outline"
                class="text-xs h-4 px-1.5 capitalize"
              >
                {{ entry.kind }}
              </Badge>
              <span class="text-xs text-muted-foreground ml-auto">{{ formatTimestamp(entry.updatedAt) }}</span>
            </div>
            <div class="text-xs leading-relaxed memory-content overflow-hidden">
              <MarkdownRenderer :content="entry.content" />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    <Dialog
      :open="relatedDialogId !== null"
      @update:open="(v: boolean) => { if (!v) relatedDialogId = null; }"
    >
      <DialogContent class="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Related memories</DialogTitle>
          <DialogDescription>Memories linked to this one in the fact graph.</DialogDescription>
        </DialogHeader>
        <div
          v-if="relatedEntries.length === 0"
          class="text-xs text-muted-foreground py-4 text-center"
        >
          No related memories.
        </div>
        <div class="space-y-2">
          <div
            v-for="entry in relatedEntries"
            :key="entry.id"
            class="p-2 rounded-md border border-border/50 bg-card"
          >
            <div class="flex items-center gap-1.5 mb-1 flex-wrap">
              <Badge
                v-if="entry.kind"
                variant="secondary"
                class="text-xs h-4 px-1.5 capitalize"
              >
                {{ entry.kind }}
              </Badge>
              <Badge
                v-if="entry.scope"
                variant="outline"
                class="text-xs h-4 px-1.5 capitalize"
              >
                {{ entry.scope }}
              </Badge>
              <span class="text-xs text-muted-foreground ml-auto">{{ formatTimestamp(entry.updatedAt) }}</span>
            </div>
            <div class="text-xs leading-relaxed memory-content overflow-hidden">
              <MarkdownRenderer :content="entry.content" />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
