<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { X } from 'lucide-vue-next';

// A caller's attributes (its data-testid, a role) go to the banner itself, not its shadow wrapper, and win over its own.
defineOptions({ inheritAttrs: false });

const props = defineProps<{
  tone: 'warning' | 'danger' | 'info';
  icon: Component;
  title: string;
}>();

const emit = defineEmits<{ dismiss: [] }>();
const { t } = useI18n();

const toneVar = computed(() => `var(--d-${props.tone})`);
const toneFillVar = computed(() => `var(--d-${props.tone}-fill)`);
</script>

<template>
  <div class="d-dock-shadow rounded-14">
    <div
      class="flex items-start gap-2.5 rounded-14 border bg-(--d-card) py-2 ps-3 pe-2"
      :style="{ borderColor: `color-mix(in srgb, ${toneFillVar} 45%, var(--d-border))` }"
      role="status"
      v-bind="$attrs"
    >
      <span
        class="mt-px flex size-6.5 shrink-0 items-center justify-center rounded-8"
        :style="{ background: `color-mix(in srgb, ${toneFillVar} 16%, transparent)`, color: toneVar }"
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
  </div>
</template>
