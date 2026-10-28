<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { LoaderCircle, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { DamoclesOverlayApi, PopupAnswer, RemovalInfo, RemoveServerOptions, RemoveServerResult } from '../../../preload/overlay-channels';
import type { ProjectConnection, ShellPlatform } from '../../../preload/shell-channels';
import { useHostOperations } from '../host-operations';
import { answerOf, ran } from '../popup-answer';
import ForgetHostDialog from './ForgetHostDialog.vue';
import PasswordlessSetup from './PasswordlessSetup.vue';
import RemoveServerDialog from './RemoveServerDialog.vue';
import SecretPrompt from './SecretPrompt.vue';

// A saved host's actions, the same on its card and in Settings, Remote hosts: Set up passwordless login, Remove Damocles server
// and Forget host, which offers the removal first while the host is reachable. Its confirmations are reka alert dialogs, so
// opened over the Connect dialog they take the pointer and focus as nested layers. Main owns both operations' runs, so a view
// mounted mid-run, or again after one ended, shows the same steps and results.
const props = defineProps<{
  api: DamoclesOverlayApi;
  hostId: string;
  hostName: string;
  connection: ProjectConnection;
  passwordless: boolean;
  os?: ShellPlatform | undefined;
}>();
// busy: a setup or removal runs here, whose progress the page shows
const emit = defineEmits<{ busy: [busy: boolean] }>();
const { t } = useI18n();

const connected = computed(() => props.connection === 'connected');
const operations = useHostOperations(props.api, () => props.hostId);
// A setup main holds stays shown, so its finished steps show after main reports the key.
const setup = computed(() => operations.value?.passwordless);
const setupRunning = computed(() => setup.value !== undefined && setup.value.result === undefined && setup.value.failed !== true);
const removalRun = computed(() => operations.value?.removal);
const removing = computed(() => removalRun.value !== undefined && removalRun.value.result === undefined && removalRun.value.failed !== true);
const removed = computed(() => removalRun.value?.result);
watch(() => removing.value || setupRunning.value, (busy) => emit('busy', busy));

// the removal dialog's facts while it is open
const removal = shallowRef<RemovalInfo | undefined>();
const forgetting = ref(false);
// a call that failed before main answered: which one
const failedCall = ref<'removalInfo' | 'remove' | 'forget' | undefined>();
const failed = computed(() => failedCall.value ?? (removalRun.value?.failed ? 'remove' : undefined));
// a removal asked from Forget host forgets the host once it succeeded
let forgetAfterRemoval = false;
// The removal stage's own ssh may ask for a secret; main holds it in the removal's run. An answered one hides at once.
const answered = ref<string | undefined>();
const askedSecret = computed(() => {
  const prompt = removalRun.value?.prompt;
  return prompt && prompt.promptId !== answered.value ? prompt : undefined;
});

// null: Cancel, which ssh takes as no answer
async function answerSecret(answer: string | null, remember: boolean): Promise<void> {
  const asked = askedSecret.value;
  if (!asked) return;
  answered.value = asked.promptId;
  try {
    await ran(props.api.answerConnect(asked.attemptId, asked.promptId, answer, remember));
  } catch {
    failedCall.value = 'remove';
  }
}

async function askRemoval(thenForget: boolean): Promise<void> {
  failedCall.value = undefined;
  forgetAfterRemoval = thenForget;
  try {
    const info = await answerOf(props.api.removalInfo(props.hostId));
    if (info) removal.value = info;
  } catch {
    failedCall.value = 'removalInfo';
  }
}

async function remove(options: RemoveServerOptions | null): Promise<void> {
  removal.value = undefined;
  if (!options) return;
  await runRemoval(() => props.api.removeServer(props.hostId, options));
}

// Try again after daemonRunning: main runs the same removal stage over ssh, with no connection to the host needed.
async function retryRemoval(): Promise<void> {
  failedCall.value = undefined;
  await runRemoval(() => props.api.retryRemoval(props.hostId));
}

async function runRemoval(call: () => Promise<PopupAnswer<RemoveServerResult>>): Promise<void> {
  const thenForget = forgetAfterRemoval;
  try {
    const result = await answerOf(call());
    if (result?.ok && thenForget) await forget();
  } catch {
    failedCall.value = 'remove';
  }
}

async function forget(): Promise<void> {
  try {
    await ran(props.api.forgetHost(props.hostId));
  } catch {
    failedCall.value = 'forget';
  }
}

function chooseForget(choice: 'cancel' | 'removeFirst' | 'forget'): void {
  forgetting.value = false;
  if (choice === 'removeFirst') void askRemoval(true);
  else if (choice === 'forget') void forget();
}

const removedText = computed(() => {
  const result = removed.value;
  if (!result) return undefined;
  if (!result.ok && result.code === 'stageFailed') return t(`remote.removeServer.stageFailed.${String(result.params['code'])}`, { name: props.hostName, ...result.params });
  if (!result.ok) return t(`remote.removeServer.failure.${result.code}`, { name: props.hostName, ...result.params });
  return [
    t('remote.removeServer.done', { name: props.hostName }),
    ...result.notices.map((notice) => t(`remote.removeServer.notice.${notice.code}`, { name: props.hostName, ...notice.params })),
  ].join(' ');
});
</script>

<template>
  <div class="flex flex-col gap-2">
    <PasswordlessSetup
      v-if="setup || (!passwordless && connected)"
      :api="api"
      :host-id="hostId"
      :host-name="hostName"
      :os="os"
      :run="setup"
    />
    <div class="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="remove-server"
        class="h-7.5 rounded-8 border-(--d-border2) bg-(--d-card) px-3 text-12"
        :disabled="!connected || removing"
        :title="connected ? undefined : t('remote.removeServer.needsConnection', { name: hostName })"
        @click="askRemoval(false)"
      >
        <LoaderCircle
          v-if="removing"
          aria-hidden="true"
          class="d-spinning"
        />
        {{ t('remote.removeServer.open') }}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="forget-host"
        class="h-7.5 rounded-8 px-3 text-12 text-(--d-muted) hover:text-(--d-danger-text)"
        :disabled="removing"
        @click="forgetting = true"
      >
        <X aria-hidden="true" />
        {{ t('remote.forget.open') }}
      </Button>
    </div>
    <div aria-live="polite">
      <p
        v-if="removing"
        data-testid="remove-server-progress"
        class="text-12 text-(--d-muted)"
      >
        {{ t('remote.removeServer.running', { name: hostName }) }}
      </p>
      <p
        v-else-if="removed?.ok"
        role="status"
        data-testid="remove-server-result"
        class="text-12 text-(--d-success-text)"
      >
        {{ removedText }}
      </p>
    </div>
    <SecretPrompt
      v-if="removing && askedSecret"
      :key="askedSecret.promptId"
      :prompt="askedSecret"
      cancellable
      @answer="answerSecret"
      @cancel="answerSecret(null, false)"
    />
    <div
      v-if="removed && !removed.ok"
      class="flex flex-wrap items-center gap-2 rounded-8 bg-(--d-danger)/12 px-2.5 py-2"
    >
      <p
        role="alert"
        data-testid="remove-server-result"
        class="text-12 text-(--d-danger-text)"
      >
        {{ removedText }}
      </p>
      <Button
        v-if="removed.code === 'daemonRunning'"
        type="button"
        variant="outline"
        size="sm"
        data-testid="remove-server-retry"
        class="h-7 rounded-8 border-(--d-border2) bg-(--d-card) px-3 text-12"
        @click="retryRemoval"
      >
        {{ t('remote.removeServer.retry') }}
      </Button>
    </div>
    <p
      v-if="failed"
      role="alert"
      data-testid="host-action-failed"
      class="text-12 text-(--d-danger-text)"
    >
      {{ t(`remote.hostActions.failed.${failed}`, { name: hostName }) }}
    </p>
    <RemoveServerDialog
      :host-name="hostName"
      :info="removal"
      @choose="remove"
    />
    <ForgetHostDialog
      :open="forgetting"
      :host-name="hostName"
      :offer-removal="connected"
      @choose="chooseForget"
    />
  </div>
</template>
