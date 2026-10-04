<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, useId } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { usePlatformBridge } from "@/composables/usePlatformBridge";
import { Eye, EyeOff, Trash2, LogOut } from "lucide-vue-next";
import SettingButton from "@/components/settings/controls/SettingButton.vue";
import SettingSwitch from "@/components/settings/controls/SettingSwitch.vue";
import type { ExtensionToWebviewMessage } from "@shared/types/messages";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const {
  openaiAuthStatus,
  openaiPreferApiKey,
  openaiChatGPTAuthInFlight,
  openaiChatGPTAuthError,
} = storeToRefs(settingsStore);
const { postMessage, onMessage } = usePlatformBridge();

const apiKeyInput = ref("");
const showKey = ref(false);
const saving = ref(false);
const inlineMessage = ref<{ kind: "success" | "warning" | "error"; text: string } | null>(null);
const pendingRequestId = ref<string | null>(null);

const apiKeyConfigured = computed(() => openaiAuthStatus.value.apikey.configured);
const chatgptSignedIn = computed(() => openaiAuthStatus.value.chatgpt.signedIn);
const codexSignedIn = computed(() => openaiAuthStatus.value.codex.signedIn);
const canTogglePreference = computed(
  () => apiKeyConfigured.value && (chatgptSignedIn.value || codexSignedIn.value)
);
const canStartChatGPTSignIn = computed(
  () => !openaiChatGPTAuthInFlight.value && !chatgptSignedIn.value
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

const preferLabelId = useId();
const preferHintId = useId();

function handlePreferenceChange(value: boolean) {
  const requestId = makeRequestId();
  pendingRequestId.value = requestId;
  inlineMessage.value = null;
  postMessage({ type: "setOpenAIPreferApiKey", preferApiKey: value, requestId });
}

function handleChatGPTSignIn() {
  if (!canStartChatGPTSignIn.value) return;
  // Set here, not only on the host's reply, so a second click before that reply sends nothing.
  settingsStore.setChatGPTAuthInFlight(true);
  postMessage({ type: "startChatGPTOAuth" });
}

function handleChatGPTSignOut() {
  if (!chatgptSignedIn.value) return;
  postMessage({ type: "signOutChatGPT" });
}

function handleCodexSignOut() {
  if (!codexSignedIn.value || openaiChatGPTAuthInFlight.value) return;
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
});

onUnmounted(() => {
  unsubscribe?.();
});

const messageClass = computed(() => {
  switch (inlineMessage.value?.kind) {
    case "success": return "sm-hint-success";
    case "warning": return "sm-hint-warning";
    case "error": return "sm-hint-error";
    default: return "";
  }
});
</script>

<template>
  <div data-testid="openai-auth-panel">
    <div class="sm-field">
      <div class="sm-field-label">
        {{ t('openai.chatgpt.label') }}
        <span class="sm-hint">{{ chatgptSignedIn ? t('openai.chatgpt.signedIn') : t('openai.chatgpt.notSignedIn') }}</span>
      </div>
      <div class="sm-field-row">
        <SettingButton
          v-if="!chatgptSignedIn"
          variant="primary"
          :disabled="!canStartChatGPTSignIn"
          @click="handleChatGPTSignIn"
        >
          {{ openaiChatGPTAuthInFlight ? t('openai.chatgpt.waiting') : t('openai.chatgpt.signIn') }}
        </SettingButton>
        <SettingButton
          v-else
          variant="danger"
          :aria-label="t('openai.chatgpt.signOutLabel')"
          @click="handleChatGPTSignOut"
        >
          <LogOut
            class="size-3.25"
            aria-hidden="true"
          />
          {{ t('openai.chatgpt.signOut') }}
        </SettingButton>
      </div>
      <p
        v-if="openaiChatGPTAuthInFlight"
        class="sm-hint"
        role="status"
        data-testid="chatgpt-manual-hint"
      >
        {{ t('openai.chatgpt.manualHint') }}
      </p>
      <p
        v-else-if="openaiChatGPTAuthError"
        class="sm-hint sm-hint-error"
        role="alert"
      >
        {{ openaiChatGPTAuthError }}
      </p>
      <p
        v-else-if="!chatgptSignedIn"
        class="sm-hint"
      >
        {{ t('openai.chatgpt.browserHint') }}
      </p>
    </div>

    <div
      v-if="codexSignedIn"
      class="sm-field"
      data-testid="legacy-codex-row"
    >
      <div class="sm-field-label">
        {{ t('openai.legacyCodex.label') }}
        <span class="sm-hint">{{ t('openai.chatgpt.signedIn') }}</span>
      </div>
      <div class="sm-field-row">
        <SettingButton
          variant="danger"
          :aria-label="t('openai.legacyCodex.signOutLabel')"
          :disabled="openaiChatGPTAuthInFlight"
          @click="handleCodexSignOut"
        >
          <LogOut
            class="size-3.25"
            aria-hidden="true"
          />
          {{ t('openai.chatgpt.signOut') }}
        </SettingButton>
      </div>
      <p class="sm-hint">
        {{ t('openai.legacyCodex.hint') }}
      </p>
    </div>

    <div class="sm-field">
      <div class="sm-field-label">
        {{ t('openai.apiKey.label') }}
        <span class="sm-hint">{{ apiKeyConfigured ? t('openai.apiKey.configured') : t('openai.apiKey.notConfigured') }}</span>
      </div>
      <div class="sm-field-row">
        <div class="sm-input sm-input-wide">
          <input
            v-model="apiKeyInput"
            :type="showKey ? 'text' : 'password'"
            autocomplete="new-password"
            spellcheck="false"
            placeholder="sk-..."
            :aria-label="t('openai.apiKey.label')"
            :disabled="saving"
            @keydown.enter.prevent="handleSave"
          >
          <button
            type="button"
            class="sm-search-clear"
            :aria-label="showKey ? t('openai.apiKey.hide') : t('openai.apiKey.show')"
            :title="showKey ? t('openai.apiKey.hide') : t('openai.apiKey.show')"
            @click="showKey = !showKey"
          >
            <EyeOff
              v-if="showKey"
              class="size-3.5"
              aria-hidden="true"
            />
            <Eye
              v-else
              class="size-3.5"
              aria-hidden="true"
            />
          </button>
        </div>
        <SettingButton
          variant="primary"
          :disabled="!apiKeyInput.trim() || saving"
          @click="handleSave"
        >
          {{ saving ? t('openai.apiKey.saving') : t('common.save') }}
        </SettingButton>
        <SettingButton
          v-if="apiKeyConfigured"
          variant="danger"
          :aria-label="t('openai.apiKey.clear')"
          :title="t('openai.apiKey.clear')"
          :disabled="saving"
          @click="handleClear"
        >
          <Trash2
            class="size-3.25"
            aria-hidden="true"
          />
        </SettingButton>
      </div>
      <p
        v-if="inlineMessage"
        class="sm-hint"
        :class="messageClass"
      >
        {{ inlineMessage.text }}
      </p>
      <p
        v-else
        class="sm-hint"
      >
        {{ t('openai.apiKey.validationHint') }}
      </p>
    </div>

    <!-- The whole row toggles the switch; aria-labelledby keeps the hint out of the switch's name. -->
    <label class="sm-field-row">
      <SettingSwitch
        :model-value="openaiPreferApiKey"
        :aria-labelledby="preferLabelId"
        :aria-describedby="preferHintId"
        :disabled="!canTogglePreference"
        data-testid="openai-prefer-api-key"
        @update:model-value="handlePreferenceChange"
      />
      <span class="flex-1">
        <span
          :id="preferLabelId"
          class="sm-field-label"
        >
          {{ t('openai.preferApiKey.label') }}
        </span>
        <span
          :id="preferHintId"
          class="sm-hint block"
        >
          {{ canTogglePreference ? t('openai.preferApiKey.descriptionEnabled') : t('openai.preferApiKey.descriptionDisabled') }}
        </span>
      </span>
    </label>
  </div>
</template>
