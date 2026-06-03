import { ref, computed } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import { defineStore } from 'pinia';
import type { MemoryEntry, MemoryKind, MemoryScope, SearchResult, UserProfile } from '@shared/types/memory';

export type KindFilter = 'all' | MemoryKind;
export type ScopeFilter = 'all' | MemoryScope;

interface MemoryStoreShape {
  memories: Ref<MemoryEntry[]>;
  searchResults: Ref<SearchResult[]>;
  searchQuery: Ref<string>;
  hasMoreObservations: Ref<boolean>;
  loadingObservations: Ref<boolean>;
  kindFilter: Ref<KindFilter>;
  scopeFilter: Ref<ScopeFilter>;
  showForgotten: Ref<boolean>;
  versionHistory: Ref<Record<string, MemoryEntry[]>>;
  relatedMemories: Ref<Record<string, MemoryEntry[]>>;
  profile: Ref<{ project: UserProfile; global: UserProfile }>;
  notes: ComputedRef<MemoryEntry[]>;
  observations: ComputedRef<MemoryEntry[]>;
  filteredMemories: ComputedRef<MemoryEntry[]>;
  setMemories: (entries: MemoryEntry[], hasMore?: boolean) => void;
  appendObservations: (entries: MemoryEntry[], hasMore: boolean) => void;
  addMemory: (entry: MemoryEntry) => void;
  removeMemory: (id: string) => void;
  setSearchResults: (results: SearchResult[]) => void;
  setSearchQuery: (query: string) => void;
  setKindFilter: (kind: KindFilter) => void;
  setScopeFilter: (scope: ScopeFilter) => void;
  setShowForgotten: (value: boolean) => void;
  setVersionHistory: (id: string, entries: MemoryEntry[]) => void;
  setRelatedMemories: (id: string, entries: MemoryEntry[]) => void;
  setProfile: (project: UserProfile, global: UserProfile) => void;
  $reset: () => void;
}

const emptyProfile = (): UserProfile => ({ static: '', dynamic: '' });

function scopeOf(entry: MemoryEntry): MemoryScope | undefined {
  if (entry.scope) return entry.scope;
  if (entry.tier === 'session' || entry.tier === 'project' || entry.tier === 'global') return entry.tier;
  return undefined;
}

export const useMemoryStore = defineStore('memory', (): MemoryStoreShape => {
  const memories = ref<MemoryEntry[]>([]);
  const searchResults = ref<SearchResult[]>([]);
  const searchQuery = ref('');
  const hasMoreObservations = ref(false);
  const loadingObservations = ref(false);
  const kindFilter = ref<KindFilter>('all');
  const scopeFilter = ref<ScopeFilter>('all');
  const showForgotten = ref(false);
  const versionHistory = ref<Record<string, MemoryEntry[]>>({});
  const relatedMemories = ref<Record<string, MemoryEntry[]>>({});
  const profile = ref<{ project: UserProfile; global: UserProfile }>({
    project: emptyProfile(),
    global: emptyProfile(),
  });

  const notes = computed(() => memories.value.filter(m => m.tier === 'note'));
  const observations = computed(() => memories.value.filter(m => m.tier === 'observation'));

  const filteredMemories = computed(() =>
    memories.value.filter(m => {
      if (m.kind === 'note' || m.kind === 'observation') return false;
      if (!showForgotten.value && m.forgotten) return false;
      if (kindFilter.value !== 'all' && m.kind !== kindFilter.value) return false;
      if (scopeFilter.value !== 'all' && scopeOf(m) !== scopeFilter.value) return false;
      return true;
    })
  );

  function setMemories(entries: MemoryEntry[], hasMore?: boolean): void {
    memories.value = entries;
    hasMoreObservations.value = hasMore ?? false;
  }

  function appendObservations(entries: MemoryEntry[], hasMore: boolean): void {
    const existingIds = new Set(memories.value.map(m => m.id));
    const newEntries = entries.filter(e => !existingIds.has(e.id));
    memories.value = [...memories.value, ...newEntries];
    hasMoreObservations.value = hasMore;
    loadingObservations.value = false;
  }

  function addMemory(entry: MemoryEntry): void {
    memories.value = [entry, ...memories.value];
  }

  function removeMemory(id: string): void {
    memories.value = memories.value.filter(m => m.id !== id);
  }

  function setSearchResults(results: SearchResult[]): void {
    searchResults.value = results;
  }

  function setSearchQuery(query: string): void {
    searchQuery.value = query;
  }

  function setKindFilter(kind: KindFilter): void {
    kindFilter.value = kind;
  }

  function setScopeFilter(scope: ScopeFilter): void {
    scopeFilter.value = scope;
  }

  function setShowForgotten(value: boolean): void {
    showForgotten.value = value;
  }

  function setVersionHistory(id: string, entries: MemoryEntry[]): void {
    versionHistory.value = { ...versionHistory.value, [id]: entries };
  }

  function setRelatedMemories(id: string, entries: MemoryEntry[]): void {
    relatedMemories.value = { ...relatedMemories.value, [id]: entries };
  }

  function setProfile(project: UserProfile, global: UserProfile): void {
    profile.value = { project, global };
  }

  function $reset(): void {
    memories.value = [];
    searchResults.value = [];
    searchQuery.value = '';
    hasMoreObservations.value = false;
    loadingObservations.value = false;
    kindFilter.value = 'all';
    scopeFilter.value = 'all';
    showForgotten.value = false;
    versionHistory.value = {};
    relatedMemories.value = {};
    profile.value = { project: emptyProfile(), global: emptyProfile() };
  }

  return {
    memories,
    searchResults,
    searchQuery,
    hasMoreObservations,
    loadingObservations,
    kindFilter,
    scopeFilter,
    showForgotten,
    versionHistory,
    relatedMemories,
    profile,
    notes,
    observations,
    filteredMemories,
    setMemories,
    appendObservations,
    addMemory,
    removeMemory,
    setSearchResults,
    setSearchQuery,
    setKindFilter,
    setScopeFilter,
    setShowForgotten,
    setVersionHistory,
    setRelatedMemories,
    setProfile,
    $reset,
  };
});
