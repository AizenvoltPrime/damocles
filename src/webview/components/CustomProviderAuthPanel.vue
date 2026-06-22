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
import { Eye, EyeOff, Trash2 } from "lucide-vue-next";
import type { ExtensionToWebviewMessage } from "@shared/types/messages";

// Single key-field auth panel shared by the custom (non-first-party) providers. The provider id doubles
// as the i18n section key (`stepfun.*` / `deepseek.*`) and selects the store ref + message variants.
const props = defineProps<{ provider: "stepfun" | "deepseek" }>();

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { stepfunConfigured, deepseekConfigured } = storeToRefs(settingsStore);
const { postMessage, onMessage } = useVSCode();

const configured = computed(() =>
  props.provider === "stepfun" ? stepfunConfigured.value : deepseekConfigured.value
);

const apiKeyInput = ref("");
const showKey = ref(false);
const saving = ref(false);
const inlineMessage = ref<{ kind: "success" | "error"; text: string } | null>(null);
const pendingRequestId = ref<string | null>(null);

const tk = (key: string): string => t(`${props.provider}.${key}`);

function makeRequestId(): string {
  return `${props.provider}-auth-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function postSet(key: string, requestId: string) {
  if (props.provider === "stepfun") postMessage({ type: "setStepfunApiKey", key, requestId });
  else postMessage({ type: "setDeepseekApiKey", key, requestId });
}

function postClear(requestId: string) {
  if (props.provider === "stepfun") postMessage({ type: "clearStepfunApiKey", requestId });
  else postMessage({ type: "clearDeepseekApiKey", requestId });
}

function postGetStatus() {
  if (props.provider === "stepfun") postMessage({ type: "getStepfunAuthStatus" });
  else postMessage({ type: "getDeepseekAuthStatus" });
}

function handleSave() {
  const key = apiKeyInput.value.trim();
  if (!key || saving.value) return;
  const requestId = makeRequestId();
  pendingRequestId.value = requestId;
  saving.value = true;
  inlineMessage.value = null;
  postSet(key, requestId);
}

function handleClear() {
  if (!configured.value || saving.value) return;
  const requestId = makeRequestId();
  pendingRequestId.value = requestId;
  saving.value = true;
  inlineMessage.value = null;
  postClear(requestId);
}

function handleAck(msg: ExtensionToWebviewMessage) {
  const setAck = props.provider === "stepfun" ? "setStepfunApiKeyAck" : "setDeepseekApiKeyAck";
  const clearAck = props.provider === "stepfun" ? "clearStepfunApiKeyAck" : "clearDeepseekApiKeyAck";
  if (msg.type === setAck) {
    if (msg.requestId !== pendingRequestId.value) return;
    pendingRequestId.value = null;
    saving.value = false;
    if (msg.ok) {
      apiKeyInput.value = "";
      showKey.value = false;
      inlineMessage.value = { kind: "success", text: tk("apiKey.saved") };
    } else {
      inlineMessage.value = { kind: "error", text: msg.error ?? tk("apiKey.saveFailed") };
    }
  } else if (msg.type === clearAck) {
    if (msg.requestId !== pendingRequestId.value) return;
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
  postGetStatus();
});

onUnmounted(() => {
  unsubscribe?.();
});

const messageClass = computed(() => {
  switch (inlineMessage.value?.kind) {
    case "success": return "text-emerald-500";
    case "error": return "text-destructive";
    default: return "";
  }
});
</script>

<template>
  <section class="mb-6">
    <h3 class="text-sm font-semibold text-foreground uppercase tracking-wide mb-3">
      {{ tk('sectionTitle') }}
    </h3>

    <div class="mb-4">
      <div class="flex items-center gap-1.5 mb-1">
        <Label class="text-xs text-muted-foreground">{{ tk('apiKey.label') }}</Label>
        <span class="flex items-center gap-1 text-xs">
          <IconCircleGreen
            v-if="configured"
            :size="8"
          />
          <IconCircleRed
            v-else
            :size="8"
          />
          <span class="text-muted-foreground">
            {{ configured ? tk('apiKey.configured') : tk('apiKey.notConfigured') }}
          </span>
        </span>
      </div>

      <div class="flex gap-2">
        <div class="relative flex-1">
          <Input
            v-model="apiKeyInput"
            :type="showKey ? 'text' : 'password'"
            :placeholder="tk('apiKey.placeholder')"
            class="bg-input border-border placeholder:text-muted-foreground pr-9"
            :disabled="saving"
            @keydown.enter="handleSave"
          />
          <button
            type="button"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            :title="showKey ? tk('apiKey.hide') : tk('apiKey.show')"
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
          {{ saving ? tk('apiKey.saving') : t('common.save') }}
        </Button>
        <Button
          v-if="configured"
          variant="ghost"
          size="icon"
          class="h-9 w-9 shrink-0 text-destructive hover:text-destructive/80 hover:bg-destructive/10"
          :title="tk('apiKey.clear')"
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
        {{ tk('apiKey.hint') }}
      </p>
    </div>
  </section>
</template>
