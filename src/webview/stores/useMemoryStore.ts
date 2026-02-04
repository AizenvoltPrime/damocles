import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { MemoryEntry, SearchResult } from '@shared/types/memory';

export const useMemoryStore = defineStore('memory', () => {
  const memories = ref<MemoryEntry[]>([]);
  const searchResults = ref<SearchResult[]>([]);
  const searchQuery = ref('');

  const sessionMemories = computed(() => memories.value.filter(m => m.tier === 'session'));
  const projectMemories = computed(() => memories.value.filter(m => m.tier === 'project'));
  const globalMemories = computed(() => memories.value.filter(m => m.tier === 'global'));
  const notes = computed(() => memories.value.filter(m => m.tier === 'note'));
  const observations = computed(() => memories.value.filter(m => m.tier === 'observation'));
  const autoSummaries = computed(() => memories.value.filter(m => m.tier === 'auto-summary'));

  function setMemories(entries: MemoryEntry[]) {
    memories.value = entries;
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
  }

  return {
    memories,
    searchResults,
    searchQuery,
    sessionMemories,
    projectMemories,
    globalMemories,
    notes,
    observations,
    autoSummaries,
    setMemories,
    addMemory,
    removeMemory,
    setSearchResults,
    setSearchQuery,
    $reset,
  };
});
