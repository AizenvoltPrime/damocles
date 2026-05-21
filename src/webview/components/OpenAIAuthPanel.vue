<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useVSCode } from "@/composables/useVSCode";
import { IconCircleGreen, IconCircleRed } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Eye, EyeOff, Trash2, LogOut } from "lucide-vue-next";
import type { ExtensionToWebviewMessage } from "@shared/types/messages";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const {
  openaiAuthStatus,
  openaiPreferApiKey,
  openaiCodexAuthInFlight,
  openaiCodexAuthError,
} = storeToRefs(settingsStore);
const { postMessage, onMessage } = useVSCode();

const apiKeyInput = ref("");
const showKey = ref(false);
const saving = ref(false);
const inlineMessage = ref<{ kind: "success" | "warning" | "error"; text: string } | null>(null);
const pendingRequestId = ref<string | null>(null);

const apiKeyConfigured = computed(() => openaiAuthStatus.value.apikey.configured);
const codexSignedIn = computed(() => openaiAuthStatus.value.codex.signedIn);
const codexAccountId = computed(() => openaiAuthStatus.value.codex.accountId ?? null);
const canTogglePreference = computed(() => apiKeyConfigured.value && codexSignedIn.value);
const canStartCodexSignIn = computed(
  () => !openaiCodexAuthInFlight.value && !codexSignedIn.value
);

function makeRequestId(): string {
  return `openai-auth-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function handleSave() {
  const key = apiKeyInput.value.trim();
  if (!key || saving.value) return;
  const requestId = makeRequestId();
  pendingRequestId.value = requestId;
  saving.value = true;
  inlineMessage.value = null;
  postMessage({ type: "setOpenAIApiKey", key, requestId });
}

function handleClear() {
  if (!apiKeyConfigured.value || saving.value) return;
  const requestId = makeRequestId();
  pendingRequestId.value = requestId;
  saving.value = true;
  inlineMessage.value = null;
  postMessage({ type: "clearOpenAIApiKey", requestId });
}

function handlePreferenceChange(value: boolean) {
  const requestId = makeRequestId();
  pendingRequestId.value = requestId;
  inlineMessage.value = null;
  postMessage({ type: "setOpenAIPreferApiKey", preferApiKey: value, requestId });
}

function handleCodexSignIn() {
  if (!canStartCodexSignIn.value) return;
  postMessage({ type: "startCodexOAuth" });
}

function handleCodexSignOut() {
  if (!codexSignedIn.value) return;
  postMessage({ type: "signOutCodex" });
}

function handleAck(msg: ExtensionToWebviewMessage) {
  if (msg.type === "setOpenAIApiKeyAck") {
    if (msg.requestId !== pendingRequestId.value) return;
    pendingRequestId.value = null;
    saving.value = false;
    if (msg.ok) {
      apiKeyInput.value = "";
      showKey.value = false;
      if (msg.validated) {
        inlineMessage.value = {
          kind: "success",
          text: t('openai.apiKey.validated', { count: msg.modelCount ?? 0 }),
        };
      } else {
        inlineMessage.value = {
          kind: "warning",
          text: msg.warning ?? t('openai.apiKey.savedWithoutValidation'),
        };
      }
    } else {
      inlineMessage.value = { kind: "error", text: msg.error ?? t('openai.apiKey.saveFailed') };
    }
  } else if (msg.type === "clearOpenAIApiKeyAck") {
    if (msg.requestId !== pendingRequestId.value) return;
    pendingRequestId.value = null;
    saving.value = false;
    if (msg.ok) {
      inlineMessage.value = { kind: "success", text: t('openai.apiKey.cleared') };
    } else {
      inlineMessage.value = { kind: "error", text: msg.error ?? t('openai.apiKey.clearFailed') };
    }
  } else if (msg.type === "setOpenAIPreferApiKeyAck") {
    if (msg.requestId !== pendingRequestId.value) return;
    pendingRequestId.value = null;
    if (!msg.ok) {
      inlineMessage.value = { kind: "error", text: msg.error ?? t('openai.apiKey.saveFailed') };
    }
  }
}

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  unsubscribe = onMessage(handleAck);
  postMessage({ type: "getOpenAIAuthStatus" });
});

onUnmounted(() => {
  unsubscribe?.();
});

const messageClass = computed(() => {
  switch (inlineMessage.value?.kind) {
    case "success": return "text-emerald-500";
    case "warning": return "text-amber-500";
    case "error": return "text-destructive";
    default: return "";
  }
});

const preferenceTooltip = computed(() => t('openai.preferApiKey.tooltip'));

const codexSignInLabel = computed(() => {
  if (openaiCodexAuthInFlight.value) return t('openai.codexSignIn.waiting');
  if (codexSignedIn.value) return t('openai.codexSignIn.signedIn');
  return t('openai.codexSignIn.signInButton');
});
</script>

<template>
  <section class="mb-6">
    <h3 class="text-sm font-semibold text-foreground uppercase tracking-wide mb-3">
      {{ t('openai.sectionTitle') }}
    </h3>

    <div class="mb-4">
      <div class="flex items-center gap-1.5 mb-1">
        <Label class="text-xs text-muted-foreground">{{ t('openai.apiKey.label') }}</Label>
        <span class="flex items-center gap-1 text-xs">
          <IconCircleGreen
            v-if="apiKeyConfigured"
            :size="8"
          />
          <IconCircleRed
            v-else
            :size="8"
          />
          <span class="text-muted-foreground">
            {{ apiKeyConfigured ? t('openai.apiKey.configured') : t('openai.apiKey.notConfigured') }}
          </span>
        </span>
      </div>

      <div class="flex gap-2">
        <div class="relative flex-1">
          <Input
            v-model="apiKeyInput"
            :type="showKey ? 'text' : 'password'"
            placeholder="sk-..."
            class="bg-input border-border placeholder:text-muted-foreground pr-9"
            :disabled="saving"
            @keydown.enter="handleSave"
          />
          <button
            type="button"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            :title="showKey ? t('openai.apiKey.hide') : t('openai.apiKey.show')"
            @click="showKey = !showKey"
          >
            <EyeOff
              v-if="showKey"
              class="h-4 w-4"
            />
            <Eye
              v-else
              class="h-4 w-4"
            />
          </button>
        </div>
        <Button
          size="sm"
          :disabled="!apiKeyInput.trim() || saving"
          @click="handleSave"
        >
          {{ saving ? t('openai.apiKey.saving') : t('common.save') }}
        </Button>
        <Button
          v-if="apiKeyConfigured"
          variant="ghost"
          size="icon"
          class="h-9 w-9 shrink-0 text-destructive hover:text-destructive/80 hover:bg-destructive/10"
          :title="t('openai.apiKey.clear')"
          :disabled="saving"
          @click="handleClear"
        >
          <Trash2 class="h-4 w-4" />
        </Button>
      </div>

      <p
        v-if="inlineMessage"
        class="text-xs mt-2"
        :class="messageClass"
      >
        {{ inlineMessage.text }}
      </p>
      <p
        v-else
        class="text-xs text-muted-foreground mt-2"
      >
        {{ t('openai.apiKey.validationHint') }}
      </p>
    </div>

    <Separator class="my-3 bg-border" />

    <div class="mb-4">
      <div class="flex items-center gap-1.5 mb-1">
        <Label class="text-xs text-muted-foreground">{{ t('openai.codexSection.label') }}</Label>
        <span class="flex items-center gap-1 text-xs">
          <IconCircleGreen
            v-if="codexSignedIn"
            :size="8"
          />
          <IconCircleRed
            v-else
            :size="8"
          />
          <span class="text-muted-foreground">
            {{ codexSignedIn
              ? (codexAccountId ? t('openai.codexSection.signedInAs', { account: codexAccountId }) : t('openai.codexSection.signedIn'))
              : t('openai.codexSection.notSignedIn') }}
          </span>
        </span>
      </div>

      <div class="flex gap-2">
        <Button
          v-if="!codexSignedIn"
          size="sm"
          :disabled="!canStartCodexSignIn"
          @click="handleCodexSignIn"
        >
          {{ codexSignInLabel }}
        </Button>
        <Button
          v-else
          variant="outline"
          size="sm"
          class="text-destructive border-destructive/40 hover:bg-destructive/10"
          @click="handleCodexSignOut"
        >
          <LogOut class="h-3.5 w-3.5 mr-1.5" />
          {{ t('openai.codexSignIn.signOut') }}
        </Button>
      </div>

      <p
        v-if="openaiCodexAuthError"
        class="text-xs text-destructive mt-2"
      >
        {{ openaiCodexAuthError }}
      </p>
      <p
        v-else-if="!codexSignedIn"
        class="text-xs text-muted-foreground mt-2"
      >
        {{ t('openai.codexSignIn.browserHint') }}
      </p>
    </div>

    <div class="flex items-start gap-2">
      <Checkbox
        id="openai-prefer-apikey"
        :checked="openaiPreferApiKey"
        :disabled="!canTogglePreference"
        @update:checked="handlePreferenceChange"
      />
      <div class="flex-1">
        <Label
          for="openai-prefer-apikey"
          class="text-xs text-foreground cursor-pointer"
          :class="!canTogglePreference && 'text-muted-foreground'"
          :title="preferenceTooltip"
        >
          {{ t('openai.preferApiKey.label') }}
        </Label>
        <p class="text-xs text-muted-foreground mt-0.5">
          {{ canTogglePreference
            ? t('openai.preferApiKey.descriptionEnabled')
            : t('openai.preferApiKey.descriptionDisabled') }}
        </p>
      </div>
    </div>
  </section>
</template>
