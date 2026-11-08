import { ref, computed } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import { defineStore } from 'pinia';
import type { MemoryEntry, MemoryKind, MemoryScope, SearchResult, UserProfile, ObservationCursor } from '@shared/types/memory';
import { useUserScopeMemory, type MemoryRowSource } from '@/composables/useUserScopeMemory';

/** The last create operation the extension settled, identified by the panel's requestId. */
export interface CreateSettlement {
  requestId: string;
  ok: boolean;
}

export type KindFilter = 'all' | MemoryKind;
export type ScopeFilter = 'all' | MemoryScope;

interface MemoryStoreShape {
  separate: ComputedRef<boolean>;
  chatMemories: Ref<MemoryEntry[]>;
  userMemories: Ref<MemoryEntry[] | null>;
  userMemoryOff: Ref<boolean>;
  userMemoryFailures: Ref<number>;
  userIds: ComputedRef<ReadonlySet<string>>;
  memories: ComputedRef<MemoryEntry[]>;
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
  versionHistory: Ref<Record<MemoryRowSource, Record<string, MemoryEntry[]>>>;
  relatedMemories: Ref<Record<MemoryRowSource, Record<string, MemoryEntry[]>>>;
  profile: Ref<{ project: UserProfile; global: UserProfile }>;
  notes: ComputedRef<MemoryEntry[]>;
  observations: ComputedRef<MemoryEntry[]>;
  filteredMemories: ComputedRef<MemoryEntry[]>;
  setMemories: (entries: MemoryEntry[], hasMore?: boolean, cursor?: ObservationCursor | null) => void;
  setUserMemories: (entries: MemoryEntry[], available: boolean) => void;
  setUserMemoriesFailed: () => void;
  rowSource: (id: string) => MemoryRowSource | undefined;
  appendObservations: (entries: MemoryEntry[], hasMore: boolean, cursor: ObservationCursor | null) => void;
  addMemory: (entry: MemoryEntry) => void;
  addUserMemory: (entry: MemoryEntry) => void;
  removeMemory: (id: string, source: MemoryRowSource) => void;
  replaceMemory: (entry: MemoryEntry) => void;
  replaceMemoryChain: (oldId: string, entry: MemoryEntry) => void;
  setPinned: (id: string, pinned: boolean, source: MemoryRowSource) => void;
  setForgotten: (id: string, forgotten: boolean, source: MemoryRowSource) => void;
  settleCreate: (requestId: string, ok: boolean) => void;
  setPendingSearchQuery: (query: string | null) => void;
  setSearchResults: (results: SearchResult[], query?: string) => void;
  setSearchQuery: (query: string) => void;
  setKindFilter: (kind: KindFilter) => void;
  setScopeFilter: (scope: ScopeFilter) => void;
  setShowForgotten: (value: boolean) => void;
  setVersionHistory: (id: string, entries: MemoryEntry[], source: MemoryRowSource) => void;
  setRelatedMemories: (id: string, entries: MemoryEntry[], source: MemoryRowSource) => void;
  lastSavedProfileSection: Ref<ProfileSectionKey | null>;
  profileSectionError: Ref<{ key: ProfileSectionKey; token: number } | null>;
  setProfile: (project: UserProfile, global: UserProfile, savedSection?: ProfileSectionRef) => void;
  setUserProfile: (global: UserProfile, available: boolean, savedSection?: ProfileSectionRef) => void;
  setProfileSectionError: (scope: 'project' | 'global', section: 'static' | 'dynamic') => void;
  clearFolderData: () => void;
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

/** A row only this computer's list may show in a remote chat: a note or a global memory. */
export function fromThisComputer(entry: MemoryEntry): boolean {
  return entry.tier === 'note' || scopeOf(entry) === 'global';
}

const emptyBySource = (): Record<MemoryRowSource, Record<string, MemoryEntry[]>> => ({ chat: {}, user: {} });

export const useMemoryStore = defineStore('memory', (): MemoryStoreShape => {
  const { separate } = useUserScopeMemory();
  // the chat core's list: graph rows, then observations in its page order
  const chatMemories = ref<MemoryEntry[]>([]);
  // this computer's notes and globals in a remote chat, with this computer's own ids; null until its first answer
  const userMemories = ref<MemoryEntry[] | null>(null);
  const userMemoryOff = ref(false);
  // failed list reads of this computer's core since its last list; each failure counts, so a repeated one is seen
  const userMemoryFailures = ref(0);
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
  // keyed by the list of the asked row, so one core's answer never shows for the other core's row
  const versionHistory = ref(emptyBySource());
  const relatedMemories = ref(emptyBySource());
  const profile = ref<{ project: UserProfile; global: UserProfile }>({
    project: emptyProfile(),
    global: emptyProfile(),
  });

  // In a remote chat global rows and notes come only from this computer's list, and an id names one shown row: a host row
  // reusing one of this computer's ids is dropped, so no host text sits on a card whose actions change this computer's row.
  const shownUserMemories = computed(() => (separate.value ? userMemories.value : null));
  const userIds = computed((): ReadonlySet<string> => new Set(shownUserMemories.value?.map(m => m.id)));
  const shownChatMemories = computed(() => {
    if (!separate.value) return chatMemories.value;
    return chatMemories.value.filter(m => !fromThisComputer(m) && !userIds.value.has(m.id));
  });
  const chatIds = computed((): ReadonlySet<string> => new Set(shownChatMemories.value.map(m => m.id)));

  const memories = computed(() => {
    const user = shownUserMemories.value;
    if (user === null) return shownChatMemories.value;
    const graph = [...shownChatMemories.value.filter(m => m.tier !== 'observation'), ...user]
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return [...graph, ...shownChatMemories.value.filter(m => m.tier === 'observation')];
  });

  /** The list a reply patches: `user` only for the *User* replies, which only this computer's core sends; every other is the chat core's. */
  function listOf(source: MemoryRowSource): MemoryEntry[] {
    return source === 'user' ? userMemories.value ?? [] : chatMemories.value;
  }

  function rowSource(id: string): MemoryRowSource | undefined {
    if (userIds.value.has(id)) return 'user';
    return chatIds.value.has(id) ? 'chat' : undefined;
  }

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
    chatMemories.value = entries;
    hasMoreObservations.value = hasMore ?? false;
    observationCursor.value = cursor ?? null;
  }

  function setUserMemories(entries: MemoryEntry[], available: boolean): void {
    userMemories.value = entries;
    userMemoryOff.value = !available;
    userMemoryFailures.value = 0;
  }

  function setUserMemoriesFailed(): void {
    userMemoryFailures.value++;
  }

  function appendObservations(entries: MemoryEntry[], hasMore: boolean, cursor: ObservationCursor | null): void {
    const existingIds = new Set(chatMemories.value.map(m => m.id));
    const newEntries = entries.filter(e => !existingIds.has(e.id));
    chatMemories.value = [...chatMemories.value, ...newEntries];
    // Guard the contract: hasMore:true with a null cursor would make "Load more" an infinite no-op
    // (it re-requests from the same null cursor forever). Treat a missing cursor as end-of-list.
    hasMoreObservations.value = hasMore && cursor !== null;
    observationCursor.value = cursor;
    loadingObservations.value = false;
  }

  function addMemory(entry: MemoryEntry): void {
    chatMemories.value = [entry, ...chatMemories.value];
  }

  // Before the first list arrives that list carries the row; a list read answered between the save and this reply holds it already.
  function addUserMemory(entry: MemoryEntry): void {
    const list = userMemories.value;
    if (!list) return;
    const i = list.findIndex(m => m.id === entry.id);
    if (i !== -1) list[i] = entry;
    else userMemories.value = [entry, ...list];
  }

  function removeMemory(id: string, source: MemoryRowSource): void {
    if (source === 'chat') chatMemories.value = chatMemories.value.filter(m => m.id !== id);
    else if (userMemories.value) userMemories.value = userMemories.value.filter(m => m.id !== id);
  }

  // Version-chain edit: the old id retires and a new latest row takes its place. Splice in place at the
  // old row's index so the item keeps its position (removeMemory + prepend would jump it to the top).
  function replaceMemoryChain(oldId: string, entry: MemoryEntry): void {
    const i = chatMemories.value.findIndex(m => m.id === oldId);
    if (i !== -1) chatMemories.value[i] = entry;
    else chatMemories.value = [entry, ...chatMemories.value];
  }

  // In-place patches preserve paged-in observations + scroll (never re-assign the whole array via setMemories).
  function replaceMemory(entry: MemoryEntry): void {
    const i = chatMemories.value.findIndex(m => m.id === entry.id);
    if (i !== -1) chatMemories.value[i] = entry;
  }

  function setPinned(id: string, pinned: boolean, source: MemoryRowSource): void {
    const m = listOf(source).find(e => e.id === id);
    if (m) m.pinned = pinned;
  }

  // Flip forgotten on the clicked row AND every loaded row sharing its version chain: a chain
  // forget/unforget affects all versions, so patching only the clicked id would leave siblings
  // showing stale state until the next full refresh. A chain lives in one core, so in one list.
  function setForgotten(id: string, forgotten: boolean, source: MemoryRowSource): void {
    const list = listOf(source);
    const target = list.find(e => e.id === id);
    if (!target) return;
    const chainRoot = target.rootId ?? target.id;
    for (const m of list) {
      if (m.id === id || (m.rootId ?? m.id) === chainRoot) m.forgotten = forgotten;
    }
  }

  function settleCreate(requestId: string, ok: boolean): void {
    createSettlement.value = { requestId, ok };
  }

  // Set by clearFolderData until the next dispatch, so a reply to a search run in the previous folder never lands.
  let searchWithdrawn = false;

  function setPendingSearchQuery(query: string | null): void {
    pendingSearchQuery.value = query;
    if (query !== null) searchWithdrawn = false;
  }

  // Drop results whose query no longer matches the latest dispatched search (out-of-order A→B land).
  function setSearchResults(results: SearchResult[], query?: string): void {
    if (searchWithdrawn) return;
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

  function setVersionHistory(id: string, entries: MemoryEntry[], source: MemoryRowSource): void {
    versionHistory.value = { ...versionHistory.value, [source]: { ...versionHistory.value[source], [id]: entries } };
  }

  function setRelatedMemories(id: string, entries: MemoryEntry[], source: MemoryRowSource): void {
    relatedMemories.value = { ...relatedMemories.value, [source]: { ...relatedMemories.value[source], [id]: entries } };
  }

  const lastSavedProfileSection = ref<ProfileSectionKey | null>(null);
  // Token bumps each error so the panel's watch fires even for the same section failing twice.
  const profileSectionError = ref<{ key: ProfileSectionKey; token: number } | null>(null);

  function setProfile(project: UserProfile, global: UserProfile, savedSection?: ProfileSectionRef): void {
    // in a remote chat the global profile is this computer's (setUserProfile), never the chat core's
    profile.value = { project, global: separate.value ? profile.value.global : global };
    // A section-scoped save confirms ONLY that section; a broadcast (no savedSection) confirms none,
    // so the panel re-seeds only clean sections and never clobbers an unsaved draft in another.
    const confirms = savedSection !== undefined && !(separate.value && savedSection.scope === 'global');
    lastSavedProfileSection.value = confirms ? profileSectionKey(savedSection) : null;
  }

  function setUserProfile(global: UserProfile, available: boolean, savedSection?: ProfileSectionRef): void {
    profile.value = { project: profile.value.project, global };
    userMemoryOff.value = !available;
    lastSavedProfileSection.value = savedSection ? profileSectionKey(savedSection) : null;
  }

  function setProfileSectionError(scope: 'project' | 'global', section: 'static' | 'dynamic'): void {
    const key = profileSectionKey({ scope, section });
    profileSectionError.value = { key, token: (profileSectionError.value?.token ?? 0) + 1 };
  }

  /** Drops everything loaded for the panel's previous folder; the user's filters survive. */
  function clearFolderData(): void {
    chatMemories.value = [];
    searchResults.value = [];
    hasMoreObservations.value = false;
    loadingObservations.value = false;
    observationCursor.value = null;
    pendingSearchQuery.value = null;
    searchWithdrawn = true;
    // this computer's list, global profile and their dialogs belong to no folder, and the folder's reload asks only the chat core
    versionHistory.value = { ...emptyBySource(), user: versionHistory.value.user };
    relatedMemories.value = { ...emptyBySource(), user: relatedMemories.value.user };
    profile.value = { project: emptyProfile(), global: separate.value ? profile.value.global : emptyProfile() };
  }

  function $reset(): void {
    chatMemories.value = [];
    userMemories.value = null;
    userMemoryOff.value = false;
    userMemoryFailures.value = 0;
    searchResults.value = [];
    searchQuery.value = '';
    hasMoreObservations.value = false;
    loadingObservations.value = false;
    observationCursor.value = null;
    createSettlement.value = null;
    pendingSearchQuery.value = null;
    searchWithdrawn = false;
    kindFilter.value = 'all';
    scopeFilter.value = 'all';
    showForgotten.value = false;
    versionHistory.value = emptyBySource();
    relatedMemories.value = emptyBySource();
    profile.value = { project: emptyProfile(), global: emptyProfile() };
    lastSavedProfileSection.value = null;
    profileSectionError.value = null;
  }

  return {
    separate,
    chatMemories,
    userMemories,
    userMemoryOff,
    userMemoryFailures,
    userIds,
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
    setUserMemories,
    setUserMemoriesFailed,
    rowSource,
    appendObservations,
    addMemory,
    addUserMemory,
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
    setUserProfile,
    setProfileSectionError,
    clearFolderData,
    $reset,
  };
});
