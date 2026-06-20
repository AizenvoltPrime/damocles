<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  IconCheck,
  IconXMark,
  IconPencil,
  IconTrash,
  IconChevronDown,
  IconSearch,
} from '@/components/icons';
import { Tag } from 'lucide-vue-next';
import DeleteSessionModal from './DeleteSessionModal.vue';
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
  if (!props.selectedSessionId) return;
  nextTick(() => {
    const selectedElement = sessionsListRef.value?.querySelector(
      `[data-session-id="${CSS.escape(props.selectedSessionId)}"]`
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
    <!-- Search input -->
    <div class="p-2 border-b border-border/30">
      <div class="relative">
        <IconSearch :size="14" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          v-model="searchQuery"
          type="text"
          :placeholder="t('session.searchPlaceholder')"
          class="h-8 pl-8 pr-8 text-xs"
          @input="handleSearchInput"
        />
        <Button
          v-if="searchQuery"
          variant="ghost"
          size="icon-sm"
          class="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
          @click="clearSearch"
        >
          <IconXMark :size="12" />
        </Button>
      </div>
    </div>

    <!-- Sessions list -->
    <div ref="sessionsListRef" class="max-h-52 overflow-y-auto overflow-x-hidden" @scroll="handleScroll">
      <!-- Empty state -->
      <div
        v-if="sessions.length === 0"
        class="p-4 text-center text-xs text-muted-foreground"
      >
        {{ searchQuery ? t('session.noSearchResults') : t('session.noSessions') }}
      </div>

      <!-- Session items -->
      <div v-for="session in sessions" :key="session.id" :data-session-id="session.id" class="group relative">
        <!-- Rename mode -->
        <div v-if="renamingSessionId === session.id" class="flex items-center gap-2 p-2 rounded bg-muted">
          <input
            ref="renameInputRef"
            v-model="renameInputValue"
            type="text"
            class="flex-1 px-2 py-1 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:border-primary"
            :placeholder="t('session.enterNewName')"
            @keyup.enter="submitRename"
            @keyup.escape="cancelRename"
          />
          <Button size="sm" class="h-6 px-2" @click="submitRename"><IconCheck :size="14" /></Button>
          <Button variant="ghost" size="sm" class="h-6 px-2" @click="cancelRename"><IconXMark :size="14" /></Button>
        </div>

        <!-- Tag mode -->
        <div v-else-if="taggingSessionId === session.id" class="flex items-center gap-2 p-2 rounded bg-muted">
          <input
            ref="tagInputRef"
            v-model="tagInputValue"
            type="text"
            class="flex-1 px-2 py-1 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:border-primary"
            :placeholder="t('session.tagPlaceholder')"
            @keyup.enter="submitTag"
            @keyup.escape="cancelTag"
          />
          <Button size="sm" class="h-6 px-2" @click="submitTag"><IconCheck :size="14" /></Button>
          <Button variant="ghost" size="sm" class="h-6 px-2" @click="cancelTag"><IconXMark :size="14" /></Button>
        </div>

        <!-- Normal display mode -->
        <div v-else class="flex items-center gap-1 pr-1">
          <Button
            variant="ghost"
            class="flex-1 min-w-0 h-auto justify-start text-left p-2 text-xs text-foreground"
            :class="[
              selectedSessionId === session.id
                ? 'bg-primary/20 border-l-2 border-primary'
                : ''
            ]"
            @click="handleSelect(session.id)"
          >
            <div class="min-w-0 w-full">
              <div class="font-medium truncate flex items-center gap-1">
                <IconCheck v-if="selectedSessionId === session.id" :size="12" class="text-primary shrink-0" />
                <span class="truncate">{{ getDisplayName(session) }}</span>
                <Badge
                  v-if="session.tag"
                  variant="outline"
                  class="shrink-0 text-xs px-1 py-0 h-3.5 font-normal text-muted-foreground border-border"
                >
                  {{ session.tag }}
                </Badge>
              </div>
              <div class="text-muted-foreground" :class="{ 'ml-4': selectedSessionId === session.id }">
                {{ formatTime(session.timestamp) }}
              </div>
            </div>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="shrink-0 text-muted-foreground hover:text-primary hover:bg-muted"
            :title="t('session.renameSession')"
            @click.stop="startRename(session.id, getDisplayName(session))"
          ><IconPencil :size="12" /></Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="shrink-0 text-muted-foreground hover:text-primary hover:bg-muted"
            :title="session.tag ? t('session.removeTag') : t('session.tagSession')"
            @click.stop="startTag(session.id, session.tag)"
          ><Tag :size="12" /></Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/20"
            :title="t('session.deleteSession')"
            @click.stop="startDelete(session.id)"
          ><IconTrash :size="12" /></Button>
        </div>
      </div>

      <!-- Load more -->
      <div v-if="!searchQuery && (hasMore || loading)" class="text-center py-2">
        <Button
          v-if="!loading"
          variant="link"
          size="sm"
          class="text-xs text-primary hover:text-foreground flex items-center gap-1"
          @click="$emit('loadMore')"
        >
          <IconChevronDown :size="12" /> {{ t('session.loadMore') }}
        </Button>
        <div v-else class="text-xs text-muted-foreground animate-pulse">
          {{ t('common.loading') }}
        </div>
      </div>
    </div>

    <!-- Delete confirmation modal -->
    <DeleteSessionModal
      :visible="!!deletingSessionId"
      :session-name="getDeletingSessionName()"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </div>
</template>
