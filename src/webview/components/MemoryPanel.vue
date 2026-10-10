<script setup lang="ts">
import { ref, shallowRef, computed, watch, reactive, onMounted, onUnmounted, nextTick, type Component, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { toast } from 'vue-sonner';
import type { MemoryTier, MemoryEntry, MemoryKind, SearchResult } from '@shared/types/memory';
import { QUALITY_AUDIT_FORGET_REASON } from '@shared/types/memory-audit';
import { useMemoryStore, type KindFilter, type ScopeFilter } from '@/stores/useMemoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useMemoryAuditStore } from '@/stores/useMemoryAuditStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useCopyToClipboard } from '@/composables/useCopyToClipboard';
import { formatMemoryForCopy } from '@/lib/format-memory-copy';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ArrowRight, Brain, Check, ChevronRight, Copy, EyeOff, History, LoaderCircle, Network, Pin, PinOff, Plus, RotateCcw, Save, Search, ShieldCheck, Trash2, UserRound } from 'lucide-vue-next';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import MarkdownRenderer from './MarkdownRenderer.vue';
import OverlayShell from './OverlayShell.vue';
import OverlayHeaderAction from './OverlayHeaderAction.vue';
import SegmentedToggle, { type SegmentedOption } from './SegmentedToggle.vue';
import SlidingIndicator from './SlidingIndicator.vue';
import { isStaleMemory } from '@shared/memory-staleness';

type TabId = 'all' | 'note' | 'observations' | 'search';
/** Observations are written by the agent, never created from this panel, so the create path excludes that tier. */
type MemoryCreateTier = Exclude<MemoryTier, 'observation'>;
type MemoryCreateKind = 'fact' | 'preference' | 'episode';

const props = defineProps<{
  notes: MemoryEntry[];
  observations: MemoryEntry[];
  searchResults: SearchResult[];
  hasMoreObservations: boolean;
  loadingObservations: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'create', payload: { tier: MemoryCreateTier; kind: MemoryCreateKind; content: string; requestId: string }): void;
  (e: 'delete', id: string): void;
  (e: 'pin', id: string): void;
  (e: 'unpin', id: string): void;
  (e: 'loadMoreObservations'): void;
}>();

/** A nested dialog is above this panel, so it answers first and the panel stays open behind it. */
function requestClose(): void {
  if (historyDialogId.value !== null || relatedDialogId.value !== null) return;
  emit('close');
}

const { t, te, locale } = useI18n();

const scoreFormat = computed(() => new Intl.NumberFormat(locale.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
/** A classifier grade renders as a localized verdict; `reason` is model-facing English. */
function searchReason(result: SearchResult): string | undefined {
  if (result.rerankRelevance === undefined || result.rerankClassifierScore === undefined) return result.reason;
  return t('contextInjection.rerankClassifier', {
    verdict: t(`contextInjection.rerankVerdict.${result.rerankRelevance}`),
    score: scoreFormat.value.format(result.rerankClassifierScore),
  });
}

// Stored kind, scope and tier values render through the memory.kind / memory.scope labels; an unknown value shows as stored.
function kindLabel(kind: string): string {
  return te(`memory.kind.${kind}`) ? t(`memory.kind.${kind}`) : kind;
}
function scopeLabel(scope: string): string {
  return te(`memory.scope.${scope}`) ? t(`memory.scope.${scope}`) : scope;
}
function tierLabel(tier: string): string {
  return te(`memory.scope.${tier}`) ? scopeLabel(tier) : kindLabel(tier);
}
const store = useMemoryStore();
const settingsStore = useSettingsStore();
const auditStore = useMemoryAuditStore();
const { postMessage } = usePlatformBridge();

onMounted(() => auditStore.requestSummary());

const activeTab = ref<TabId>('all');
const newMemoryContent = ref('');
const newMemoryTier = ref<MemoryCreateTier>('project');
const newMemoryKind = ref<MemoryCreateKind>('fact');
const pendingCreate = ref(false);
// Correlates this panel's in-flight create with its settlement so a chat /remember or a failed
// pin/delete can never clear our pending-create state.
const pendingCreateRequestId = ref<string | null>(null);
const searchInput = ref('');
const hasSearched = ref(false);
const searchedQuery = ref('');
const searchPending = ref(false);
const scrollContainerRef = ref<HTMLElement | null>(null);

const historyDialogId = ref<string | null>(null);
const relatedDialogId = ref<string | null>(null);
const profileExpanded = ref(false);

const kindOptions = computed<SegmentedOption<KindFilter>[]>(() => [
  { value: 'all', label: t('memoryPanel.allKinds') },
  { value: 'fact', label: kindLabel('fact') },
  { value: 'preference', label: kindLabel('preference') },
  { value: 'episode', label: kindLabel('episode') },
]);

const scopeOptions = computed<SegmentedOption<ScopeFilter>[]>(() => [
  { value: 'all', label: t('memoryPanel.allScopes') },
  { value: 'session', label: scopeLabel('session') },
  { value: 'project', label: scopeLabel('project') },
  { value: 'global', label: scopeLabel('global') },
]);

const tierOptions = computed<SegmentedOption<MemoryCreateTier>[]>(() => [
  { value: 'session', label: scopeLabel('session') },
  { value: 'project', label: scopeLabel('project') },
  { value: 'global', label: scopeLabel('global') },
  { value: 'note', label: kindLabel('note') },
]);

const createKindOptions = computed<SegmentedOption<MemoryCreateKind>[]>(() => [
  { value: 'fact', label: kindLabel('fact') },
  { value: 'preference', label: kindLabel('preference') },
  { value: 'episode', label: kindLabel('episode') },
]);

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

const hasDraft = computed(() => newMemoryContent.value.trim() !== '' || Object.values(profileDirty).some(Boolean));

interface ProfileSection {
  key: keyof typeof profileDirty;
  scope: 'project' | 'global';
  section: 'static' | 'dynamic';
  label: string;
  placeholder: string;
  model: Ref<string>;
}

const profileSections = computed<ProfileSection[]>(() => [
  { key: 'projectStatic', scope: 'project', section: 'static', label: `${scopeLabel('project')} · ${t('memoryPanel.profileStatic')}`, placeholder: t('memoryPanel.projectStaticPlaceholder'), model: profileStaticProject },
  { key: 'projectDynamic', scope: 'project', section: 'dynamic', label: `${scopeLabel('project')} · ${t('memoryPanel.profileDynamic')}`, placeholder: t('memoryPanel.dynamicPlaceholder'), model: profileDynamicProject },
  { key: 'globalStatic', scope: 'global', section: 'static', label: `${scopeLabel('global')} · ${t('memoryPanel.profileStatic')}`, placeholder: t('memoryPanel.globalStaticPlaceholder'), model: profileStaticGlobal },
  { key: 'globalDynamic', scope: 'global', section: 'dynamic', label: `${scopeLabel('global')} · ${t('memoryPanel.profileDynamic')}`, placeholder: t('memoryPanel.dynamicPlaceholder'), model: profileDynamicGlobal },
]);

function onProfileInput(section: ProfileSection, value: string): void {
  section.model.value = value;
  profileDirty[section.key] = true;
}

/**
 * Sections with an in-flight save. A section stays dirty until its save round-trips: the handler
 * posts profileData only on success, which confirms the save and lets us clear dirty and re-seed. A
 * failed save posts no profileData, so dirty stays set and the draft survives.
 */
const profilePending = reactive({
  projectStatic: false,
  projectDynamic: false,
  globalStatic: false,
  globalDynamic: false,
});

/**
 * Re-seed only the textareas the user hasn't edited. A profileData broadcast re-fires this watcher,
 * so a plain dirty guard is not enough: on a section save we confirm ONLY the section the server
 * echoed (store.lastSavedProfileSection), clearing just its pending+dirty flags. Other sections keep
 * their unsaved drafts. A broadcast with no savedSection confirms nothing.
 */
function syncProfileDrafts() {
  const saved = store.lastSavedProfileSection;
  if (saved && profilePending[saved]) {
    profilePending[saved] = false;
    profileDirty[saved] = false;
  }
  if (!profileDirty.projectStatic) profileStaticProject.value = store.profile.project.static;
  if (!profileDirty.projectDynamic) profileDynamicProject.value = store.profile.project.dynamic;
  if (!profileDirty.globalStatic) profileStaticGlobal.value = store.profile.global.static;
  if (!profileDirty.globalDynamic) profileDynamicGlobal.value = store.profile.global.dynamic;
}

watch(() => store.profile, syncProfileDrafts, { immediate: true });

// A failed section save clears only that section's pending flag (draft stays, dirty stays) so a later
// unrelated profileData can't overwrite the user's unsaved edit with the old server value.
watch(() => store.profileSectionError, (err) => {
  if (err) profilePending[err.key] = false;
});

function handleScroll() {
  if (activeTab.value !== 'observations' || !props.hasMoreObservations || props.loadingObservations) return;
  const container = scrollContainerRef.value;
  if (!container) return;
  const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (scrollBottom < 50) {
    emit('loadMoreObservations');
  }
}

const tabList = shallowRef<HTMLElement | null>(null);
const tabs = computed(() => {
  const base: { id: TabId; label: string; count: number; hasMore?: boolean }[] = [
    { id: 'all', label: t('memoryPanel.tabs.memories'), count: store.filteredMemories.length },
    { id: 'note', label: t('memoryPanel.tabs.notes'), count: props.notes.length },
    { id: 'observations', label: t('memoryPanel.tabs.observations'), count: props.observations.length, hasMore: props.hasMoreObservations },
  ];
  if (hasSearched.value) {
    base.push({ id: 'search', label: t('memoryPanel.tabs.results'), count: searchPending.value ? 0 : props.searchResults.length });
  }
  return base;
});

const activeTabIndex = computed(() => tabs.value.findIndex((tab) => tab.id === activeTab.value));
const { box: tabBox, animate: tabAnimate } = useSlidingIndicator(tabList, '[role="tab"]', activeTabIndex);

function onTabKeydown(event: KeyboardEvent): void {
  const count = tabs.value.length;
  const step = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[event.key];
  let next: number | undefined;
  if (step !== undefined) next = (activeTabIndex.value + step + count) % count;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = count - 1;
  const tab = next === undefined ? undefined : tabs.value[next];
  if (!tab) return;
  event.preventDefault();
  activeTab.value = tab.id;
  void nextTick(() => tabList.value?.querySelector<HTMLElement>(`[data-tab="${tab.id}"]`)?.focus());
}

// Settle only OUR create: the store echoes the requestId the extension returned. A success clears the
// input (keeping the last-used kind); a failure preserves the text so the user can retry. A
// settlement for any other requestId (or none) is ignored.
watch(() => store.createSettlement, (settlement) => {
  if (!settlement || settlement.requestId !== pendingCreateRequestId.value) return;
  pendingCreate.value = false;
  pendingCreateRequestId.value = null;
  if (settlement.ok) newMemoryContent.value = '';
});

function handleAdd() {
  if (!newMemoryContent.value.trim() || pendingCreate.value) return;
  const requestId = `create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pendingCreate.value = true;
  pendingCreateRequestId.value = requestId;
  emit('create', {
    tier: newMemoryTier.value,
    kind: newMemoryKind.value,
    content: newMemoryContent.value.trim(),
    requestId,
  });
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
    store.setPendingSearchQuery(query);
    postMessage({ type: 'searchMemories', query: { query, includeForgotten: store.showForgotten } });
    hasSearched.value = true;
    searchedQuery.value = query;
    searchPending.value = true;
    activeTab.value = 'search';
  }
}

// The results prop lags the dispatched query; clear pending only once the new results land, so the
// Results tab never shows the previous query's rows under the new query's label. The store already
// discards results whose query doesn't match the latest dispatch, so a stale A→B landing won't fire.
watch(() => props.searchResults, () => { searchPending.value = false; });

// A failed search clears the store's pending query (via memoryError) but posts no results, so mirror
// that here or the local "Searching…" placeholder would hang forever.
watch(() => store.pendingSearchQuery, (q) => { if (q === null) searchPending.value = false; });

// Clearing the box retires the Results tab; fall back to the memories tab if it was active.
watch(() => searchInput.value.trim(), (query) => {
  if (!query) {
    hasSearched.value = false;
    searchPending.value = false;
    if (activeTab.value === 'search') activeTab.value = 'all';
  }
});

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
    profilePending.projectStatic = false;
    profilePending.projectDynamic = false;
    profilePending.globalStatic = false;
    profilePending.globalDynamic = false;
    syncProfileDrafts();
  }
}

// A search and a project profile draft belong to the folder they were made in; Save would write the
// draft into the new folder's profile. Global drafts are not folder-bound and stay.
watch(() => settingsStore.panelWorkspaceFolderKey, () => {
  searchInput.value = '';
  profileDirty.projectStatic = false;
  profileDirty.projectDynamic = false;
  profilePending.projectStatic = false;
  profilePending.projectDynamic = false;
  syncProfileDrafts();
});

function saveProfileSection(scope: 'project' | 'global', section: 'static' | 'dynamic', content: string) {
  postMessage({ type: 'setProfileSection', scope, section, content });
  const key = `${scope}${section === 'static' ? 'Static' : 'Dynamic'}` as keyof typeof profileDirty;
  // Keep the section dirty until the save confirms; a failed save posts no profileData, so the draft
  // is preserved instead of being optimistically discarded.
  profilePending[key] = true;
}

function formatTimestamp(epoch: number): string {
  const now = Date.now();
  const diff = now - epoch;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('time.daysAgo', { n: days });
  return new Date(epoch).toLocaleDateString();
}

const { copyToClipboard } = useCopyToClipboard();
const copiedId = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
// Monotonic click sequence: the clipboard write is async, so two rapid clicks (A then B) can resolve
// out of order. We stamp each click and apply its result only if it is still the latest — otherwise a
// slow-resolving earlier click would move the checkmark onto the wrong item.
let copySeq = 0;

async function handleCopy(memory: MemoryEntry) {
  const seq = ++copySeq;
  const ok = await copyToClipboard(formatMemoryForCopy(memory));
  if (!ok || seq !== copySeq) return;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedId.value = memory.id;
  copiedTimer = setTimeout(() => {
    copiedId.value = null;
  }, 2000);
}

interface MemoryAction {
  id: string;
  label: string;
  icon: Component;
  class: string;
  run: () => void;
}

/** A row's actions; `full` adds history, related and forget, which only kind/scope memories have. */
function memoryActions(memory: MemoryEntry, full = true): MemoryAction[] {
  const copied = copiedId.value === memory.id;
  const actions: MemoryAction[] = [
    { id: 'copy', label: copied ? t('memoryPanel.copiedAria') : t('memoryPanel.copyAria'), icon: copied ? Check : Copy, class: copied ? 'text-(--d-success)' : 'text-(--d-muted) hover:text-(--d-text)', run: () => void handleCopy(memory) },
    memory.pinned
      ? { id: 'unpin', label: t('memoryPanel.unpin'), icon: PinOff, class: 'text-(--d-warning)', run: () => emit('unpin', memory.id) }
      : { id: 'pin', label: t('memoryPanel.pin'), icon: Pin, class: 'text-(--d-muted) hover:text-(--d-text)', run: () => emit('pin', memory.id) },
  ];
  if (full) {
    actions.push(
      { id: 'history', label: t('memoryPanel.versionHistory'), icon: History, class: 'text-(--d-muted) hover:text-(--d-text)', run: () => openHistory(memory.id) },
      { id: 'related', label: t('memoryPanel.relatedMemories'), icon: Network, class: 'text-(--d-muted) hover:text-(--d-text)', run: () => openRelated(memory.id) },
      memory.forgotten
        ? { id: 'restore', label: t('memoryPanel.restore'), icon: RotateCcw, class: 'text-(--d-success)', run: () => handleUnforget(memory.id) }
        : { id: 'forget', label: t('memoryPanel.forget'), icon: EyeOff, class: 'text-(--d-muted) hover:text-(--d-text)', run: () => handleForget(memory.id) },
    );
  }
  actions.push({ id: 'delete', label: t('common.delete'), icon: Trash2, class: 'text-(--d-muted) hover:text-(--d-danger)', run: () => emit('delete', memory.id) });
  return actions;
}

function rowClass(memory: MemoryEntry): string[] {
  return [
    memory.pinned
      ? 'border-[color-mix(in_srgb,var(--d-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--d-warning)_6%,var(--d-card))]'
      : 'border-(--d-border) bg-(--d-card)',
    memory.forgotten ? 'opacity-50' : '',
    highlightedId.value === memory.id ? 'ring-2 ring-(--d-accent)' : '',
  ];
}

// Rows rise in only while the panel opens; switching tabs or filters re-renders them in place.
const arriving = ref(true);
let arrivalTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
  arriving.value = false;
  arrivalTimer = undefined;
}, 600);

const uiStore = useUIStore();
const MAX_FOCUS_PAGES = 5;
const FOCUS_HIGHLIGHT_MS = 2000;
const highlightedId = ref<string | null>(null);
let focusPagesRequested = 0;
let highlightTimer: ReturnType<typeof setTimeout> | undefined;

function tabForKind(kind: MemoryKind): TabId {
  if (kind === 'note') return 'note';
  if (kind === 'observation') return 'observations';
  return 'all';
}

function rowsOf(tab: TabId): readonly MemoryEntry[] {
  if (tab === 'note') return props.notes;
  if (tab === 'observations') return props.observations;
  return store.filteredMemories;
}

async function revealFocused(id: string): Promise<void> {
  uiStore.clearMemoryPanelFocus();
  highlightedId.value = id;
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightedId.value = null;
  }, FOCUS_HIGHLIGHT_MS);
  await nextTick();
  const row = Array.from(scrollContainerRef.value?.querySelectorAll<HTMLElement>('[data-memory-id]') ?? [])
    .find((el) => el.dataset.memoryId === id);
  row?.scrollIntoView({ block: 'center' });
  row?.focus({ preventScroll: true });
}

/** `loaded` is false until a memory list arrives after the focus request; until then a miss only waits. */
function applyFocus(loaded: boolean): void {
  const focus = uiStore.memoryPanelFocus;
  if (!focus) return;
  const target = store.memories.find((m) => m.id === focus.id);
  if (target?.forgotten && activeTab.value === 'all') store.setShowForgotten(true);
  if (rowsOf(activeTab.value).some((m) => m.id === focus.id)) {
    void revealFocused(focus.id);
    return;
  }
  if (!loaded) return;
  if (focus.kind === 'observation' && props.hasMoreObservations && focusPagesRequested < MAX_FOCUS_PAGES) {
    focusPagesRequested++;
    emit('loadMoreObservations');
    return;
  }
  uiStore.clearMemoryPanelFocus();
  toast.info(t('contextInjection.action.notInPanel'));
}

watch(() => store.memories, () => applyFocus(true));

// The panel owns its list request, sent only once the watcher above can see the reply.
watch(() => uiStore.memoryPanelFocus, (focus) => {
  if (!focus) return;
  store.setKindFilter('all');
  store.setScopeFilter('all');
  activeTab.value = tabForKind(focus.kind);
  focusPagesRequested = 0;
  applyFocus(false);
  if (uiStore.memoryPanelFocus) postMessage({ type: 'requestMemories' });
}, { immediate: true });

onMounted(() => {
  if (!uiStore.memoryPanelFocus) postMessage({ type: 'requestMemories' });
});

onUnmounted(() => {
  if (arrivalTimer) clearTimeout(arrivalTimer);
  if (copiedTimer) clearTimeout(copiedTimer);
  if (highlightTimer) clearTimeout(highlightTimer);
});
</script>

<template>
  <OverlayShell
    :title="t('memoryPanel.title')"
    :subtitle="t('memoryPanel.subtitle')"
    :icon="Brain"
    max-width="62.5rem"
    fill
    :has-draft="hasDraft"
    data-testid="memory-panel"
    @close="requestClose"
  >
    <template #header-actions>
      <OverlayHeaderAction
        :label="t('memoryAudit.openButton')"
        :icon="ShieldCheck"
        icon-only
        data-audit-open
        @click="auditStore.openOverlay()"
      />
    </template>

    <div
      ref="scrollContainerRef"
      class="flex h-full flex-col gap-3 overflow-y-auto px-4 pt-3 pb-4.5"
      @scroll="handleScroll"
    >
      <div
        v-if="auditStore.showBanner"
        class="flex flex-wrap items-center gap-2 rounded-10 bg-(--d-accent-soft) px-3 py-2 text-xs"
        data-audit-banner
      >
        <ShieldCheck
          class="size-3.5 flex-none text-(--d-accent)"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1">{{ t('memoryAudit.banner.text', { count: auditStore.summary?.eligibleCount ?? 0 }) }}</span>
        <button
          type="button"
          class="d-press h-6.5 rounded-md bg-(--d-accent) px-2.5 font-semibold text-(--d-on-accent) transition-[filter] hover:brightness-110"
          data-audit-banner-open
          @click="auditStore.openOverlay()"
        >
          {{ t('memoryAudit.banner.action') }}
        </button>
        <button
          type="button"
          class="h-6.5 rounded-md px-2.5 text-(--d-muted) transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
          :aria-label="t('memoryAudit.banner.dismissLabel')"
          data-audit-banner-dismiss
          @click="auditStore.dismissBanner()"
        >
          {{ t('memoryAudit.banner.dismiss') }}
        </button>
      </div>

      <div class="flex flex-col gap-2.5">
        <label class="flex h-8.5 items-center gap-2 rounded-10 border border-(--d-border2) bg-(--d-input) pr-1 pl-2.75 transition-colors focus-within:border-(--d-accent)">
          <Search
            class="size-3.25 flex-none text-(--d-faint)"
            aria-hidden="true"
          />
          <span class="sr-only">{{ t('memoryPanel.searchPlaceholder') }}</span>
          <input
            v-model="searchInput"
            type="search"
            class="min-w-0 flex-1 border-0 bg-transparent text-(--d-text) outline-none placeholder:text-(--d-faint)"
            :placeholder="t('memoryPanel.searchPlaceholder')"
            data-overlay-initial-focus
            data-testid="memory-search"
            @keydown="handleSearchKeyDown"
          >
          <button
            type="button"
            class="flex size-6.5 flex-none items-center justify-center rounded-md text-(--d-muted) transition-colors enabled:hover:bg-(--d-hover) enabled:hover:text-(--d-text) disabled:opacity-40"
            :disabled="!searchInput.trim()"
            :aria-label="t('memoryPanel.search')"
            :title="t('memoryPanel.search')"
            @click="handleSearch"
          >
            <ArrowRight
              class="size-3.25"
              aria-hidden="true"
            />
          </button>
        </label>

        <div
          ref="tabList"
          role="tablist"
          :aria-label="t('memoryPanel.title')"
          class="relative isolate flex self-start overflow-x-auto rounded-9 bg-(--d-hover) p-0.75"
          @keydown="onTabKeydown"
        >
          <SlidingIndicator
            :box="tabBox"
            :radius="7"
            :animate="tabAnimate"
            class="text-(--d-card) drop-shadow-[0_1px_2px_rgba(0,0,0,.18)]"
          />
          <button
            v-for="tab in tabs"
            :id="`memory-tab-${tab.id}`"
            :key="tab.id"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab.id"
            :aria-controls="`memory-panel-${tab.id}`"
            :tabindex="activeTab === tab.id ? 0 : -1"
            class="relative z-1 flex flex-none items-center gap-1.5 rounded-7 px-2.75 py-1 text-xs whitespace-nowrap transition-colors"
            :class="activeTab === tab.id ? 'text-(--d-text)' : 'text-(--d-muted) hover:text-(--d-text)'"
            :data-tab="tab.id"
            :data-active="activeTab === tab.id || undefined"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
            <span
              v-if="tab.count"
              class="font-mono text-10.5 text-(--d-faint) tabular-nums"
            >{{ tab.count }}{{ tab.hasMore ? '+' : '' }}</span>
          </button>
        </div>
      </div>

      <div
        v-if="activeTab === 'all'"
        class="flex flex-wrap items-center gap-2"
      >
        <SegmentedToggle
          :model-value="store.kindFilter"
          :options="kindOptions"
          class="bg-(--d-hover)"
          indicator-class="text-[color-mix(in_srgb,var(--d-accent)_18%,var(--d-bg))]"
          selected-class="text-(--d-accent-text)"
          :aria-label="t('memoryPanel.kindFilter')"
          @update:model-value="store.setKindFilter"
        />
        <SegmentedToggle
          :model-value="store.scopeFilter"
          :options="scopeOptions"
          class="bg-(--d-hover)"
          indicator-class="text-(--d-card)"
          :aria-label="t('memoryPanel.scopeFilter')"
          @update:model-value="store.setScopeFilter"
        />
        <span class="flex-1" />
        <label class="flex items-center gap-1.5 text-11.5 text-(--d-muted)">
          <Switch
            :checked="store.showForgotten"
            :aria-label="t('memoryPanel.showForgotten')"
            @update:checked="handleShowForgotten"
          />
          {{ t('memoryPanel.showForgotten') }}
        </label>
      </div>

      <div
        :id="`memory-panel-${activeTab}`"
        role="tabpanel"
        :aria-labelledby="`memory-tab-${activeTab}`"
        class="flex flex-col gap-2"
      >
        <template v-if="activeTab === 'all'">
          <section class="overflow-hidden rounded-xl border border-(--d-border) bg-(--d-card)">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-12.5 font-semibold transition-colors hover:bg-(--d-hover)"
              :aria-expanded="profileExpanded"
              data-testid="memory-profile-toggle"
              @click="toggleProfile"
            >
              <UserRound
                class="size-3.5 flex-none text-(--d-accent)"
                aria-hidden="true"
              />
              {{ t('memoryPanel.userProfile') }}
              <span class="text-11 font-normal text-(--d-faint)">{{ t('memoryPanel.profileHint') }}</span>
              <span class="flex-1" />
              <ChevronRight
                class="size-3.25 text-(--d-faint) transition-transform duration-200 ease-out"
                :class="profileExpanded && 'rotate-90'"
                aria-hidden="true"
              />
            </button>
            <div
              class="grid transition-[grid-template-rows] duration-250 ease-out"
              :class="profileExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
            >
              <div class="min-h-0 overflow-hidden">
                <div
                  v-if="profileExpanded"
                  class="grid grid-cols-[repeat(auto-fit,minmax(13.75rem,1fr))] gap-2.5 px-3 pb-3"
                >
                  <div
                    v-for="section in profileSections"
                    :key="section.key"
                    class="flex flex-col gap-1"
                  >
                    <label
                      :for="`memory-profile-${section.key}`"
                      class="text-10.5 font-semibold tracking-[.04em] text-(--d-faint) uppercase"
                    >{{ section.label }}</label>
                    <textarea
                      :id="`memory-profile-${section.key}`"
                      :value="section.model.value"
                      rows="3"
                      class="resize-y rounded-lg border border-(--d-border) bg-(--d-input) px-2.5 py-2 text-xs text-(--d-text) outline-none placeholder:text-(--d-faint) focus:border-(--d-accent)"
                      :placeholder="section.placeholder"
                      @input="onProfileInput(section, ($event.target as HTMLTextAreaElement).value)"
                    />
                    <button
                      type="button"
                      class="d-press flex h-6.5 items-center gap-1 self-end rounded-md border border-(--d-border2) px-2 text-11.5 transition-colors hover:bg-(--d-hover)"
                      @click="saveProfileSection(section.scope, section.section, section.model.value)"
                    >
                      <Save
                        class="size-3"
                        aria-hidden="true"
                      />{{ t('common.save') }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <p
            v-if="store.filteredMemories.length === 0"
            class="p-6 text-center text-(--d-faint)"
          >
            {{ t('memoryPanel.noMatches') }}
          </p>
          <article
            v-for="(memory, index) in store.filteredMemories"
            :key="memory.id"
            class="flex gap-2.5 rounded-xl border px-3 py-2.5 outline-none transition-[opacity,border-color] duration-200 focus-visible:ring-2 focus-visible:ring-(--d-accent)"
            :class="[rowClass(memory), arriving && 'd-arrive']"
            :style="arriving ? { animationDelay: `${Math.min(index, 8) * 25}ms` } : undefined"
            :data-memory-id="memory.id"
            :data-focused="highlightedId === memory.id || undefined"
            tabindex="-1"
          >
            <div class="min-w-0 flex-1">
              <div class="mb-1 flex flex-wrap items-center gap-1.5 text-10.5">
                <span
                  v-if="memory.kind"
                  class="rounded-5 bg-(--d-accent-soft) px-1.5 leading-4.25 font-semibold text-(--d-accent-text)"
                >{{ kindLabel(memory.kind) }}</span>
                <span
                  v-if="memory.scope"
                  class="rounded-5 bg-(--d-hover) px-1.5 leading-4.25 text-(--d-muted)"
                >{{ scopeLabel(memory.scope) }}</span>
                <span
                  v-if="memory.pinned"
                  class="flex items-center gap-0.75 text-(--d-warning-text)"
                ><Pin
                  class="size-2.5"
                  aria-hidden="true"
                />{{ t('memoryPanel.pinned') }}</span>
                <span
                  v-if="isStaleMemory(memory)"
                  class="rounded-5 bg-[color-mix(in_srgb,var(--d-warning)_12%,transparent)] px-1.5 leading-4.25 text-(--d-warning-text)"
                  :title="t('memoryPanel.staleTitle', { n: memory.fileChangeCount ?? 0 })"
                >{{ t('memoryPanel.stale') }}</span>
                <span
                  v-if="memory.isInference"
                  class="rounded-5 bg-[color-mix(in_srgb,var(--d-info)_12%,transparent)] px-1.5 leading-4.25 text-(--d-info-text)"
                >{{ t('memoryPanel.inferred') }}</span>
                <span
                  v-if="(memory.sourceCount ?? 0) > 1"
                  class="rounded-5 bg-(--d-hover) px-1.5 leading-4.25 text-(--d-muted)"
                >{{ t('memoryPanel.sources', { n: memory.sourceCount }) }}</span>
                <span
                  v-if="memory.forgotten"
                  class="rounded-5 bg-(--d-hover) px-1.5 leading-4.25 text-(--d-muted)"
                  :title="memory.forgetReason ?? undefined"
                >{{ t('memoryPanel.forgotten') }}</span>
                <span
                  v-if="memory.forgotten && memory.forgetReason === QUALITY_AUDIT_FORGET_REASON"
                  class="rounded-5 bg-(--d-hover) px-1.5 leading-4.25 text-(--d-muted)"
                  :data-forget-reason="QUALITY_AUDIT_FORGET_REASON"
                >{{ t('memoryAudit.forgetReason') }}</span>
                <span
                  v-for="tag in memory.tags"
                  :key="tag"
                  class="font-mono text-(--d-faint)"
                >#{{ tag }}</span>
                <span
                  v-if="(memory.accessCount ?? 0) > 0"
                  class="font-mono text-(--d-faint)"
                >{{ t('memoryPanel.used', { n: memory.accessCount }) }}</span>
                <span
                  v-if="(memory.version ?? 1) > 1"
                  class="font-mono text-(--d-faint)"
                >{{ t('memoryPanel.version', { n: memory.version }) }}</span>
                <span class="font-mono text-(--d-faint)">{{ formatTimestamp(memory.createdAt) }}</span>
              </div>
              <MarkdownRenderer
                :content="memory.content"
                :allow-remote-images="false"
                class="memory-content text-12.5"
              />
            </div>
            <div class="flex flex-none items-start gap-px">
              <button
                v-for="action in memoryActions(memory)"
                :key="action.id"
                type="button"
                class="flex rounded-md p-1.25 transition-colors hover:bg-(--d-hover)"
                :class="action.class"
                :title="action.label"
                :aria-label="action.label"
                :data-memory-action="action.id"
                @click="action.run()"
              >
                <component
                  :is="action.icon"
                  class="size-3.25"
                  aria-hidden="true"
                />
              </button>
            </div>
          </article>
        </template>

        <template v-if="activeTab === 'note'">
          <p
            v-if="notes.length === 0"
            class="p-6 text-center text-(--d-faint)"
          >
            {{ t('memoryPanel.noNotesBefore') }} <code class="rounded-5 bg-(--d-hover) px-1.5 font-mono text-xs text-(--d-accent-text)">/note text</code> {{ t('memoryPanel.noNotesAfter') }}
          </p>
          <article
            v-for="memory in notes"
            :key="memory.id"
            class="flex gap-2.5 rounded-xl border px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-(--d-accent)"
            :class="rowClass(memory)"
            :data-memory-id="memory.id"
            :data-focused="highlightedId === memory.id || undefined"
            tabindex="-1"
          >
            <div class="min-w-0 flex-1">
              <div class="mb-1 flex flex-wrap items-center gap-1.5 text-10.5">
                <span class="rounded-5 bg-(--d-accent-soft) px-1.5 leading-4.25 font-semibold text-(--d-accent-text)">{{ kindLabel('note') }}</span>
                <span
                  v-if="memory.pinned"
                  class="flex items-center gap-0.75 text-(--d-warning-text)"
                ><Pin
                  class="size-2.5"
                  aria-hidden="true"
                />{{ t('memoryPanel.pinned') }}</span>
                <span
                  v-for="tag in memory.tags"
                  :key="tag"
                  class="font-mono text-(--d-faint)"
                >#{{ tag }}</span>
                <span class="font-mono text-(--d-faint)">{{ formatTimestamp(memory.createdAt) }}</span>
              </div>
              <MarkdownRenderer
                :content="memory.content"
                :allow-remote-images="false"
                class="memory-content text-12.5"
              />
            </div>
            <div class="flex flex-none items-start gap-px">
              <button
                v-for="action in memoryActions(memory, false)"
                :key="action.id"
                type="button"
                class="flex rounded-md p-1.25 transition-colors hover:bg-(--d-hover)"
                :class="action.class"
                :title="action.label"
                :aria-label="action.label"
                :data-memory-action="action.id"
                @click="action.run()"
              >
                <component
                  :is="action.icon"
                  class="size-3.25"
                  aria-hidden="true"
                />
              </button>
            </div>
          </article>
        </template>

        <template v-if="activeTab === 'observations'">
          <p
            v-if="observations.length === 0"
            class="p-6 text-center text-(--d-faint)"
          >
            {{ t('memoryPanel.noObservations') }}
          </p>
          <article
            v-for="memory in observations"
            :key="memory.id"
            class="flex gap-2.5 rounded-xl border px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-(--d-accent)"
            :class="rowClass(memory)"
            :data-memory-id="memory.id"
            :data-focused="highlightedId === memory.id || undefined"
            tabindex="-1"
          >
            <div class="min-w-0 flex-1">
              <div class="mb-1 flex flex-wrap items-center gap-1.5 text-10.5">
                <span
                  v-if="memory.observationType"
                  class="rounded-5 bg-(--d-accent-soft) px-1.5 leading-4.25 font-semibold text-(--d-accent-text)"
                >{{ memory.observationType }}</span>
                <span
                  v-if="memory.pinned"
                  class="flex items-center gap-0.75 text-(--d-warning-text)"
                ><Pin
                  class="size-2.5"
                  aria-hidden="true"
                />{{ t('memoryPanel.pinned') }}</span>
                <span
                  v-if="isStaleMemory(memory)"
                  class="rounded-5 bg-[color-mix(in_srgb,var(--d-warning)_12%,transparent)] px-1.5 leading-4.25 text-(--d-warning-text)"
                  :title="t('memoryPanel.staleTitle', { n: memory.fileChangeCount ?? 0 })"
                >{{ t('memoryPanel.stale') }}</span>
                <span
                  v-for="tag in (memory.observationTags ?? [])"
                  :key="tag"
                  class="font-mono text-(--d-faint)"
                >#{{ tag }}</span>
                <span
                  v-if="(memory.accessCount ?? 0) > 0"
                  class="font-mono text-(--d-faint)"
                >{{ t('memoryPanel.used', { n: memory.accessCount }) }}</span>
                <span
                  v-if="(memory.version ?? 1) > 1"
                  class="font-mono text-(--d-faint)"
                >{{ t('memoryPanel.version', { n: memory.version }) }}</span>
                <span class="font-mono text-(--d-faint)">{{ formatTimestamp(memory.createdAt) }}</span>
              </div>
              <div
                v-if="memory.title"
                class="truncate text-12.5 font-semibold"
              >
                {{ memory.title }}
              </div>
              <MarkdownRenderer
                :content="memory.content"
                :allow-remote-images="false"
                class="memory-content text-xs text-(--d-muted)"
              />
              <ul
                v-if="memory.facts && memory.facts.length > 0"
                class="mt-1.5 flex flex-col gap-0.5"
              >
                <li
                  v-for="(fact, i) in memory.facts.slice(0, 3)"
                  :key="i"
                  class="border-l-2 border-(--d-border2) pl-2 text-xs text-(--d-muted)"
                >
                  {{ fact }}
                </li>
              </ul>
            </div>
            <div class="flex flex-none items-start gap-px">
              <button
                v-for="action in memoryActions(memory, false)"
                :key="action.id"
                type="button"
                class="flex rounded-md p-1.25 transition-colors hover:bg-(--d-hover)"
                :class="action.class"
                :title="action.label"
                :aria-label="action.label"
                :data-memory-action="action.id"
                @click="action.run()"
              >
                <component
                  :is="action.icon"
                  class="size-3.25"
                  aria-hidden="true"
                />
              </button>
            </div>
          </article>
          <p
            v-if="loadingObservations"
            class="py-3 text-center text-xs text-(--d-faint)"
            role="status"
          >
            <LoaderCircle
              class="size-3 d-spinning mr-1 inline"
              aria-hidden="true"
            />{{ t('memoryPanel.loadingMore') }}
          </p>
          <button
            v-else-if="hasMoreObservations"
            type="button"
            class="self-center rounded-md px-2.5 py-1 text-xs text-(--d-accent) transition-colors hover:bg-(--d-hover) hover:text-(--d-accent-text)"
            data-testid="memory-load-more"
            @click="emit('loadMoreObservations')"
          >
            {{ t('memoryPanel.loadMore') }}
          </button>
        </template>

        <template v-if="activeTab === 'search'">
          <p
            v-if="searchPending"
            class="p-6 text-center text-(--d-faint)"
            role="status"
          >
            {{ t('memoryPanel.searching', { query: searchedQuery }) }}
          </p>
          <p
            v-else-if="searchResults.length === 0"
            class="p-6 text-center text-(--d-faint)"
          >
            {{ t('memoryPanel.noResults', { query: searchedQuery }) }}
          </p>
          <article
            v-for="result in searchPending ? [] : searchResults"
            :key="result.id"
            class="rounded-xl border border-(--d-border) bg-(--d-card) px-3 py-2.5"
            :title="searchReason(result)"
          >
            <div class="mb-1 flex flex-wrap items-center gap-1.5 text-10.5">
              <span class="rounded-5 bg-(--d-accent-soft) px-1.5 leading-4.25 font-semibold text-(--d-accent-text)">{{ tierLabel(result.tier) }}</span>
              <span
                v-if="result.rerankRelevance"
                class="rounded-5 bg-(--d-hover) px-1.5 leading-4.25 text-(--d-muted)"
                data-testid="search-rerank-badge"
              >{{ t(`contextInjection.badge.rerank.${result.rerankRelevance}`) }}</span>
              <span
                v-if="result.observationType"
                class="text-(--d-faint)"
              >{{ result.observationType }}</span>
              <span class="font-mono text-(--d-faint)">{{ formatTimestamp(result.timestamp) }}</span>
            </div>
            <div
              v-if="result.title"
              class="truncate text-12.5 font-semibold"
            >
              {{ result.title }}
            </div>
            <MarkdownRenderer
              :content="result.snippet"
              :allow-remote-images="false"
              class="memory-content text-xs text-(--d-muted)"
            />
            <p
              v-if="searchReason(result)"
              class="mt-1 text-xs text-(--d-info) italic"
              data-testid="search-result-reason"
            >
              {{ searchReason(result) }}
            </p>
          </article>
        </template>
      </div>
      <Dialog
        :open="historyDialogId !== null"
        @update:open="(v: boolean) => { if (!v) historyDialogId = null; }"
      >
        <DialogContent class="max-h-[80vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{{ t('memoryPanel.versionHistory') }}</DialogTitle>
            <DialogDescription>{{ t('memoryPanel.versionHistoryDescription') }}</DialogDescription>
          </DialogHeader>
          <p
            v-if="historyEntries.length === 0"
            class="py-4 text-center text-xs text-(--d-faint)"
          >
            {{ t('memoryPanel.noVersionHistory') }}
          </p>
          <div class="flex flex-col gap-2">
            <article
              v-for="entry in historyEntries"
              :key="entry.id"
              class="rounded-10 border bg-(--d-card) px-3 py-2"
              :class="entry.isLatest ? 'border-(--d-accent)' : 'border-(--d-border)'"
            >
              <div class="mb-1 flex flex-wrap items-center gap-1.5 text-10.5">
                <span class="rounded-5 bg-(--d-hover) px-1.5 font-mono leading-4.25 text-(--d-muted)">v{{ entry.version ?? 1 }}</span>
                <span
                  v-if="entry.isLatest"
                  class="rounded-5 bg-(--d-accent-soft) px-1.5 leading-4.25 font-semibold text-(--d-accent-text)"
                >{{ t('memoryPanel.latest') }}</span>
                <span
                  v-if="entry.kind"
                  class="rounded-5 bg-(--d-hover) px-1.5 leading-4.25 text-(--d-muted)"
                >{{ kindLabel(entry.kind) }}</span>
                <span class="ml-auto font-mono text-(--d-faint)">{{ formatTimestamp(entry.updatedAt) }}</span>
              </div>
              <MarkdownRenderer
                :content="entry.content"
                :allow-remote-images="false"
                class="memory-content text-xs"
              />
            </article>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        :open="relatedDialogId !== null"
        @update:open="(v: boolean) => { if (!v) relatedDialogId = null; }"
      >
        <DialogContent class="max-h-[80vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{{ t('memoryPanel.relatedMemories') }}</DialogTitle>
            <DialogDescription>{{ t('memoryPanel.relatedDescription') }}</DialogDescription>
          </DialogHeader>
          <p
            v-if="relatedEntries.length === 0"
            class="py-4 text-center text-xs text-(--d-faint)"
          >
            {{ t('memoryPanel.noRelated') }}
          </p>
          <div class="flex flex-col gap-2">
            <article
              v-for="entry in relatedEntries"
              :key="entry.id"
              class="rounded-10 border border-(--d-border) bg-(--d-card) px-3 py-2"
            >
              <div class="mb-1 flex flex-wrap items-center gap-1.5 text-10.5">
                <span
                  v-if="entry.kind"
                  class="rounded-5 bg-(--d-accent-soft) px-1.5 leading-4.25 font-semibold text-(--d-accent-text)"
                >{{ kindLabel(entry.kind) }}</span>
                <span
                  v-if="entry.scope"
                  class="rounded-5 bg-(--d-hover) px-1.5 leading-4.25 text-(--d-muted)"
                >{{ scopeLabel(entry.scope) }}</span>
                <span class="ml-auto font-mono text-(--d-faint)">{{ formatTimestamp(entry.updatedAt) }}</span>
              </div>
              <MarkdownRenderer
                :content="entry.content"
                :allow-remote-images="false"
                class="memory-content text-xs"
              />
            </article>
          </div>
        </DialogContent>
      </Dialog>
    </div>

    <template #footer>
      <div
        v-if="activeTab === 'all'"
        class="flex flex-none flex-col gap-2 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5"
      >
        <div class="flex h-9 items-center gap-2 rounded-10 border border-dashed border-(--d-border2) bg-(--d-bg) pr-1.5 pl-3 transition-colors focus-within:border-solid focus-within:border-(--d-accent)">
          <Plus
            class="size-3.25 flex-none text-(--d-faint)"
            aria-hidden="true"
          />
          <label
            for="memory-new"
            class="sr-only"
          >{{ t(`memoryPanel.addPlaceholder.${newMemoryTier}`) }}</label>
          <input
            id="memory-new"
            v-model="newMemoryContent"
            type="text"
            class="min-w-0 flex-1 border-0 bg-transparent text-12.5 text-(--d-text) outline-none placeholder:text-(--d-faint)"
            :placeholder="t(`memoryPanel.addPlaceholder.${newMemoryTier}`)"
            data-testid="memory-new"
            @keydown="handleAddKeyDown"
          >
          <button
            type="button"
            class="d-press flex h-6.5 flex-none items-center gap-1 rounded-md bg-(--d-accent) px-2.5 text-xs font-semibold text-(--d-on-accent) transition-[filter] enabled:hover:brightness-110 disabled:opacity-40"
            :disabled="!newMemoryContent.trim() || pendingCreate"
            data-testid="memory-add"
            @click="handleAdd"
          >
            <LoaderCircle
              v-if="pendingCreate"
              class="size-3 d-spinning"
              aria-hidden="true"
            />
            {{ t('common.add') }}
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <SegmentedToggle
            v-model="newMemoryTier"
            :options="tierOptions"
            class="bg-(--d-hover)"
            indicator-class="text-(--d-card)"
            :aria-label="t('memoryPanel.newTier')"
          />
          <SegmentedToggle
            v-if="newMemoryTier !== 'note'"
            v-model="newMemoryKind"
            :options="createKindOptions"
            class="bg-(--d-hover)"
            indicator-class="text-(--d-card)"
            :aria-label="t('memoryPanel.newKind')"
          />
        </div>
      </div>
    </template>
  </OverlayShell>
</template>
