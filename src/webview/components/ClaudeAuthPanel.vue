<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useVSCode } from "@/composables/useVSCode";
import { IconCircleGreen, IconCircleRed } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogOut } from "lucide-vue-next";

type Mode = "none" | "apikey" | "allowance" | "extra";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { claudeAuthMode, claudeAuthBusy, claudeAuthError } = storeToRefs(settingsStore);
const { postMessage } = useVSCode();

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

const modeLabel = computed(() => {
  switch (claudeAuthMode.value) {
    case "apikey": return t("claudeAuth.status.apikey");
    case "allowance": return t("claudeAuth.status.allowance");
    case "extra": return t("claudeAuth.status.extra");
    default: return t("claudeAuth.status.none");
  }
});

onMounted(() => {
  postMessage({ type: "getClaudeAuthStatus" });
});
</script>

<template>
  <section class="mb-6">
    <div class="flex items-center gap-1.5 mb-3">
      <h3 class="text-sm font-semibold text-foreground uppercase tracking-wide">
        {{ t('claudeAuth.sectionTitle') }}
      </h3>
      <span class="flex items-center gap-1 text-xs">
        <IconCircleGreen
          v-if="claudeAuthMode !== 'none'"
          :size="8"
        />
        <IconCircleRed
          v-else
          :size="8"
        />
        <span class="text-muted-foreground">{{ modeLabel }}</span>
      </span>
    </div>

    <!-- API key -->
    <label class="flex items-center gap-2 mb-2 cursor-pointer">
      <input
        type="radio"
        :checked="selected === 'apikey'"
        :disabled="busy"
        @change="onSelect('apikey')"
      >
      <span class="text-xs text-foreground w-28 shrink-0">{{ t('claudeAuth.modes.apikey') }}</span>
      <Input
        v-model="apiKeyInput"
        type="password"
        placeholder="sk-ant-..."
        class="bg-input border-border placeholder:text-muted-foreground h-7 text-xs flex-1"
        :disabled="busy || selected !== 'apikey'"
        @keydown.enter="saveApiKey"
      />
      <Button
        size="sm"
        class="h-7"
        :disabled="busy || selected !== 'apikey' || !apiKeyInput.trim()"
        @click="saveApiKey"
      >
        {{ t('common.save') }}
      </Button>
    </label>

    <!-- Subscription · allowance -->
    <label class="flex items-center gap-2 mb-2 cursor-pointer">
      <input
        type="radio"
        :checked="selected === 'allowance'"
        :disabled="busy"
        @change="onSelect('allowance')"
      >
      <span class="text-xs text-foreground flex-1">
        {{ t('claudeAuth.modes.allowance') }}
        <span class="text-muted-foreground">{{ t('claudeAuth.modes.allowanceHint') }}</span>
      </span>
      <span
        v-if="claudeAuthMode === 'allowance'"
        class="text-xs text-emerald-500"
      >{{ t('claudeAuth.status.signedIn') }}</span>
    </label>

    <!-- Subscription · extra usage -->
    <label class="flex items-center gap-2 mb-3 cursor-pointer">
      <input
        type="radio"
        :checked="selected === 'extra'"
        :disabled="busy"
        @change="onSelect('extra')"
      >
      <span class="text-xs text-foreground flex-1">
        {{ t('claudeAuth.modes.extra') }}
        <span class="text-muted-foreground">{{ t('claudeAuth.modes.extraHint') }}</span>
      </span>
      <span
        v-if="claudeAuthMode === 'extra'"
        class="text-xs text-emerald-500"
      >{{ t('claudeAuth.status.signedIn') }}</span>
    </label>

    <div class="flex items-center gap-2">
      <Button
        v-if="claudeAuthMode !== 'none'"
        variant="outline"
        size="sm"
        class="h-7 text-destructive border-destructive/40 hover:bg-destructive/10"
        :disabled="busy"
        @click="signOut"
      >
        <LogOut class="h-3.5 w-3.5 mr-1.5" />
        {{ claudeAuthMode === 'apikey' ? t('claudeAuth.clearKey') : t('claudeAuth.signOut') }}
      </Button>
      <span
        v-if="busy"
        class="text-xs text-muted-foreground"
      >{{ t('claudeAuth.working') }}</span>
    </div>

    <p
      v-if="claudeAuthError"
      class="text-xs text-destructive mt-2"
    >
      {{ claudeAuthError }}
    </p>
  </section>
</template>
