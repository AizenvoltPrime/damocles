<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Check } from 'lucide-vue-next';
import type { ConflictChoice } from './conflict-parser';

// The action row above a conflict in an input pane (the prototype's merge editor), or its resolved mark once the Result no
// longer holds it. Rendered into a Monaco view zone; inline link buttons, which no shadcn part draws at a code line's size.
defineProps<{ side: 'incoming' | 'current'; resolved: boolean; focused: boolean }>();
const emit = defineEmits<{ accept: [choice: ConflictChoice] }>();
const { t } = useI18n();
const ACTIONS: ReadonlyArray<{ readonly choice: ConflictChoice; readonly label: string }> = [
  { choice: 'incoming', label: 'merge.acceptIncoming' },
  { choice: 'current', label: 'merge.acceptCurrent' },
  { choice: 'both', label: 'merge.acceptBoth' },
];
</script>

<template>
  <div
    class="flex h-full items-center gap-2 pl-3 font-sans text-11 whitespace-nowrap"
    :class="focused && !resolved ? 'qd-merge-actions-focus' : ''"
    :data-testid="`merge-actions-${side}`"
  >
    <Transition
      name="t-swap"
      mode="out-in"
    >
      <span
        v-if="resolved"
        key="resolved"
        class="inline-flex items-center gap-1 text-(--d-success-text)"
      ><Check
        aria-hidden="true"
        class="size-3"
      />{{ t('merge.resolved') }}</span>
      <span
        v-else
        key="open"
        class="inline-flex items-center gap-2"
      >
        <template
          v-for="(action, index) in ACTIONS"
          :key="action.choice"
        >
          <span
            v-if="index > 0"
            aria-hidden="true"
            class="text-(--d-faint)"
          >|</span>
          <button
            type="button"
            class="cursor-pointer rounded-5 px-0.5 text-(--d-accent-text) outline-none hover:underline focus-visible:shadow-[0_0_0_1px_var(--d-accent)]"
            :data-testid="`merge-accept-${action.choice}`"
            @click="emit('accept', action.choice)"
          >
            {{ t(action.label) }}
          </button>
        </template>
      </span>
    </Transition>
  </div>
</template>
