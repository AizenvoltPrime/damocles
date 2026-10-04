<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { ClipboardList, Eye } from 'lucide-vue-next';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { usePlanSummary } from '@/composables/usePlanSummary';

const { t } = useI18n();
const permissionStore = usePermissionStore();
const { pendingPlanApproval } = storeToRefs(permissionStore);
const planSummary = usePlanSummary(() => pendingPlanApproval.value?.toolUseId);

const subtitle = computed(() => [...planSummary.value, t('cards.planBanner.unchanged')].join(' · '));
</script>

<template>
  <Transition name="t-up">
    <section
      v-if="pendingPlanApproval"
      class="flex items-center gap-2.5 rounded-[0.875rem] border border-[color-mix(in_srgb,var(--d-accent)_45%,var(--d-border))] bg-(--d-card) py-2 pr-2 pl-3 shadow-(--d-shadow)"
      :aria-label="t('cards.planBanner.title')"
      data-testid="plan-ready-banner"
    >
      <span
        class="flex size-6.5 flex-none items-center justify-center rounded-8 bg-(--d-accent-soft) text-(--d-accent)"
        aria-hidden="true"
      >
        <ClipboardList class="size-3.5" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="font-semibold text-(--d-text)">
          {{ t('cards.planBanner.title') }}
        </div>
        <div class="truncate text-xs text-(--d-muted)">
          {{ subtitle }}
        </div>
      </div>
      <button
        type="button"
        class="d-press flex h-7.5 flex-none items-center gap-1.5 rounded-9 bg-(--d-accent) px-3.25 text-12.5 font-semibold whitespace-nowrap text-(--d-on-accent) transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent)"
        @click="permissionStore.showPlanOverlay()"
      >
        <Eye
          class="size-3.25"
          aria-hidden="true"
        />
        {{ t('cards.planBanner.review') }}
      </button>
    </section>
  </Transition>
</template>
