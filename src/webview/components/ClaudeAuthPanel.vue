<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { usePlatformBridge } from "@/composables/usePlatformBridge";
import { LogOut } from "lucide-vue-next";
import SettingButton from "@/components/settings/controls/SettingButton.vue";

type Mode = "none" | "apikey" | "allowance" | "extra";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { claudeAuthMode, claudeAuthBusy, claudeAuthError, claudeSignInWaiting } = storeToRefs(settingsStore);
const { postMessage } = usePlatformBridge();

// The radio reflects the active mode and lets the user pick the one to set up; only a button starts a sign-in.
const selected = ref<Exclude<Mode, "none">>("allowance");
const apiKeyInput = ref("");
const pasting = ref(false);
const pasteInput = ref("");
const pasteField = ref<HTMLInputElement | null>(null);

watch(
  claudeAuthMode,
  (mode) => {
    if (mode !== "none") selected.value = mode;
  },
  { immediate: true },
);

watch(claudeSignInWaiting, (waiting) => {
  if (waiting) return;
  pasting.value = false;
  pasteInput.value = "";
});

const signedInSubscription = computed(() => claudeAuthMode.value === "allowance" || claudeAuthMode.value === "extra");
const busy = computed(() => claudeAuthBusy.value);
const needsSignIn = computed(() => selected.value !== "apikey" && !signedInSubscription.value);

function onSelect(mode: Exclude<Mode, "none">) {
  selected.value = mode;
  // The stored OAuth token serves both buckets, so switching between them needs no sign-in.
  if (busy.value || !signedInSubscription.value || mode === "apikey" || mode === claudeAuthMode.value) return;
  postMessage({ type: "claudeSetBilling", useAllowance: mode === "allowance" });
}

function signIn() {
  if (busy.value || !needsSignIn.value) return;
  postMessage({ type: "claudeSignIn", useAllowance: selected.value === "allowance" });
}

async function showPaste() {
  pasting.value = true;
  await nextTick();
  pasteField.value?.focus();
}

function submitPaste() {
  const input = pasteInput.value.trim();
  if (!input) return;
  postMessage({ type: "claudeSignInPaste", input });
  pasteInput.value = "";
}

function cancelSignIn() {
  postMessage({ type: "claudeSignInCancel" });
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

    <div
      v-if="claudeSignInWaiting"
      class="sm-field mt-1"
      data-testid="claude-sign-in-waiting"
    >
      <p
        class="sm-hint"
        role="status"
      >
        {{ t('claudeAuth.waiting') }}
      </p>
      <div class="sm-field-row">
        <template v-if="pasting">
          <div class="sm-input sm-input-wide">
            <input
              ref="pasteField"
              v-model="pasteInput"
              type="text"
              autocomplete="off"
              spellcheck="false"
              :placeholder="t('claudeAuth.pastePlaceholder')"
              :aria-label="t('claudeAuth.pasteLabel')"
              @keydown.enter.prevent="submitPaste"
            >
          </div>
          <SettingButton
            variant="primary"
            :disabled="!pasteInput.trim()"
            @click="submitPaste"
          >
            {{ t('claudeAuth.pasteSubmit') }}
          </SettingButton>
        </template>
        <SettingButton
          v-else
          @click="showPaste"
        >
          {{ t('claudeAuth.pasteInstead') }}
        </SettingButton>
        <SettingButton @click="cancelSignIn">
          {{ t('common.cancel') }}
        </SettingButton>
      </div>
    </div>

    <div
      v-else-if="needsSignIn"
      class="sm-field mt-1"
    >
      <div class="sm-field-row">
        <SettingButton
          variant="primary"
          :disabled="busy"
          data-testid="claude-sign-in"
          @click="signIn"
        >
          {{ t('claudeAuth.signIn') }}
        </SettingButton>
      </div>
      <p class="sm-hint">
        {{ t('claudeAuth.signInHint') }}
      </p>
    </div>

    <div
      v-if="!claudeSignInWaiting"
      class="sm-field-row mt-1"
    >
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
