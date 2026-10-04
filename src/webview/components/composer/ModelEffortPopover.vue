<script setup lang="ts">
import { computed, useTemplateRef } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { Check, ChevronUp, Cpu } from 'lucide-vue-next';
import type { AcceptableValue } from 'reka-ui';
import type { EffortLevel, ModelInfo } from '@shared/types/settings';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MENU_CONTENT } from '@/components/chat-header/menuStyles';
import SlidingIndicator from '@/components/SlidingIndicator.vue';
import { providerLogoSvg } from '@/components/icons/provider-logos';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import { modelVendor, type ModelVendor } from '@/composables/useModelIdentity';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { remPx } from '@/composables/useRemPx';

const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const settingsStore = useSettingsStore();
const { availableModels, activeModel, defaultModel, panelThinking, panelThinkingModel } = storeToRefs(settingsStore);

// Vendor names are brands, shown as written in every language.
const VENDOR_NAMES: Record<ModelVendor, string> = { anthropic: 'Anthropic', openai: 'OpenAI', deepseek: 'DeepSeek', stepfun: 'StepFun' };

const chatModel = computed(() => activeModel.value || defaultModel.value);
const current = computed(() => availableModels.value.find((model) => model.value === chatModel.value));

const groups = computed(() => {
  const byVendor = new Map<ModelVendor, ModelInfo[]>();
  for (const model of availableModels.value) {
    const vendor = modelVendor(model);
    byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), model]);
  }
  return [...byVendor].map(([vendor, models]) => ({ vendor, name: VENDOR_NAMES[vendor], logo: providerLogoSvg(vendor), models }));
});

const thinkingModel = computed(() => availableModels.value.find((model) => model.value === (panelThinkingModel.value || chatModel.value)));
const effortLevels = computed<EffortLevel[]>(() => thinkingModel.value?.supportedEffortLevels ?? []);
const thinkingOn = computed(() => panelThinking.value !== null && (!panelThinking.value.thinkingDisabled || thinkingModel.value?.backend === 'openai'));
const showEffort = computed(() => thinkingOn.value && (thinkingModel.value?.supportsAdaptiveThinking ?? false) && effortLevels.value.length > 0);
const effort = computed<EffortLevel | undefined>(() => panelThinking.value?.effort ?? effortLevels.value[0]);
const effortIndex = computed(() => (effort.value ? effortLevels.value.indexOf(effort.value) : 0));
const effortGroup = useTemplateRef('effortGroup');
const { box: effortBox, animate: effortAnimate } = useSlidingIndicator(() => effortGroup.value?.$el as HTMLElement | undefined, '[role="menuitemradio"]', effortIndex);

const triggerLabel = computed(() => {
  const name = current.value?.displayName ?? chatModel.value;
  return showEffort.value && effort.value ? `${name} · ${t(`settingsModal.effort.${effort.value}`)}` : name;
});

function selectModel(value: AcceptableValue): void {
  if (typeof value !== 'string' || value === chatModel.value) return;
  if (settingsStore.pendingOpenAIModel && settingsStore.pendingOpenAIModel !== value) settingsStore.setPendingOpenAIModel(null);
  settingsStore.setModelState(value, defaultModel.value);
  postMessage({ type: 'setActiveModel', model: value });
}

function selectEffort(value: AcceptableValue): void {
  if (typeof value !== 'string' || value === effort.value) return;
  const level = effortLevels.value.find((candidate) => candidate === value);
  if (level) postMessage({ type: 'setPanelEffort', effort: level, model: panelThinkingModel.value || chatModel.value });
}

const currentLogo = computed(() => (current.value ? providerLogoSvg(modelVendor(current.value)) : undefined));
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger
      class="d-tool-btn h-7 min-w-0 shrink gap-1.5 rounded-full px-2.25 text-xs"
      :title="t('composer.modelFor')"
      :aria-label="`${t('composer.modelFor')}: ${triggerLabel}`"
      data-testid="composer-model"
    >
      <!-- eslint-disable vue/no-v-html -- a vendored static logo constant (provider-logos.ts) -->
      <span
        v-if="currentLogo"
        class="size-3.5 shrink-0 [&>svg]:size-full"
        aria-hidden="true"
        v-html="currentLogo"
      />
      <!-- eslint-enable vue/no-v-html -->
      <Cpu
        v-else
        class="size-3.5"
        aria-hidden="true"
      />
      <span class="truncate @max-[32.5rem]:hidden">{{ triggerLabel }}</span>
      <ChevronUp
        class="size-2.75 shrink-0"
        aria-hidden="true"
      />
    </DropdownMenuTrigger>
    <DropdownMenuContent
      side="top"
      align="end"
      :side-offset="remPx(0.5)"
      :class="[MENU_CONTENT, 'max-h-[min(38.75rem,var(--reka-dropdown-menu-content-available-height))] w-67.5 overflow-y-auto rounded-xl p-1.5']"
      data-testid="composer-model-menu"
    >
      <DropdownMenuLabel class="px-2 pb-1.5 pt-1 text-10.5 font-normal uppercase tracking-[.06em] text-(--d-faint)">
        {{ t('composer.modelFor') }}
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        :model-value="chatModel"
        :aria-label="t('composer.modelFor')"
        @update:model-value="selectModel"
      >
        <template
          v-for="group in groups"
          :key="group.vendor"
        >
          <div
            class="flex items-center gap-1.75 px-2.25 pb-0.75 pt-1.5 text-10.5 text-(--d-faint)"
            role="presentation"
          >
            <!-- eslint-disable vue/no-v-html -- a vendored static logo constant (provider-logos.ts) -->
            <span
              v-if="group.logo"
              class="size-3 shrink-0 [&>svg]:size-full"
              aria-hidden="true"
              v-html="group.logo"
            />
            <!-- eslint-enable vue/no-v-html -->
            {{ group.name }}
          </div>
          <DropdownMenuRadioItem
            v-for="model in group.models"
            :key="model.value"
            :value="model.value"
            :title="model.description"
            class="gap-2.25 rounded-7 px-2.25 py-1.5 text-13 text-(--d-text) focus:bg-(--d-hover) focus:text-(--d-text) data-[state=checked]:bg-(--d-accent-soft) [&>span:first-child]:hidden"
            data-testid="composer-model-option"
          >
            <!-- eslint-disable vue/no-v-html -- a vendored static logo constant (provider-logos.ts) -->
            <span
              v-if="group.logo"
              class="size-3.75 shrink-0 [&>svg]:size-full"
              aria-hidden="true"
              v-html="group.logo"
            />
            <!-- eslint-enable vue/no-v-html -->
            <span class="flex-1 truncate">{{ model.displayName }}</span>
            <Check
              class="size-3.25 shrink-0 text-(--d-accent) transition-opacity"
              :class="model.value === chatModel ? 'opacity-100' : 'opacity-0'"
              aria-hidden="true"
            />
          </DropdownMenuRadioItem>
        </template>
      </DropdownMenuRadioGroup>
      <template v-if="showEffort">
        <DropdownMenuSeparator class="mx-0.5 my-1.5 bg-(--d-border)" />
        <DropdownMenuLabel class="px-2 pb-1.5 pt-0.5 text-10.5 font-normal uppercase tracking-[.06em] text-(--d-faint)">
          {{ t('composer.reasoningEffort') }}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          ref="effortGroup"
          :model-value="effort ?? null"
          :aria-label="t('composer.reasoningEffort')"
          class="relative isolate flex flex-wrap gap-0.75 px-1 pb-1"
          @update:model-value="selectEffort"
        >
          <SlidingIndicator
            :box="effortBox"
            :radius="6"
            :animate="effortAnimate"
            class="z-1 text-(--d-accent)"
          />
          <!-- The pill fill sits in ::before below the indicator (z 1) and the label above it, so the indicator slides between them. -->
          <DropdownMenuRadioItem
            v-for="level in effortLevels"
            :key="level"
            :value="level"
            class="rounded-md px-2 py-0.75 text-11.5/normal transition-colors duration-200 before:absolute before:inset-0 before:rounded-[inherit] before:bg-(--d-hover) before:content-[''] focus:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--d-accent) focus-visible:outline-solid [&>span:first-child]:hidden"
            :class="level === effort ? 'text-(--d-on-accent) focus:text-(--d-on-accent)' : 'text-(--d-muted) focus:text-(--d-text)'"
            data-testid="composer-effort-option"
            @select.prevent
          >
            <span class="relative z-2 whitespace-nowrap">{{ t(`settingsModal.effort.${level}`) }}</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
