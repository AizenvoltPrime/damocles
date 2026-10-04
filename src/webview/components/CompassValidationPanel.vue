<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Component } from 'vue';
import { ChevronRight, CircleX, Compass, Info, RefreshCw, TriangleAlert } from 'lucide-vue-next';
import OverlayHeaderAction from './OverlayHeaderAction.vue';
import OverlayShell from './OverlayShell.vue';
import LoadingSpinner from './LoadingSpinner.vue';
import { useCompassStore } from '@/stores/useCompassStore';
const { t } = useI18n();

const store = useCompassStore();

const expandedCategories = ref<Set<string>>(new Set());

const sortedIssues = computed(() => {
	if (!store.validationResult) return [];
	const order: Record<string, number> = { error: 0, warning: 1, info: 2 };
	return [...store.validationResult.issues].sort(
		(a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
	);
});

const isHealthy = computed(() =>
	store.validationResult !== null && store.validationResult.issues.every(i => i.severity === 'info')
);

function toggleCategory(category: string): void {
	if (expandedCategories.value.has(category)) {
		expandedCategories.value.delete(category);
	} else {
		expandedCategories.value.add(category);
	}
}

// `chip` is the tone's `.d-tone-*` class (style.css), for the count on its tint.
function severityColor(severity: string): { icon: string; chip: string } {
	if (severity === 'error') return { icon: 'text-(--d-danger)', chip: 'd-tone-danger' };
	if (severity === 'warning') return { icon: 'text-(--d-warning)', chip: 'd-tone-warning' };
	return { icon: 'text-(--d-info)', chip: 'd-tone-info' };
}

function severityIcon(severity: string): Component {
	if (severity === 'error') return CircleX;
	if (severity === 'warning') return TriangleAlert;
	return Info;
}

function ratioClass(ratio: number): string {
	return ratio < 1.0 ? 'text-(--d-warning)' : 'text-(--d-text)';
}

onMounted(() => {
	if (!store.validationResult && !store.validationLoading) {
		store.requestValidation();
	}
});
</script>

<template>
  <OverlayShell
    fill
    :title="t('compassValidation.title')"
    :icon="Compass"
    icon-class="text-(--d-success)"
    @close="store.setActivePanel(null)"
  >
    <template #header-actions>
      <OverlayHeaderAction
        :label="t('compassValidation.revalidate')"
        :icon="RefreshCw"
        :busy="store.validationLoading"
        :disabled="store.validationLoading"
        @click="store.requestValidation()"
      />
    </template>

    <div
      v-if="store.validationLoading"
      class="flex flex-col items-center justify-center gap-2 py-12"
    >
      <LoadingSpinner class="size-6" />
      <span
        v-if="store.buildProgress"
        class="text-xs text-(--d-muted)"
      >
        {{ t('compassValidation.buildingProgress', { current: store.buildProgress.current, total: store.buildProgress.total }) }}
      </span>
      <span
        v-else
        class="text-xs text-(--d-muted)"
      >{{ t('compassValidation.running') }}</span>
    </div>

    <div
      v-else-if="store.validationResult"
      class="flex flex-col"
    >
      <div class="mx-4 mt-3 mb-2 rounded-xl border border-(--d-border) bg-(--d-card) px-3 py-2.5">
        <div class="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1 text-12.5">
          <span class="text-(--d-muted)">{{ t('compassValidation.nodes') }}</span>
          <span>{{ store.validationResult.summary.nodeCount.toLocaleString() }}</span>
          <span class="text-(--d-muted)">{{ t('compassValidation.edges') }}</span>
          <span>{{ store.validationResult.summary.edgeCount.toLocaleString() }}</span>
          <span class="text-(--d-muted)">{{ t('compassValidation.ratio') }}</span>
          <span :class="ratioClass(store.validationResult.summary.edgeToNodeRatio)">
            {{ store.validationResult.summary.edgeToNodeRatio.toFixed(2) }}
          </span>
          <span class="text-(--d-muted)">{{ t('compassValidation.coverage') }}</span>
          <span>{{ store.validationResult.summary.coveragePercent }}%</span>
        </div>
        <div class="text-10 text-(--d-muted) mt-1">
          {{ t('compassValidation.checkedIn', { ms: store.validationResult.durationMs }) }}
        </div>
        <p
          v-if="store.buildProgress"
          class="text-xs text-(--d-muted) mt-1"
        >
          {{ t('compassValidation.reindexing') }}
        </p>
      </div>

      <div
        v-if="isHealthy"
        class="px-3 py-6 text-center"
      >
        <div class="text-sm text-(--d-success) font-medium">
          {{ t('compassValidation.healthy') }}
        </div>
      </div>

      <ScrollArea
        v-else
        class="flex-1"
      >
        <div class="divide-y divide-(--d-border)">
          <div
            v-for="issue in sortedIssues"
            :key="issue.category"
          >
            <button
              type="button"
              class="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-(--d-hover)"
              :aria-expanded="expandedCategories.has(issue.category)"
              @click="toggleCategory(issue.category)"
            >
              <component
                :is="severityIcon(issue.severity)"
                class="size-3.25 flex-none"
                :class="severityColor(issue.severity).icon"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 truncate text-12.5 text-(--d-text)">{{ issue.category }}</span>
              <span
                v-if="issue.count > 0"
                class="flex-none rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_14%,transparent)] px-1.75 font-mono text-10.5/4"
                :class="severityColor(issue.severity).chip"
              >{{ issue.count }}</span>
              <ChevronRight
                class="size-3.25 flex-none text-(--d-faint) transition-transform duration-200"
                :class="expandedCategories.has(issue.category) && 'rotate-90'"
                aria-hidden="true"
              />
            </button>
            <div
              v-if="expandedCategories.has(issue.category)"
              class="px-4 pb-3 pl-10.5"
            >
              <p class="mb-1.5 text-11.5 text-(--d-muted)">
                {{ issue.description }}
              </p>
              <div
                v-if="issue.entities.length > 0"
                class="max-h-48 overflow-y-auto rounded-lg border border-(--d-border) bg-(--d-code) p-1.5"
              >
                <div
                  v-for="(entity, idx) in issue.entities"
                  :key="idx"
                  class="truncate px-1 py-0.5 font-mono text-11 text-(--d-text)"
                >
                  {{ entity }}
                </div>
                <div
                  v-if="issue.truncated"
                  class="text-10 text-(--d-muted) italic px-1 pt-0.5"
                >
                  {{ t('compassValidation.andMore') }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  </OverlayShell>
</template>
