<script setup lang="ts">
import { KeyRound } from 'lucide-vue-next';
import DockBanner from './DockBanner.vue';

defineProps<{
  message: string;
}>();

defineEmits<{
  (e: 'sign-in'): void;
  (e: 'dismiss'): void;
}>();
</script>

<template>
  <DockBanner
    tone="warning"
    :icon="KeyRound"
    :title="$t('authBanner.title')"
    data-testid="auth-banner"
    @dismiss="$emit('dismiss')"
  >
    <p class="truncate text-xs text-(--d-text)">
      {{ message }}
    </p>
    <p class="mt-0.5 pb-0.5 text-xs text-(--d-muted)">
      {{ $t('authBanner.independenceNote') }}
    </p>
    <template #actions>
      <button
        type="button"
        class="d-press flex h-7.5 shrink-0 items-center rounded-9 bg-(--d-accent) px-3.25 text-12.5 font-semibold text-(--d-on-accent)"
        @click="$emit('sign-in')"
      >
        {{ $t('authBanner.signIn') }}
      </button>
    </template>
  </DockBanner>
</template>
