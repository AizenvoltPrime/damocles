<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconSearch, IconFile, IconWarning, IconLayers } from '@/components/icons';
import type { RewindHistoryItem } from '@shared/types/session';

const { t } = useI18n();

const props = defineProps<{
  isOpen: boolean;
  prompts: RewindHistoryItem[];
  isLoading?: boolean;
}>();

const emit = defineEmits<{
  select: [item: RewindHistoryItem];
  close: [];
}>();

const searchQuery = ref('');
const selectedIndex = ref(0);
const searchInputRef = ref<HTMLInputElement | null>(null);
const itemRefs = ref<(HTMLDivElement | null)[]>([]);

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

watch(() => props.isOpen, (isOpen) => {
  if (isOpen) {
    searchQuery.value = '';
    selectedIndex.value = 0;
    nextTick(() => {
      searchInputRef.value?.focus();
    });
  } else {
    itemRefs.value = [];
  }
});

watch(() => filteredPrompts.value.length, () => {
  if (selectedIndex.value >= filteredPrompts.value.length) {
    selectedIndex.value = Math.max(0, filteredPrompts.value.length - 1);
  }
});

watch(selectedIndex, (index) => {
  itemRefs.value[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

function handleKeyDown(event: KeyboardEvent) {
  switch (event.key) {
    case 'ArrowUp':
      event.preventDefault();
      if (selectedIndex.value > 0) {
        selectedIndex.value--;
      } else {
        selectedIndex.value = filteredPrompts.value.length - 1;
      }
      break;
    case 'ArrowDown':
      event.preventDefault();
      if (selectedIndex.value < filteredPrompts.value.length - 1) {
        selectedIndex.value++;
      } else {
        selectedIndex.value = 0;
      }
      break;
    case 'Enter':
      event.preventDefault();
      if (filteredPrompts.value.length > 0) {
        emit('select', filteredPrompts.value[selectedIndex.value]);
      }
      break;
    case 'Escape':
      event.preventDefault();
      emit('close');
      break;
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

onMounted(() => {
  document.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown);
});
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="isOpen"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
        @click.self="emit('close')"
      >
        <div class="w-full max-w-lg bg-muted border border-border rounded-lg shadow-xl overflow-hidden">
          <div class="px-4 py-3 border-b border-border/30 flex items-center gap-2">
            <span class="text-lg">⏪</span>
            <span class="font-medium">{{ t('rewindBrowser.title') }}</span>
          </div>

          <div class="p-3 border-b border-border/30">
            <div class="relative">
              <IconSearch :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                ref="searchInputRef"
                v-model="searchQuery"
                type="text"
                :placeholder="t('rewindBrowser.searchPlaceholder')"
                class="w-full pl-9 pr-3 py-2 bg-card border border-border/30 rounded text-sm focus:outline-none focus:border-primary"
              />
            </div>
          </div>

          <div v-if="isLoading" class="p-8 text-center text-muted-foreground text-sm">
            {{ t('rewindBrowser.loadingHistory') }}
          </div>

          <div v-else-if="filteredPrompts.length === 0" class="p-8 text-center text-muted-foreground text-sm">
            {{ t('rewindBrowser.noPrompts') }}
          </div>

          <div v-else class="max-h-64 overflow-y-auto">
            <div
              v-for="(prompt, index) in filteredPrompts"
              :key="prompt.messageId"
              :ref="el => itemRefs[index] = el as HTMLDivElement"
              class="px-3 py-2 cursor-pointer transition-colors"
              :class="index === selectedIndex
                ? 'bg-primary/60'
                : 'hover:bg-muted'"
              @click="emit('select', prompt)"
              @mouseenter="selectedIndex = index"
            >
              <div class="flex items-start gap-2">
                <IconLayers v-if="prompt.kind === 'compaction'" :size="14" class="text-info mt-0.5 shrink-0" />
                <span v-else class="text-primary mt-0.5">▸</span>
                <div class="flex-1 min-w-0">
                  <div v-if="prompt.kind === 'compaction'" class="text-sm font-medium text-info">
                    {{ t('rewindBrowser.compactionPoint') }}
                  </div>
                  <div class="text-sm truncate" :class="prompt.kind === 'compaction' ? 'text-muted-foreground italic' : ''">
                    <template v-if="prompt.kind === 'compaction'">{{ prompt.content ? truncateContent(prompt.content) : t('rewindBrowser.compactionNoSummary') }}</template>
                    <template v-else>"{{ truncateContent(prompt.content) }}"</template>
                  </div>
                  <div class="text-xs text-muted-foreground mt-0.5">
                    {{ formatRelativeTime(prompt.timestamp) }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div
            v-if="filteredPrompts.length > 0 && filteredPrompts[selectedIndex]"
            class="px-4 py-3 border-t border-border/30 bg-card/30"
          >
            <!-- Compaction anchor: branches to the full pre-compaction conversation in a new panel; no files change. -->
            <template v-if="filteredPrompts[selectedIndex].kind === 'compaction'">
              <div class="flex items-start gap-2 text-xs text-muted-foreground">
                <IconLayers :size="14" class="mt-0.5 shrink-0 text-info" />
                <span class="flex-1 min-w-0">{{ t('rewindBrowser.compactionRestores') }}</span>
              </div>
              <div class="flex items-center gap-2 text-xs text-warning mt-2">
                <IconWarning :size="14" />
                <span>{{ t('rewindBrowser.compactionWarning') }}</span>
              </div>
            </template>
            <template v-else>
              <div class="flex items-start gap-2 text-xs text-muted-foreground">
                <IconFile :size="14" class="mt-0.5 shrink-0" />
                <div class="flex-1 min-w-0">
                  <template v-if="filteredPrompts[selectedIndex].filesAffected === 0">
                    <span>{{ t('rewindBrowser.noFilesRestored') }}</span>
                  </template>
                  <template v-else-if="filteredPrompts[selectedIndex].files">
                    <span>{{ t('rewindBrowser.filesRestored', { n: filteredPrompts[selectedIndex].filesAffected }, filteredPrompts[selectedIndex].filesAffected) }}:</span>
                    <div class="flex flex-wrap gap-1 mt-1">
                      <span
                        v-for="file in filteredPrompts[selectedIndex].files.slice(0, 5)"
                        :key="file.path"
                        class="px-1.5 py-0.5 bg-primary/20 rounded text-xs font-mono truncate max-w-[7.5rem]"
                        :title="file.displayName"
                      >{{ file.displayName }}</span>
                      <span
                        v-if="filteredPrompts[selectedIndex].files.length > 5"
                        class="px-1.5 py-0.5 text-xs text-muted-foreground"
                      >{{ t('rewindBrowser.moreFiles', { n: filteredPrompts[selectedIndex].files.length - 5 }) }}</span>
                    </div>
                  </template>
                  <template v-else>
                    <span>{{ t('rewindBrowser.filesRestored', { n: filteredPrompts[selectedIndex].filesAffected }, filteredPrompts[selectedIndex].filesAffected) }}</span>
                  </template>
                </div>
              </div>
              <div class="flex items-center gap-2 text-xs text-warning mt-2">
                <IconWarning :size="14" />
                <span>{{ t('rewindBrowser.warning') }}</span>
              </div>
            </template>
          </div>

          <div class="px-4 py-2 border-t border-border/30 bg-card/50 text-xs text-muted-foreground flex items-center gap-4">
            <span class="flex items-center gap-1">
              <kbd class="px-1.5 py-0.5 bg-card rounded text-xs font-mono">↑↓</kbd>
              <span class="opacity-80">{{ t('rewindBrowser.navigate') }}</span>
            </span>
            <span class="flex items-center gap-1">
              <kbd class="px-1.5 py-0.5 bg-card rounded text-xs font-mono">Enter</kbd>
              <span class="opacity-80">{{ t('rewindBrowser.select') }}</span>
            </span>
            <span class="flex items-center gap-1">
              <kbd class="px-1.5 py-0.5 bg-card rounded text-xs font-mono">Esc</kbd>
              <span class="opacity-80">{{ t('common.cancel') }}</span>
            </span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
