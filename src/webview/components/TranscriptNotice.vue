<script setup lang="ts">
import { computed, type Component } from 'vue';

const props = defineProps<{
  tone: 'warning' | 'danger' | 'info';
  icon: Component;
  title: string;
  /** A short chip beside the title, e.g. a refusal category. */
  chip?: string | undefined;
}>();

const toneVar = computed(() => `var(--d-${props.tone})`);
const toneTextVar = computed(() => `var(--d-${props.tone}-text)`);
</script>

<template>
  <!-- Padding, not margin: the virtual list measures each row's height, and margins fall outside it. -->
  <div class="py-2">
    <section
      class="flex items-start gap-2.5 rounded-xl border bg-(--d-card) px-3 py-2.25"
      :style="{ borderColor: `color-mix(in srgb, ${toneVar} 35%, var(--d-border))` }"
      :aria-label="title"
    >
      <span
        class="flex size-7 flex-none items-center justify-center rounded-lg"
        :style="{ background: `color-mix(in srgb, ${toneVar} 14%, transparent)`, color: toneVar }"
        aria-hidden="true"
      >
        <component
          :is="icon"
          class="size-3.5"
        />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <span class="text-13 font-semibold text-(--d-text)">{{ title }}</span>
          <span
            v-if="chip"
            class="rounded-full px-2 py-px text-11 font-medium"
            :style="{ background: `color-mix(in srgb, ${toneVar} 14%, transparent)`, color: toneTextVar }"
          >{{ chip }}</span>
        </div>
        <div class="flex flex-col gap-0.5 text-xs text-pretty text-(--d-muted)">
          <slot />
        </div>
      </div>
    </section>
  </div>
</template>
