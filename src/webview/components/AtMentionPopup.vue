<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconFile, IconFolder, IconLoader, IconRobot } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import type { AtMentionItem } from '@shared/types/commands';
import { escapeHtml } from '@shared/utils';

const { t } = useI18n();

const props = defineProps<{
  isOpen: boolean;
  items: AtMentionItem[];
  selectedIndex: number;
  anchorElement: HTMLElement | null;
  query: string;
  isLoading: boolean;
}>();

const emit = defineEmits<{
  select: [item: AtMentionItem];
  close: [];
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
    bottom: `${window.innerHeight - rect.top + 8}px`,
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

  return `${escapedBefore}<span class="text-primary font-semibold">${escapedMatch}</span>${escapedAfter}`;
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0 scale-95 translate-y-2"
      enter-to-class="opacity-100 scale-100 translate-y-0"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100 scale-100 translate-y-0"
      leave-to-class="opacity-0 scale-95 translate-y-2"
    >
      <div
        v-if="isOpen"
        ref="popupRef"
        :style="popupStyle"
        class="z-50 bg-muted border border-border rounded-lg shadow-xl overflow-hidden origin-bottom flex flex-col max-h-80"
      >
        <div class="flex-1 min-h-0 overflow-y-auto">
          <div class="p-1">
            <!-- Loading State -->
            <div v-if="isLoading && items.length === 0" class="px-3 py-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <IconLoader :size="16" class="animate-spin text-primary" />
              <span>{{ t('atMention.indexing') }}</span>
            </div>

            <!-- Empty State -->
            <div v-else-if="items.length === 0" class="px-3 py-4 text-center text-sm text-muted-foreground">
              <div class="mb-1">{{ t('atMention.noMatches') }}</div>
              <div class="text-xs opacity-70">{{ t('atMention.tryDifferent') }}</div>
            </div>

            <!-- Item List -->
            <div
              v-for="(item, index) in items"
              v-else
              :key="getItemKey(item)"
              :ref="el => itemRefs[index] = el as HTMLDivElement"
              class="px-2 py-1.5 rounded cursor-pointer flex items-center gap-2 transition-all duration-75"
              :class="index === selectedIndex
                ? 'bg-primary/60 text-primary-foreground'
                : 'hover:bg-muted text-foreground'"
              @click="emit('select', item)"
              @mouseenter="$emit('update:selectedIndex', index)"
            >
              <!-- File Item -->
              <template v-if="item.type === 'file'">
                <IconFolder v-if="item.data.isDirectory" :size="16" class="shrink-0 text-primary" />
                <IconFile v-else :size="16" class="shrink-0 text-muted-foreground" />
                <div class="flex-1 min-w-0 flex items-center gap-2">
                  <span
                    class="font-medium truncate"
                    v-html="highlightMatch(getFileName(item.data.relativePath))"
                  />
                  <span
                    v-if="getFolderPath(item.data.relativePath)"
                    class="text-xs text-muted-foreground/70 truncate flex-1 text-right"
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
                  <span class="text-xs text-muted-foreground/70 truncate flex-1">
                    {{ item.data.description }}
                  </span>
                </div>
                <Badge variant="outline" class="shrink-0 text-xs px-1.5 py-0 h-4">
                  {{ t('atMention.builtin') }}
                </Badge>
              </template>

              <!-- Custom Agent Item -->
              <template v-else-if="item.type === 'custom-agent'">
                <IconRobot :size="16" class="shrink-0 text-primary" />
                <div class="flex-1 min-w-0 flex items-center gap-2">
                  <span
                    class="font-medium truncate"
                    v-html="highlightMatch(`agent-${item.data.name}`)"
                  />
                  <span class="text-xs text-muted-foreground/70 truncate flex-1">
                    {{ item.data.description }}
                  </span>
                </div>
                <Badge variant="outline" class="shrink-0 text-xs px-1.5 py-0 h-4">
                  {{ item.data.source }}
                </Badge>
              </template>

            </div>
          </div>
        </div>

        <!-- Footer hints -->
        <div class="px-3 py-2 border-t border-border/30 bg-card/30 text-xs text-muted-foreground flex items-center gap-4">
          <span class="flex items-center gap-1">
            <kbd class="px-1.5 py-0.5 bg-card rounded text-xs font-mono">↑↓</kbd>
            <span class="opacity-80">{{ t('common.navigate') }}</span>
          </span>
          <span class="flex items-center gap-1">
            <kbd class="px-1.5 py-0.5 bg-card rounded text-xs font-mono">Tab</kbd>
            <span class="opacity-80">{{ t('common.select') }}</span>
          </span>
          <span class="flex items-center gap-1">
            <kbd class="px-1.5 py-0.5 bg-card rounded text-xs font-mono">Esc</kbd>
            <span class="opacity-80">{{ t('common.close') }}</span>
          </span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
