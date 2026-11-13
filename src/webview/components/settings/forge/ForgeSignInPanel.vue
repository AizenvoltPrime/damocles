<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { ExternalLink, LoaderCircle, TriangleAlert } from 'lucide-vue-next';
import { FORGE_SIGN_IN_ROUTES, MAX_FORGE_TOKEN_CHARS, type ForgeAccountSummary, type ForgeServerSummary, type ForgeSignInRoute, type ForgeSignInState } from '@shared/forge/accounts';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useLocalizedText } from '@/composables/useLocalizedText';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { Button } from '@/components/ui/button';
import SignInPhases from '@/components/SignInPhases.vue';
import type { SegmentedOption } from '@/components/SegmentedToggle.vue';
import SettingButton from '../controls/SettingButton.vue';
import SettingSeg from '../controls/SettingSeg.vue';
import SettingSwitch from '../controls/SettingSwitch.vue';
import { isRunning } from './forge-sign-in';

const props = defineProps<{
  server: ForgeServerSummary;
  /** "Sign in again" / "Enter a new token": core replaces this account. */
  reauth?: ForgeAccountSummary | undefined;
}>();

const emit = defineEmits<{
  /** The user left the panel, cancelling the flow it started when flowCancelled; the row returns focus to its "Add account". */
  (e: 'close', flowCancelled: boolean): void;
}>();

const { t } = useI18n();
const { rt } = useLocalizedText();
const { postMessage } = usePlatformBridge();
const { forgeSignIns } = storeToRefs(useSettingsStore());

const IDLE: ForgeSignInState = { phase: 'idle' };
const state = computed<ForgeSignInState>(() => forgeSignIns.value[props.server.id] ?? IDLE);
const running = computed(() => isRunning(state.value));

const titleId = useId();
const routeHintId = useId();
const tokenId = useId();
const tokenErrorId = useId();
const tokenSwitchLabelId = useId();

const available = (route: ForgeSignInRoute): boolean => props.server.routes[route].reason === undefined;
const firstAvailable = FORGE_SIGN_IN_ROUTES.find(available) ?? 'token';
const route = ref<ForgeSignInRoute>(props.reauth !== undefined && available(props.reauth.route) ? props.reauth.route : firstAvailable);

const routeOptions = computed<SegmentedOption<ForgeSignInRoute>[]>(() => FORGE_SIGN_IN_ROUTES.map((value) => ({
  value,
  label: t(`settingsModal.forge.signIn.${value}`),
  ...(available(value) ? {} : { disabled: true, attrs: { 'aria-describedby': routeHintId } }),
})));

// One line per distinct reason, since both OAuth routes usually share the build-config reason.
const unavailableHints = computed(() => {
  const lines = new Map<string, string>();
  for (const value of FORGE_SIGN_IN_ROUTES) {
    const unavailable = props.server.routes[value].reason;
    if (unavailable === undefined) continue;
    const reason = rt(unavailable);
    const label = t(`settingsModal.forge.signIn.${value}`);
    const known = lines.get(reason);
    lines.set(reason, known === undefined ? label : `${known}, ${label}`);
  }
  return [...lines].map(([reason, routes]) => t('settingsModal.forge.signIn.unavailable', { route: routes, reason }));
});

// A panel opened on a flow already running (the view attached mid sign-in) owns that flow's outcome too, whatever its route.
const sent = ref(running.value);
const sentRoute = ref<ForgeSignInRoute | null>(null);
const pending = ref(false);

const announcement = computed(() => {
  const phase = state.value.phase;
  return phase === 'starting' || phase === 'browser' || phase === 'deviceCode' || phase === 'finishing' ? t(`settingsModal.forge.signIn.status.${phase}`) : '';
});
const error = computed(() => (sent.value && state.value.phase === 'idle' ? state.value.error ?? null : null));
// The error stays with the route that failed, so choosing another route never shows it there.
const routeError = computed(() => (error.value !== null && (sentRoute.value === null || sentRoute.value === route.value) ? error.value : null));

const token = ref('');
const tokenShells = ref(props.reauth?.agentShells ?? false);
const tokenEmpty = ref(false);
// Each refusal remounts the field's box, which replays its shake.
const refusals = ref(0);
const tokenRefusal = computed(() => (route.value === 'token' && routeError.value !== null ? rt(routeError.value.message) : tokenEmpty.value ? t('settingsModal.forge.signIn.tokenEmpty') : null));
watch(error, (next) => {
  if (next !== null) refusals.value += 1;
});

const tokenInput = ref<HTMLInputElement | null>(null);
const startButton = ref<InstanceType<typeof SettingButton> | null>(null);
const phases = ref<InstanceType<typeof SignInPhases> | null>(null);
const root = ref<HTMLElement | null>(null);

function focusIsOurs(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || root.value?.contains(active) === true;
}

// A start disables its control, so focus comes back once core answers: to a refused token's field, else to the start button.
watch(state, async (next, previous) => {
  pending.value = false;
  await nextTick();
  if (!focusIsOurs()) return;
  if (next.phase === 'deviceCode' && previous.phase !== 'deviceCode') phases.value?.focusCopy();
  else if (next.phase === 'idle' && (previous.phase !== 'idle' || next.error !== previous.error)) {
    if (route.value === 'token' && routeError.value !== null) tokenInput.value?.focus();
    else (startButton.value?.$el as HTMLElement | undefined)?.focus();
  }
});

/** Whether the request went out; a repeat while core has not answered is dropped. */
function start(chosen: ForgeSignInRoute, secret?: string): boolean {
  if (pending.value) return false;
  pending.value = true;
  sent.value = true;
  sentRoute.value = chosen;
  // "Agent shells may use this account": browser and device tokens expire, so agent shells may use them by default; a long-lived token is chosen at sign-in.
  // Sign in again keeps the account's own choice.
  postMessage({
    type: 'forgeSignIn',
    serverId: props.server.id,
    route: chosen,
    agentShells: chosen === 'token' ? tokenShells.value : props.reauth?.agentShells ?? true,
    ...(secret === undefined ? {} : { token: secret }),
    ...(props.reauth === undefined ? {} : { reauthAccountId: props.reauth.id }),
  });
  return true;
}

function submitToken(): void {
  const secret = token.value.trim();
  if (secret === '') {
    tokenEmpty.value = true;
    refusals.value += 1;
    tokenInput.value?.focus();
    return;
  }
  tokenEmpty.value = false;
  // The token lives only in this field until it is sent; the webview keeps no copy.
  if (start('token', secret)) token.value = '';
}

// Core starts the flow as it reads the request, so a cancel sent before its first state still finds the flow.
function cancel(): void {
  const flowCancelled = running.value || pending.value;
  if (flowCancelled) postMessage({ type: 'forgeSignInCancel', serverId: props.server.id });
  emit('close', flowCancelled);
}

// The webview never opens a URL: core opens the page it holds for this server and flow.
function openSignInPage(): void {
  postMessage({ type: 'forgeOpenPage', page: 'signIn', serverId: props.server.id });
}

function openTokenPage(): void {
  postMessage({ type: 'forgeOpenPage', page: 'token', serverId: props.server.id });
}

function copyAndOpen(): void {
  postMessage({ type: 'forgeSignInCopyCode', serverId: props.server.id });
  openSignInPage();
}

function copyAck(message: ExtensionToWebviewMessage): boolean | null {
  return message.type === 'forgeSignInCopyCodeAck' && message.serverId === props.server.id ? message.ok : null;
}

defineExpose({ cancel });
</script>

<template>
  <div
    ref="root"
    class="flex flex-col gap-2"
    role="group"
    :aria-labelledby="titleId"
    data-testid="forge-sign-in"
  >
    <span
      :id="titleId"
      class="sm-field-label"
    >{{ t('settingsModal.forge.signIn.title', { server: server.host }) }}</span>
    <template v-if="!running">
      <SettingSeg
        v-model="route"
        class="self-start"
        :options="routeOptions"
        :label="t('settingsModal.forge.signIn.method')"
        radios
      />
      <div
        v-if="unavailableHints.length > 0"
        :id="routeHintId"
        data-testid="forge-route-unavailable"
      >
        <p
          v-for="hint in unavailableHints"
          :key="hint"
          class="sm-hint"
        >
          {{ hint }}
        </p>
      </div>
    </template>
    <!-- while finishing, the line below shows the same words, so this one only speaks them -->
    <p
      class="sm-hint"
      :class="{ 'sr-only': state.phase === 'finishing' }"
      role="status"
      data-testid="forge-sign-in-status"
    >
      {{ announcement }}
    </p>

    <template v-if="state.phase === 'browser' || state.phase === 'deviceCode'">
      <p
        v-if="state.phase === 'browser'"
        class="sm-hint"
      >
        {{ t('settingsModal.forge.signIn.browserWaiting') }}
      </p>
      <SignInPhases
        ref="phases"
        :state="state"
        :copy-ack="copyAck"
        @copy-and-open="copyAndOpen"
        @open-page="openSignInPage"
      />
    </template>
    <p
      v-else-if="state.phase === 'finishing'"
      class="sm-hint flex items-center gap-1.5"
      aria-hidden="true"
      data-testid="forge-sign-in-checking"
    >
      <LoaderCircle class="size-3 d-spinning" />
      {{ t('settingsModal.forge.signIn.checking') }}
    </p>

    <template v-else-if="!running && route === 'browser'">
      <p class="sm-hint">
        {{ t('settingsModal.forge.signIn.browserHint', { server: server.host }) }}
      </p>
    </template>
    <template v-else-if="!running && route === 'device'">
      <p class="sm-hint">
        {{ t('settingsModal.forge.signIn.deviceHint') }}
      </p>
    </template>
    <template v-else-if="!running && route === 'token'">
      <p class="sm-hint">
        {{ t('settingsModal.forge.signIn.tokenHint') }}
      </p>
      <ul
        class="flex flex-wrap gap-1"
        :aria-label="t('settingsModal.forge.signIn.scopes')"
      >
        <li
          v-for="scope in server.tokenScopes"
          :key="scope"
          class="rounded-5 bg-(--d-accent-soft) px-1.5 font-mono text-11/4.5 text-(--d-accent-text)"
        >
          {{ scope }}
        </li>
      </ul>
      <Button
        type="button"
        variant="link"
        class="h-auto gap-1 self-start p-0 text-12 font-normal text-(--d-accent-text) [&_svg]:size-3"
        data-testid="forge-open-token-page"
        @click="openTokenPage"
      >
        {{ t('settingsModal.forge.signIn.openTokenPage') }}
        <ExternalLink aria-hidden="true" />
      </Button>
      <label
        :for="tokenId"
        class="sm-field-label"
      >{{ t('settingsModal.forge.signIn.tokenLabel') }}</label>
      <!-- a password field rather than SettingInput: the token is a one-shot secret, never a setting shown back -->
      <div
        :key="refusals"
        class="sm-input sm-input-wide"
        :class="{ 'd-shake': refusals > 0 && tokenRefusal !== null }"
        :data-invalid="tokenRefusal === null ? undefined : ''"
      >
        <input
          :id="tokenId"
          ref="tokenInput"
          v-model="token"
          type="password"
          autocomplete="off"
          spellcheck="false"
          :maxlength="MAX_FORGE_TOKEN_CHARS"
          :disabled="pending"
          :aria-invalid="tokenRefusal === null ? undefined : 'true'"
          :aria-describedby="tokenRefusal === null ? undefined : tokenErrorId"
          data-testid="forge-token-input"
          @input="tokenEmpty = false"
          @keydown.enter.prevent="submitToken"
        >
      </div>
      <p
        v-if="tokenRefusal !== null"
        :id="tokenErrorId"
        class="sm-hint sm-hint-error"
        role="alert"
        data-testid="forge-token-refusal"
      >
        {{ tokenRefusal }}
      </p>
      <label class="sm-field-row">
        <SettingSwitch
          v-model="tokenShells"
          :aria-labelledby="tokenSwitchLabelId"
        />
        <span
          :id="tokenSwitchLabelId"
          class="sm-field-label"
        >{{ t('settingsModal.forge.account.agentShells') }}</span>
      </label>
      <p class="flex items-start gap-1.5 text-11.5 text-(--d-warning-text)">
        <TriangleAlert
          class="mt-0.5 size-3 flex-none"
          aria-hidden="true"
        />
        <span>{{ t('settingsModal.forge.signIn.tokenAgentWarning') }}</span>
      </p>
    </template>

    <p
      v-if="routeError !== null && route !== 'token'"
      class="sm-hint sm-hint-error"
      role="alert"
      data-testid="forge-sign-in-error"
    >
      {{ rt(routeError.message) }}
    </p>

    <div class="sm-field-row">
      <SettingButton
        v-if="!running && route === 'browser'"
        ref="startButton"
        variant="primary"
        :disabled="pending"
        @click="start('browser')"
      >
        {{ t('settingsModal.forge.signIn.browserStart') }}
      </SettingButton>
      <SettingButton
        v-else-if="!running && route === 'device'"
        ref="startButton"
        variant="primary"
        :disabled="pending"
        @click="start('device')"
      >
        {{ t('settingsModal.forge.signIn.deviceStart') }}
      </SettingButton>
      <SettingButton
        v-else-if="!running && route === 'token'"
        ref="startButton"
        variant="primary"
        :disabled="pending"
        @click="submitToken"
      >
        {{ t('settingsModal.forge.signIn.submit') }}
      </SettingButton>
      <SettingButton
        data-testid="forge-sign-in-cancel"
        @click="cancel"
      >
        {{ t('common.cancel') }}
      </SettingButton>
    </div>
  </div>
</template>
