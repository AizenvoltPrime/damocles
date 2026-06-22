<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { setLocale, i18n } from "@/i18n";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { DEFAULT_THINKING_TOKENS, DEFAULT_MODELS } from "@shared/types/constants";
import type { ExtensionSettings, ModelInfo, PermissionMode, EffortLevel, PanelThinkingState, AutoCompactConfig } from "@shared/types/settings";
import type { VoiceProvider, VoiceConfig, VoiceMode } from "@shared/types/voice";
import { IconCircleGreen, IconCircleRed } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import JarvisSettings from "./JarvisSettings.vue";
import OpenAIAuthPanel from "./OpenAIAuthPanel.vue";
import ClaudeAuthPanel from "./ClaudeAuthPanel.vue";
import CustomProviderAuthPanel from "./CustomProviderAuthPanel.vue";
import { Trash2 } from "lucide-vue-next";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const { t } = useI18n();

const props = defineProps<{
  settings: ExtensionSettings;
  availableModels: ModelInfo[];
  visible: boolean;
  activeModel: string;
  defaultModel: string;
  panelThinking: PanelThinkingState | null;
  panelThinkingModel: string;
  defaultThinking: PanelThinkingState | null;
  defaultThinkingModel: string;
  voiceConfig: VoiceConfig;
  voiceHasApiKey: boolean;
  exploreHasApiKey: boolean;
  exploreProvider: string;
  exploreModel: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "setActiveModel", model: string): void;
  (e: "setDefaultModel", model: string): void;
  (e: "setPanelThinkingDisabled", disabled: boolean): void;
  (e: "setPanelEffort", effort: EffortLevel | null, model: string): void;
  (e: "setPanelMaxThinkingTokens", tokens: number | null, model: string): void;
  (e: "setDefaultThinkingDisabled", disabled: boolean): void;
  (e: "setDefaultEffort", effort: EffortLevel | null, model: string): void;
  (e: "setDefaultMaxThinkingTokens", tokens: number | null): void;
  (e: "setBudgetLimit", budgetUsd: number | null): void;
  (e: "setTaskBudget", budget: number | null): void;
  (e: "setAutoCompact", config: AutoCompactConfig): void;
  (e: "setDefaultPermissionMode", mode: PermissionMode): void;
  (e: "setDefaultDangerouslySkipPermissions", enabled: boolean): void;
  (e: "setIdeContextEnabled", enabled: boolean): void;
  (e: "setWorktreeBaseRef", baseRef: 'fresh' | 'head'): void;
  (e: "openVSCodeSettings"): void;
  (e: "setVoiceProvider", provider: VoiceProvider): void;
  (e: "setVoiceApiKey", provider: VoiceProvider, apiKey: string): void;
  (e: "deleteVoiceApiKey", provider: VoiceProvider): void;
  (e: "setVoiceLanguage", language: string): void;
  (e: "setVoiceMode", mode: VoiceMode): void;
  (e: "setExploreApiKey", apiKey: string): void;
  (e: "deleteExploreApiKey"): void;
  (e: "setExploreProvider", provider: string): void;
  (e: "setExploreModel", model: string): void;
}>();

const permissionModeOptions = computed<{ value: PermissionMode; label: string; description: string }[]>(() => {
  const options = [
    { value: "default" as PermissionMode, label: t("settings.permissionOptions.default.label"), description: t("settings.permissionOptions.default.description") },
    {
      value: "acceptEdits" as PermissionMode,
      label: t("settings.permissionOptions.acceptEdits.label"),
      description: t("settings.permissionOptions.acceptEdits.description"),
    },
  ];
  options.push({ value: "plan" as PermissionMode, label: t("settings.permissionOptions.plan.label"), description: t("settings.permissionOptions.plan.description") });
  return options;
});

const languageOptions = [
  { value: "en", label: "English" },
  { value: "el", label: "Ελληνικά" },
];

const currentLocale = computed(() => i18n.global.locale.value);

function handleLanguageChange(value: string) {
  setLocale(value);
}

function handleDefaultModeChange(mode: string) {
  emit("setDefaultPermissionMode", mode as PermissionMode);
}

function handleWorktreeBaseRefChange(baseRef: 'fresh' | 'head') {
  emit("setWorktreeBaseRef", baseRef);
}

function handleDefaultDangerouslySkipPermissionsChange(enabled: boolean) {
  emit("setDefaultDangerouslySkipPermissions", enabled);
}

function handleIdeContextEnabledChange(enabled: boolean) {
  emit("setIdeContextEnabled", enabled);
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === "Escape" && props.visible) {
    emit("close");
  }
}

onMounted(() => {
  window.addEventListener("keydown", handleKeyDown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeyDown);
  if (highlightTimeout) {
    clearTimeout(highlightTimeout);
    highlightTimeout = null;
  }
});

const localBudgetLimit = ref(props.settings.maxBudgetUsd);
const localTaskBudget = ref<number | null>(props.settings.taskBudget ?? null);

const modelCatalog = computed(() =>
  props.availableModels.length > 0 ? props.availableModels : DEFAULT_MODELS,
);

const panelModelInfo = computed(() =>
  modelCatalog.value.find(m => m.value === (props.panelThinkingModel || props.activeModel)),
);

const defaultsModelInfo = computed(() =>
  modelCatalog.value.find(m => m.value === (props.defaultThinkingModel || props.defaultModel)),
);

const panelIsAdaptiveCapable = computed(() => panelModelInfo.value?.supportsAdaptiveThinking ?? false);
const defaultsIsAdaptiveCapable = computed(() => defaultsModelInfo.value?.supportsAdaptiveThinking ?? false);

const panelIsOpenAIBackend = computed(() => panelModelInfo.value?.backend === "openai");
const defaultsIsOpenAIBackend = computed(() => defaultsModelInfo.value?.backend === "openai");

const panelEffortLevels = computed(() => panelModelInfo.value?.supportedEffortLevels ?? []);
const defaultsEffortLevels = computed(() => defaultsModelInfo.value?.supportedEffortLevels ?? []);

const settingsStore = useSettingsStore();
const {
  pendingOpenAIModel,
  openaiAuthStatus: pendingAuthStatus,
} = storeToRefs(settingsStore);

const openaiAuthPanelRef = ref<HTMLElement | null>(null);
const openaiAuthHighlight = ref(false);
let highlightTimeout: ReturnType<typeof setTimeout> | null = null;

function flashOpenAIAuthPanel() {
  if (highlightTimeout) clearTimeout(highlightTimeout);
  openaiAuthHighlight.value = true;
  highlightTimeout = setTimeout(() => {
    openaiAuthHighlight.value = false;
  }, 2000);
}

watch(pendingOpenAIModel, async (next) => {
  if (!next) return;
  if (!props.visible) emit("close");
  await nextTick();
  openaiAuthPanelRef.value?.scrollIntoView({ behavior: "smooth", block: "center" });
  flashOpenAIAuthPanel();
}, { immediate: true });

watch(
  () => ({
    pending: pendingOpenAIModel.value,
    signedIn: pendingAuthStatus.value.codex.signedIn,
    apiKey: pendingAuthStatus.value.apikey.configured,
  }),
  (current) => {
    if (current.pending && (current.signedIn || current.apiKey)) {
      emit("setActiveModel", current.pending);
      settingsStore.setPendingOpenAIModel(null);
    }
  },
);

function handleActiveModelChange(value: string) {
  if (pendingOpenAIModel.value && pendingOpenAIModel.value !== value) {
    settingsStore.setPendingOpenAIModel(null);
  }
  emit("setActiveModel", value);
}

function handleDefaultModelChange(value: string) {
  emit("setDefaultModel", value);
}

function handleBudgetChange(event: Event) {
  const inputValue = (event.target as HTMLInputElement).value;
  const value = inputValue ? parseFloat(inputValue) : null;
  localBudgetLimit.value = value;
  emit("setBudgetLimit", value);
}

function handleTaskBudgetChange(event: Event) {
  const inputValue = (event.target as HTMLInputElement).value;
  const parsed = inputValue ? parseInt(inputValue, 10) : null;
  const budget = parsed && !isNaN(parsed) && parsed > 0 ? parsed : null;
  localTaskBudget.value = budget;
  emit("setTaskBudget", budget);
}

function handleAutoCompactEnabledChange(enabled: boolean) {
  emit("setAutoCompact", { ...props.settings.autoCompact, enabled });
}

function handleAutoCompactTriggerChange(event: Event) {
  const raw = (event.target as HTMLInputElement).value;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const triggerPercent = Math.min(95, Math.max(50, isNaN(parsed) ? 80 : parsed));
  emit("setAutoCompact", { ...props.settings.autoCompact, triggerPercent });
}

function clampThinkingTokens(raw: string): number {
  const value = raw ? parseInt(raw, 10) : DEFAULT_THINKING_TOKENS;
  return Math.min(63999, Math.max(1000, value));
}

function handlePanelThinkingTokensChange(event: Event) {
  const clamped = clampThinkingTokens((event.target as HTMLInputElement).value);
  const model = props.panelThinkingModel || props.activeModel;
  emit("setPanelMaxThinkingTokens", clamped, model);
}

function handleDefaultThinkingTokensChange(event: Event) {
  const clamped = clampThinkingTokens((event.target as HTMLInputElement).value);
  emit("setDefaultMaxThinkingTokens", clamped);
}

function handlePanelEffortChange(value: string) {
  const model = props.panelThinkingModel || props.activeModel;
  emit("setPanelEffort", value as EffortLevel, model);
}

function handleDefaultEffortChange(value: string) {
  const model = props.defaultThinkingModel || props.defaultModel;
  emit("setDefaultEffort", value as EffortLevel, model);
}

const modelOptions = computed(() => {
  if (props.availableModels.length > 0) {
    return props.availableModels;
  }
  return DEFAULT_MODELS;
});

const currentModelDisplayName = computed(() => {
  if (!props.activeModel) return "Opus 4.8";
  const model = modelOptions.value.find((m) => m.value === props.activeModel);
  return model?.displayName || props.activeModel;
});

const voiceProviderOptions: { value: VoiceProvider; label: string }[] = [
  { value: "openai-whisper", label: "OpenAI Whisper" },
  { value: "deepgram", label: "Deepgram" },
  { value: "google-cloud-stt", label: "Google Cloud STT" },
];

const voiceApiKeyInput = ref("");

function handleVoiceProviderChange(value: string) {
  emit("setVoiceProvider", value as VoiceProvider);
  voiceApiKeyInput.value = "";
}

function handleSaveVoiceApiKey() {
  const key = voiceApiKeyInput.value.trim();
  if (!key) return;
  emit("setVoiceApiKey", props.voiceConfig.provider, key);
  voiceApiKeyInput.value = "";
}

function handleDeleteVoiceApiKey() {
  emit("deleteVoiceApiKey", props.voiceConfig.provider);
}

const voiceLanguageOptions: { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "el", label: "Ελληνικά" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
  { value: "pt", label: "Português" },
  { value: "nl", label: "Nederlands" },
  { value: "ru", label: "Русский" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "zh", label: "中文" },
  { value: "ar", label: "العربية" },
  { value: "hi", label: "हिन्दी" },
  { value: "pl", label: "Polski" },
  { value: "tr", label: "Türkçe" },
  { value: "sv", label: "Svenska" },
  { value: "da", label: "Dansk" },
  { value: "uk", label: "Українська" },
];

const voiceModeOptions = computed<{ value: VoiceMode; label: string }[]>(() => [
  { value: "off", label: t("jarvisSettings.modeOff") },
  { value: "push-to-talk", label: t("jarvisSettings.modePushToTalk") },
  { value: "wake-word", label: t("jarvisSettings.modeWakeWord") },
]);

function handleVoiceModeChange(value: string) {
  emit("setVoiceMode", value as VoiceMode);
}

function handleVoiceLanguageChange(value: string) {
  emit("setVoiceLanguage", value);
}

const exploreProviderOptions = computed<{ value: string; label: string }[]>(() => [
  { value: "default", label: t("settings.explore.providerDefault") },
  { value: "openrouter", label: "OpenRouter" },
  { value: "gemini", label: "Google Gemini" },
  { value: "stepfun", label: "StepFun" },
]);

const exploreApiKeyInput = ref("");
const exploreModelInput = ref("");

const isExploreThirdParty = computed(() => props.exploreProvider !== "default");

// StepFun's key is managed in its dedicated auth section (shared SecretStorage entry), so hide the
// Explore API-key input for it to avoid a duplicate entry point.
const exploreNeedsApiKeyInput = computed(() => isExploreThirdParty.value && props.exploreProvider !== "stepfun");

const exploreApiKeyPlaceholder = computed(() => {
  switch (props.exploreProvider) {
    case "gemini": return t("settings.explore.apiKeyPlaceholderGemini");
    case "stepfun": return t("settings.explore.apiKeyPlaceholderStepfun");
    default: return t("settings.explore.apiKeyPlaceholderOpenrouter");
  }
});

const exploreDescription = computed(() => {
  switch (props.exploreProvider) {
    case "default": return t("settings.explore.descriptionDefault");
    case "gemini": return t("settings.explore.descriptionGemini");
    case "stepfun": return t("settings.explore.descriptionStepfun");
    default: return t("settings.explore.descriptionOpenrouter");
  }
});

function handleExploreProviderChange(value: string) {
  emit("setExploreProvider", value);
  exploreApiKeyInput.value = "";
}

function handleExploreModelSave() {
  const model = exploreModelInput.value.trim();
  if (!model) return;
  emit("setExploreModel", model);
  exploreModelInput.value = "";
}

function handleSaveExploreApiKey() {
  const key = exploreApiKeyInput.value.trim();
  if (!key) return;
  emit("setExploreApiKey", key);
  exploreApiKeyInput.value = "";
}

function handleDeleteExploreApiKey() {
  emit("deleteExploreApiKey");
}

</script>

<template>
  <Sheet :open="visible" @update:open="(open: boolean) => !open && emit('close')">
    <SheetContent side="right" class="w-80 bg-card border-l border-border overflow-y-auto">
      <SheetHeader class="mb-6">
        <SheetTitle class="text-foreground">{{ t("settings.title") }}</SheetTitle>
      </SheetHeader>

      <!-- ========================================================== -->
      <!-- SECTION 1: This Panel                                       -->
      <!-- ========================================================== -->
      <section class="mb-6">
        <h3 class="text-sm font-semibold text-foreground uppercase tracking-wide mb-3">
          {{ t("settings.thisPanel") }}
        </h3>

        <!-- Model (This Panel) -->
        <div class="mb-5">
          <Label class="block mb-2 text-primary font-medium">{{ t("settings.model") }}</Label>
          <Select :model-value="activeModel" @update:model-value="handleActiveModelChange">
            <SelectTrigger class="w-full bg-input border-border">
              <SelectValue :placeholder="currentModelDisplayName" />
            </SelectTrigger>
            <SelectContent class="bg-popover border-border">
              <SelectItem v-for="model in modelOptions" :key="model.value" :value="model.value">
                {{ model.displayName }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- Reasoning (This Panel) -->
        <div v-if="panelThinking" class="mb-5">
          <Label class="block mb-2 text-primary font-medium">{{ t("settings.reasoning") }}</Label>

          <div v-if="!panelIsOpenAIBackend" class="flex items-center gap-2 mb-3">
            <Switch
              id="panel-disable-thinking"
              :checked="panelThinking.thinkingDisabled"
              @update:checked="(val: boolean) => emit('setPanelThinkingDisabled', val)"
            />
            <Label for="panel-disable-thinking" class="text-sm font-normal">{{ t("settings.disableThinking") }}</Label>
          </div>

          <div v-if="(!panelThinking.thinkingDisabled || panelIsOpenAIBackend) && panelIsAdaptiveCapable" class="mb-2">
            <Label class="block mb-2 text-sm text-muted-foreground">{{ t("settings.reasoningEffort") }}</Label>
            <Select :model-value="panelThinking.effort ?? panelEffortLevels[0] ?? ''" @update:model-value="handlePanelEffortChange">
              <SelectTrigger class="w-full bg-input border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent class="bg-popover border-border">
                <SelectItem v-for="level in panelEffortLevels" :key="level" :value="level">
                  {{ t(`settings.effort${level.charAt(0).toUpperCase() + level.slice(1)}`) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div v-else-if="!panelThinking.thinkingDisabled" class="mb-2">
            <Label class="block mb-2 text-sm text-muted-foreground">{{ t("settings.extendedThinking") }}</Label>
            <div class="flex items-center gap-2">
              <Input
                type="number"
                :model-value="panelThinking.maxThinkingTokens ?? DEFAULT_THINKING_TOKENS"
                :min="1000"
                :max="63999"
                :step="1000"
                class="bg-input border-border text-center"
                @change="handlePanelThinkingTokensChange"
              />
              <span class="text-sm text-muted-foreground whitespace-nowrap">{{ t("common.tokens") }}</span>
            </div>
          </div>
        </div>
      </section>

      <Separator class="my-4 bg-border" />

      <!-- ========================================================== -->
      <!-- SECTION 2: Defaults for New Panels                          -->
      <!-- ========================================================== -->
      <section class="mb-6">
        <h3 class="text-sm font-semibold text-foreground uppercase tracking-wide mb-3">
          {{ t("settings.defaultForNewPanels") }}
        </h3>

        <!-- Default Model -->
        <div class="mb-5">
          <Label class="block mb-2 text-primary font-medium">{{ t("settings.model") }}</Label>
          <Select :model-value="defaultModel" @update:model-value="handleDefaultModelChange">
            <SelectTrigger class="w-full bg-input border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent class="bg-popover border-border">
              <SelectItem v-for="model in modelOptions" :key="model.value" :value="model.value">
                {{ model.displayName }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- Default Reasoning -->
        <div v-if="defaultThinking" class="mb-5">
          <Label class="block mb-2 text-primary font-medium">{{ t("settings.reasoning") }}</Label>

          <div v-if="!defaultsIsOpenAIBackend" class="flex items-center gap-2 mb-3">
            <Switch
              id="default-disable-thinking"
              :checked="defaultThinking.thinkingDisabled"
              @update:checked="(val: boolean) => emit('setDefaultThinkingDisabled', val)"
            />
            <Label for="default-disable-thinking" class="text-sm font-normal">{{ t("settings.disableThinking") }}</Label>
          </div>

          <div v-if="(!defaultThinking.thinkingDisabled || defaultsIsOpenAIBackend) && defaultsIsAdaptiveCapable" class="mb-2">
            <Label class="block mb-2 text-sm text-muted-foreground">{{ t("settings.reasoningEffort") }}</Label>
            <Select :model-value="defaultThinking.effort ?? defaultsEffortLevels[0] ?? ''" @update:model-value="handleDefaultEffortChange">
              <SelectTrigger class="w-full bg-input border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent class="bg-popover border-border">
                <SelectItem v-for="level in defaultsEffortLevels" :key="level" :value="level">
                  {{ t(`settings.effort${level.charAt(0).toUpperCase() + level.slice(1)}`) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div v-else-if="!defaultThinking.thinkingDisabled" class="mb-2">
            <Label class="block mb-2 text-sm text-muted-foreground">{{ t("settings.extendedThinking") }}</Label>
            <div class="flex items-center gap-2">
              <Input
                type="number"
                :model-value="defaultThinking.maxThinkingTokens ?? DEFAULT_THINKING_TOKENS"
                :min="1000"
                :max="63999"
                :step="1000"
                class="bg-input border-border text-center"
                @change="handleDefaultThinkingTokensChange"
              />
              <span class="text-sm text-muted-foreground whitespace-nowrap">{{ t("common.tokens") }}</span>
            </div>
          </div>
        </div>

        <!-- Default YOLO Mode -->
        <div class="mb-5">
          <Label class="block mb-2 text-primary font-medium">{{ t("settings.defaultYolo") }}</Label>
          <div class="flex items-center justify-between">
            <Label for="default-yolo" class="text-sm font-normal text-foreground">
              {{ t("settings.defaultYoloLabel") }}
            </Label>
            <Switch
              id="default-yolo"
              :checked="settings.defaultDangerouslySkipPermissions"
              @update:checked="handleDefaultDangerouslySkipPermissionsChange"
            />
          </div>
          <p class="text-xs text-muted-foreground mt-1">
            {{ t("settings.defaultYoloDescription") }}
          </p>
        </div>

        <!-- IDE Opened-File Context -->
        <div class="mb-5">
          <Label class="block mb-2 text-primary font-medium">{{ t("settings.ideContext") }}</Label>
          <div class="flex items-center justify-between">
            <Label for="ide-context-enabled" class="text-sm font-normal text-foreground">
              {{ t("settings.ideContextLabel") }}
            </Label>
            <Switch
              id="ide-context-enabled"
              :checked="settings.ideContextEnabled"
              @update:checked="handleIdeContextEnabledChange"
            />
          </div>
          <p class="text-xs text-muted-foreground mt-1">
            {{ t("settings.ideContextDescription") }}
          </p>
        </div>
      </section>

      <Separator class="my-4 bg-border" />

      <!-- ========================================================== -->
      <!-- SECTION 3: Workspace                                        -->
      <!-- ========================================================== -->
      <section class="mb-6">
        <h3 class="text-sm font-semibold text-foreground uppercase tracking-wide mb-3">
          {{ t("settings.workspace") }}
        </h3>

        <!-- Default Permission Mode -->
        <div class="mb-5">
          <Label class="block mb-2 text-primary font-medium">{{ t("settings.defaultPermissionMode") }}</Label>
          <Select :model-value="settings.defaultPermissionMode" @update:model-value="handleDefaultModeChange">
            <SelectTrigger class="w-full bg-input border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent class="bg-popover border-border">
              <SelectItem v-for="option in permissionModeOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground mt-1">
            {{ t("settings.defaultPermissionModeDescription") }}
          </p>
        </div>

        <!-- Worktree Base Ref -->
        <div class="mb-5">
          <Label class="block mb-2 text-primary font-medium">{{ t("settings.worktreeBaseRef") }}</Label>
          <div class="flex items-center justify-between">
            <Label for="worktree-base-ref" class="text-sm font-normal text-foreground">
              {{ t("settings.worktreeBaseRefLabel") }}
            </Label>
            <Switch
              id="worktree-base-ref"
              :checked="props.settings.worktreeBaseRef === 'fresh'"
              @update:checked="(val: boolean) => handleWorktreeBaseRefChange(val ? 'fresh' : 'head')"
            />
          </div>
          <p class="text-xs text-muted-foreground mt-1">
            {{ t("settings.worktreeBaseRefDescription") }}
          </p>
        </div>

        <!-- Budget Limit -->
        <div class="mb-5">
          <Label class="block mb-2 text-primary font-medium">{{ t("settings.budgetLimit") }}</Label>
          <Input
            type="number"
            :model-value="localBudgetLimit ?? ''"
            step="0.1"
            min="0"
            :placeholder="t('settings.budgetPlaceholder')"
            class="bg-input border-border placeholder:text-muted-foreground"
            @change="handleBudgetChange"
          />
          <p class="text-xs text-muted-foreground mt-1">
            {{ t("settings.budgetLimitDescription") }}
          </p>
        </div>

        <!-- Auto-compact -->
        <div class="mb-5">
          <Label class="block mb-2 text-primary font-medium">{{ t("settings.autoCompact") }}</Label>
          <div class="flex items-center justify-between">
            <Label for="auto-compact-enabled" class="text-sm font-normal text-foreground">
              {{ t("settings.autoCompactEnabled") }}
            </Label>
            <Switch
              id="auto-compact-enabled"
              :checked="props.settings.autoCompact.enabled"
              @update:checked="handleAutoCompactEnabledChange"
            />
          </div>
          <div v-if="props.settings.autoCompact.enabled" class="flex items-center gap-2 mt-3">
            <Input
              type="number"
              :model-value="props.settings.autoCompact.triggerPercent"
              :min="50"
              :max="95"
              :step="5"
              class="bg-input border-border text-center"
              @change="handleAutoCompactTriggerChange"
            />
            <span class="text-sm text-muted-foreground whitespace-nowrap">{{ t("settings.autoCompactTriggerSuffix") }}</span>
          </div>
          <p class="text-xs text-muted-foreground mt-1">
            {{ t("settings.autoCompactDescription") }}
          </p>
        </div>

        <!-- Task Token Budget -->
        <div class="mb-5">
          <Label class="block mb-2 text-primary font-medium">{{ t("settings.taskBudget") }}</Label>
          <Input
            type="number"
            :model-value="localTaskBudget ?? ''"
            step="1000"
            min="1"
            :placeholder="t('settings.taskBudgetPlaceholder')"
            class="bg-input border-border placeholder:text-muted-foreground"
            @change="handleTaskBudgetChange"
          />
          <p class="text-xs text-muted-foreground mt-1">
            {{ t("settings.taskBudgetDescription") }}
          </p>
        </div>

        <!-- Language -->
        <div class="mb-5">
          <Label class="block mb-2 text-primary font-medium">{{ t("settings.language") }}</Label>
          <Select :model-value="currentLocale" @update:model-value="handleLanguageChange">
            <SelectTrigger class="w-full bg-input border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent class="bg-popover border-border">
              <SelectItem v-for="lang in languageOptions" :key="lang.value" :value="lang.value">
                {{ lang.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- VS Code Settings Link -->
        <Button class="w-full" @click="emit('openVSCodeSettings')">
          {{ t("settings.openVsCodeSettings") }}
        </Button>
        <p class="text-xs text-muted-foreground mt-2 text-center">
          {{ t("settings.settingsInfo") }}
        </p>
      </section>

      <Separator class="my-4 bg-border" />

      <!-- ========================================================== -->
      <!-- SECTION 3b: Explore Agent                                   -->
      <!-- ========================================================== -->
      <section class="mb-6">
        <h3 class="text-sm font-semibold text-foreground uppercase tracking-wide mb-3">
          {{ t("settings.explore.title") }}
        </h3>

        <div class="mb-3">
          <Label class="text-xs text-muted-foreground mb-1 block">{{ t("settings.explore.provider") }}</Label>
          <Select :model-value="exploreProvider" @update:model-value="handleExploreProviderChange">
            <SelectTrigger class="w-full bg-input border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent class="bg-popover border-border">
              <SelectItem v-for="option in exploreProviderOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div v-if="isExploreThirdParty" class="mb-3">
          <Label class="text-xs text-muted-foreground mb-1 block">{{ t("settings.explore.model") }}</Label>
          <div class="flex gap-2">
            <Input
              v-model="exploreModelInput"
              :placeholder="exploreModel || t('settings.explore.modelPlaceholder')"
              class="flex-1 bg-input border-border placeholder:text-muted-foreground"
              @keydown.enter="handleExploreModelSave"
            />
            <Button size="sm" :disabled="!exploreModelInput.trim()" @click="handleExploreModelSave">
              {{ t("settings.explore.saveKey") }}
            </Button>
          </div>
        </div>

        <div v-if="exploreNeedsApiKeyInput" class="mb-3">
          <div class="flex items-center gap-1.5 mb-1">
            <Label class="text-xs text-muted-foreground">{{ t("settings.explore.apiKey") }}</Label>
            <span class="flex items-center gap-1 text-xs">
              <IconCircleGreen v-if="exploreHasApiKey" :size="8" />
              <IconCircleRed v-else :size="8" />
              <span class="text-muted-foreground">{{ exploreHasApiKey ? t("settings.explore.keyStored") : t("settings.explore.noKey") }}</span>
            </span>
          </div>
          <div class="flex gap-2">
            <Input
              v-model="exploreApiKeyInput"
              type="password"
              :placeholder="exploreApiKeyPlaceholder"
              class="flex-1 bg-input border-border placeholder:text-muted-foreground"
              @keydown.enter="handleSaveExploreApiKey"
            />
            <Button size="sm" :disabled="!exploreApiKeyInput.trim()" @click="handleSaveExploreApiKey">
              {{ t("settings.explore.saveKey") }}
            </Button>
            <Button
              v-if="exploreHasApiKey"
              variant="ghost"
              size="icon"
              class="h-9 w-9 shrink-0 text-destructive hover:text-destructive/80 hover:bg-destructive/10"
              :title="t('settings.explore.deleteKey')"
              @click="handleDeleteExploreApiKey"
            >
              <Trash2 class="h-4 w-4" />
            </Button>
          </div>
        </div>

        <p class="text-xs text-muted-foreground mt-1">
          {{ exploreDescription }}
        </p>
      </section>

      <Separator class="my-4 bg-border" />

      <!-- ========================================================== -->
      <!-- SECTION 3b: Claude Authentication                           -->
      <!-- ========================================================== -->
      <ClaudeAuthPanel />

      <Separator class="my-4 bg-border" />

      <!-- ========================================================== -->
      <!-- SECTION 3c: OpenAI Authentication                           -->
      <!-- ========================================================== -->
      <div
        ref="openaiAuthPanelRef"
        class="transition-all duration-300 rounded-md"
        :class="openaiAuthHighlight ? 'ring-2 ring-amber-500 ring-offset-2 ring-offset-card' : ''"
      >
        <OpenAIAuthPanel />
      </div>

      <Separator class="my-4 bg-border" />

      <!-- ========================================================== -->
      <!-- SECTION 3d: StepFun Authentication                          -->
      <!-- ========================================================== -->
      <CustomProviderAuthPanel provider="stepfun" />

      <Separator class="my-4 bg-border" />

      <!-- ========================================================== -->
      <!-- SECTION 3e: DeepSeek Authentication                         -->
      <!-- ========================================================== -->
      <CustomProviderAuthPanel provider="deepseek" />

      <Separator class="my-4 bg-border" />

      <!-- ========================================================== -->
      <!-- SECTION 4: Voice                                            -->
      <!-- ========================================================== -->
      <section class="mb-6">
        <h3 class="text-sm font-semibold text-foreground uppercase tracking-wide mb-3">
          {{ t("settings.voice.title") }}
        </h3>

        <div class="mb-3">
          <Label class="text-xs text-muted-foreground mb-1 block">{{ t("jarvisSettings.modeLabel") }}</Label>
          <Select :model-value="voiceConfig.mode" @update:model-value="handleVoiceModeChange">
            <SelectTrigger class="w-full bg-input border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent class="bg-popover border-border">
              <SelectItem v-for="opt in voiceModeOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <template v-if="voiceConfig.mode === 'push-to-talk'">
          <div class="mb-3">
            <Label class="text-xs text-muted-foreground mb-1 block">{{ t("settings.voice.provider") }}</Label>
            <Select :model-value="voiceConfig.provider" @update:model-value="handleVoiceProviderChange">
              <SelectTrigger class="w-full bg-input border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent class="bg-popover border-border">
                <SelectItem v-for="option in voiceProviderOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="mb-3">
            <div class="flex items-center gap-1.5 mb-1">
              <Label class="text-xs text-muted-foreground">{{ t("settings.voice.apiKey") }}</Label>
              <span class="flex items-center gap-1 text-xs">
                <IconCircleGreen v-if="voiceHasApiKey" :size="8" />
                <IconCircleRed v-else :size="8" />
                <span class="text-muted-foreground">{{ voiceHasApiKey ? t("settings.voice.keyStored") : t("settings.voice.noKey") }}</span>
              </span>
            </div>
            <div class="flex gap-2">
              <Input
                v-model="voiceApiKeyInput"
                type="password"
                :placeholder="t('settings.voice.apiKeyPlaceholder')"
                class="flex-1 bg-input border-border placeholder:text-muted-foreground"
                @keydown.enter="handleSaveVoiceApiKey"
              />
              <Button size="sm" :disabled="!voiceApiKeyInput.trim()" @click="handleSaveVoiceApiKey">
                {{ t("settings.voice.saveKey") }}
              </Button>
              <Button
                v-if="voiceHasApiKey"
                variant="ghost"
                size="icon"
                class="h-9 w-9 shrink-0 text-destructive hover:text-destructive/80 hover:bg-destructive/10"
                :title="t('settings.voice.deleteKey')"
                @click="handleDeleteVoiceApiKey"
              >
                <Trash2 class="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div>
            <Label class="text-xs text-muted-foreground mb-1 block">{{ t("settings.voice.language") }}</Label>
            <Select :model-value="voiceConfig.language" @update:model-value="handleVoiceLanguageChange">
              <SelectTrigger class="w-full bg-input border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent class="bg-popover border-border">
                <SelectItem v-for="lang in voiceLanguageOptions" :key="lang.value" :value="lang.value">
                  {{ lang.label }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground mt-1">
              {{ t("settings.voice.languageHint") }}
            </p>
          </div>
        </template>

        <Separator v-if="voiceConfig.mode !== 'off'" class="my-4 bg-border" />

        <JarvisSettings v-if="voiceConfig.mode !== 'off'" />
      </section>
    </SheetContent>
  </Sheet>
</template>
