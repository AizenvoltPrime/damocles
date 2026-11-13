<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Copy, Trash2 } from 'lucide-vue-next';
import { MAX_FORGE_FIELD_CHARS, type ForgeKind, type ForgeServerFormField, type ForgeServerSummary } from '@shared/forge/accounts';
import type { LocalizedText } from '@shared/localized-text';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useLocalizedText } from '@/composables/useLocalizedText';
import { useOpenerFocus } from '@/composables/useOpenerFocus';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import ConfirmDialogLayout from '@/components/ConfirmDialogLayout.vue';
import type { SegmentedOption } from '@/components/SegmentedToggle.vue';
import SettingButton from '../controls/SettingButton.vue';
import SettingSeg from '../controls/SettingSeg.vue';

export type ServerFormOutcome = { kind: 'added' | 'saved' | 'removed'; serverId: string; host: string };

const props = defineProps<{
  /** The server being edited; absent: the form adds one. */
  server?: ForgeServerSummary | undefined;
  /** The redirect URI a new server of each kind would use. */
  redirectUris: Record<ForgeKind, string>;
  /** The server's accounts, which removing it signs out. */
  accountCount: number;
}>();

const emit = defineEmits<{
  (e: 'close', outcome?: ServerFormOutcome): void;
  /** Core removes the row, this form with it, before it answers; the group takes the success. */
  (e: 'removing', requestId: string): void;
}>();

const COPIED_FEEDBACK_MS = 2000;

const { t } = useI18n();
const { rt } = useLocalizedText();
const { postMessage, onMessage } = usePlatformBridge();

const editing = computed(() => props.server !== undefined);

type TextField = Exclude<ForgeServerFormField, 'kind'>;
const fieldIds = (): { input: string; hint: string; error: string } => ({ input: useId(), hint: useId(), error: useId() });
const ids: Record<TextField, { input: string; hint: string; error: string }> = { url: fieldIds(), clientId: fieldIds(), clientSecret: fieldIds(), gitHosts: fieldIds() };
const kindErrorId = useId();
const pendingTitleId = useId();
const pendingHintId = useId();

const url = ref(props.server?.baseUrl ?? '');
const kind = ref<ForgeKind>(props.server?.kind ?? 'gitlab');
const clientId = ref(props.server?.oauthClientId ?? '');
const clientSecret = ref('');
// The web host is the server's own git host; the field holds only the others.
const webHost = props.server === undefined ? undefined : new URL(props.server.baseUrl).host;
const gitHosts = ref((props.server?.gitHosts ?? []).filter((host) => host !== webHost).join(', '));

const kindOptions = computed<SegmentedOption<ForgeKind>[]>(() => [
  { value: 'gitlab', label: t('settingsModal.forge.serverForm.kindGitlab'), ...(editing.value ? { disabled: true } : {}) },
  { value: 'github', label: t('settingsModal.forge.serverForm.kindGithub'), ...(editing.value ? { disabled: true } : {}) },
]);
// A GitHub OAuth app (GHES or a ghe.com tenant) needs its secret for the browser route's code exchange; GitLab apps are public clients.
const secretShown = computed(() => kind.value === 'github');
const redirectUri = computed(() => props.server?.redirectUri ?? props.redirectUris[kind.value]);

const fields: Record<TextField, Ref<HTMLInputElement | null>> = {
  url: ref<HTMLInputElement | null>(null),
  clientId: ref<HTMLInputElement | null>(null),
  clientSecret: ref<HTMLInputElement | null>(null),
  gitHosts: ref<HTMLInputElement | null>(null),
};

const pending = ref<{ requestId: string; remove: boolean; secretSent: boolean } | null>(null);
// A refused save names its field, the URL when core names none; a refused removal belongs to the form.
const refusal = ref<{ at: ForgeServerFormField | 'remove'; message: LocalizedText; seq: number } | null>(null);
const invalid = (at: ForgeServerFormField | 'remove'): boolean => refusal.value?.at === at;
// Each refusal of a field remounts its box, which replays the shake.
const boxKey = (at: TextField): number => (invalid(at) ? refusal.value!.seq : 0);
const describedBy = (at: TextField): string => (invalid(at) ? ids[at].error : ids[at].hint);
// A refused save cleared the secret it sent, so its field asks for it again.
const secretCleared = ref(false);
const removing = ref(false);

const newRequestId = (): string => `forge-server-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const listedHosts = (): string[] => gitHosts.value.split(/[\s,]+/).filter((host) => host !== '');

function submit(): void {
  if (pending.value !== null) return;
  const requestId = newRequestId();
  const id = clientId.value.trim();
  const secret = secretShown.value ? clientSecret.value.trim() : '';
  pending.value = { requestId, remove: false, secretSent: secret !== '' };
  const oauth = { ...(id === '' ? {} : { clientId: id }), ...(secret === '' ? {} : { clientSecret: secret }) };
  if (props.server === undefined) postMessage({ type: 'forgeAddServer', requestId, url: url.value.trim(), kind: kind.value, gitHosts: listedHosts(), ...oauth });
  else postMessage({ type: 'forgeEditServer', requestId, serverId: props.server.id, gitHosts: listedHosts(), ...oauth });
  // The secret is sent once; core keeps it in the secret store and never sends it back.
  clientSecret.value = '';
}

function confirmRemove(): void {
  removing.value = false;
  if (props.server === undefined || pending.value !== null) return;
  const requestId = newRequestId();
  pending.value = { requestId, remove: true, secretSent: false };
  emit('removing', requestId);
  postMessage({ type: 'forgeRemoveServer', requestId, serverId: props.server.id });
}

async function handleResult(message: Extract<ExtensionToWebviewMessage, { type: 'forgeServerFormResult' }>): Promise<void> {
  if (message.requestId !== pending.value?.requestId) return;
  const { remove, secretSent } = pending.value;
  pending.value = null;
  if (message.ok) {
    if (!remove) emit('close', { kind: editing.value ? 'saved' : 'added', serverId: message.serverId, host: props.server?.host ?? message.serverId });
    return;
  }
  const at = remove ? 'remove' : message.field ?? 'url';
  refusal.value = { at, message: message.message, seq: (refusal.value?.seq ?? 0) + 1 };
  secretCleared.value = secretSent;
  await nextTick();
  if (at !== 'remove' && at !== 'kind') fields[at].value?.focus();
}

// Hosts learned from the server's clone addresses: each waits for Confirm or Dismiss, answered on its own.
const pendingHosts = computed(() => props.server?.pendingGitHosts ?? []);
const hostRequests = ref<ReadonlyMap<string, { requestId: string; action: 'confirm' | 'dismiss' }>>(new Map());
const hostErrors = ref<ReadonlyMap<string, LocalizedText>>(new Map());
const hostOutcome = ref<{ host: string; action: 'confirm' | 'dismiss' } | null>(null);
const hostOutcomeText = computed(() => {
  const outcome = hostOutcome.value;
  if (outcome === null) return '';
  return t(outcome.action === 'confirm' ? 'settingsModal.forge.serverForm.hostConfirmed' : 'settingsModal.forge.serverForm.hostDismissed', { host: outcome.host });
});
const hostList = ref<HTMLElement | null>(null);
const hostErrorId = (index: number): string => `${pendingHintId}-error-${index}`;

function answerHost(host: string, action: 'confirm' | 'dismiss'): void {
  if (props.server === undefined || hostRequests.value.has(host)) return;
  const requestId = newRequestId();
  hostRequests.value = new Map(hostRequests.value).set(host, { requestId, action });
  const errors = new Map(hostErrors.value);
  errors.delete(host);
  hostErrors.value = errors;
  hostOutcome.value = null;
  postMessage({ type: action === 'confirm' ? 'forgeConfirmGitHost' : 'forgeDismissGitHost', requestId, serverId: props.server.id, host });
}

async function handleHostResult(message: Extract<ExtensionToWebviewMessage, { type: 'forgeServerFormResult' }>): Promise<void> {
  const entry = [...hostRequests.value].find(([, request]) => request.requestId === message.requestId);
  if (entry === undefined) return;
  const [host, { action }] = entry;
  const requests = new Map(hostRequests.value);
  requests.delete(host);
  hostRequests.value = requests;
  if (!message.ok) {
    hostErrors.value = new Map(hostErrors.value).set(host, message.message);
    return;
  }
  // A confirmed host is one of the server's git hosts now, so a later Save must send it too.
  if (action === 'confirm' && !listedHosts().includes(host)) gitHosts.value = [...listedHosts(), host].join(', ');
  hostOutcome.value = { host, action };
  // Core published the list without the host before it answered, so its buttons are gone: focus moves to the next host, else to the field.
  await nextTick();
  const next = hostList.value?.querySelector<HTMLElement>('[data-host-action="confirm"]:not(:disabled)');
  (next ?? fields.gitHosts.value)?.focus();
}

function askRemove(): void {
  removing.value = true;
}
function cancelRemove(): void {
  removing.value = false;
}
const returnFocus = useOpenerFocus(() => removing.value);

const copy = ref<{ requestId: string; state: 'pending' | 'copied' | 'failed' } | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

// Core copies the URI it holds; the desktop settings overlay grants the webview no clipboard.
function copyRedirectUri(): void {
  if (copy.value?.state === 'pending') return;
  const requestId = newRequestId();
  copy.value = { requestId, state: 'pending' };
  postMessage({ type: 'forgeCopyRedirectUri', requestId, kind: kind.value, ...(props.server === undefined ? {} : { serverId: props.server.id }) });
}

function handleCopyAck(message: ExtensionToWebviewMessage): void {
  if (message.type !== 'forgeCopyRedirectUriAck' || message.requestId !== copy.value?.requestId) return;
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  copy.value = { requestId: message.requestId, state: message.ok ? 'copied' : 'failed' };
  copiedTimer = message.ok ? setTimeout(() => (copy.value = null), COPIED_FEEDBACK_MS) : null;
}

let stopListening: (() => void) | null = null;
onMounted(() => {
  const stops = [
    onMessage((message) => {
      if (message.type !== 'forgeServerFormResult') return;
      void handleResult(message);
      void handleHostResult(message);
    }),
    onMessage(handleCopyAck),
  ];
  stopListening = () => stops.forEach((stop) => stop());
  if (!editing.value) fields.url.value?.focus();
});
onUnmounted(() => {
  stopListening?.();
  if (copiedTimer !== null) clearTimeout(copiedTimer);
});

const steps = computed(() => (kind.value === 'gitlab'
  ? { intro: 'settingsModal.forge.serverForm.stepsGitlab', list: 'settingsModal.forge.serverForm.stepsGitlabList', count: 5 }
  : { intro: 'settingsModal.forge.serverForm.stepsGithub', list: 'settingsModal.forge.serverForm.stepsGithubList', count: 3 }));
</script>

<template>
  <form
    class="flex flex-col gap-3"
    novalidate
    data-testid="forge-server-form"
    @submit.prevent="submit"
  >
    <div class="sm-field">
      <label
        :for="ids.url.input"
        class="sm-field-label"
      >{{ t('settingsModal.forge.serverForm.url') }}</label>
      <!-- form fields rather than SettingInput: the form sends them together on submit, never one by one -->
      <div
        :key="boxKey('url')"
        class="sm-input sm-input-wide"
        :class="{ 'd-shake': invalid('url') }"
        :data-invalid="invalid('url') ? '' : undefined"
      >
        <input
          :id="ids.url.input"
          :ref="fields.url"
          v-model="url"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="https://gitlab.example.com"
          :maxlength="MAX_FORGE_FIELD_CHARS"
          :disabled="editing"
          :aria-invalid="invalid('url') ? 'true' : undefined"
          :aria-describedby="describedBy('url')"
          @keydown.enter.prevent="submit"
        >
      </div>
      <p
        v-if="invalid('url')"
        :id="ids.url.error"
        class="sm-hint sm-hint-error"
        role="alert"
        data-testid="forge-server-refusal"
      >
        {{ rt(refusal!.message) }}
      </p>
      <p
        v-else
        :id="ids.url.hint"
        class="sm-hint"
      >
        {{ t('settingsModal.forge.serverForm.urlHint') }}
      </p>
    </div>

    <div class="sm-field">
      <span class="sm-field-label">{{ t('settingsModal.forge.serverForm.kind') }}</span>
      <SettingSeg
        v-model="kind"
        class="self-start"
        :options="kindOptions"
        :label="t('settingsModal.forge.serverForm.kind')"
        :aria-describedby="invalid('kind') ? kindErrorId : undefined"
        radios
      />
      <p
        v-if="invalid('kind')"
        :id="kindErrorId"
        class="sm-hint sm-hint-error"
        role="alert"
        data-testid="forge-server-refusal"
      >
        {{ rt(refusal!.message) }}
      </p>
    </div>

    <div class="sm-field">
      <label
        :for="ids.clientId.input"
        class="sm-field-label"
      >{{ t('settingsModal.forge.serverForm.clientId') }}</label>
      <div
        :key="boxKey('clientId')"
        class="sm-input sm-input-wide"
        :class="{ 'd-shake': invalid('clientId') }"
        :data-invalid="invalid('clientId') ? '' : undefined"
      >
        <input
          :id="ids.clientId.input"
          :ref="fields.clientId"
          v-model="clientId"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :maxlength="MAX_FORGE_FIELD_CHARS"
          :aria-invalid="invalid('clientId') ? 'true' : undefined"
          :aria-describedby="describedBy('clientId')"
          @keydown.enter.prevent="submit"
        >
      </div>
      <p
        v-if="invalid('clientId')"
        :id="ids.clientId.error"
        class="sm-hint sm-hint-error"
        role="alert"
        data-testid="forge-server-refusal"
      >
        {{ rt(refusal!.message) }}
      </p>
      <p
        v-else
        :id="ids.clientId.hint"
        class="sm-hint"
      >
        {{ t('settingsModal.forge.serverForm.clientIdHint') }}
      </p>
    </div>

    <div
      v-if="secretShown"
      class="sm-field"
    >
      <label
        :for="ids.clientSecret.input"
        class="sm-field-label"
      >{{ t('settingsModal.forge.serverForm.clientSecret') }}</label>
      <div
        :key="boxKey('clientSecret')"
        class="sm-input sm-input-wide"
        :class="{ 'd-shake': invalid('clientSecret') }"
        :data-invalid="invalid('clientSecret') ? '' : undefined"
      >
        <input
          :id="ids.clientSecret.input"
          :ref="fields.clientSecret"
          v-model="clientSecret"
          type="password"
          autocomplete="off"
          spellcheck="false"
          :maxlength="MAX_FORGE_FIELD_CHARS"
          :aria-invalid="invalid('clientSecret') ? 'true' : undefined"
          :aria-describedby="describedBy('clientSecret')"
          @input="secretCleared = false"
          @keydown.enter.prevent="submit"
        >
      </div>
      <p
        v-if="invalid('clientSecret')"
        :id="ids.clientSecret.error"
        class="sm-hint sm-hint-error"
        role="alert"
        data-testid="forge-server-refusal"
      >
        {{ rt(refusal!.message) }}
      </p>
      <p
        v-else
        :id="ids.clientSecret.hint"
        class="sm-hint"
        data-testid="forge-client-secret-hint"
      >
        {{ secretCleared
          ? t('settingsModal.forge.serverForm.clientSecretAgain')
          : server?.hasClientSecret ? t('settingsModal.forge.serverForm.clientSecretKept') : t('settingsModal.forge.serverForm.clientSecretHint') }}
      </p>
    </div>

    <div class="sm-field">
      <label
        :for="ids.gitHosts.input"
        class="sm-field-label"
      >{{ t('settingsModal.forge.serverForm.gitHosts') }}</label>
      <div
        :key="boxKey('gitHosts')"
        class="sm-input sm-input-wide"
        :class="{ 'd-shake': invalid('gitHosts') }"
        :data-invalid="invalid('gitHosts') ? '' : undefined"
      >
        <input
          :id="ids.gitHosts.input"
          :ref="fields.gitHosts"
          v-model="gitHosts"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="git.example.com"
          :aria-invalid="invalid('gitHosts') ? 'true' : undefined"
          :aria-describedby="describedBy('gitHosts')"
          @keydown.enter.prevent="submit"
        >
      </div>
      <p
        v-if="invalid('gitHosts')"
        :id="ids.gitHosts.error"
        class="sm-hint sm-hint-error"
        role="alert"
        data-testid="forge-server-refusal"
      >
        {{ rt(refusal!.message) }}
      </p>
      <p
        v-else
        :id="ids.gitHosts.hint"
        class="sm-hint"
      >
        {{ t('settingsModal.forge.serverForm.gitHostsHint') }}
      </p>
      <p
        v-if="editing"
        class="sm-hint sm-hint-success"
        role="status"
        data-testid="forge-pending-host-outcome"
      >
        {{ hostOutcomeText }}
      </p>
    </div>

    <div
      v-if="pendingHosts.length > 0"
      class="sm-field d-arrive"
      data-testid="forge-pending-hosts"
    >
      <span
        :id="pendingTitleId"
        class="sm-field-label"
      >{{ t('settingsModal.forge.serverForm.pendingTitle') }}</span>
      <p
        :id="pendingHintId"
        class="sm-hint"
      >
        {{ t('settingsModal.forge.serverForm.pendingHint') }}
      </p>
      <div ref="hostList">
        <TransitionGroup
          tag="ul"
          class="relative flex flex-col gap-1.5"
          :aria-labelledby="pendingTitleId"
          :aria-describedby="pendingHintId"
          enter-active-class="t-tuck-enter-active"
          leave-active-class="t-row-leave-active"
          move-class="t-row-move"
        >
          <li
            v-for="(host, index) in pendingHosts"
            :key="host"
            class="flex flex-wrap items-center gap-2 rounded-7 border border-(--d-border) bg-(--d-bg) py-1.5 ps-2.5 pe-1.5"
            :aria-busy="hostRequests.has(host) ? 'true' : undefined"
            :data-testid="`forge-pending-host-${host}`"
          >
            <code class="min-w-0 flex-1 font-mono text-12 wrap-anywhere">{{ host }}</code>
            <SettingButton
              variant="primary"
              data-host-action="confirm"
              :disabled="hostRequests.has(host)"
              :aria-label="t('settingsModal.forge.serverForm.confirmHostLabel', { host })"
              :aria-describedby="hostErrors.has(host) ? hostErrorId(index) : undefined"
              @click="answerHost(host, 'confirm')"
            >
              <Check
                class="size-3"
                aria-hidden="true"
              />
              {{ t('settingsModal.forge.serverForm.confirmHost') }}
            </SettingButton>
            <SettingButton
              :disabled="hostRequests.has(host)"
              :aria-label="t('settingsModal.forge.serverForm.dismissHostLabel', { host })"
              @click="answerHost(host, 'dismiss')"
            >
              {{ t('settingsModal.forge.serverForm.dismissHost') }}
            </SettingButton>
            <p
              v-if="hostErrors.has(host)"
              :id="hostErrorId(index)"
              class="sm-hint sm-hint-error basis-full d-arrive"
              role="alert"
              data-testid="forge-pending-host-refusal"
            >
              {{ rt(hostErrors.get(host)!) }}
            </p>
          </li>
        </TransitionGroup>
      </div>
    </div>

    <div class="sm-field">
      <span class="sm-field-label">{{ t('settingsModal.forge.serverForm.redirectUri') }}</span>
      <div class="flex flex-wrap items-center gap-2">
        <code
          class="rounded-7 border border-(--d-border) bg-(--d-code) px-2 py-1 font-mono text-12 wrap-anywhere select-all"
          data-testid="forge-redirect-uri"
        >{{ redirectUri }}</code>
        <SettingButton
          :disabled="copy?.state === 'pending'"
          data-testid="forge-copy-redirect-uri"
          @click="copyRedirectUri"
        >
          <Copy
            class="size-3"
            aria-hidden="true"
          />
          {{ t('settingsModal.forge.serverForm.copy') }}
        </SettingButton>
        <span
          class="sm-hint sm-hint-success"
          role="status"
        >{{ copy?.state === 'copied' ? t('settingsModal.forge.serverForm.copied') : '' }}</span>
      </div>
      <p
        v-if="copy?.state === 'failed'"
        class="sm-hint sm-hint-error"
        role="alert"
      >
        {{ t('settingsModal.forge.serverForm.copyFailed') }}
      </p>
      <p class="sm-hint">
        {{ t(steps.intro) }}
      </p>
      <ol
        class="sm-hint list-decimal ps-5"
        data-testid="forge-registration-steps"
      >
        <li
          v-for="index in steps.count"
          :key="index"
        >
          {{ t(`${steps.list}.step${index}`) }}
        </li>
      </ol>
    </div>

    <p
      v-if="invalid('remove')"
      class="sm-hint sm-hint-error"
      role="alert"
      data-testid="forge-server-refusal"
    >
      {{ rt(refusal!.message) }}
    </p>

    <div class="sm-field-row">
      <SettingButton
        variant="primary"
        :disabled="pending !== null"
        data-testid="forge-server-submit"
        @click="submit"
      >
        {{ editing ? t('settingsModal.forge.serverForm.save') : t('settingsModal.forge.serverForm.add') }}
      </SettingButton>
      <SettingButton
        data-testid="forge-server-cancel"
        @click="emit('close')"
      >
        {{ t('common.cancel') }}
      </SettingButton>
      <SettingButton
        v-if="editing"
        variant="danger"
        :disabled="pending !== null"
        data-testid="forge-server-remove"
        @click="askRemove"
      >
        <Trash2
          class="size-3"
          aria-hidden="true"
        />
        {{ t('settingsModal.forge.serverForm.remove') }}
      </SettingButton>
    </div>

    <AlertDialog
      :open="removing"
      @update:open="(next: boolean) => !next && cancelRemove()"
    >
      <AlertDialogContent
        class="max-w-md gap-0 overflow-hidden p-0"
        data-testid="forge-remove-server-confirm"
        @close-auto-focus="returnFocus"
      >
        <ConfirmDialogLayout
          :icon="Trash2"
          tone="danger"
          :title="t('settingsModal.forge.serverForm.removeTitle', { server: server?.host ?? '' })"
          :description="t('settingsModal.forge.serverForm.removeMessage', { n: accountCount }, accountCount)"
          :cancel-label="t('common.cancel')"
          :confirm-label="t('settingsModal.forge.serverForm.remove')"
          danger
          @cancel="cancelRemove"
          @confirm="confirmRemove"
        />
      </AlertDialogContent>
    </AlertDialog>
  </form>
</template>
