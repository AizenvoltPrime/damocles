<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { X } from 'lucide-vue-next';

const props = defineProps<{
  tone: 'warning' | 'danger' | 'info';
  icon: Component;
  title: string;
}>();

const emit = defineEmits<{ dismiss: [] }>();
const { t } = useI18n();

const toneVar = computed(() => `var(--d-${props.tone})`);
</script>

<template>
  <div
    class="flex items-start gap-2.5 rounded-[0.875rem] border bg-(--d-card) py-2 ps-3 pe-2 shadow-(--d-shadow)"
    :style="{ borderColor: `color-mix(in srgb, ${toneVar} 45%, var(--d-border))` }"
    role="status"
  >
    <span
      class="mt-px flex size-6.5 shrink-0 items-center justify-center rounded-8"
      :style="{ background: `color-mix(in srgb, ${toneVar} 16%, transparent)`, color: toneVar }"
      aria-hidden="true"
    >
      <component
        :is="icon"
        class="size-3.5"
      />
    </span>
    <div class="min-w-0 flex-1">
      <div
        class="font-semibold leading-6.5"
        :style="{ color: toneVar }"
      >
        {{ title }}
      </div>
      <slot />
    </div>
    <slot name="actions" />
    <button
      type="button"
      class="d-tool-btn size-7 min-w-7 px-0"
      :title="t('common.dismiss')"
      :aria-label="t('common.dismiss')"
      data-testid="banner-dismiss"
      @click="emit('dismiss')"
    >
      <X
        class="size-3.25"
        aria-hidden="true"
      />
    </button>
  </div>
</template>
