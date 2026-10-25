<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, useId, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { usePlatformBridge } from "@/composables/usePlatformBridge";
import { Eye, EyeOff, Trash2 } from "lucide-vue-next";
import SettingButton from "@/components/settings/controls/SettingButton.vue";
import SettingSwitch from "@/components/settings/controls/SettingSwitch.vue";
import ProviderSignInField from "@/components/ProviderSignInField.vue";
import { useMemoryJudgeNames } from "@/components/settings/memory-judge-names";
import type { ExtensionToWebviewMessage } from "@shared/types/messages";
import { isKeyProviderId, isSignInProviderId, type AccountProviderId } from "@shared/settings-sections";

// The auth panel shared by the account providers: a sign-in, a key field, or both. The provider id doubles as the i18n section key.
const props = defineProps<{ provider: AccountProviderId }>();

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { keyProviderStatus, providerSignInState, memoryJudge } = storeToRefs(settingsStore);
const { postMessage, onMessage } = usePlatformBridge();

const status = computed(() => keyProviderStatus.value[props.provider]);
const configured = computed(() => status.value.configured);
const signInProvider = computed(() => (isSignInProviderId(props.provider) ? props.provider : null));
const keyProvider = computed(() => (isKeyProviderId(props.provider) ? props.provider : null));

// The preference decides only between a sign-in and the key saved here, so it shows only when both exist.
const showPreferSwitch = computed(() => status.value.configured && status.value.signedIn);
// The key sync leaves a provider alone while it signs in, so the preference waits for the flow to end.
const signInRunning = computed(() => signInProvider.value !== null && providerSignInState.value[signInProvider.value].phase !== "idle");
const preferLabelId = useId();
const preferHintId = useId();
// The switch shows the value it sent until core acknowledges it, and core's status after.
const preferPending = ref<{ requestId: string; value: boolean } | null>(null);
const preferError = ref<string | null>(null);
const preferValue = computed(() => preferPending.value?.value ?? status.value.preferApiKey);

watch(showPreferSwitch, (shown) => {
  if (shown) return;
  preferPending.value = null;
  preferError.value = null;
});

const { classifierName, judgeText } = useMemoryJudgeNames();

const memoryJudgeText = computed(() => {
  const judge = memoryJudge.value;
  return props.provider === "typesafe" && judge ? judgeText(judge) : null;
});

const rejectedJudgeLines = computed(() => {
  const judge = memoryJudge.value;
  if (props.provider !== "typesafe" || !judge?.rejected) return [];
  return judge.rejected.map(({ via, reason }) => ({
    via,
    text: t("typesafe.memoryJudge.rejected", {
      provider: classifierName(via),
      reason: t(`typesafe.memoryJudge.rejection.${reason}`),
    }),
  }));
});

const apiKeyInput = ref("");
const showKey = ref(false);
const saving = ref(false);
const inlineMessage = ref<{ kind: "success" | "error"; text: string } | null>(null);
const pendingRequestId = ref<string | null>(null);

const tk = (key: string): string => t(`${props.provider}.${key}`);

function makeRequestId(): string {
  return `${props.provider}-auth-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function handleSave() {
  const key = apiKeyInput.value.trim();
  const provider = keyProvider.value;
  if (!key || saving.value || !provider) return;
  const requestId = makeRequestId();
  pendingRequestId.value = requestId;
  saving.value = true;
  inlineMessage.value = null;
  postMessage({ type: "setProviderApiKey", provider, key, requestId });
}

function handleClear() {
  const provider = keyProvider.value;
  if (!configured.value || saving.value || !provider) return;
  const requestId = makeRequestId();
  pendingRequestId.value = requestId;
  saving.value = true;
  inlineMessage.value = null;
  postMessage({ type: "clearProviderApiKey", provider, requestId });
}

function handlePreferenceChange(value: boolean) {
  const provider = keyProvider.value;
  if (!provider || signInRunning.value) return;
  const requestId = makeRequestId();
  preferPending.value = { requestId, value };
  preferError.value = null;
  postMessage({ type: "setProviderPreferApiKey", provider, preferApiKey: value, requestId });
}

function handleAck(msg: ExtensionToWebviewMessage) {
  if (msg.type === "setProviderPreferApiKeyAck") {
    if (msg.provider !== props.provider || msg.requestId !== preferPending.value?.requestId) return;
    preferPending.value = null;
    if (!msg.ok) preferError.value = msg.error ?? t("providerAuth.preferApiKey.failed");
  } else if (msg.type === "setProviderApiKeyAck") {
    if (msg.provider !== props.provider || msg.requestId !== pendingRequestId.value) return;
    pendingRequestId.value = null;
    saving.value = false;
    if (msg.ok) {
      apiKeyInput.value = "";
      showKey.value = false;
      inlineMessage.value = { kind: "success", text: tk("apiKey.saved") };
    } else {
      inlineMessage.value = { kind: "error", text: msg.error ?? tk("apiKey.saveFailed") };
    }
  } else if (msg.type === "clearProviderApiKeyAck") {
    if (msg.provider !== props.provider || msg.requestId !== pendingRequestId.value) return;
    pendingRequestId.value = null;
    saving.value = false;
    if (msg.ok) {
      inlineMessage.value = { kind: "success", text: tk("apiKey.cleared") };
    } else {
      inlineMessage.value = { kind: "error", text: msg.error ?? tk("apiKey.clearFailed") };
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
    case "error": return "sm-hint-error";
    default: return "";
  }
});
</script>

<template>
  <div :data-testid="`${provider}-auth-panel`">
    <p
      v-if="status.active"
      class="sm-hint"
      role="status"
      data-testid="credential-active"
    >
      {{ t(`providerAuth.active.${status.active}`) }}
    </p>
    <ProviderSignInField
      v-if="signInProvider"
      :provider="signInProvider"
    />
    <div
      v-else-if="status.signedIn"
      class="sm-field"
      data-testid="provider-sign-in"
    >
      <div class="sm-field-label">
        {{ t('providerAuth.signIn.label') }}
        <span class="sm-hint">{{ t('providerAuth.signIn.signedIn') }}</span>
      </div>
    </div>
    <div
      v-if="keyProvider"
      class="sm-field"
    >
      <div class="sm-field-label">
        {{ tk('apiKey.label') }}
        <span class="sm-hint">{{ configured ? tk('apiKey.configured') : tk('apiKey.notConfigured') }}</span>
      </div>
      <div class="sm-field-row">
        <div class="sm-input sm-input-wide">
          <input
            v-model="apiKeyInput"
            :type="showKey ? 'text' : 'password'"
            autocomplete="new-password"
            spellcheck="false"
            :placeholder="tk('apiKey.placeholder')"
            :aria-label="tk('apiKey.label')"
            :disabled="saving"
            @keydown.enter.prevent="handleSave"
          >
          <button
            type="button"
            class="sm-search-clear"
            :title="showKey ? tk('apiKey.hide') : tk('apiKey.show')"
            :aria-label="showKey ? tk('apiKey.hide') : tk('apiKey.show')"
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
          {{ saving ? tk('apiKey.saving') : t('common.save') }}
        </SettingButton>
        <SettingButton
          v-if="configured"
          variant="danger"
          :title="tk('apiKey.clear')"
          :aria-label="tk('apiKey.clear')"
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
        :role="inlineMessage.kind === 'error' ? 'alert' : 'status'"
      >
        {{ inlineMessage.text }}
      </p>
      <p
        v-else
        class="sm-hint"
      >
        {{ tk('apiKey.hint') }}
      </p>
      <div
        v-if="memoryJudgeText"
        role="status"
        class="sm-hint"
      >
        <p data-testid="memory-judge">
          {{ t('typesafe.memoryJudge.label', { judge: memoryJudgeText }) }}
        </p>
        <p
          v-for="line in rejectedJudgeLines"
          :key="line.via"
          class="sm-hint-warning"
          data-testid="memory-judge-rejected"
        >
          {{ line.text }}
        </p>
      </div>
    </div>

    <template v-if="showPreferSwitch">
      <!-- The whole row toggles the switch; aria-labelledby keeps the hint out of the switch's name. -->
      <label class="sm-field-row">
        <SettingSwitch
          :model-value="preferValue"
          :aria-labelledby="preferLabelId"
          :aria-describedby="preferHintId"
          :disabled="signInRunning"
          data-testid="prefer-api-key"
          @update:model-value="handlePreferenceChange"
        />
        <span class="flex-1">
          <span
            :id="preferLabelId"
            class="sm-field-label"
          >
            {{ t('providerAuth.preferApiKey.label') }}
          </span>
          <span
            :id="preferHintId"
            class="sm-hint block"
          >
            {{ t('providerAuth.preferApiKey.description') }}
          </span>
        </span>
      </label>
      <p
        v-if="preferError"
        class="sm-hint sm-hint-error"
        role="alert"
      >
        {{ preferError }}
      </p>
    </template>
  </div>
</template>
