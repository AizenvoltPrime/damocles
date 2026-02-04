<script setup lang="ts">
import { ref, computed } from 'vue';
import type { MemoryTier, MemoryEntry, SearchResult } from '@shared/types/memory';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { IconArrowLeft, IconBrain, IconSearch, IconTrash } from '@/components/icons';
import { Plus } from 'lucide-vue-next';
import { useOverlayEscape } from '@/composables/useOverlayEscape';
import MarkdownRenderer from './MarkdownRenderer.vue';

type TabId = 'session' | 'project' | 'global' | 'note' | 'observations' | 'summaries' | 'search';

const props = defineProps<{
  sessionMemories: MemoryEntry[];
  projectMemories: MemoryEntry[];
  globalMemories: MemoryEntry[];
  notes: MemoryEntry[];
  observations: MemoryEntry[];
  autoSummaries: MemoryEntry[];
  searchResults: SearchResult[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'create', tier: MemoryTier, content: string): void;
  (e: 'delete', id: string): void;
  (e: 'search', query: string): void;
}>();

useOverlayEscape(() => emit('close'));

const activeTab = ref<TabId>('session');
const newMemoryContent = ref('');
const searchInput = ref('');

const tabs = computed(() => {
  const base: { id: TabId; label: string; count: number }[] = [
    { id: 'session', label: 'Session', count: props.sessionMemories.length },
    { id: 'project', label: 'Project', count: props.projectMemories.length },
    { id: 'global', label: 'Global', count: props.globalMemories.length },
    { id: 'note', label: 'Notes', count: props.notes.length },
    { id: 'observations', label: 'Observations', count: props.observations.length },
    { id: 'summaries', label: 'Summaries', count: props.autoSummaries.length },
  ];
  if (props.searchResults.length > 0) {
    base.push({ id: 'search', label: 'Results', count: props.searchResults.length });
  }
  return base;
});

const currentTierForAdd = computed<MemoryTier | null>(() => {
  const tab = activeTab.value;
  if (tab === 'session' || tab === 'project' || tab === 'global' || tab === 'note') return tab;
  return null;
});

function handleAdd() {
  const tier = currentTierForAdd.value;
  if (!tier || !newMemoryContent.value.trim()) return;
  emit('create', tier, newMemoryContent.value.trim());
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
    emit('search', query);
    activeTab.value = 'search';
  }
}

function handleSearchKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleSearch();
  }
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
    <!-- Header -->
    <header class="flex items-center gap-3 px-4 py-3 bg-muted border-b border-border/30 shrink-0">
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground hover:bg-background shrink-0"
        @click="emit('close')"
      >
        <IconArrowLeft :size="18" />
      </Button>

      <IconBrain :size="20" class="text-primary shrink-0" />

      <div class="flex-1 min-w-0">
        <h2 class="text-sm font-medium text-foreground">Memory</h2>
        <p class="text-xs text-muted-foreground">Browse and manage memories</p>
      </div>
    </header>

    <!-- Search bar -->
    <div class="px-4 py-2 flex gap-2 border-b border-border/30">
      <Input
        v-model="searchInput"
        placeholder="Search all memories..."
        class="h-8 text-xs"
        @keydown="handleSearchKeyDown"
      />
      <Button variant="ghost" size="icon-sm" @click="handleSearch" :disabled="!searchInput.trim()">
        <IconSearch :size="14" />
      </Button>
    </div>

    <!-- Tab bar -->
    <div class="px-4 py-1.5 flex gap-0.5 overflow-x-auto border-b border-border/30">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="px-2 py-1 text-[11px] rounded-md transition-colors shrink-0 flex items-center gap-1 cursor-pointer"
        :class="activeTab === tab.id
          ? 'bg-primary/15 text-primary font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted'"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
        <span v-if="tab.count" class="bg-muted text-muted-foreground text-[10px] px-1 rounded">{{ tab.count }}</span>
      </button>
    </div>

    <!-- Scrollable content -->
    <div class="flex-1 overflow-y-auto p-4">
      <!-- Session Memories -->
      <template v-if="activeTab === 'session'">
        <div v-if="sessionMemories.length === 0" class="text-center text-xs text-muted-foreground py-8">
          No session memories yet. Use <code class="bg-muted px-1 rounded">/remember</code> to save one.
        </div>
        <div v-for="memory in sessionMemories" :key="memory.id" class="group mb-2 p-2 rounded-md border border-border/50 hover:border-border bg-card">
          <div class="flex items-start justify-between gap-2">
            <div class="text-xs leading-relaxed flex-1 memory-content overflow-hidden">
              <MarkdownRenderer :content="memory.content" />
            </div>
            <Button variant="ghost" size="icon-sm" class="opacity-0 group-hover:opacity-100 shrink-0" @click="emit('delete', memory.id)">
              <IconTrash :size="12" />
            </Button>
          </div>
          <div class="flex items-center gap-1 mt-1.5">
            <Badge v-for="tag in memory.tags" :key="tag" variant="outline" class="text-[10px] h-4 px-1">{{ tag }}</Badge>
            <span class="text-[10px] text-muted-foreground ml-auto">{{ formatTimestamp(memory.createdAt) }}</span>
          </div>
        </div>
      </template>

      <!-- Project Memories -->
      <template v-if="activeTab === 'project'">
        <div v-if="projectMemories.length === 0" class="text-center text-xs text-muted-foreground py-8">
          No project memories. Use <code class="bg-muted px-1 rounded">/remember project: text</code> to save one.
        </div>
        <div v-for="memory in projectMemories" :key="memory.id" class="group mb-2 p-2 rounded-md border border-border/50 hover:border-border bg-card">
          <div class="flex items-start justify-between gap-2">
            <div class="text-xs leading-relaxed flex-1 memory-content overflow-hidden">
              <MarkdownRenderer :content="memory.content" />
            </div>
            <Button variant="ghost" size="icon-sm" class="opacity-0 group-hover:opacity-100 shrink-0" @click="emit('delete', memory.id)">
              <IconTrash :size="12" />
            </Button>
          </div>
          <div class="flex items-center gap-1 mt-1.5">
            <Badge v-for="tag in memory.tags" :key="tag" variant="outline" class="text-[10px] h-4 px-1">{{ tag }}</Badge>
            <span class="text-[10px] text-muted-foreground ml-auto">{{ formatTimestamp(memory.createdAt) }}</span>
          </div>
        </div>
      </template>

      <!-- Global Memories -->
      <template v-if="activeTab === 'global'">
        <div v-if="globalMemories.length === 0" class="text-center text-xs text-muted-foreground py-8">
          No global memories. Use <code class="bg-muted px-1 rounded">/remember global: text</code> to save one.
        </div>
        <div v-for="memory in globalMemories" :key="memory.id" class="group mb-2 p-2 rounded-md border border-border/50 hover:border-border bg-card">
          <div class="flex items-start justify-between gap-2">
            <div class="text-xs leading-relaxed flex-1 memory-content overflow-hidden">
              <MarkdownRenderer :content="memory.content" />
            </div>
            <Button variant="ghost" size="icon-sm" class="opacity-0 group-hover:opacity-100 shrink-0" @click="emit('delete', memory.id)">
              <IconTrash :size="12" />
            </Button>
          </div>
          <div class="flex items-center gap-1 mt-1.5">
            <Badge v-for="tag in memory.tags" :key="tag" variant="outline" class="text-[10px] h-4 px-1">{{ tag }}</Badge>
            <span class="text-[10px] text-muted-foreground ml-auto">{{ formatTimestamp(memory.createdAt) }}</span>
          </div>
        </div>
      </template>

      <!-- Notes -->
      <template v-if="activeTab === 'note'">
        <div v-if="notes.length === 0" class="text-center text-xs text-muted-foreground py-8">
          No notes yet. Use <code class="bg-muted px-1 rounded">/note text</code> to save one.
        </div>
        <div v-for="memory in notes" :key="memory.id" class="group mb-2 p-2 rounded-md border border-border/50 hover:border-border bg-card">
          <div class="flex items-start justify-between gap-2">
            <div class="text-xs leading-relaxed flex-1 memory-content overflow-hidden">
              <MarkdownRenderer :content="memory.content" />
            </div>
            <Button variant="ghost" size="icon-sm" class="opacity-0 group-hover:opacity-100 shrink-0" @click="emit('delete', memory.id)">
              <IconTrash :size="12" />
            </Button>
          </div>
          <div class="flex items-center gap-1 mt-1.5">
            <Badge v-for="tag in memory.tags" :key="tag" variant="outline" class="text-[10px] h-4 px-1">{{ tag }}</Badge>
            <span class="text-[10px] text-muted-foreground ml-auto">{{ formatTimestamp(memory.createdAt) }}</span>
          </div>
        </div>
      </template>

      <!-- Observations -->
      <template v-if="activeTab === 'observations'">
        <div v-if="observations.length === 0" class="text-center text-xs text-muted-foreground py-8">
          No observations yet. Claude will record observations as it works.
        </div>
        <div v-for="memory in observations" :key="memory.id" class="mb-2 p-2 rounded-md border border-border/50 bg-card">
          <div class="flex items-center gap-1.5 mb-1">
            <Badge v-if="memory.observationType" variant="secondary" class="text-[10px] h-4 px-1.5">{{ memory.observationType }}</Badge>
            <span v-if="memory.title" class="text-xs font-medium truncate">{{ memory.title }}</span>
          </div>
          <div class="text-[11px] text-muted-foreground leading-relaxed memory-content overflow-hidden">
            <MarkdownRenderer :content="memory.content" />
          </div>
          <div v-if="memory.facts && memory.facts.length > 0" class="mt-1.5 space-y-0.5">
            <p v-for="(fact, i) in memory.facts.slice(0, 3)" :key="i" class="text-[10px] text-muted-foreground/80 pl-2 border-l border-border">
              {{ fact }}
            </p>
          </div>
          <div class="flex items-center gap-1 mt-1.5 flex-wrap">
            <Badge v-for="tag in (memory.observationTags ?? [])" :key="tag" variant="outline" class="text-[9px] h-3.5 px-1">{{ tag }}</Badge>
            <span class="text-[10px] text-muted-foreground ml-auto">{{ formatTimestamp(memory.createdAt) }}</span>
          </div>
        </div>
      </template>

      <!-- Summaries -->
      <template v-if="activeTab === 'summaries'">
        <div v-if="autoSummaries.length === 0" class="text-center text-xs text-muted-foreground py-8">
          No summaries yet. Summaries are captured automatically when context is compacted.
        </div>
        <div v-for="memory in autoSummaries" :key="memory.id" class="mb-2 p-2 rounded-md border border-border/50 bg-card">
          <div class="flex items-center gap-1.5 mb-1">
            <Badge variant="secondary" class="text-[10px] h-4 px-1.5">auto-summary</Badge>
            <span class="text-[10px] text-muted-foreground ml-auto">{{ formatTimestamp(memory.createdAt) }}</span>
          </div>
          <div class="text-[11px] text-muted-foreground leading-relaxed memory-content overflow-hidden">
            <MarkdownRenderer :content="memory.content" />
          </div>
        </div>
      </template>

      <!-- Search Results -->
      <template v-if="activeTab === 'search'">
        <div v-if="searchResults.length === 0" class="text-center text-xs text-muted-foreground py-8">
          No results found.
        </div>
        <div v-for="result in searchResults" :key="result.id" class="mb-2 p-2 rounded-md border border-border/50 bg-card">
          <div class="flex items-center gap-1.5 mb-1">
            <Badge variant="secondary" class="text-[10px] h-4 px-1.5">{{ result.tier }}</Badge>
            <span v-if="result.title" class="text-xs font-medium truncate">{{ result.title }}</span>
            <span v-if="result.observationType" class="text-[10px] text-muted-foreground">({{ result.observationType }})</span>
          </div>
          <div class="text-[11px] text-muted-foreground leading-relaxed memory-content overflow-hidden">
            <MarkdownRenderer :content="result.snippet" />
          </div>
          <span class="text-[10px] text-muted-foreground">{{ formatTimestamp(result.timestamp) }}</span>
        </div>
      </template>
    </div>

    <!-- Quick-add input (visible for session/project/global/note tabs) -->
    <div v-if="currentTierForAdd" class="px-4 py-3 border-t border-border/30 shrink-0">
      <div class="flex gap-2">
        <Input
          v-model="newMemoryContent"
          :placeholder="`Add ${activeTab} memory...`"
          class="h-8 text-xs flex-1"
          @keydown="handleAddKeyDown"
        />
        <Button variant="default" size="icon-sm" @click="handleAdd" :disabled="!newMemoryContent.trim()">
          <Plus :size="14" />
        </Button>
      </div>
    </div>
  </div>
</template>
