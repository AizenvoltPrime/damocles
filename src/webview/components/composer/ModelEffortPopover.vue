<script setup lang="ts">
import { computed, useId, useTemplateRef } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { Check, ChevronUp, Cpu, Settings2 } from 'lucide-vue-next';
import type { AcceptableValue } from 'reka-ui';
import type { EffortLevel, ModelInfo } from '@shared/types/settings';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MENU_CONTENT } from '@/components/chat-header/menuStyles';
import SlidingIndicator from '@/components/SlidingIndicator.vue';
import ProviderLogo from '@/components/icons/ProviderLogo.vue';
import { hasProviderLogo } from '@/components/icons/provider-logos';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import { MODEL_VENDOR_NAMES, modelVendor, type ModelVendor } from '@shared/model-vendor';
import { ACCOUNT_PROVIDER_NAMES } from '@shared/settings-sections';
import { usePickerModels } from '@/composables/usePickerModels';
import { useOpenSettings } from '@/composables/useOpenSettings';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { remPx } from '@/composables/useRemPx';
import { useChatHost } from '@/composables/useChatHost';

const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const settingsStore = useSettingsStore();
const { availableModels, activeModel, defaultModel, panelThinking, panelThinkingModel } = storeToRefs(settingsStore);

const chatModel = computed(() => activeModel.value || defaultModel.value);
const current = computed(() => availableModels.value.find((model) => model.value === chatModel.value));

const pickerModels = usePickerModels();
const openSettings = useOpenSettings();
const noProvidersId = useId();

function vendorGroups(list: readonly ModelInfo[]): Array<{ vendor: ModelVendor; name: string; models: ModelInfo[] }> {
  const byVendor = new Map<ModelVendor, ModelInfo[]>();
  for (const model of list) {
    const vendor = modelVendor(model);
    byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), model]);
  }
  return [...byVendor].map(([vendor, models]) => ({ vendor, name: MODEL_VENDOR_NAMES[vendor], models }));
}

// A remote chat whose host runs some models on its own credentials shows the user's sign-in and the host's environment
// apart, each named as this computer names it; otherwise one list.
const host = useChatHost();
const sources = computed(() => {
  const label = host.value;
  const hosted = pickerModels.value.filter((model) => model.credentialSource === 'host');
  if (!label || hosted.length === 0) return [{ source: undefined, label: undefined, groups: vendorGroups(pickerModels.value) }];
  const own = pickerModels.value.filter((model) => model.credentialSource !== 'host');
  return [
    { source: 'client' as const, label: t('composer.modelSourceSignIn', { computer: label.computer }), groups: vendorGroups(own) },
    { source: 'host' as const, label: t('composer.modelSourceHost', { host: label.name }), groups: vendorGroups(hosted) },
  ].filter((group) => group.groups.length > 0);
});
const noProviders = computed(() => sources.value.every((source) => source.groups.length === 0));

function hostHint(model: ModelInfo): string | undefined {
  if (model.credentialSource !== 'host' || !host.value) return undefined;
  return t('composer.modelHostHint', { host: host.value.name, provider: MODEL_VENDOR_NAMES[modelVendor(model)] });
}

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
  if (typeof value !== 'string') return;
  // Sent for the current model too, which withdraws a pick core holds for a sign-in; the label changes only on core's modelUpdate.
  postMessage({ type: 'setActiveModel', model: value });
}

function selectEffort(value: AcceptableValue): void {
  if (typeof value !== 'string' || value === effort.value) return;
  const level = effortLevels.value.find((candidate) => candidate === value);
  if (level) postMessage({ type: 'setPanelEffort', effort: level, model: panelThinkingModel.value || chatModel.value });
}

const currentVendor = computed(() => (current.value ? modelVendor(current.value) : undefined));

// A model core marks unavailable (outside the user's plan, or a remote chat's loopback endpoint): shown, muted, never picked.
function unavailableTitle(model: ModelInfo): string | undefined {
  const unavailable = model.unavailable;
  if (!unavailable) return model.description;
  if (unavailable.reason === 'not-in-plan') return t('composer.modelNotInPlanTitle', { provider: ACCOUNT_PROVIDER_NAMES[unavailable.provider], model: model.displayName });
  const { endpoint } = unavailable;
  return host.value ? t('composer.modelUnavailableLoopback', { endpoint, host: host.value.name }) : t('composer.modelUnavailableLoopbackHere', { endpoint });
}

function unavailableReason(model: ModelInfo): string {
  if (model.unavailable?.reason === 'not-in-plan') return t('composer.modelNotInPlan');
  return host.value ? t('composer.modelUnavailable', { host: host.value.name }) : t('composer.modelUnavailableHere');
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger
      class="d-tool-btn h-7 min-w-0 shrink gap-1.5 rounded-full px-2.25 text-xs"
      :title="t('composer.modelFor')"
      :aria-label="`${t('composer.modelFor')}: ${triggerLabel}`"
      data-testid="composer-model"
    >
      <ProviderLogo
        v-if="currentVendor && hasProviderLogo(currentVendor)"
        :provider="currentVendor"
        class="size-3.5"
      />
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
        <DropdownMenuGroup
          v-for="(source, sourceIndex) in sources"
          :key="source.source ?? 'all'"
          :aria-label="source.label"
          :data-credential-source="source.source"
        >
          <template v-if="source.label">
            <DropdownMenuSeparator
              v-if="sourceIndex > 0"
              class="mx-0.5 my-1.5 bg-(--d-border)"
            />
            <div
              class="truncate px-2 pt-1.5 pb-0.5 text-10 font-semibold tracking-[.06em] text-(--d-faint) uppercase"
              role="presentation"
              data-testid="composer-model-source"
              :data-credential-source="source.source"
            >
              {{ source.label }}
            </div>
          </template>
          <template
            v-for="group in source.groups"
            :key="group.vendor"
          >
            <div
              class="flex items-center gap-1.75 px-2.25 pb-0.75 pt-1.5 text-10.5 text-(--d-faint)"
              role="presentation"
              data-testid="composer-model-group"
            >
              <ProviderLogo
                :provider="group.vendor"
                class="size-3"
              />
              {{ group.name }}
            </div>
            <DropdownMenuRadioItem
              v-for="model in group.models"
              :key="model.value"
              :value="model.value"
              :title="unavailableTitle(model)"
              :disabled="model.unavailable !== undefined"
              :data-unavailable="model.unavailable?.reason"
              class="gap-2.25 rounded-7 px-2.25 py-1.5 text-13 text-(--d-text) focus:bg-(--d-hover) focus:text-(--d-text) data-[state=checked]:bg-(--d-accent-soft) data-disabled:pointer-events-auto data-disabled:cursor-default data-disabled:opacity-100 [&>span:first-child]:hidden"
              data-testid="composer-model-option"
            >
              <!-- an unavailable model dims its logo and name only, so its reason keeps its token's contrast (palette-contrast.test.ts) -->
              <ProviderLogo
                :provider="group.vendor"
                class="size-3.75"
                :class="model.unavailable && 'opacity-50'"
              />
              <span class="flex min-w-0 flex-1 flex-col">
                <span
                  class="truncate"
                  :class="model.unavailable && 'opacity-50'"
                >{{ model.displayName }}</span>
                <!-- on its own line, so the model it marks keeps its name at any width -->
                <span
                  v-if="model.unavailable"
                  class="truncate text-11 text-(--d-faint-text)"
                >{{ unavailableReason(model) }}</span>
                <!-- wraps, so the whole hint reads at the menu's width -->
                <span
                  v-else-if="hostHint(model)"
                  class="text-11/snug text-(--d-faint-text)"
                  data-testid="composer-model-hint"
                >{{ hostHint(model) }}</span>
              </span>
              <Check
                class="size-3.25 shrink-0 text-(--d-accent) transition-opacity"
                :class="model.value === chatModel ? 'opacity-100' : 'opacity-0'"
                aria-hidden="true"
              />
            </DropdownMenuRadioItem>
          </template>
        </DropdownMenuGroup>
      </DropdownMenuRadioGroup>
      <!-- arrow keys never reach text in a menu, so Manage models… carries it as its description -->
      <p
        v-if="noProviders"
        :id="noProvidersId"
        class="px-2.25 py-1.5 text-12 text-(--d-faint-text)"
        role="presentation"
        data-testid="composer-no-providers"
      >
        {{ t('composer.noProvidersShown') }}
      </p>
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
      <DropdownMenuSeparator class="mx-0.5 my-1.5 bg-(--d-border)" />
      <DropdownMenuItem
        class="gap-2.25 rounded-7 px-2.25 py-1.5 text-13 text-(--d-muted) focus:bg-(--d-hover) focus:text-(--d-text)"
        :aria-describedby="noProviders ? noProvidersId : undefined"
        data-testid="composer-manage-models"
        @select="openSettings('accounts')"
      >
        <Settings2
          class="size-3.75"
          aria-hidden="true"
        />
        {{ t('composer.manageModels') }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
