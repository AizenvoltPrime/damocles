<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { usePlatformBridge } from "@/composables/usePlatformBridge";
import { Eye, EyeOff, Trash2 } from "lucide-vue-next";
import SettingButton from "@/components/settings/controls/SettingButton.vue";
import { useMemoryJudgeNames } from "@/components/settings/memory-judge-names";
import type { ExtensionToWebviewMessage } from "@shared/types/messages";
import type { KeyProviderId } from "@shared/settings-sections";

// Single key-field auth panel shared by the key providers. The provider id doubles as the i18n section key.
const props = defineProps<{ provider: KeyProviderId }>();

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { keyProviderConfigured, memoryJudge } = storeToRefs(settingsStore);
const { postMessage, onMessage } = usePlatformBridge();

const configured = computed(() => keyProviderConfigured.value[props.provider]);

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
  if (!key || saving.value) return;
  const requestId = makeRequestId();
  pendingRequestId.value = requestId;
  saving.value = true;
  inlineMessage.value = null;
  postMessage({ type: "setProviderApiKey", provider: props.provider, key, requestId });
}

function handleClear() {
  if (!configured.value || saving.value) return;
  const requestId = makeRequestId();
  pendingRequestId.value = requestId;
  saving.value = true;
  inlineMessage.value = null;
  postMessage({ type: "clearProviderApiKey", provider: props.provider, requestId });
}

function handleAck(msg: ExtensionToWebviewMessage) {
  if (msg.type === "setProviderApiKeyAck") {
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
    <div class="sm-field">
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
  </div>
</template>
