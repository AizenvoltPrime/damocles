<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Globe, LoaderCircle, X } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import type { PanePage } from '../../../preload/pane-channels';
import { PAGE_PANEL_ID, pageDomId, pageTitle } from '../page-ids';

const props = defineProps<{
  pages: readonly PanePage[];
  activePageId: string | undefined;
  mac: boolean;
}>();
const emit = defineEmits<{ select: [id: string]; close: [id: string] }>();
const { t } = useI18n();

const tablist = ref<HTMLElement | null>(null);
const focusedId = ref<string | undefined>();

// Roving tabindex: the one tab in the page's Tab order is the last one focused, else the active one.
const tabbableId = computed(() => {
  if (focusedId.value !== undefined && props.pages.some((page) => page.id === focusedId.value)) return focusedId.value;
  return props.activePageId ?? props.pages[0]?.id;
});
watch(() => props.activePageId, () => {
  focusedId.value = undefined;
});

function labelOf(page: PanePage): string {
  const title = pageTitle(page, t('pane.newPage'));
  return page.loading ? t('pane.pageLoading', { title }) : title;
}

async function focusTab(id: string): Promise<void> {
  focusedId.value = id;
  await nextTick();
  tablist.value?.querySelector<HTMLElement>(`[id="${CSS.escape(pageDomId(id))}"]`)?.focus();
}

function close(id: string): void {
  const index = props.pages.findIndex((page) => page.id === id);
  const neighbour = props.pages[index + 1] ?? props.pages[index - 1];
  emit('close', id);
  if (neighbour && document.activeElement?.closest('[role="tablist"]')) void focusTab(neighbour.id);
}

function onKeydown(event: KeyboardEvent, page: PanePage, index: number): void {
  const count = props.pages.length;
  let target: PanePage | undefined;
  switch (event.key) {
    case 'ArrowRight':
      target = props.pages[(index + 1) % count];
      break;
    case 'ArrowLeft':
      target = props.pages[(index - 1 + count) % count];
      break;
    case 'Home':
      target = props.pages[0];
      break;
    case 'End':
      target = props.pages[count - 1];
      break;
    case 'Enter':
    case ' ':
      emit('select', page.id);
      break;
    case 'Delete':
      close(page.id);
      break;
    case 'Backspace':
      // The Mac keyboard's delete key sends Backspace.
      if (!props.mac) return;
      close(page.id);
      break;
    default:
      return;
  }
  event.preventDefault();
  if (target) void focusTab(target.id);
}
</script>

<template>
  <div
    ref="tablist"
    role="tablist"
    :aria-label="t('pane.pagesLabel')"
    :aria-description="t('pane.pagesKeyboardHelp')"
    class="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]"
  >
    <div
      v-for="(page, index) in pages"
      :id="pageDomId(page.id)"
      :key="page.id"
      role="tab"
      :aria-selected="page.id === activePageId"
      :aria-controls="page.id === activePageId ? PAGE_PANEL_ID : undefined"
      :aria-label="labelOf(page)"
      :aria-busy="page.loading"
      :tabindex="page.id === tabbableId ? 0 : -1"
      :title="page.url && page.url !== page.title ? `${labelOf(page)}\n${page.url}` : labelOf(page)"
      :class="cn(
        'group relative flex w-44 min-w-20 shrink cursor-pointer select-none items-center gap-1.5 border-r border-border px-2.5 text-xs outline-none transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        page.id === activePageId
          ? 'bg-background text-foreground after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )"
      @click="emit('select', page.id)"
      @auxclick="$event.button === 1 && close(page.id)"
      @focus="focusedId = page.id"
      @keydown="onKeydown($event, page, index)"
    >
      <LoaderCircle
        v-if="page.loading"
        class="size-3.5 shrink-0 animate-spin text-info"
        aria-hidden="true"
      />
      <img
        v-else-if="page.iconDataUrl?.startsWith('data:image/')"
        :src="page.iconDataUrl"
        alt=""
        class="size-4 shrink-0"
      >
      <Globe
        v-else
        class="size-3.5 shrink-0"
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1 truncate">{{ pageTitle(page, t('pane.newPage')) }}</span>
      <!-- Mouse affordance only; keyboard users close with Delete, as in the window's tab strip. -->
      <span
        aria-hidden="true"
        :title="t('pane.closePage', { title: pageTitle(page, t('pane.newPage')) })"
        class="flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted-foreground/20 group-hover:opacity-100 group-aria-selected:opacity-70"
        @click.stop="close(page.id)"
      >
        <X class="size-3" />
      </span>
    </div>
  </div>
</template>
