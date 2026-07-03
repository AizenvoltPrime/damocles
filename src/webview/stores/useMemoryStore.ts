import { ref, computed } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import { defineStore } from 'pinia';
import type { MemoryEntry, MemoryKind, MemoryScope, SearchResult, UserProfile, ObservationCursor } from '@shared/types/memory';

/** The last create operation the extension settled, identified by the panel's requestId. */
export interface CreateSettlement {
  requestId: string;
  ok: boolean;
}

export type KindFilter = 'all' | MemoryKind;
export type ScopeFilter = 'all' | MemoryScope;

interface MemoryStoreShape {
  memories: Ref<MemoryEntry[]>;
  searchResults: Ref<SearchResult[]>;
  searchQuery: Ref<string>;
  hasMoreObservations: Ref<boolean>;
  loadingObservations: Ref<boolean>;
  observationCursor: Ref<ObservationCursor | null>;
  createSettlement: Ref<CreateSettlement | null>;
  pendingSearchQuery: Ref<string | null>;
  kindFilter: Ref<KindFilter>;
  scopeFilter: Ref<ScopeFilter>;
  showForgotten: Ref<boolean>;
  versionHistory: Ref<Record<string, MemoryEntry[]>>;
  relatedMemories: Ref<Record<string, MemoryEntry[]>>;
  profile: Ref<{ project: UserProfile; global: UserProfile }>;
  notes: ComputedRef<MemoryEntry[]>;
  observations: ComputedRef<MemoryEntry[]>;
  filteredMemories: ComputedRef<MemoryEntry[]>;
  setMemories: (entries: MemoryEntry[], hasMore?: boolean, cursor?: ObservationCursor | null) => void;
  appendObservations: (entries: MemoryEntry[], hasMore: boolean, cursor: ObservationCursor | null) => void;
  addMemory: (entry: MemoryEntry) => void;
  removeMemory: (id: string) => void;
  replaceMemory: (entry: MemoryEntry) => void;
  replaceMemoryChain: (oldId: string, entry: MemoryEntry) => void;
  setPinned: (id: string, pinned: boolean) => void;
  setForgotten: (id: string, forgotten: boolean) => void;
  settleCreate: (requestId: string, ok: boolean) => void;
  setPendingSearchQuery: (query: string | null) => void;
  setSearchResults: (results: SearchResult[], query?: string) => void;
  setSearchQuery: (query: string) => void;
  setKindFilter: (kind: KindFilter) => void;
  setScopeFilter: (scope: ScopeFilter) => void;
  setShowForgotten: (value: boolean) => void;
  setVersionHistory: (id: string, entries: MemoryEntry[]) => void;
  setRelatedMemories: (id: string, entries: MemoryEntry[]) => void;
  lastSavedProfileSection: Ref<ProfileSectionKey | null>;
  profileSectionError: Ref<{ key: ProfileSectionKey; token: number } | null>;
  setProfile: (project: UserProfile, global: UserProfile, savedSection?: ProfileSectionRef) => void;
  setProfileSectionError: (scope: 'project' | 'global', section: 'static' | 'dynamic') => void;
  $reset: () => void;
}

export type ProfileSectionRef = { scope: 'project' | 'global'; section: 'static' | 'dynamic' };
export type ProfileSectionKey = 'projectStatic' | 'projectDynamic' | 'globalStatic' | 'globalDynamic';

export function profileSectionKey(ref: ProfileSectionRef): ProfileSectionKey {
  return `${ref.scope}${ref.section === 'static' ? 'Static' : 'Dynamic'}` as ProfileSectionKey;
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
  const observationCursor = ref<ObservationCursor | null>(null);
  const createSettlement = ref<CreateSettlement | null>(null);
  const pendingSearchQuery = ref<string | null>(null);
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

  function setMemories(entries: MemoryEntry[], hasMore?: boolean, cursor?: ObservationCursor | null): void {
    memories.value = entries;
    hasMoreObservations.value = hasMore ?? false;
    observationCursor.value = cursor ?? null;
  }

  function appendObservations(entries: MemoryEntry[], hasMore: boolean, cursor: ObservationCursor | null): void {
    const existingIds = new Set(memories.value.map(m => m.id));
    const newEntries = entries.filter(e => !existingIds.has(e.id));
    memories.value = [...memories.value, ...newEntries];
    // Guard the contract: hasMore:true with a null cursor would make "Load more" an infinite no-op
    // (it re-requests from the same null cursor forever). Treat a missing cursor as end-of-list.
    hasMoreObservations.value = hasMore && cursor !== null;
    observationCursor.value = cursor;
    loadingObservations.value = false;
  }

  function addMemory(entry: MemoryEntry): void {
    memories.value = [entry, ...memories.value];
  }

  function removeMemory(id: string): void {
    memories.value = memories.value.filter(m => m.id !== id);
  }

  // Version-chain edit: the old id retires and a new latest row takes its place. Splice in place at the
  // old row's index so the item keeps its position (removeMemory + prepend would jump it to the top).
  function replaceMemoryChain(oldId: string, entry: MemoryEntry): void {
    const i = memories.value.findIndex(m => m.id === oldId);
    if (i !== -1) memories.value[i] = entry;
    else memories.value = [entry, ...memories.value];
  }

  // In-place patches preserve paged-in observations + scroll (never re-assign the whole array via setMemories).
  function replaceMemory(entry: MemoryEntry): void {
    const i = memories.value.findIndex(m => m.id === entry.id);
    if (i !== -1) memories.value[i] = entry;
  }

  function setPinned(id: string, pinned: boolean): void {
    const m = memories.value.find(e => e.id === id);
    if (m) m.pinned = pinned;
  }

  // Flip forgotten on the clicked row AND every loaded row sharing its version chain: a chain
  // forget/unforget affects all versions, so patching only the clicked id would leave siblings
  // showing stale state until the next full refresh.
  function setForgotten(id: string, forgotten: boolean): void {
    const target = memories.value.find(e => e.id === id);
    if (!target) return;
    const chainRoot = target.rootId ?? target.id;
    for (const m of memories.value) {
      if (m.id === id || (m.rootId ?? m.id) === chainRoot) m.forgotten = forgotten;
    }
  }

  function settleCreate(requestId: string, ok: boolean): void {
    createSettlement.value = { requestId, ok };
  }

  function setPendingSearchQuery(query: string | null): void {
    pendingSearchQuery.value = query;
  }

  // Drop results whose query no longer matches the latest dispatched search (out-of-order A→B land).
  function setSearchResults(results: SearchResult[], query?: string): void {
    if (query !== undefined && pendingSearchQuery.value !== null && query !== pendingSearchQuery.value) return;
    searchResults.value = results;
    pendingSearchQuery.value = null;
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

  const lastSavedProfileSection = ref<ProfileSectionKey | null>(null);
  // Token bumps each error so the panel's watch fires even for the same section failing twice.
  const profileSectionError = ref<{ key: ProfileSectionKey; token: number } | null>(null);

  function setProfile(project: UserProfile, global: UserProfile, savedSection?: ProfileSectionRef): void {
    profile.value = { project, global };
    // A section-scoped save confirms ONLY that section; a broadcast (no savedSection) confirms none,
    // so the panel re-seeds only clean sections and never clobbers an unsaved draft in another.
    lastSavedProfileSection.value = savedSection ? profileSectionKey(savedSection) : null;
  }

  function setProfileSectionError(scope: 'project' | 'global', section: 'static' | 'dynamic'): void {
    const key = profileSectionKey({ scope, section });
    profileSectionError.value = { key, token: (profileSectionError.value?.token ?? 0) + 1 };
  }

  function $reset(): void {
    memories.value = [];
    searchResults.value = [];
    searchQuery.value = '';
    hasMoreObservations.value = false;
    loadingObservations.value = false;
    observationCursor.value = null;
    createSettlement.value = null;
    pendingSearchQuery.value = null;
    kindFilter.value = 'all';
    scopeFilter.value = 'all';
    showForgotten.value = false;
    versionHistory.value = {};
    relatedMemories.value = {};
    profile.value = { project: emptyProfile(), global: emptyProfile() };
    lastSavedProfileSection.value = null;
    profileSectionError.value = null;
  }

  return {
    memories,
    searchResults,
    searchQuery,
    hasMoreObservations,
    loadingObservations,
    observationCursor,
    createSettlement,
    pendingSearchQuery,
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
    replaceMemory,
    replaceMemoryChain,
    setPinned,
    setForgotten,
    settleCreate,
    setPendingSearchQuery,
    setSearchResults,
    setSearchQuery,
    setKindFilter,
    setScopeFilter,
    setShowForgotten,
    setVersionHistory,
    setRelatedMemories,
    lastSavedProfileSection,
    profileSectionError,
    setProfile,
    setProfileSectionError,
    $reset,
  };
});
