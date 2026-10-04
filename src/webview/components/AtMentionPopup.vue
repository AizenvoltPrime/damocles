<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconFile, IconFolder, IconLoader, IconRobot } from '@/components/icons';
import type { AtMentionItem } from '@shared/types/commands';
import { escapeHtml } from '@shared/utils';

const { t } = useI18n();
const listLabel = computed(() => t('composer.mentionList'));

const props = defineProps<{
  isOpen: boolean;
  /** The listbox id the composer's textarea names in aria-controls; option ids derive from it. */
  listId: string;
  items: AtMentionItem[];
  selectedIndex: number;
  anchorElement: HTMLElement | null;
  query: string;
  isLoading: boolean;
}>();

const emit = defineEmits<{
  select: [item: AtMentionItem];
  close: [];
  'update:selectedIndex': [index: number];
}>();

const popupRef = ref<HTMLDivElement | null>(null);
const itemRefs = ref<(HTMLDivElement | null)[]>([]);
const popupStyle = ref<Record<string, string>>({});

function updatePosition() {
  if (!props.anchorElement) {
    popupStyle.value = {};
    return;
  }

  const rect = props.anchorElement.getBoundingClientRect();

  popupStyle.value = {
    position: 'fixed',
    bottom: `calc(${window.innerHeight - rect.top}px + 0.5rem)`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
  };
}

watch(() => props.isOpen, (isOpen) => {
  if (isOpen) {
    updatePosition();
    window.addEventListener('resize', updatePosition);
  } else {
    window.removeEventListener('resize', updatePosition);
  }
}, { immediate: true });

watch(() => props.selectedIndex, (newIndex) => {
  const item = itemRefs.value[newIndex];
  if (item) {
    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
});

function handleClickOutside(event: MouseEvent) {
  if (popupRef.value && !popupRef.value.contains(event.target as Node)) {
    emit('close');
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  window.removeEventListener('resize', updatePosition);
});

function getItemKey(item: AtMentionItem): string {
  switch (item.type) {
    case 'file':
      return `file:${item.data.relativePath}`;
    case 'builtin-agent':
      return `builtin-agent:${item.data.id}`;
    case 'custom-agent':
      return `custom-agent:${item.data.name}`;
  }
}

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

function getFolderPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

function highlightMatch(text: string): string {
  const escaped = escapeHtml(text);
  if (!props.query) return escaped;

  const lowerText = text.toLowerCase();
  const lowerQuery = props.query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);

  if (index === -1) return escaped;

  const escapedBefore = escapeHtml(text.slice(0, index));
  const escapedMatch = escapeHtml(text.slice(index, index + props.query.length));
  const escapedAfter = escapeHtml(text.slice(index + props.query.length));

  return `${escapedBefore}<span class="text-(--d-accent-text) font-bold">${escapedMatch}</span>${escapedAfter}`;
}
</script>

<template>
  <Teleport to="body">
    <Transition name="t-pop-top">
      <div
        v-if="isOpen"
        ref="popupRef"
        :style="popupStyle"
        class="z-50 flex max-h-80 origin-bottom flex-col overflow-hidden rounded-xl border border-(--d-border2) bg-(--d-card) text-(--d-text) shadow-(--d-shadow)"
      >
        <div class="flex-1 min-h-0 overflow-y-auto">
          <div
            :id="listId"
            class="p-1"
            role="listbox"
            :aria-label="listLabel"
          >
            <!-- Loading State -->
            <div
              v-if="isLoading && items.length === 0"
              class="flex items-center justify-center gap-2 px-3 py-4 text-12.5 text-(--d-muted)"
            >
              <IconLoader
                class="size-4 animate-[d-spin_.9s_linear_infinite] text-(--d-accent)"
              />
              <span>{{ t('atMention.indexing') }}</span>
            </div>

            <!-- Empty State -->
            <div
              v-else-if="items.length === 0"
              class="px-3 py-4 text-center text-12.5 text-(--d-muted)"
            >
              <div class="mb-1">{{ t('atMention.noMatches') }}</div>
              <div class="text-xs opacity-70">{{ t('atMention.tryDifferent') }}</div>
            </div>

            <!-- Item List -->
            <div
              v-for="(item, index) in items"
              v-else
              :id="`${listId}-${index}`"
              :key="getItemKey(item)"
              :ref="el => itemRefs[index] = el as HTMLDivElement"
              class="flex min-h-8.5 cursor-pointer items-center gap-2.25 rounded-lg px-2.25 py-1.25 text-12.5 transition-colors duration-75"
              :class="index === selectedIndex ? 'bg-(--d-accent-soft)' : ''"
              role="option"
              :aria-selected="index === selectedIndex"
              @click="emit('select', item)"
              @mouseenter="$emit('update:selectedIndex', index)"
            >
              <!-- File Item -->
              <template v-if="item.type === 'file'">
                <IconFolder
                  v-if="item.data.isDirectory"
                  class="size-4 shrink-0 text-(--d-accent)"
                />
                <IconFile
                  v-else
                  class="size-4 shrink-0 text-(--d-muted)"
                />
                <div class="flex-1 min-w-0 flex items-center gap-2">
                  <span
                    class="font-medium truncate"
                    v-html="highlightMatch(getFileName(item.data.relativePath))"
                  />
                  <span
                    v-if="getFolderPath(item.data.relativePath)"
                    class="text-xs truncate flex-1 text-right"
                    :class="index === selectedIndex ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
                    style="direction: rtl; text-align: right;"
                  >
                    {{ getFolderPath(item.data.relativePath) }}
                  </span>
                </div>
              </template>

              <!-- Built-in Agent Item -->
              <template v-else-if="item.type === 'builtin-agent'">
                <span class="shrink-0 text-base leading-none">{{ item.data.icon }}</span>
                <div class="flex-1 min-w-0 flex items-center gap-2">
                  <span
                    class="font-medium truncate"
                    v-html="highlightMatch(`agent-${item.data.id}`)"
                  />
                  <span
                    class="text-xs truncate flex-1"
                    :class="index === selectedIndex ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
                  >
                    {{ item.data.description }}
                  </span>
                </div>
                <span class="shrink-0 rounded-5 border border-(--d-border) bg-(--d-hover) px-1.5 text-10.5/4.25 text-(--d-muted)">
                  {{ t('atMention.builtin') }}
                </span>
              </template>

              <!-- Custom Agent Item -->
              <template v-else-if="item.type === 'custom-agent'">
                <IconRobot
                  class="size-4 shrink-0 text-(--d-accent)"
                />
                <div class="flex-1 min-w-0 flex items-center gap-2">
                  <span
                    class="font-medium truncate"
                    v-html="highlightMatch(`agent-${item.data.name}`)"
                  />
                  <span
                    class="text-xs truncate flex-1"
                    :class="index === selectedIndex ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
                  >
                    {{ item.data.description }}
                  </span>
                </div>
                <span class="shrink-0 rounded-5 border border-(--d-border) bg-(--d-hover) px-1.5 text-10.5/4.25 text-(--d-muted)">
                  {{ item.data.source }}
                </span>
              </template>

            </div>
          </div>
        </div>

        <div
          class="flex items-center gap-3.5 border-t border-(--d-border) bg-(--d-panel) px-3 py-1.75 text-11 text-(--d-faint)"
          aria-hidden="true"
        >
          <span class="flex items-center gap-1"><kbd class="rounded-md border border-(--d-border) bg-(--d-card) px-1.5 py-px font-mono text-10.5">↑↓</kbd>{{ t('composer.acNavigate') }}</span>
          <span class="flex items-center gap-1"><kbd class="rounded-md border border-(--d-border) bg-(--d-card) px-1.5 py-px font-mono text-10.5">Tab</kbd>{{ t('composer.acSelect') }}</span>
          <span class="flex items-center gap-1"><kbd class="rounded-md border border-(--d-border) bg-(--d-card) px-1.5 py-px font-mono text-10.5">Esc</kbd>{{ t('composer.acClose') }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
