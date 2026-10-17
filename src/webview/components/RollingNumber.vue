<script setup lang="ts">
import { ref, watch } from 'vue';

// A count that rolls to its new value: up when it rose, down when it fell. Both copies share one inline-grid cell, so the
// width never empties between them; the leaving copy is hidden from assistive technology and loses its test id.
const props = defineProps<{ value: number; testId?: string }>();
const roll = ref<'t-swap' | 't-swap-down'>('t-swap');
watch(() => props.value, (next, previous) => {
  roll.value = next >= previous ? 't-swap' : 't-swap-down';
});

function retire(element: Element): void {
  element.removeAttribute('data-testid');
  element.setAttribute('aria-hidden', 'true');
}
</script>

<template>
  <span class="inline-grid">
    <Transition
      :name="roll"
      @before-leave="retire"
    >
      <span
        :key="value"
        :data-testid="testId"
        class="[grid-area:1/1]"
      >{{ value }}</span>
    </Transition>
  </span>
</template>
