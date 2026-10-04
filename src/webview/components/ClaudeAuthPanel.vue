<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { usePlatformBridge } from "@/composables/usePlatformBridge";
import { LogOut } from "lucide-vue-next";
import SettingButton from "@/components/settings/controls/SettingButton.vue";

type Mode = "none" | "apikey" | "allowance" | "extra";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { claudeAuthMode, claudeAuthBusy, claudeAuthError } = storeToRefs(settingsStore);
const { postMessage } = usePlatformBridge();

// The radio reflects the active mode but lets the user pre-select 'apikey' to reveal the key field.
const selected = ref<Exclude<Mode, "none">>("allowance");
const apiKeyInput = ref("");

watch(
  claudeAuthMode,
  (mode) => {
    if (mode !== "none") selected.value = mode;
  },
  { immediate: true },
);

const signedInSubscription = computed(() => claudeAuthMode.value === "allowance" || claudeAuthMode.value === "extra");
const busy = computed(() => claudeAuthBusy.value);

function chooseSubscription(useAllowance: boolean) {
  if (busy.value) return;
  // Already signed in with an OAuth token → just flip the billing bucket (no re-login).
  if (signedInSubscription.value) postMessage({ type: "claudeSetBilling", useAllowance });
  else postMessage({ type: "claudeSignIn", useAllowance });
}

function onSelect(mode: Exclude<Mode, "none">) {
  selected.value = mode;
  if (mode === "allowance") chooseSubscription(true);
  else if (mode === "extra") chooseSubscription(false);
}

function saveApiKey() {
  const key = apiKeyInput.value.trim();
  if (!key || busy.value) return;
  postMessage({ type: "claudeSetApiKey", key });
  apiKeyInput.value = "";
}

function signOut() {
  if (busy.value) return;
  postMessage({ type: "claudeSignOut" });
}
</script>

<template>
  <div data-testid="claude-auth-panel">
    <label class="sm-choice">
      <input
        type="radio"
        name="claude-auth-mode"
        :checked="selected === 'allowance'"
        :disabled="busy"
        @change="onSelect('allowance')"
      >
      <span class="flex-1">
        {{ t('claudeAuth.modes.allowance') }}
        <span class="sm-hint">{{ t('claudeAuth.modes.allowanceHint') }}</span>
      </span>
      <span
        v-if="claudeAuthMode === 'allowance'"
        class="sm-hint sm-hint-success"
      >{{ t('claudeAuth.status.signedIn') }}</span>
    </label>

    <label class="sm-choice">
      <input
        type="radio"
        name="claude-auth-mode"
        :checked="selected === 'extra'"
        :disabled="busy"
        @change="onSelect('extra')"
      >
      <span class="flex-1">
        {{ t('claudeAuth.modes.extra') }}
        <span class="sm-hint">{{ t('claudeAuth.modes.extraHint') }}</span>
      </span>
      <span
        v-if="claudeAuthMode === 'extra'"
        class="sm-hint sm-hint-success"
      >{{ t('claudeAuth.status.signedIn') }}</span>
    </label>

    <label class="sm-choice">
      <input
        type="radio"
        name="claude-auth-mode"
        :checked="selected === 'apikey'"
        :disabled="busy"
        @change="onSelect('apikey')"
      >
      <span class="flex-1">{{ t('claudeAuth.modes.apikey') }}</span>
    </label>
    <div
      v-if="selected === 'apikey'"
      class="sm-field-row mb-3 pl-6"
    >
      <div class="sm-input sm-input-wide">
        <input
          v-model="apiKeyInput"
          type="password"
          autocomplete="new-password"
          spellcheck="false"
          placeholder="sk-ant-..."
          :aria-label="t('claudeAuth.modes.apikey')"
          :disabled="busy"
          @keydown.enter.prevent="saveApiKey"
        >
      </div>
      <SettingButton
        variant="primary"
        :disabled="busy || !apiKeyInput.trim()"
        @click="saveApiKey"
      >
        {{ t('common.save') }}
      </SettingButton>
    </div>

    <div class="sm-field-row mt-1">
      <SettingButton
        v-if="claudeAuthMode !== 'none'"
        variant="danger"
        :disabled="busy"
        @click="signOut"
      >
        <LogOut
          class="size-3.25"
          aria-hidden="true"
        />
        {{ claudeAuthMode === 'apikey' ? t('claudeAuth.clearKey') : t('claudeAuth.signOut') }}
      </SettingButton>
      <span
        v-if="busy"
        class="sm-hint"
        role="status"
      >{{ t('claudeAuth.working') }}</span>
    </div>

    <p
      v-if="claudeAuthError"
      class="sm-hint sm-hint-error mt-2"
      role="alert"
    >
      {{ claudeAuthError }}
    </p>
  </div>
</template>
