<script setup lang="ts">
import { computed, nextTick, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight } from 'lucide-vue-next';
import type { SettingsSectionId } from '@shared/settings-sections';
import SlidingIndicator from '@/components/SlidingIndicator.vue';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import type { SettingsSectionMeta } from './settings-rows';

const props = defineProps<{
  sections: readonly SettingsSectionMeta[];
  active: SettingsSectionId;
  /** The indicator hides while a search query is active (M6). */
  searching: boolean;
  /** Below 720px the nav is a full-width list that opens each section as a page (M8). */
  list: boolean;
  panelId: string;
}>();

const emit = defineEmits<{
  (e: 'select', section: SettingsSectionId): void;
}>();

const { t } = useI18n();
const root = shallowRef<HTMLElement | null>(null);

const activeIndex = computed(() => props.sections.findIndex((section) => section.id === props.active));
const { box, animate } = useSlidingIndicator(root, '[role="tab"]', activeIndex);

function tabs(): HTMLElement[] {
  return root.value ? [...root.value.querySelectorAll<HTMLElement>('[role="tab"]')] : [];
}

function focusTab(index: number): void {
  const section = props.sections[index];
  if (!section) return;
  emit('select', section.id);
  void nextTick(() => tabs()[index]?.focus());
}

function onKeydown(event: KeyboardEvent): void {
  const count = props.sections.length;
  const current = Math.max(0, tabs().indexOf(document.activeElement as HTMLElement));
  let next: number | null = null;
  if (event.key === 'ArrowDown') next = (current + 1) % count;
  else if (event.key === 'ArrowUp') next = (current - 1 + count) % count;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = count - 1;
  if (next === null) return;
  event.preventDefault();
  // In the list layout a section opens as its own page, so arrows only move focus there.
  if (props.list) tabs()[next]?.focus();
  else focusTab(next);
}
</script>

<template>
  <div
    ref="root"
    role="tablist"
    aria-orientation="vertical"
    class="sm-tabs"
    :class="{ 'sm-tabs-searching': searching }"
    :aria-label="t('settingsModal.sections')"
    @keydown="onKeydown"
  >
    <SlidingIndicator
      v-if="!list"
      variant="soft"
      :box="box"
      :radius="9"
      :animate="animate"
      class="sm-pill text-(--d-accent-soft)"
      :class="{ 'sm-pill-hidden': searching }"
    />
    <button
      v-for="(section, index) in sections"
      :key="section.id"
      type="button"
      role="tab"
      class="sm-tab"
      :data-testid="`settings-nav-${section.id}`"
      :aria-selected="!list && index === activeIndex ? 'true' : 'false'"
      :aria-controls="panelId"
      :tabindex="index === (activeIndex === -1 ? 0 : activeIndex) ? 0 : -1"
      @click="emit('select', section.id)"
    >
      <component
        :is="section.icon"
        class="size-3.75"
        aria-hidden="true"
      />
      <span class="flex-1">{{ t(section.label) }}</span>
      <ChevronRight
        v-if="list"
        class="size-3.75 sm-tab-chevron"
        aria-hidden="true"
      />
    </button>
  </div>
</template>
