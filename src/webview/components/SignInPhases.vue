<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import SettingButton from '@/components/settings/controls/SettingButton.vue';

/** The browser and device-code phases of a sign-in flow core runs; the owner posts the requests its flow takes. */
const props = defineProps<{
  state: { phase: 'deviceCode'; userCode: string; verificationUri: string; expiresAt?: number } | { phase: 'browser' };
  /** The owner's copy acknowledgement: ok or not when `message` answers this flow's copy, else null. */
  copyAck: (message: ExtensionToWebviewMessage) => boolean | null;
}>();

const emit = defineEmits<{
  /** Core copies the code it holds and opens the page; the webview's clipboard is not granted in the desktop settings overlay. */
  (e: 'copyAndOpen'): void;
  /** The webview never opens a URL: core opens the page it holds for this flow. */
  (e: 'openPage'): void;
}>();

const COPIED_FEEDBACK_MS = 2000;

const { t } = useI18n();
const { onMessage } = usePlatformBridge();

const copyButton = ref<InstanceType<typeof SettingButton> | null>(null);

const copy = ref<'idle' | 'pending' | 'copied' | 'failed'>('idle');
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
function setCopy(next: typeof copy.value): void {
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  copiedTimer = next === 'copied' ? setTimeout(() => setCopy('idle'), COPIED_FEEDBACK_MS) : null;
  copy.value = next;
}
watch(() => props.state.phase, () => setCopy('idle'));

const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
function stopTicker(): void {
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
}
const expiresAt = computed(() => (props.state.phase === 'deviceCode' ? props.state.expiresAt : undefined));
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

function copyAndOpen(): void {
  if (props.state.phase !== 'deviceCode' || copy.value === 'pending') return;
  setCopy('pending');
  emit('copyAndOpen');
}

function handleCopyAck(message: ExtensionToWebviewMessage): void {
  if (copy.value !== 'pending') return;
  const ok = props.copyAck(message);
  if (ok !== null) setCopy(ok ? 'copied' : 'failed');
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

defineExpose({
  focusCopy: () => (copyButton.value?.$el as HTMLElement | undefined)?.focus(),
});
</script>

<template>
  <template v-if="state.phase === 'deviceCode'">
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
    v-else
    class="sm-field-row"
  >
    <SettingButton
      data-testid="provider-sign-in-open-again"
      @click="emit('openPage')"
    >
      {{ t('providerSignIn.browser.openAgain') }}
    </SettingButton>
  </div>
</template>
