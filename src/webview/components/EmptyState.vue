<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { BookOpen, Bug, FlaskConical } from 'lucide-vue-next';
import { useSettingsStore } from '@/stores/useSettingsStore';

const emit = defineEmits<{ pick: [prompt: string] }>();

const { t } = useI18n();
const { workspaceFolders, panelWorkspaceFolderKey, hostCapabilities } = storeToRefs(useSettingsStore());

const logoUri = ref('');
onMounted(() => {
  logoUri.value = document.getElementById('app')?.dataset.logoUri ?? '';
});

const project = computed(() => workspaceFolders.value.find((f) => f.key === panelWorkspaceFolderKey.value)?.name);

const suggestions = computed(() => [
  { icon: BookOpen, label: t('emptyState.explain') },
  { icon: Bug, label: t('emptyState.fixBug') },
  { icon: FlaskConical, label: t('emptyState.writeTests') },
]);
</script>

<template>
  <div
    class="chat-column flex flex-col items-center gap-3.5 pt-[12vh] pb-8 text-center"
    data-testid="empty-state"
  >
    <img
      v-if="logoUri"
      :src="logoUri"
      alt=""
      class="size-14 animate-[d-up_.4s_var(--ease-out)_both] drop-shadow-[0_6px_24px_color-mix(in_srgb,var(--d-accent)_35%,transparent)]"
    >
    <h2 class="animate-[d-up_.4s_var(--ease-out)_60ms_both] text-[1.25rem] font-semibold tracking-[-.015em] text-(--d-text)">
      {{ project ? t('emptyState.title', { project }) : t('emptyState.titleNoProject') }}
    </h2>
    <p class="max-w-105 animate-[d-up_.4s_var(--ease-out)_110ms_both] text-pretty text-(--d-muted)">
      {{ hostCapabilities.fileMentionDrop ? t('emptyState.subtitleDrag') : t('emptyState.subtitle') }}
    </p>
    <div class="mt-1 flex flex-wrap justify-center gap-2">
      <button
        v-for="(suggestion, index) in suggestions"
        :key="suggestion.label"
        type="button"
        class="d-press flex items-center gap-1.75 rounded-full border border-(--d-border2) bg-(--d-card) px-3.25 py-2 text-(--d-text) transition-colors hover:border-(--d-accent) hover:text-(--d-accent) animate-[d-up_.4s_var(--ease-out)_both]"
        :style="{ animationDelay: `${160 + index * 50}ms` }"
        data-testid="empty-state-suggestion"
        @click="emit('pick', suggestion.label)"
      >
        <component
          :is="suggestion.icon"
          class="size-3.25"
          aria-hidden="true"
        />
        {{ suggestion.label }}
      </button>
    </div>
  </div>
</template>
