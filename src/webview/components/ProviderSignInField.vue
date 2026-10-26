<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { LogOut } from 'lucide-vue-next';
import type { SignInProviderId } from '@shared/settings-sections';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';
import type { ProviderSignInState } from '@shared/types/settings';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import SettingInput, { type InputParse } from '@/components/settings/controls/SettingInput.vue';

// Strings specific to a provider live under `<provider>.signIn`; the flow's own strings under `providerSignIn`.
const props = defineProps<{ provider: SignInProviderId }>();

const COPIED_FEEDBACK_MS = 2000;

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { providerSignInState, keyProviderStatus } = storeToRefs(settingsStore);
const { postMessage, onMessage } = usePlatformBridge();

const state = computed<ProviderSignInState>(() => providerSignInState.value[props.provider]);
const status = computed(() => keyProviderStatus.value[props.provider]);
const signedIn = computed(() => status.value.signedIn);
const tk = (key: string): string => t(`${props.provider}.signIn.${key}`);

const root = ref<HTMLElement | null>(null);
const signInButton = ref<InstanceType<typeof SettingButton> | null>(null);
const copyButton = ref<InstanceType<typeof SettingButton> | null>(null);
const answerField = ref<HTMLElement | null>(null);
const answerInput = ref<{ submit: () => void } | null>(null);
const answerId = useId();

// The account row's status announces the credential, so this region narrates only a running flow.
const announcement = computed(() => {
  const current = state.value;
  if (current.phase === 'idle') return '';
  return t(`providerSignIn.status.${current.phase === 'prompt' ? current.prompt : current.phase}`);
});

const error = computed(() => (state.value.phase === 'idle' ? state.value.error ?? null : null));
const cancellable = computed(() => state.value.phase !== 'idle' && state.value.phase !== 'finishing');
const answerShown = computed(() => state.value.phase === 'prompt' || (state.value.phase === 'browser' && state.value.paste));
const answerRefusal = computed(() => {
  const current = state.value;
  if ((current.phase !== 'prompt' && current.phase !== 'browser') || current.invalid !== true) return null;
  return t(current.phase === 'prompt' ? 'providerSignIn.enterpriseDomain.invalid' : 'providerSignIn.paste.invalid');
});

// Every request below makes core post this provider's state or status again; until then a repeat would only be dropped.
const pending = ref(false);
watch([state, status], () => {
  pending.value = false;
});

const copy = ref<'idle' | 'pending' | 'copied' | 'failed'>('idle');
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
function setCopy(next: typeof copy.value): void {
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  copiedTimer = next === 'copied' ? setTimeout(() => setCopy('idle'), COPIED_FEEDBACK_MS) : null;
  copy.value = next;
}

const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
function stopTicker(): void {
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
}
const expiresAt = computed(() => (state.value.phase === 'deviceCode' ? state.value.expiresAt : undefined));
watch(expiresAt, (at) => {
  stopTicker();
  if (at === undefined) return;
  now.value = Date.now();
  if (now.value >= at) return;
  ticker = setInterval(() => {
    now.value = Date.now();
    if (now.value >= at) stopTicker();
  }, 1000);
}, { immediate: true });

const countdown = computed(() => {
  if (expiresAt.value === undefined) return null;
  const seconds = Math.max(0, Math.ceil((expiresAt.value - now.value) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
});

// Focus moves only while it is in this field or was lost with an element the phase change removed.
function focusIsOurs(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || root.value?.contains(active) === true;
}

// The answer field also appears within a phase: OpenRouter's browser phase gains its paste field after it began.
watch([() => state.value.phase, answerShown], async ([phase, shown], [previous]) => {
  if (phase !== previous) setCopy('idle');
  await nextTick();
  if (!focusIsOurs()) return;
  if (phase === 'deviceCode') (copyButton.value?.$el as HTMLElement | undefined)?.focus();
  else if (shown) answerField.value?.querySelector('input')?.focus();
  else if (phase === 'idle' && previous !== 'idle') (signInButton.value?.$el as HTMLElement | undefined)?.focus();
});

function request(message: WebviewToExtensionMessage): void {
  if (pending.value) return;
  pending.value = true;
  postMessage(message);
}

function signIn(): void {
  request({ type: 'providerSignIn', provider: props.provider });
}

function cancel(): void {
  request({ type: 'providerSignInCancel', provider: props.provider });
}

function signOut(): void {
  request({ type: 'providerSignOut', provider: props.provider });
}

// The webview never opens a URL: core opens the page it holds for this flow.
function openPage(): void {
  postMessage({ type: 'providerSignInOpenPage', provider: props.provider });
}

// Core copies the code it holds; the webview's clipboard is not granted in the desktop settings overlay.
function copyAndOpen(): void {
  if (state.value.phase !== 'deviceCode' || copy.value === 'pending') return;
  setCopy('pending');
  postMessage({ type: 'providerSignInCopyCode', provider: props.provider });
  openPage();
}

function handleCopyAck(message: ExtensionToWebviewMessage): void {
  if (message.type !== 'providerSignInCopyCodeAck' || message.provider !== props.provider || copy.value !== 'pending') return;
  setCopy(message.ok ? 'copied' : 'failed');
}

let stopAcks: (() => void) | null = null;
onMounted(() => {
  stopAcks = onMessage(handleCopyAck);
});
onUnmounted(() => {
  stopAcks?.();
  stopTicker();
  if (copiedTimer !== null) clearTimeout(copiedTimer);
});

const parsePaste: InputParse<string> = (raw) => {
  const input = raw.trim();
  return input ? { ok: true, value: input } : { ok: false, error: t('providerSignIn.answerEmpty') };
};

// Blank means github.com.
const parseDomain: InputParse<string> = (raw) => ({ ok: true, value: raw.trim() });

function answer(input: string): void {
  request({ type: 'providerSignInAnswer', provider: props.provider, input });
}
</script>

<template>
  <div
    ref="root"
    class="sm-field"
    data-testid="provider-sign-in"
  >
    <div class="sm-field-label">
      {{ t('providerAuth.signIn.label') }}
      <span
        v-if="state.phase === 'idle' && signedIn && !error"
        class="sm-hint"
        data-testid="provider-sign-in-signed-in"
      >{{ t('providerAuth.signIn.signedIn') }}</span>
    </div>
    <p
      class="sm-hint"
      role="status"
      data-testid="provider-sign-in-status"
    >
      {{ announcement }}
    </p>

    <template v-if="state.phase === 'idle'">
      <div class="sm-field-row">
        <SettingButton
          ref="signInButton"
          variant="primary"
          :disabled="pending"
          data-testid="provider-sign-in-start"
          @click="signIn"
        >
          {{ tk('button') }}
        </SettingButton>
        <SettingButton
          v-if="signedIn"
          variant="danger"
          :disabled="pending"
          data-testid="provider-sign-out"
          @click="signOut"
        >
          <LogOut
            class="size-3.25"
            aria-hidden="true"
          />
          {{ t('providerSignIn.signOut') }}
        </SettingButton>
      </div>
      <p class="sm-hint">
        {{ tk('hint') }}
      </p>
    </template>

    <template v-else-if="state.phase === 'deviceCode'">
      <p class="sm-hint">
        {{ t('providerSignIn.deviceCode.codeLabel') }}
        <code
          class="font-mono text-sm text-(--d-text) select-all"
          data-testid="provider-sign-in-code"
        >{{ state.userCode }}</code>
      </p>
      <p class="sm-hint break-all">
        {{ t('providerSignIn.deviceCode.page', { uri: state.verificationUri }) }}
      </p>
      <div class="sm-field-row">
        <SettingButton
          ref="copyButton"
          variant="primary"
          :disabled="copy === 'pending'"
          data-testid="provider-sign-in-copy"
          @click="copyAndOpen"
        >
          {{ t('providerSignIn.deviceCode.copyAndOpen') }}
        </SettingButton>
        <span
          v-if="copy === 'copied'"
          class="sm-hint sm-hint-success"
          role="status"
        >{{ t('providerSignIn.deviceCode.copied') }}</span>
      </div>
      <p
        v-if="copy === 'failed'"
        class="sm-hint sm-hint-error"
        role="alert"
      >
        {{ t('providerSignIn.deviceCode.copyFailed') }}
      </p>
      <p
        v-if="countdown !== null"
        class="sm-hint"
        data-testid="provider-sign-in-countdown"
      >
        {{ t('providerSignIn.deviceCode.expiresIn', { time: countdown }) }}
      </p>
    </template>

    <div
      v-if="state.phase === 'browser'"
      class="sm-field-row"
    >
      <SettingButton
        data-testid="provider-sign-in-open-again"
        @click="openPage"
      >
        {{ t('providerSignIn.browser.openAgain') }}
      </SettingButton>
    </div>

    <div
      v-if="answerShown"
      ref="answerField"
      class="sm-field-row"
    >
      <label
        :for="answerId"
        class="sm-hint w-full"
        data-testid="provider-sign-in-answer-label"
      >{{ state.phase === 'prompt' ? t('providerSignIn.enterpriseDomain.label') : t('providerSignIn.paste.label') }}</label>
      <!-- an answer is sent only on an explicit submit: a blur, the window's included, would send a half-typed one -->
      <SettingInput
        ref="answerInput"
        model-value=""
        :input-id="answerId"
        :parse="state.phase === 'prompt' ? parseDomain : parsePaste"
        :label="state.phase === 'prompt' ? t('providerSignIn.enterpriseDomain.label') : t('providerSignIn.paste.label')"
        :placeholder="state.phase === 'prompt' ? t('providerSignIn.enterpriseDomain.placeholder') : undefined"
        :commit-on-blur="false"
        :disabled="pending"
        :refusal="answerRefusal"
        wide
        @commit="answer"
      />
      <SettingButton
        variant="primary"
        :disabled="pending"
        data-testid="provider-sign-in-submit"
        @click="answerInput?.submit()"
      >
        {{ t('providerSignIn.answerSubmit') }}
      </SettingButton>
      <SettingButton
        v-if="state.phase === 'prompt'"
        :disabled="pending"
        data-testid="provider-sign-in-skip"
        @click="answer('')"
      >
        {{ t('providerSignIn.enterpriseDomain.skip') }}
      </SettingButton>
    </div>
    <div
      v-if="cancellable"
      class="sm-field-row"
    >
      <SettingButton
        :disabled="pending"
        data-testid="provider-sign-in-cancel"
        @click="cancel"
      >
        {{ t('common.cancel') }}
      </SettingButton>
    </div>

    <p
      v-if="error"
      class="sm-hint sm-hint-error"
      role="alert"
      data-testid="provider-sign-in-error"
    >
      {{ error.message }}
    </p>
  </div>
</template>
