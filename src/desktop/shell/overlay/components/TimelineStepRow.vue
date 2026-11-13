<script setup lang="ts">
import { Check, LoaderCircle, X } from 'lucide-vue-next';
import type { FlowStepState } from '../../../../shared/forge/publish';

// One step of a timeline (StepTimeline, FlowTimeline): the rail to the next step, the state's badge, the label slot and,
// in the default slot, what the step shows under its label.
defineProps<{ step: string; state: FlowStepState; index: number; last: boolean }>();
</script>

<template>
  <li
    :data-step="step"
    :data-state="state"
    class="timeline-row relative grid grid-cols-[1.5rem_1fr] gap-x-3 pb-4.5 last:pb-0"
    :style="{ '--row-index': index }"
  >
    <span
      v-if="!last"
      aria-hidden="true"
      class="absolute inset-s-3 top-6 bottom-0 -ms-px w-0.5 bg-(--d-border)"
    >
      <span
        class="timeline-line block size-full origin-top bg-(--d-success)"
        :class="state === 'done' ? 'scale-y-100' : 'scale-y-0'"
      />
    </span>
    <span
      aria-hidden="true"
      class="relative z-1 grid size-6 place-items-center rounded-full border-[1.5px] bg-(--d-card) transition-colors duration-200 ease-out"
      :class="{
        'border-(--d-border2) text-(--d-faint)': state === 'pending',
        'border-(--d-accent) text-(--d-accent)': state === 'active',
        'border-(--d-success) bg-[color-mix(in_srgb,var(--d-success)_16%,var(--d-card))] text-(--d-success)': state === 'done',
        'border-(--d-danger) bg-[color-mix(in_srgb,var(--d-danger)_16%,var(--d-card))] text-(--d-danger)': state === 'failed',
      }"
    >
      <Transition
        name="t-icon"
        mode="out-in"
      >
        <Check
          v-if="state === 'done'"
          key="done"
          class="size-3"
        />
        <X
          v-else-if="state === 'failed'"
          key="failed"
          class="size-3"
        />
        <span
          v-else-if="state === 'active'"
          key="active"
          class="grid place-items-center"
        >
          <LoaderCircle class="timeline-spinner d-spinning size-3" />
          <span class="timeline-ellipsis text-11 leading-none font-semibold">…</span>
        </span>
      </Transition>
    </span>
    <div class="flex min-w-0 flex-col">
      <span
        class="text-13/6 font-medium wrap-break-word"
        :class="state === 'pending' ? 'text-(--d-faint-text)' : state === 'failed' ? 'text-(--d-danger-text)' : ''"
      ><slot name="label" /></span>
      <slot />
    </div>
  </li>
</template>
