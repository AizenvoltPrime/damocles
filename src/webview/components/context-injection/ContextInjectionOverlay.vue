<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { IconCheck, IconChevronRight, IconCopy, IconDatabase } from '@/components/icons';
import LoadingSpinner from '../LoadingSpinner.vue';
import OverlayShell from '../OverlayShell.vue';
import InjectionKpiGrid from './InjectionKpiGrid.vue';
import InjectionQueryStrip from './InjectionQueryStrip.vue';
import InjectedMemoryCard from './InjectedMemoryCard.vue';
import CarriedMemoryRow from './CarriedMemoryRow.vue';
import { shortId } from './memory-display';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { useCopyToClipboard } from '@/composables/useCopyToClipboard';
import type { MemoryNotice } from '@shared/types/context-injection';

const { t, locale } = useI18n();
const store = useContextInjectionStore();
const { hasCopied, copyToClipboard } = useCopyToClipboard();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const view = ref('memories');

const display = computed(() => store.currentMemoryInjection);
const hasDisplay = computed(() => display.value !== null || store.isBuilding);

const nothingNew = computed(() => {
  const d = display.value;
  return d !== null && d.added.length === 0 && d.notices.length === 0
    && d.profile.state !== 'injected' && d.compass.state !== 'injected';
});

const profileOpen = ref(false);
const compassOpen = ref(false);

const integerFormat = computed(() => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 0 }));

function counted(key: string, n: number): string {
  return t(key, { count: integerFormat.value.format(n) }, n);
}

function noticeText(notice: MemoryNotice): string {
  const label = notice.title ?? notice.snippet;
  return t(`contextInjection.notice.${notice.kind}`, { label, replacement: notice.replacementId ? shortId(notice.replacementId) : '' });
}
</script>

<template>
  <OverlayShell
    data-testid="context-injection-overlay"
    :title="t('contextInjection.title')"
    :subtitle="t('contextInjection.promptN', { n: store.activePromptIndex + 1 })"
    :icon="IconDatabase"
    icon-class="text-primary"
    @close="emit('close')"
  >
    <template #header-actions>
      <Badge
        v-if="display?.rerankApplied"
        variant="outline"
        class="text-xs"
        :title="t('contextInjection.rerankedHint')"
        data-header="reranked"
      >
        {{ t('contextInjection.reranked') }}
      </Badge>
      <Badge v-if="display" variant="secondary" class="text-xs" data-header="tokens">
        {{ counted('contextInjection.tokensAdded', display.tokens.total) }}
      </Badge>
    </template>

    <div class="@container p-4 space-y-4">
      <div v-if="store.isLoading && !store.isBuilding" class="flex items-center justify-center py-12">
        <LoadingSpinner class="size-6" />
      </div>

      <div
        v-else-if="!hasDisplay"
        class="flex flex-col items-center justify-center text-center gap-3 py-12"
        data-state="no-record"
      >
        <IconDatabase class="size-8 text-(--d-faint)" />
        <div>
          <p class="text-sm text-(--d-muted)">{{ t('contextInjection.noContext') }}</p>
          <p class="text-xs text-(--d-faint) mt-1">{{ t('contextInjection.noContextHint') }}</p>
        </div>
      </div>

      <div v-else-if="!display" class="flex items-center justify-center gap-2 py-12" data-state="building">
        <LoadingSpinner class="size-4" />
        <span class="text-xs text-(--d-muted)">{{ t('contextInjection.building') }}</span>
      </div>

      <template v-else>
        <InjectionKpiGrid :display="display" />
        <InjectionQueryStrip :query="display.query" />

        <Tabs v-model="view" class="gap-4">
          <TabsList :aria-label="t('contextInjection.view.label')" class="h-8">
            <TabsTrigger value="memories" class="px-2 text-xs" data-view-tab="memories">{{ t('contextInjection.view.memories') }}</TabsTrigger>
            <TabsTrigger value="exactText" class="px-2 text-xs" data-view-tab="exactText">{{ t('contextInjection.view.exactText') }}</TabsTrigger>
          </TabsList>

          <TabsContent value="memories" class="space-y-4">
            <p v-if="nothingNew" class="text-sm text-(--d-muted)" data-state="nothing-new">
              {{ counted('contextInjection.nothingNew', display.carried.length) }}
            </p>

            <section class="text-xs" data-section="profile">
              <Collapsible v-if="display.profile.state === 'injected'" v-model:open="profileOpen">
                <CollapsibleTrigger as-child>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 py-1 text-(--d-muted) transition-colors hover:text-(--d-text) cursor-pointer"
                    data-action="toggle-profile"
                  >
                    <IconChevronRight class="size-3.5 shrink-0 transition-transform" :class="{ 'rotate-90': profileOpen }" />
                    <span class="font-medium">{{ t('contextInjection.profile.label') }}</span>
                    <span class="ml-auto tabular-nums" data-section-tokens>{{ counted('contextInjection.memoryTokenCount', display.profile.tokens) }}</span>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre
                    class="mt-1 whitespace-pre-wrap wrap-break-word rounded-lg border border-(--d-border) bg-[color-mix(in_srgb,var(--d-hover)_60%,transparent)] p-3 font-mono text-xs text-(--d-text)"
                    data-profile-text
                  >{{ display.profile.text }}</pre>
                </CollapsibleContent>
              </Collapsible>
              <p v-else class="text-(--d-muted)">
                <span class="font-medium">{{ t('contextInjection.profile.label') }}:</span>
                {{ t(`contextInjection.profile.${display.profile.state}`) }}
              </p>
            </section>

            <section class="text-xs" data-section="compass">
              <Collapsible v-if="display.compass.state === 'injected'" v-model:open="compassOpen">
                <CollapsibleTrigger as-child>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 py-1 text-(--d-muted) transition-colors hover:text-(--d-text) cursor-pointer"
                    data-action="toggle-compass"
                  >
                    <IconChevronRight class="size-3.5 shrink-0 transition-transform" :class="{ 'rotate-90': compassOpen }" />
                    <span class="font-medium">{{ t('contextInjection.compass.label') }}</span>
                    <span class="ml-auto tabular-nums" data-section-tokens>{{ counted('contextInjection.memoryTokenCount', display.tokens.compass) }}</span>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre
                    class="mt-1 whitespace-pre-wrap wrap-break-word rounded-lg border border-(--d-border) bg-[color-mix(in_srgb,var(--d-hover)_60%,transparent)] p-3 font-mono text-xs text-(--d-text)"
                    data-compass-text
                  >{{ display.compass.text }}</pre>
                </CollapsibleContent>
              </Collapsible>
              <p v-else class="text-(--d-muted)">
                <span class="font-medium">{{ t('contextInjection.compass.label') }}:</span>
                {{ t(`contextInjection.compass.${display.compass.state}`) }}
              </p>
            </section>

            <section v-if="display.added.length > 0" class="space-y-2" data-section="added">
              <h3 class="text-xs font-medium uppercase tracking-widest text-(--d-muted)">
                {{ t('contextInjection.section.added', { count: display.added.length }) }}
              </h3>
              <InjectedMemoryCard
                v-for="memory in display.added"
                :key="memory.id"
                :memory="memory"
                :pinned="store.isPinned(memory.id, memory.isPinned)"
                :forgotten="store.isForgotten(memory.id, memory.isForgotten)"
              />
            </section>

            <section v-if="display.notices.length > 0" class="space-y-2" data-section="notices">
              <h3 class="text-xs font-medium uppercase tracking-widest text-(--d-muted)">
                {{ t('contextInjection.section.notices', { count: display.notices.length }) }}
              </h3>
              <ul class="space-y-1">
                <li
                  v-for="notice in display.notices"
                  :key="`${notice.kind}:${notice.id}`"
                  class="text-xs text-(--d-text) rounded-md border border-(--d-border) px-3 py-2"
                  :data-notice="notice.kind"
                >
                  {{ noticeText(notice) }}
                </li>
              </ul>
            </section>

            <section v-if="display.carried.length > 0" class="space-y-2" data-section="carried">
              <h3 class="text-xs font-medium uppercase tracking-widest text-(--d-muted)">
                {{ t('contextInjection.section.carried', { count: display.carried.length }) }}
              </h3>
              <ul class="space-y-1">
                <CarriedMemoryRow
                  v-for="memory in display.carried"
                  :key="memory.id"
                  :memory="memory"
                  :pinned="store.isPinned(memory.id, memory.isPinned)"
                  :forgotten="store.isForgotten(memory.id)"
                />
              </ul>
            </section>
          </TabsContent>

          <TabsContent value="exactText" class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs text-(--d-muted)">{{ t('contextInjection.exactTextHint') }}</p>
              <Button
                v-if="display.exactText"
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs"
                data-action="copy-exact-text"
                @click="copyToClipboard(display.exactText)"
              >
                <component :is="hasCopied ? IconCheck : IconCopy" class="size-3.5" />
                <span>{{ hasCopied ? t('contextInjection.copied') : t('contextInjection.copy') }}</span>
              </Button>
            </div>
            <pre
              v-if="display.exactText"
              class="text-xs font-mono whitespace-pre-wrap wrap-break-word rounded-lg border border-(--d-border) bg-[color-mix(in_srgb,var(--d-hover)_60%,transparent)] p-3 text-(--d-text)"
              data-exact-text
            >{{ display.exactText }}</pre>
            <p v-else class="text-sm text-(--d-muted)" data-state="nothing-sent">{{ t('contextInjection.nothingSent') }}</p>
          </TabsContent>
        </Tabs>
      </template>
    </div>
  </OverlayShell>
</template>
