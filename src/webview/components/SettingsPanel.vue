<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { setLocale, i18n } from "@/i18n";
import { DEFAULT_THINKING_TOKENS, DEFAULT_MODELS } from "@shared/types/constants";
import type { ExtensionSettings, ModelInfo, PermissionMode, ContextStrategy, ProviderProfile, EffortLevel } from "@shared/types/settings";
import type { VoiceProvider, VoiceConfig } from "@shared/types/voice";
import { IconCircleGreen, IconCircleRed } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import ProfileEditor from "./ProfileEditor.vue";
import { Plus, Pencil, Trash2 } from "lucide-vue-next";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const { t } = useI18n();

const props = defineProps<{
  settings: ExtensionSettings;
  availableModels: ModelInfo[];
  visible: boolean;
  providerProfiles: ProviderProfile[];
  activeProviderProfile: string | null;
  defaultProviderProfile: string | null;
  activeModel: string;
  defaultModel: string;
  activeBetas: string[];
  activeContextStrategy: ContextStrategy;
  defaultContextStrategy: ContextStrategy;
  voiceConfig: VoiceConfig;
  voiceHasApiKey: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "setActiveModel", model: string): void;
  (e: "setDefaultModel", model: string): void;
  (e: "setMaxThinkingTokens", tokens: number | null): void;
  (e: "setThinkingDisabled", disabled: boolean): void;
  (e: "setEffort", effort: EffortLevel | null): void;
  (e: "setBudgetLimit", budgetUsd: number | null): void;
  (e: "setTaskBudget", budget: number | null): void;
  (e: "toggleBeta", beta: string, enabled: boolean): void;
  (e: "setDefaultPermissionMode", mode: PermissionMode): void;
  (e: "openVSCodeSettings"): void;
  (e: "createProfile", profile: ProviderProfile): void;
  (e: "updateProfile", originalName: string, profile: ProviderProfile): void;
  (e: "deleteProfile", profileName: string): void;
  (e: "setActiveProfile", profileName: string | null): void;
  (e: "setDefaultProfile", profileName: string | null): void;
  (e: "setActiveContextStrategy", strategy: ContextStrategy): void;
  (e: "setDefaultContextStrategy", strategy: ContextStrategy): void;
  (e: "setVoiceProvider", provider: VoiceProvider): void;
  (e: "setVoiceApiKey", provider: VoiceProvider, apiKey: string): void;
  (e: "deleteVoiceApiKey", provider: VoiceProvider): void;
  (e: "setVoiceLanguage", language: string): void;
}>();

const permissionModeOptions = computed<{ value: PermissionMode; label: string; description: string }[]>(() => [
  { value: "default", label: t("settings.permissionOptions.default.label"), description: t("settings.permissionOptions.default.description") },
  {
    value: "acceptEdits",
    label: t("settings.permissionOptions.acceptEdits.label"),
    description: t("settings.permissionOptions.acceptEdits.description"),
  },
  { value: "plan", label: t("settings.permissionOptions.plan.label"), description: t("settings.permissionOptions.plan.description") },
]);

const contextStrategyOptions = computed<{ value: ContextStrategy; label: string; description: string }[]>(() => [
  { value: "default", label: t("settings.contextStrategy.default.label"), description: t("settings.contextStrategy.default.description") },
  { value: "recall", label: t("settings.contextStrategy.recall.label"), description: t("settings.contextStrategy.recall.description") },
]);

function handleActiveContextStrategyChange(strategy: string) {
  emit("setActiveContextStrategy", strategy as ContextStrategy);
}

function handleDefaultContextStrategyChange(strategy: string) {
  emit("setDefaultContextStrategy", strategy as ContextStrategy);
}

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
});

const localMaxThinkingTokens = ref(props.settings.maxThinkingTokens);
const localBudgetLimit = ref(props.settings.maxBudgetUsd);
const localTaskBudget = ref<number | null>(props.settings.taskBudget ?? null);
const lastThinkingTokens = ref(props.settings.maxThinkingTokens ?? DEFAULT_THINKING_TOKENS);
const localThinkingDisabled = ref(props.settings.thinkingDisabled ?? false);
const localEffort = ref<EffortLevel | null>(props.settings.effort ?? null);

const currentModelInfo = computed(() =>
  (props.availableModels.length > 0 ? props.availableModels : DEFAULT_MODELS)
    .find(m => m.value === props.activeModel)
);

const isAdaptiveCapable = computed(() => currentModelInfo.value?.supportsAdaptiveThinking ?? false);

const effortLevels = computed(() =>
  currentModelInfo.value?.supportedEffortLevels ?? []
);

const enableExtendedThinking = computed({
  get: () => localMaxThinkingTokens.value !== null,
  set: (enabled: boolean) => {
    if (!enabled) {
      lastThinkingTokens.value = localMaxThinkingTokens.value ?? DEFAULT_THINKING_TOKENS;
      localMaxThinkingTokens.value = null;
      emit("setMaxThinkingTokens", null);
    } else {
      localMaxThinkingTokens.value = lastThinkingTokens.value;
      emit("setMaxThinkingTokens", lastThinkingTokens.value);
    }
  },
});

// Sync with incoming settings (immediate: true ensures sync on mount)
watch(
  () => props.settings,
  (newSettings) => {
    localMaxThinkingTokens.value = newSettings.maxThinkingTokens;
    localBudgetLimit.value = newSettings.maxBudgetUsd;
    localTaskBudget.value = newSettings.taskBudget ?? null;
    localThinkingDisabled.value = newSettings.thinkingDisabled ?? false;
    localEffort.value = newSettings.effort ?? null;
    if (newSettings.maxThinkingTokens !== null) {
      lastThinkingTokens.value = newSettings.maxThinkingTokens;
    }
  },
  { deep: true, immediate: true },
);

const CONTEXT_1M_BETA = "context-1m-2025-08-07";

const modelSupports1MContext = computed(() => {
  return /claude-(?:sonnet|opus)-4/.test(props.activeModel);
});

const is1MContextEnabled = computed({
  get: () => props.activeBetas.includes(CONTEXT_1M_BETA) && modelSupports1MContext.value,
  set: (enabled: boolean) => {
    if (enabled && !modelSupports1MContext.value) return;
    emit("toggleBeta", CONTEXT_1M_BETA, enabled);
  },
});

function handleActiveModelChange(value: string) {
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

function handleThinkingTokensChange(event: Event) {
  const inputValue = (event.target as HTMLInputElement).value;
  const value = inputValue ? parseInt(inputValue, 10) : DEFAULT_THINKING_TOKENS;
  const clamped = Math.min(63999, Math.max(1000, value));
  localMaxThinkingTokens.value = clamped;
  emit("setMaxThinkingTokens", clamped);
}

function handleEffortChange(value: string) {
  const effort = value as EffortLevel;
  localEffort.value = effort;
  emit("setEffort", effort);
}

const modelOptions = computed(() => {
  if (props.availableModels.length > 0) {
    return props.availableModels;
  }
  return DEFAULT_MODELS;
});

// Get current model display name
const currentModelDisplayName = computed(() => {
  if (!props.activeModel) return "Opus 4.6";
  const model = modelOptions.value.find((m) => m.value === props.activeModel);
  return model?.displayName || props.activeModel;
});

// Provider Profile state
const profileEditorVisible = ref(false);
const editingProfile = ref<ProviderProfile | null>(null);
const profileToDelete = ref<string | null>(null);

function handleActiveProfileChange(value: string) {
  emit("setActiveProfile", value === "__none__" ? null : value);
}

function handleDefaultProfileChange(value: string) {
  emit("setDefaultProfile", value === "__none__" ? null : value);
}

function openProfileEditor(profile?: ProviderProfile) {
  editingProfile.value = profile ?? null;
  profileEditorVisible.value = true;
}

function closeProfileEditor() {
  profileEditorVisible.value = false;
  editingProfile.value = null;
}

function handleSaveProfile(profile: ProviderProfile) {
  if (editingProfile.value) {
    emit("updateProfile", editingProfile.value.name, profile);
  } else {
    emit("createProfile", profile);
  }
  closeProfileEditor();
}

function confirmDeleteProfile(profileName: string) {
  profileToDelete.value = profileName;
}

function handleDeleteProfile() {
  if (profileToDelete.value) {
    emit("deleteProfile", profileToDelete.value);
    profileToDelete.value = null;
  }
}

function cancelDeleteProfile() {
  profileToDelete.value = null;
}

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

function handleVoiceLanguageChange(value: string) {
  emit("setVoiceLanguage", value);
}
</script>

<template>
  <Sheet :open="visible" @update:open="(open: boolean) => !open && emit('close')">
    <SheetContent side="right" class="w-80 bg-card border-l border-border overflow-y-auto">
      <SheetHeader class="mb-6">
        <SheetTitle class="text-foreground">{{ t("settings.title") }}</SheetTitle>
      </SheetHeader>

      <!-- Provider Profile -->
      <div class="mb-5">
        <div class="flex items-center justify-between mb-2">
          <Label class="text-primary font-medium">{{ t("settings.providerProfile") }}</Label>
          <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('settings.addProfile')" @click="openProfileEditor()">
            <Plus class="h-4 w-4" />
          </Button>
        </div>

        <!-- This Panel's Profile -->
        <div class="mb-3">
          <Label class="text-xs text-muted-foreground mb-1 block">{{ t("settings.thisPanel") }}</Label>
          <Select :model-value="activeProviderProfile ?? '__none__'" @update:model-value="handleActiveProfileChange">
            <SelectTrigger class="w-full bg-input border-border">
              <SelectValue :placeholder="t('settings.noProfile')" />
            </SelectTrigger>
            <SelectContent class="bg-popover border-border">
              <SelectItem value="__none__">
                {{ t("settings.noProfile") }}
              </SelectItem>
              <SelectItem v-for="profile in providerProfiles" :key="profile.name" :value="profile.name">
                {{ profile.name }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- Default for New Panels -->
        <div class="mb-2">
          <Label class="text-xs text-muted-foreground mb-1 block">{{ t("settings.defaultForNewPanels") }}</Label>
          <Select :model-value="defaultProviderProfile ?? '__none__'" @update:model-value="handleDefaultProfileChange">
            <SelectTrigger class="w-full bg-input border-border">
              <SelectValue :placeholder="t('settings.noProfile')" />
            </SelectTrigger>
            <SelectContent class="bg-popover border-border">
              <SelectItem value="__none__">
                {{ t("settings.noProfile") }}
              </SelectItem>
              <SelectItem v-for="profile in providerProfiles" :key="profile.name" :value="profile.name">
                {{ profile.name }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div v-if="providerProfiles.length > 0" class="mt-2 space-y-1">
          <div
            v-for="profile in providerProfiles"
            :key="profile.name"
            class="flex items-center justify-between text-xs text-muted-foreground px-1 py-0.5 rounded hover:bg-muted/50"
          >
            <span class="truncate">{{ profile.name }}</span>
            <div class="flex items-center gap-1">
              <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('settings.editProfile')" @click="openProfileEditor(profile)">
                <Pencil class="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="h-5 w-5 text-destructive hover:text-destructive"
                :title="t('settings.deleteProfile')"
                @click="confirmDeleteProfile(profile.name)"
              >
                <Trash2 class="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>
        <p class="text-xs text-muted-foreground mt-1">
          {{ t("settings.providerProfileDescription") }}
        </p>
      </div>

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

      <!-- Model Selection -->
      <div class="mb-5">
        <Label class="block mb-2 text-primary font-medium">{{ t("settings.model") }}</Label>

        <!-- This Panel's Model -->
        <div class="mb-3">
          <Label class="text-xs text-muted-foreground mb-1 block">{{ t("settings.thisPanel") }}</Label>
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

        <!-- Default Model for New Panels -->
        <div>
          <Label class="text-xs text-muted-foreground mb-1 block">{{ t("settings.defaultForNewPanels") }}</Label>
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

      <!-- Reasoning Effort (adaptive 4.6 models) -->
      <div v-if="isAdaptiveCapable" class="mb-5">
        <Label class="block mb-2 text-primary font-medium">{{ t("settings.reasoningEffort") }}</Label>
        <Select :model-value="localEffort ?? 'high'" :disabled="localThinkingDisabled" @update:model-value="handleEffortChange">
          <SelectTrigger class="w-full bg-input border-border" :class="{ 'opacity-50': localThinkingDisabled }">
            <SelectValue />
          </SelectTrigger>
          <SelectContent class="bg-popover border-border">
            <SelectItem v-for="level in effortLevels" :key="level" :value="level">
              {{ t(`settings.effort${level.charAt(0).toUpperCase() + level.slice(1)}`) }}
            </SelectItem>
          </SelectContent>
        </Select>
        <div class="flex items-center gap-2 mt-3">
          <Switch
            id="disable-thinking"
            :checked="localThinkingDisabled"
            @update:checked="(val: boolean) => { localThinkingDisabled = val; emit('setThinkingDisabled', val); }"
          />
          <Label for="disable-thinking" class="text-sm font-normal">{{ t("settings.disableThinking") }}</Label>
        </div>
      </div>

      <!-- Extended Thinking (legacy models) -->
      <div v-else class="mb-5">
        <div class="flex items-center justify-between mb-2">
          <Label for="extended-thinking" class="text-primary font-medium">
            {{ t("settings.extendedThinking") }}
          </Label>
          <Switch id="extended-thinking" v-model:checked="enableExtendedThinking" />
        </div>
        <div v-if="enableExtendedThinking" class="mt-3 flex items-center gap-2">
          <Input
            type="number"
            :model-value="localMaxThinkingTokens ?? DEFAULT_THINKING_TOKENS"
            :min="1000"
            :max="63999"
            :step="1000"
            class="bg-input border-border text-center"
            @change="handleThinkingTokensChange"
          />
          <span class="text-sm text-muted-foreground whitespace-nowrap">{{ t("common.tokens") }}</span>
        </div>
      </div>

      <!-- Extended Features -->
      <div class="mb-5">
        <Label class="block mb-2 text-foreground font-medium">{{ t("settings.extendedFeatures") }}</Label>
        <div class="flex items-center justify-between">
          <Label for="context-1m" class="text-sm font-normal text-foreground" :class="{ 'text-muted-foreground': !modelSupports1MContext }">
            {{ t("settings.context1m") }}
          </Label>
          <Switch id="context-1m" v-model:checked="is1MContextEnabled" :disabled="!modelSupports1MContext" />
        </div>
        <p class="text-xs text-muted-foreground mt-1">
          {{ modelSupports1MContext ? t("settings.context1mDescription") : t("settings.extendedThinkingCondition") }}
        </p>
      </div>

      <!-- Context Strategy -->
      <div class="mb-5">
        <Label class="block mb-2 text-primary font-medium">{{ t("settings.contextStrategy.label") }}</Label>

        <!-- This Panel's Strategy -->
        <div class="mb-3">
          <Label class="text-xs text-muted-foreground mb-1 block">{{ t("settings.thisPanel") }}</Label>
          <Select :model-value="activeContextStrategy" @update:model-value="handleActiveContextStrategyChange">
            <SelectTrigger class="w-full bg-input border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent class="bg-popover border-border">
              <SelectItem v-for="option in contextStrategyOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- Default Strategy for New Panels -->
        <div>
          <Label class="text-xs text-muted-foreground mb-1 block">{{ t("settings.defaultForNewPanels") }}</Label>
          <Select :model-value="defaultContextStrategy" @update:model-value="handleDefaultContextStrategyChange">
            <SelectTrigger class="w-full bg-input border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent class="bg-popover border-border">
              <SelectItem v-for="option in contextStrategyOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p class="text-xs text-muted-foreground mt-1">
          {{ t("settings.contextStrategy.description") }}
        </p>
      </div>

      <!-- Language Selection -->
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

      <!-- Voice Input -->
      <div class="mb-5">
        <Label class="block mb-2 text-primary font-medium">{{ t("settings.voice.title") }}</Label>

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
      </div>

      <!-- Divider -->
      <Separator class="my-4 bg-border" />

      <!-- VS Code Settings Link -->
      <Button class="w-full" @click="emit('openVSCodeSettings')">
        {{ t("settings.openVsCodeSettings") }}
      </Button>

      <!-- Info -->
      <p class="text-xs text-muted-foreground mt-4 text-center">
        {{ t("settings.settingsInfo") }}
      </p>
    </SheetContent>
  </Sheet>

  <!-- Profile Editor Modal -->
  <ProfileEditor :visible="profileEditorVisible" :profile="editingProfile" @close="closeProfileEditor" @save="handleSaveProfile" />

  <!-- Delete Profile Confirmation -->
  <AlertDialog :open="profileToDelete !== null">
    <AlertDialogContent class="bg-card border-border">
      <AlertDialogHeader>
        <AlertDialogTitle class="text-foreground">{{ t("settings.deleteProfileConfirmTitle") }}</AlertDialogTitle>
        <AlertDialogDescription class="text-muted-foreground">
          {{ t("settings.deleteProfileConfirmMessage", { name: profileToDelete }) }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel @click="cancelDeleteProfile">{{ t("common.cancel") }}</AlertDialogCancel>
        <AlertDialogAction class="bg-destructive text-destructive-foreground hover:bg-destructive/90" @click="handleDeleteProfile">
          {{ t("common.delete") }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
