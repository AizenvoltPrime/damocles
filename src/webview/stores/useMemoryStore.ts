import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { MemoryEntry, SearchResult } from '@shared/types/memory';

export const useMemoryStore = defineStore('memory', () => {
  const memories = ref<MemoryEntry[]>([]);
  const searchResults = ref<SearchResult[]>([]);
  const searchQuery = ref('');
  const hasMoreObservations = ref(false);
  const loadingObservations = ref(false);

  const sessionMemories = computed(() => memories.value.filter(m => m.tier === 'session'));
  const projectMemories = computed(() => memories.value.filter(m => m.tier === 'project'));
  const globalMemories = computed(() => memories.value.filter(m => m.tier === 'global'));
  const notes = computed(() => memories.value.filter(m => m.tier === 'note'));
  const observations = computed(() => memories.value.filter(m => m.tier === 'observation'));

  function setMemories(entries: MemoryEntry[], hasMore?: boolean) {
    memories.value = entries;
    hasMoreObservations.value = hasMore ?? false;
  }

  function appendObservations(entries: MemoryEntry[], hasMore: boolean) {
    const existingIds = new Set(memories.value.map(m => m.id));
    const newEntries = entries.filter(e => !existingIds.has(e.id));
    memories.value = [...memories.value, ...newEntries];
    hasMoreObservations.value = hasMore;
    loadingObservations.value = false;
  }

  function addMemory(entry: MemoryEntry) {
    memories.value = [entry, ...memories.value];
  }

  function removeMemory(id: string) {
    memories.value = memories.value.filter(m => m.id !== id);
  }

  function setSearchResults(results: SearchResult[]) {
    searchResults.value = results;
  }

  function setSearchQuery(query: string) {
    searchQuery.value = query;
  }

  function $reset() {
    memories.value = [];
    searchResults.value = [];
    searchQuery.value = '';
    hasMoreObservations.value = false;
    loadingObservations.value = false;
  }

  return {
    memories,
    searchResults,
    searchQuery,
    hasMoreObservations,
    loadingObservations,
    sessionMemories,
    projectMemories,
    globalMemories,
    notes,
    observations,
    setMemories,
    appendObservations,
    addMemory,
    removeMemory,
    setSearchResults,
    setSearchQuery,
    $reset,
  };
});
