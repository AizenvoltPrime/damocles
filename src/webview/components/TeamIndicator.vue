<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { Users } from 'lucide-vue-next';
import { useTeamStore } from '@/stores/useTeamStore';

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
    type="button"
    class="flex shrink-0 items-center gap-1.25 rounded-full border border-transparent bg-(--d-accent-soft) px-2 py-0.5 text-(--d-accent-text) transition-colors hover:border-(--d-accent)"
    data-testid="composer-team"
    @click="openFirstActive"
  >
    <Users
      class="size-2.75 animate-[d-pulse_1.6s_ease-in-out_infinite]"
      aria-hidden="true"
    />
    <span class="@max-[43rem]:sr-only">{{ t('team.indicator.label', { n: activeTeamCount }) }}</span>
  </button>
</template>
