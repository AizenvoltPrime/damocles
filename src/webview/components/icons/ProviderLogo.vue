<script setup lang="ts">
import { computed } from 'vue';
import { providerLogoSvg } from './provider-logos';

// Takes a provider id, never markup, so v-html only ever receives a vendored constant.
const props = defineProps<{ provider: string }>();

const svg = computed(() => providerLogoSvg(props.provider));
</script>

<template>
  <!-- eslint-disable vue/no-v-html -- a vendored static logo constant (provider-logos.ts) -->
  <span
    v-if="svg"
    class="shrink-0 [&>svg]:size-full"
    aria-hidden="true"
    v-html="svg"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>
