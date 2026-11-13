<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';

const props = defineProps<{
  tone: 'warning' | 'danger' | 'info' | 'design';
  icon: Component;
  title: string;
  /** A short chip beside the title, e.g. a refusal category. */
  chip?: string | undefined;
  /** The title's element id, for a control inside the notice to point at. */
  titleId?: string | undefined;
  /** Shows a Dismiss button, which emits dismiss. */
  dismissible?: boolean | undefined;
}>();

const emit = defineEmits<{ dismiss: [] }>();
const { t } = useI18n();

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
          <span
            :id="titleId"
            class="text-13 font-semibold text-(--d-text)"
          >{{ title }}</span>
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
      <Button
        v-if="dismissible"
        type="button"
        variant="ghost"
        size="icon-sm"
        class="-me-1 -mt-0.5 size-7 flex-none rounded-8 text-(--d-faint-text) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.25"
        :title="t('common.dismiss')"
        :aria-label="t('common.dismiss')"
        data-testid="transcript-notice-dismiss"
        @click="emit('dismiss')"
      >
        <X aria-hidden="true" />
      </Button>
    </section>
  </div>
</template>
