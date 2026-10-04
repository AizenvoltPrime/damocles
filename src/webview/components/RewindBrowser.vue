<script setup lang="ts">
import { ref, computed, watch, useId, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { FileText, Layers, LifeBuoy, MessageSquare, RotateCcw, Search, TriangleAlert } from 'lucide-vue-next';
import { useSessionStore } from '@/stores';
import OverlayShell from '@/components/OverlayShell.vue';
import SlidingIndicator from '@/components/SlidingIndicator.vue';
import RewindCheckpointNotes from '@/components/RewindCheckpointNotes.vue';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import { formatClock, formatDateTime } from '@/utils/clock';
import type { RestorePoint, RewindHistoryItem } from '@shared/types/session';

const { t, locale } = useI18n();

const { checkpointMessages } = storeToRefs(useSessionStore());

/** A compaction anchor is a full rewind anchor (file restore + fork options) only when a checkpoint
 *  was captured at compaction; otherwise it's a legacy conversation-only anchor. */
function isCheckpointBacked(item: RewindHistoryItem): boolean {
  return item.kind === 'compaction' && checkpointMessages.value.has(item.messageId);
}

/** Whether a list row shows the file-count badge: prompt anchors and checkpoint-backed compaction
 *  anchors that actually restore files. Checkpoint-less compaction anchors never show it. */
function showFileBadge(item: RewindHistoryItem): boolean {
  return (item.kind !== 'compaction' || isCheckpointBacked(item)) && item.filesAffected > 0;
}

const props = defineProps<{
  prompts: RewindHistoryItem[];
  /** Pre-rewind snapshots, newest first; each can put back the files its rewind replaced. */
  restorePoints?: RestorePoint[];
  isLoading?: boolean;
}>();

const emit = defineEmits<{
  select: [item: RewindHistoryItem];
  undo: [point: RestorePoint];
  close: [];
}>();

function restorePointLabel(point: RestorePoint): string {
  const at = new Date(point.createdAt);
  const sameDay = at.toDateString() === new Date().toDateString();
  const time = sameDay ? formatClock(at, locale.value) : formatDateTime(at, locale.value);
  return point.target.kind === 'undo' ? t('rewindBrowser.beforeUndoAt', { time }) : t('rewindBrowser.beforeRewindAt', { time });
}

/** The prompt a restore point's rewind went back to, when it is still in the list. */
function rewoundTo(point: RestorePoint): string {
  if (point.target.kind !== 'turn') return '';
  const userEntryId = point.target.userEntryId;
  return props.prompts.find((p) => p.messageId === userEntryId)?.content ?? '';
}

const listId = useId();

const searchQuery = ref('');
const selectedIndex = ref(0);
const list = shallowRef<HTMLElement | null>(null);

/** The text a search query matches against — the prompt content, plus the visible "Compaction point"
 *  label for compaction rows so a summary-less compaction anchor is still findable by keyword. */
function searchableText(item: RewindHistoryItem): string {
  const base = item.content;
  return item.kind === 'compaction' ? `${base} ${t('rewindBrowser.compactionPoint')}` : base;
}

const filteredPrompts = computed(() => {
  if (!searchQuery.value) return props.prompts;
  const query = searchQuery.value.toLowerCase();
  return props.prompts.filter(p =>
    searchableText(p).toLowerCase().includes(query)
  );
});

const selectedPrompt = computed<RewindHistoryItem | undefined>(() => filteredPrompts.value[selectedIndex.value]);
const { box, animate } = useSlidingIndicator(list, '[role="option"]', selectedIndex);

watch(() => filteredPrompts.value.length, () => {
  if (selectedIndex.value >= filteredPrompts.value.length) {
    selectedIndex.value = Math.max(0, filteredPrompts.value.length - 1);
  }
});

watch(selectedIndex, (index) => {
  list.value?.querySelectorAll<HTMLElement>('[role="option"]')[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

function onSearchKeydown(event: KeyboardEvent): void {
  const count = filteredPrompts.value.length;
  switch (event.key) {
    case 'ArrowUp':
      event.preventDefault();
      if (count > 0) selectedIndex.value = selectedIndex.value > 0 ? selectedIndex.value - 1 : count - 1;
      break;
    case 'ArrowDown':
      event.preventDefault();
      if (count > 0) selectedIndex.value = selectedIndex.value < count - 1 ? selectedIndex.value + 1 : 0;
      break;
    case 'Enter': {
      event.preventDefault();
      const selected = selectedPrompt.value;
      if (selected) emit('select', selected);
      break;
    }
  }
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minAgo', { n: minutes }, minutes);

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hourAgo', { n: hours }, hours);

  const days = Math.floor(hours / 24);
  return t('time.dayAgo', { n: days }, days);
}

function truncateContent(content: string, maxLength: number = 60): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + '...';
}
</script>

<template>
  <OverlayShell
    :title="t('rewindBrowser.title')"
    :subtitle="t('overlays.rewind.subtitle')"
    :icon="RotateCcw"
    data-testid="rewind-browser"
    @close="emit('close')"
  >
    <div class="flex flex-col gap-2 px-4 pt-3 pb-4.5">
      <label class="flex h-8.5 items-center gap-2 rounded-10 border border-(--d-border2) bg-(--d-input) px-2.75 transition-[border-color,box-shadow] focus-within:border-(--d-accent) focus-within:shadow-[0_0_0_4px_var(--d-accent-soft)]">
        <Search
          class="size-3.25 flex-none text-(--d-faint)"
          aria-hidden="true"
        />
        <input
          v-model="searchQuery"
          type="text"
          role="combobox"
          data-overlay-initial-focus
          aria-autocomplete="list"
          :aria-expanded="filteredPrompts.length > 0"
          :aria-controls="listId"
          :aria-activedescendant="selectedPrompt ? `${listId}-${selectedIndex}` : undefined"
          :aria-label="t('rewindBrowser.searchPlaceholder')"
          :placeholder="t('rewindBrowser.searchPlaceholder')"
          class="min-w-0 flex-1 border-0 bg-transparent text-(--d-text) outline-none placeholder:text-(--d-faint)"
          data-testid="rewind-search"
          @keydown="onSearchKeydown"
        >
      </label>

      <p
        v-if="isLoading"
        class="p-7.5 text-center text-(--d-faint)"
      >
        {{ t('rewindBrowser.loadingHistory') }}
      </p>

      <p
        v-else-if="filteredPrompts.length === 0"
        class="p-7.5 text-center text-(--d-faint)"
      >
        {{ t('rewindBrowser.noPrompts') }}
      </p>

      <div
        v-else
        :id="listId"
        ref="list"
        role="listbox"
        :aria-label="t('rewindBrowser.title')"
        class="relative flex flex-col gap-2"
      >
        <SlidingIndicator
          variant="ring"
          :box="box"
          :radius="11"
          :animate="animate"
          class="z-1 text-(--d-accent)"
        />
        <div
          v-for="(prompt, index) in filteredPrompts"
          :id="`${listId}-${index}`"
          :key="prompt.messageId"
          role="option"
          :aria-selected="index === selectedIndex"
          class="flex cursor-pointer gap-2.75 rounded-11 border border-(--d-border) bg-(--d-card) px-3 py-2.5"
          :title="prompt.content || undefined"
          @click="emit('select', prompt)"
          @mouseenter="selectedIndex = index"
        >
          <span
            class="relative z-2 flex size-6 flex-none items-center justify-center rounded-7"
            :class="prompt.kind === 'compaction' ? 'bg-(--d-accent-soft) text-(--d-accent)' : 'bg-(--d-hover) text-(--d-muted)'"
            aria-hidden="true"
          >
            <Layers
              v-if="prompt.kind === 'compaction'"
              class="size-3.25"
            />
            <MessageSquare
              v-else
              class="size-3.25"
            />
          </span>
          <div class="relative z-2 min-w-0 flex-1">
            <div
              class="truncate"
              :class="prompt.kind === 'compaction' ? 'text-(--d-muted) italic' : 'font-medium'"
            >
              {{ prompt.kind === 'compaction' && !prompt.content ? t('rewindBrowser.compactionNoSummary') : prompt.content }}
            </div>
            <div
              class="text-11"
              :class="index === selectedIndex ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
            >
              {{ prompt.kind === 'compaction' ? `${t('rewindBrowser.compactionPoint')} · ${formatRelativeTime(prompt.timestamp)}` : formatRelativeTime(prompt.timestamp) }}
            </div>
          </div>
          <span
            v-if="showFileBadge(prompt)"
            class="relative z-2 flex-none self-center rounded-full bg-(--d-hover) px-1.75 font-mono text-10.5 whitespace-nowrap text-(--d-muted)"
          >{{ t('rewind.filesAffected', { n: prompt.filesAffected }, prompt.filesAffected) }}</span>
          <span
            v-if="prompt.notRewindable"
            data-testid="rewind-row-not-rewindable"
            class="relative z-2 flex-none self-center rounded-full bg-[color-mix(in_srgb,var(--d-warning)_20%,transparent)] px-1.75 text-10.5 whitespace-nowrap text-(--d-warning-text)"
          >{{ t('rewind.notRewindable.badge') }}</span>
        </div>
      </div>

      <template v-if="!isLoading && restorePoints && restorePoints.length > 0">
        <h3 class="mt-2 text-11 font-semibold tracking-[.07em] text-(--d-faint) uppercase">
          {{ t('rewindBrowser.restorePoints') }}
        </h3>
        <div
          data-testid="rewind-restore-points"
          class="flex flex-col gap-2"
        >
          <div
            v-for="point in restorePoints"
            :key="point.id"
            data-testid="rewind-restore-point"
            class="rounded-11 border border-(--d-border) bg-(--d-card) px-3 py-2.25"
          >
            <div class="flex items-center gap-2.5">
              <LifeBuoy
                class="size-3.5 flex-none text-(--d-info)"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <div class="text-12.5">
                  {{ restorePointLabel(point) }}
                </div>
                <div
                  v-if="rewoundTo(point)"
                  class="truncate text-11 text-(--d-faint)"
                >
                  {{ t('rewindBrowser.rewoundTo', { prompt: truncateContent(rewoundTo(point)) }) }}
                </div>
                <div class="text-11 text-(--d-faint)">
                  {{ point.filesAffected > 0 ? t('rewindBrowser.filesRestored', { n: point.filesAffected }, point.filesAffected) : t('rewindBrowser.noFilesRestored') }}
                </div>
              </div>
              <button
                type="button"
                data-testid="rewind-undo"
                class="d-press flex-none rounded-7 border border-(--d-border2) px-2.5 py-1 text-11.5 font-medium whitespace-nowrap transition-colors hover:border-(--d-accent) hover:text-(--d-accent) focus-visible:outline-2 focus-visible:outline-(--d-accent)"
                @click="emit('undo', point)"
              >
                {{ t('rewindBrowser.undoRewind') }}
              </button>
            </div>
            <RewindCheckpointNotes
              class="mt-1.5"
              :skipped="point.skipped"
              :target="{ kind: 'restore-point', id: point.id }"
            />
          </div>
        </div>
      </template>

      <div
        class="flex justify-center gap-3.5 pt-1 font-mono text-11 text-(--d-faint)"
        aria-hidden="true"
      >
        <span>↑↓ {{ t('rewindBrowser.navigate') }}</span>
        <span>↩ {{ t('rewindBrowser.select') }}</span>
      </div>
    </div>

    <template #footer>
      <footer
        v-if="selectedPrompt"
        class="flex flex-none flex-col gap-2 border-t border-(--d-border) bg-(--d-panel) px-4 py-3 text-xs text-(--d-muted)"
        data-testid="rewind-selected"
      >
        <!-- Legacy (checkpoint-less) compaction anchor: branches to the full pre-compaction
             conversation in a new panel; no files change. -->
        <template v-if="selectedPrompt.kind === 'compaction' && !isCheckpointBacked(selectedPrompt)">
          <div class="flex items-start gap-2">
            <Layers
              class="size-3.5 mt-0.5 flex-none text-(--d-info)"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1">{{ t('rewindBrowser.compactionRestores') }}</span>
          </div>
          <div class="flex items-center gap-2 text-(--d-warning)">
            <TriangleAlert
              class="size-3.5 flex-none"
              aria-hidden="true"
            />
            <span>{{ t('rewindBrowser.compactionWarning') }}</span>
          </div>
        </template>
        <template v-else>
          <div class="flex items-start gap-2">
            <FileText
              class="size-3.5 mt-0.5 flex-none"
              aria-hidden="true"
            />
            <div class="min-w-0 flex-1">
              <template v-if="selectedPrompt.filesAffected === 0">
                <span>{{ t('rewindBrowser.noFilesRestored') }}</span>
              </template>
              <template v-else-if="selectedPrompt.files">
                <span>{{ t('rewindBrowser.filesRestored', { n: selectedPrompt.filesAffected }, selectedPrompt.filesAffected) }}:</span>
                <div class="mt-1 flex flex-wrap gap-1">
                  <span
                    v-for="file in selectedPrompt.files.slice(0, 5)"
                    :key="file.path"
                    class="max-w-30 truncate rounded-5 bg-(--d-hover) px-1.5 py-px font-mono text-11 text-(--d-text)"
                    :title="file.displayName"
                  >{{ file.displayName }}</span>
                  <span
                    v-if="selectedPrompt.files.length > 5"
                    class="px-1.5 py-px text-11"
                  >{{ t('rewindBrowser.moreFiles', { n: selectedPrompt.files.length - 5 }) }}</span>
                </div>
              </template>
              <template v-else>
                <span>{{ t('rewindBrowser.filesRestored', { n: selectedPrompt.filesAffected }, selectedPrompt.filesAffected) }}</span>
              </template>
            </div>
          </div>
          <template v-if="isCheckpointBacked(selectedPrompt)">
            <div class="flex items-center gap-2 text-(--d-info)">
              <Layers
                class="size-3.5 flex-none"
                aria-hidden="true"
              />
              <span>{{ selectedPrompt.filesAffected > 0
                ? t('rewindBrowser.compactionFullRewind')
                : t('rewindBrowser.compactionForkOnly') }}</span>
            </div>
            <div class="flex items-center gap-2 text-(--d-warning)">
              <TriangleAlert
                class="size-3.5 flex-none"
                aria-hidden="true"
              />
              <span>{{ t('rewindBrowser.compactionTurnsDropped') }}</span>
            </div>
          </template>
          <div
            v-else
            class="flex items-center gap-2 text-(--d-warning)"
          >
            <TriangleAlert
              class="size-3.5 flex-none"
              aria-hidden="true"
            />
            <span>{{ t('rewindBrowser.warning') }}</span>
          </div>
          <RewindCheckpointNotes
            :skipped="selectedPrompt.skipped"
            :not-rewindable="selectedPrompt.notRewindable"
            :target="{ kind: 'turn', userEntryId: selectedPrompt.messageId }"
          />
        </template>
      </footer>
    </template>
  </OverlayShell>
</template>
