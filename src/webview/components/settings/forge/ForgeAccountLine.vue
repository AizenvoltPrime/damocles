<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { LogOut, ShieldAlert, TriangleAlert } from 'lucide-vue-next';
import type { ForgeAccountSummary, ForgeServerSummary } from '@shared/forge/accounts';
import type { LocalizedText } from '@shared/localized-text';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useLocalizedText } from '@/composables/useLocalizedText';
import SettingAccount from '../controls/SettingAccount.vue';
import SettingButton from '../controls/SettingButton.vue';
import SettingSwitch from '../controls/SettingSwitch.vue';
import ForgeAvatar from './ForgeAvatar.vue';

const props = defineProps<{
  account: ForgeAccountSummary;
  server: ForgeServerSummary;
  showAvatars: boolean;
  /** Manage shows one account's details at a time; the group decides which. */
  managing: boolean;
  /** The account a sign-in just added, which slides in once. */
  arrived: boolean;
  /** Why core refused to sign this account out, shown in Manage. */
  signOutError?: LocalizedText | undefined;
}>();

const emit = defineEmits<{
  (e: 'toggleManage'): void;
  (e: 'signInAgain'): void;
  (e: 'signOut'): void;
}>();

const { t, locale } = useI18n();
const { rt } = useLocalizedText();
const { postMessage, onMessage } = usePlatformBridge();
const detailId = useId();
const hintId = useId();
const switchLabelId = useId();
const shellsErrorId = useId();
const signOutErrorId = useId();

const login = computed(() => props.account.login);
const server = computed(() => props.server.host);

const status = computed(() => {
  if (!props.account.needsSignIn) return { state: 'ok' as const, text: t('settingsModal.forge.account.signedIn') };
  return { state: 'warn' as const, text: t(props.account.route === 'token' ? 'settingsModal.forge.account.tokenRefused' : 'settingsModal.forge.account.signInExpired') };
});

const dateOf = (epoch: number): string => new Intl.DateTimeFormat(locale.value, { day: 'numeric', month: 'long', year: 'numeric' }).format(epoch);

const refusedNote = computed(() => {
  const named = { server: server.value, login: login.value };
  const at = props.account.needsSignInAt;
  const base = props.account.route === 'token' ? 'settingsModal.forge.account.tokenRefusedNote' : 'settingsModal.forge.account.signInExpiredNote';
  return at === undefined ? t(`${base}Undated`, named) : t(base, { ...named, date: dateOf(at) });
});

// The switch shows the value it sent until core answers that write, then core's value: the stored one again after a refusal.
const sent = ref<{ requestId: string; agentShells: boolean } | null>(null);
const announcement = ref('');
const shellsError = ref<LocalizedText | null>(null);
const shells = computed(() => sent.value?.agentShells ?? props.account.agentShells);

function setShells(agentShells: boolean): void {
  const requestId = `forge-shells-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  sent.value = { requestId, agentShells };
  announcement.value = '';
  shellsError.value = null;
  postMessage({ type: 'forgeSetAgentShells', requestId, accountId: props.account.id, agentShells });
}

function shellsResult(message: ExtensionToWebviewMessage): void {
  if (message.type !== 'forgeAccountActionResult' || message.requestId !== sent.value?.requestId) return;
  const { agentShells } = sent.value;
  sent.value = null;
  if (message.ok) announcement.value = t(agentShells ? 'settingsModal.forge.account.agentShellsNowOn' : 'settingsModal.forge.account.agentShellsNowOff', { login: login.value });
  else shellsError.value = message.message;
}

let stopListening: (() => void) | null = null;
onMounted(() => {
  stopListening = onMessage(shellsResult);
});
onUnmounted(() => stopListening?.());

// The webview never opens a URL: core resolves the organization's page for this account.
function openOrgAccess(org: string): void {
  postMessage({ type: 'forgeOpenPage', page: 'orgAccess', accountId: props.account.id, org });
}
</script>

<template>
  <li
    class="flex flex-col not-first:border-t not-first:border-(--d-border)"
    :class="{ 'd-row-arrive': arrived }"
    :data-testid="`forge-account-${account.login}`"
    :data-account-id="account.id"
  >
    <div class="flex flex-wrap items-center gap-2.5 py-2">
      <span class="flex min-w-0 flex-[1_1_12rem] items-center gap-2.5">
        <ForgeAvatar
          :login="account.login"
          :avatar-key="showAvatars ? account.avatarKey : undefined"
        />
        <span class="flex min-w-0 flex-col">
          <span class="truncate text-12.5 font-medium">{{ account.name ?? account.login }}</span>
          <span class="truncate text-11 text-(--d-faint-text)"><span class="font-mono">{{ account.login }}</span> · {{ t(`settingsModal.forge.account.route.${account.route}`) }}</span>
        </span>
      </span>
      <SettingAccount
        class="ms-auto"
        :state="status.state"
        :status="status.text"
        :action="t('settingsModal.forge.account.manage')"
        :action-label="t('settingsModal.forge.account.manageLabel', { login, server })"
        :expanded="managing"
        :controls="detailId"
        @toggle="emit('toggleManage')"
      />
    </div>

    <ul
      v-if="account.orgAccess.length > 0"
      class="flex flex-col gap-1.5 pb-2"
    >
      <li
        v-for="issue in account.orgAccess"
        :key="`${issue.kind}-${issue.org}`"
        class="flex flex-wrap items-center gap-2 text-11.5 text-(--d-warning-text)"
      >
        <template v-if="issue.kind === 'ssoRequired'">
          <ShieldAlert
            class="size-3"
            aria-hidden="true"
          />
          <SettingButton @click="openOrgAccess(issue.org)">
            {{ t('settingsModal.forge.account.orgSso', { org: issue.org }) }}
          </SettingButton>
        </template>
        <template v-else>
          <TriangleAlert
            class="size-3"
            aria-hidden="true"
          />
          <span>{{ t('settingsModal.forge.account.orgNotApproved', { org: issue.org }) }}</span>
          <SettingButton @click="openOrgAccess(issue.org)">
            {{ t('settingsModal.forge.account.requestApproval') }}
          </SettingButton>
        </template>
      </li>
    </ul>

    <div
      v-if="managing"
      :id="detailId"
      class="mb-3 ms-10 flex flex-col gap-2.5 rounded-9 border border-(--d-border) bg-(--d-bg) p-3 @max-[36rem]:ms-0"
      data-testid="forge-manage"
    >
      <p
        v-if="account.needsSignIn"
        class="flex items-start gap-1.5 text-11.5 text-(--d-warning-text)"
        role="note"
      >
        <TriangleAlert
          class="mt-0.5 size-3 flex-none"
          aria-hidden="true"
        />
        <span>{{ refusedNote }}</span>
      </p>
      <label class="sm-field-row">
        <SettingSwitch
          :model-value="shells"
          :aria-labelledby="switchLabelId"
          :aria-describedby="shellsError === null ? hintId : `${hintId} ${shellsErrorId}`"
          @update:model-value="setShells"
        />
        <span
          :id="switchLabelId"
          class="sm-field-label"
        >{{ t('settingsModal.forge.account.agentShells') }}</span>
      </label>
      <p
        :id="hintId"
        class="sm-hint"
      >
        {{ shells ? t('settingsModal.forge.account.agentShellsHint', { login, server }) : t('settingsModal.forge.account.agentShellsOffHint', { server }) }}
      </p>
      <p
        v-if="shellsError !== null"
        :id="shellsErrorId"
        class="sm-hint sm-hint-error d-arrive"
        role="alert"
        data-testid="forge-agent-shells-error"
      >
        {{ rt(shellsError) }}
      </p>
      <p
        class="sm-hint"
        role="status"
      >
        {{ announcement }}
      </p>
      <p
        v-if="!account.needsSignIn"
        class="sm-hint"
      >
        {{ t(`settingsModal.forge.account.signedInOn.${account.route}`, { date: dateOf(account.addedAt) }) }}
      </p>
      <p
        v-if="account.route === 'token'"
        class="flex items-start gap-1.5 text-11.5 text-(--d-warning-text)"
      >
        <TriangleAlert
          class="mt-0.5 size-3 flex-none"
          aria-hidden="true"
        />
        <span>{{ t('settingsModal.forge.account.tokenWarning') }}</span>
      </p>
      <p
        v-if="signOutError !== undefined"
        :id="signOutErrorId"
        class="sm-hint sm-hint-error d-arrive"
        role="alert"
        data-testid="forge-sign-out-error"
      >
        {{ rt(signOutError) }}
      </p>
      <div class="sm-field-row">
        <SettingButton
          :variant="account.needsSignIn ? 'primary' : 'default'"
          data-testid="forge-sign-in-again"
          @click="emit('signInAgain')"
        >
          {{ account.needsSignIn && account.route === 'token' ? t('settingsModal.forge.account.enterNewToken') : t('settingsModal.forge.account.signInAgain') }}
        </SettingButton>
        <SettingButton
          variant="danger"
          :aria-describedby="signOutError === undefined ? undefined : signOutErrorId"
          data-testid="forge-sign-out"
          @click="emit('signOut')"
        >
          <LogOut
            class="size-3"
            aria-hidden="true"
          />
          {{ t('settingsModal.forge.account.signOut') }}
        </SettingButton>
      </div>
    </div>
  </li>
</template>
