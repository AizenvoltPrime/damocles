<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, ChevronDown, Folder, Pencil, Search, Tag, Trash2, X } from 'lucide-vue-next';
import { storeToRefs } from 'pinia';
import DeleteSessionModal from './DeleteSessionModal.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { StoredSession } from '@shared/types/session';

const props = defineProps<{
  sessions: StoredSession[];
  selectedSessionId: string | null;
  selectedSessionName: string | null;
  hasMore: boolean;
  loading: boolean;
}>();

const emit = defineEmits<{
  (e: 'select', sessionId: string): void;
  (e: 'rename', sessionId: string, newName: string): void;
  (e: 'delete', sessionId: string): void;
  (e: 'tag', sessionId: string, tag: string | null): void;
  (e: 'loadMore'): void;
  (e: 'search', query: string, offset?: number): void;
  (e: 'open'): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();
const { isMultiRoot } = storeToRefs(useSettingsStore());

function folderLabel(session: StoredSession): string | null {
  return isMultiRoot.value ? session.workspaceFolder?.label ?? null : null;
}

const searchQuery = ref('');
const searchDebounceTimeout = ref<ReturnType<typeof setTimeout> | null>(null);
const renamingSessionId = ref<string | null>(null);
const renameInputValue = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);
const deletingSessionId = ref<string | null>(null);
const taggingSessionId = ref<string | null>(null);
const tagInputValue = ref('');
const tagInputRef = ref<HTMLInputElement | null>(null);
const sessionsListRef = ref<HTMLElement | null>(null);
const awaitingSelectedSession = ref(false);
const searchOffset = ref(0);

const isInEditMode = computed(() =>
  !!renamingSessionId.value || !!taggingSessionId.value || !!deletingSessionId.value
);

defineExpose({ isInEditMode });

function scrollToSelectedSession() {
  const sessionId = props.selectedSessionId;
  if (!sessionId) return;
  nextTick(() => {
    const selectedElement = sessionsListRef.value?.querySelector(
      `[data-session-id="${CSS.escape(sessionId)}"]`
    );
    selectedElement?.scrollIntoView({ block: 'nearest' });
  });
}

onMounted(() => {
  const selectedInArray = props.selectedSessionId &&
    props.sessions.some(s => s.id === props.selectedSessionId);
  if (selectedInArray) {
    scrollToSelectedSession();
  } else if (props.selectedSessionId) {
    awaitingSelectedSession.value = true;
    emit('open');
  }
});

watch(() => props.sessions, () => {
  if (awaitingSelectedSession.value && props.selectedSessionId) {
    const selectedInArray = props.sessions.some(s => s.id === props.selectedSessionId);
    if (selectedInArray) {
      awaitingSelectedSession.value = false;
      scrollToSelectedSession();
    }
  }
});

function handleSearchInput() {
  if (searchDebounceTimeout.value) {
    clearTimeout(searchDebounceTimeout.value);
  }

  searchDebounceTimeout.value = setTimeout(() => {
    searchOffset.value = 0;
    emit('search', searchQuery.value, 0);
  }, 300);
}

function clearSearch() {
  searchQuery.value = '';
  searchOffset.value = 0;
  emit('search', '', 0);
}

function handleScroll(event: Event) {
  const container = event.target as HTMLElement;
  if (!container) return;

  const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (scrollBottom < 50 && props.hasMore && !props.loading) {
    if (searchQuery.value.trim()) {
      searchOffset.value = props.sessions.length;
      emit('search', searchQuery.value, searchOffset.value);
    } else {
      emit('loadMore');
    }
  }
}

function handleSelect(sessionId: string) {
  emit('select', sessionId);
  emit('close');
}

function startRename(sessionId: string, currentName: string) {
  renamingSessionId.value = sessionId;
  renameInputValue.value = currentName;
  nextTick(() => {
    renameInputRef.value?.focus();
    renameInputRef.value?.select();
  });
}

function submitRename() {
  if (renamingSessionId.value && renameInputValue.value.trim()) {
    emit('rename', renamingSessionId.value, renameInputValue.value.trim());
    renamingSessionId.value = null;
  }
}

function cancelRename() {
  renamingSessionId.value = null;
}

function startTag(sessionId: string, currentTag?: string) {
  taggingSessionId.value = sessionId;
  tagInputValue.value = currentTag ?? '';
  nextTick(() => {
    tagInputRef.value?.focus();
    tagInputRef.value?.select();
  });
}

function submitTag() {
  if (taggingSessionId.value) {
    const tag = tagInputValue.value.trim() || null;
    emit('tag', taggingSessionId.value, tag);
    taggingSessionId.value = null;
  }
}

function cancelTag() {
  taggingSessionId.value = null;
}

function startDelete(sessionId: string) {
  deletingSessionId.value = sessionId;
}

function confirmDelete() {
  if (deletingSessionId.value) {
    emit('delete', deletingSessionId.value);
    deletingSessionId.value = null;
  }
}

function cancelDelete() {
  deletingSessionId.value = null;
}

function getDisplayName(session: StoredSession): string {
  return session.customTitle || session.aiTitle || session.preview;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return t('time.justNow');
  if (diffMins < 60) return t('time.minutesAgo', { n: diffMins });
  if (diffHours < 24) return t('time.hoursAgo', { n: diffHours });
  if (diffDays < 7) return t('time.daysAgo', { n: diffDays });
  return date.toLocaleDateString();
}

function getDeletingSessionName(): string {
  if (!deletingSessionId.value) return '';
  const session = props.sessions.find(s => s.id === deletingSessionId.value);
  return session ? getDisplayName(session) : '';
}

onUnmounted(() => {
  if (searchDebounceTimeout.value) {
    clearTimeout(searchDebounceTimeout.value);
  }
});
</script>

<template>
  <div>
    <div class="relative mb-1">
      <Search
        class="size-3.25 pointer-events-none absolute inset-s-2.5 top-1/2 -translate-y-1/2 text-(--d-faint)"
        aria-hidden="true"
      />
      <input
        v-model="searchQuery"
        type="search"
        :placeholder="t('history.search')"
        :aria-label="t('history.search')"
        class="h-8 w-full rounded-lg border border-(--d-border) bg-(--d-input) ps-8 pe-8 text-12.5 text-(--d-text) outline-none transition-colors placeholder:text-(--d-faint) focus:border-(--d-accent) [&::-webkit-search-cancel-button]:hidden"
        data-testid="history-search"
        @input="handleSearchInput"
      >
      <button
        v-if="searchQuery"
        type="button"
        class="absolute inset-e-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text)"
        :aria-label="t('history.clearSearch')"
        :title="t('history.clearSearch')"
        @click="clearSearch"
      >
        <X
          class="size-3"
          aria-hidden="true"
        />
      </button>
    </div>

    <div
      ref="sessionsListRef"
      class="max-h-[min(21.25rem,55vh)] overflow-y-auto overflow-x-hidden"
      @scroll="handleScroll"
    >
      <div
        v-if="sessions.length === 0"
        class="px-3 py-5 text-center text-xs text-(--d-muted)"
      >
        {{ searchQuery ? t('session.noSearchResults') : t('session.noSessions') }}
      </div>

      <div
        v-for="session in sessions"
        :key="session.id"
        :data-session-id="session.id"
        class="group relative"
      >
        <div
          v-if="renamingSessionId === session.id"
          class="flex items-center gap-1 rounded-lg bg-(--d-hover) p-1"
        >
          <input
            :ref="(el) => { renameInputRef = el as HTMLInputElement | null }"
            v-model="renameInputValue"
            type="text"
            class="h-7 min-w-0 flex-1 rounded-md border border-(--d-border2) bg-(--d-input) px-2 text-xs text-(--d-text) outline-none focus:border-(--d-accent)"
            :placeholder="t('session.enterNewName')"
            :aria-label="t('session.renameSession')"
            @keyup.enter="submitRename"
            @keyup.escape="cancelRename"
          />
          <button
            type="button"
            class="d-tool-btn h-7 min-w-7 px-0 text-(--d-accent)"
            :aria-label="t('common.save')"
            :title="t('common.save')"
            @click="submitRename"
          >
            <Check
              class="size-3.5"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            class="d-tool-btn h-7 min-w-7 px-0"
            :aria-label="t('common.cancel')"
            :title="t('common.cancel')"
            @click="cancelRename"
          >
            <X
              class="size-3.5"
              aria-hidden="true"
            />
          </button>
        </div>

        <div
          v-else-if="taggingSessionId === session.id"
          class="flex items-center gap-1 rounded-lg bg-(--d-hover) p-1"
        >
          <input
            :ref="(el) => { tagInputRef = el as HTMLInputElement | null }"
            v-model="tagInputValue"
            type="text"
            class="h-7 min-w-0 flex-1 rounded-md border border-(--d-border2) bg-(--d-input) px-2 text-xs text-(--d-text) outline-none focus:border-(--d-accent)"
            :placeholder="t('session.tagPlaceholder')"
            :aria-label="t('session.tagSession')"
            @keyup.enter="submitTag"
            @keyup.escape="cancelTag"
          />
          <button
            type="button"
            class="d-tool-btn h-7 min-w-7 px-0 text-(--d-accent)"
            :aria-label="t('common.save')"
            :title="t('common.save')"
            @click="submitTag"
          >
            <Check
              class="size-3.5"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            class="d-tool-btn h-7 min-w-7 px-0"
            :aria-label="t('common.cancel')"
            :title="t('common.cancel')"
            @click="cancelTag"
          >
            <X
              class="size-3.5"
              aria-hidden="true"
            />
          </button>
        </div>

        <div
          v-else
          class="flex items-center rounded-lg transition-colors hover:bg-(--d-hover)"
          :class="{ 'bg-(--d-accent-soft)': selectedSessionId === session.id }"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2.25 rounded-lg px-2.25 py-1.75 text-start text-13 text-(--d-text)"
            :aria-current="selectedSessionId === session.id ? 'true' : undefined"
            data-testid="session-select"
            @click="handleSelect(session.id)"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="selectedSessionId === session.id ? 'bg-(--d-accent)' : 'bg-(--d-faint)'"
              aria-hidden="true"
            />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate">{{ getDisplayName(session) }}</span>
                <span
                  v-if="session.tag"
                  class="shrink-0 rounded-5 border border-(--d-border2) px-1.5 text-10.5/4 text-(--d-muted)"
                  data-testid="session-tag-label"
                >{{ session.tag }}</span>
              </span>
              <span
                v-if="folderLabel(session)"
                class="flex min-w-0 items-center gap-1 text-11"
                :class="selectedSessionId === session.id ? 'text-(--d-faint-text)' : 'text-(--d-faint) group-hover:text-(--d-faint-text)'"
                :title="t('session.folderLabel', { folder: folderLabel(session) })"
                data-testid="session-folder-badge"
              >
                <Folder
                  class="size-2.5 shrink-0"
                  aria-hidden="true"
                />
                <span class="truncate">{{ folderLabel(session) }}</span>
              </span>
            </span>
            <span
              class="shrink-0 text-11 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
              :class="selectedSessionId === session.id ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
            >{{ formatTime(session.timestamp) }}</span>
          </button>
          <span class="absolute inset-e-1 flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              class="d-tool-btn h-6 min-w-6 px-0"
              :title="t('session.renameSession')"
              :aria-label="t('session.renameSession')"
              data-testid="session-rename"
              @click.stop="startRename(session.id, getDisplayName(session))"
            ><Pencil
              class="size-3"
              aria-hidden="true"
            /></button>
            <button
              type="button"
              class="d-tool-btn h-6 min-w-6 px-0"
              :title="session.tag ? t('session.removeTag') : t('session.tagSession')"
              :aria-label="session.tag ? t('session.removeTag') : t('session.tagSession')"
              data-testid="session-tag"
              @click.stop="startTag(session.id, session.tag)"
            ><Tag
              class="size-3"
              aria-hidden="true"
            /></button>
            <button
              type="button"
              class="d-tool-btn h-6 min-w-6 px-0 hover:text-(--d-danger)"
              :title="t('session.deleteSession')"
              :aria-label="t('session.deleteSession')"
              data-testid="session-delete"
              @click.stop="startDelete(session.id)"
            ><Trash2
              class="size-3"
              aria-hidden="true"
            /></button>
          </span>
        </div>
      </div>

      <div
        v-if="!searchQuery && (hasMore || loading)"
        class="flex justify-center py-1.5"
      >
        <button
          v-if="!loading"
          type="button"
          class="d-tool-btn gap-1 px-2 text-xs"
          data-testid="session-load-more"
          @click="$emit('loadMore')"
        >
          <ChevronDown
            class="size-3"
            aria-hidden="true"
          />{{ t('session.loadMore') }}
        </button>
        <div
          v-else
          class="animate-[d-pulse_1.4s_ease-in-out_infinite] text-xs text-(--d-muted)"
        >
          {{ t('common.loading') }}
        </div>
      </div>
    </div>

    <DeleteSessionModal
      :visible="!!deletingSessionId"
      :session-name="getDeletingSessionName()"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </div>
</template>
