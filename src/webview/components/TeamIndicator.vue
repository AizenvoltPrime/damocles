<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useTeamStore } from '@/stores/useTeamStore';
import { storeToRefs } from 'pinia';
import LoadingSpinner from './LoadingSpinner.vue';

const { t } = useI18n();

const teamStore = useTeamStore();
const { activeTeamCount } = storeToRefs(teamStore);

function openFirstActive(): void {
  const firstActive = teamStore.activeTeams[0];
  if (firstActive) {
    teamStore.openOverlay(firstActive.teamId);
  }
}
</script>

<template>
  <button
    v-if="activeTeamCount > 0"
    class="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-primary hover:bg-foreground/5 transition-colors cursor-pointer"
    @click="openFirstActive"
  >
    <LoadingSpinner :size="12" class="text-primary" />
    <span>{{ t('team.indicator.label', { n: activeTeamCount }) }}</span>
  </button>
</template>
