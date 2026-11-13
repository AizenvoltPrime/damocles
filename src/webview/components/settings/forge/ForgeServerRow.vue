<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import type { ForgeAccountSummary, ForgeKind, ForgeServerSummary, ForgeSignInState } from '@shared/forge/accounts';
import type { LocalizedText } from '@shared/localized-text';
import { useSettingsStore } from '@/stores/useSettingsStore';
import GithubMark from '@/components/icons/GithubMark.vue';
import GitlabMark from '@/components/icons/GitlabMark.vue';
import SettingsRow from '../SettingsRow.vue';
import SettingButton from '../controls/SettingButton.vue';
import { FORGE_SERVER_ROW } from '../settings-rows';
import ForgeAccountLine from './ForgeAccountLine.vue';
import ForgeServerForm, { type ServerFormOutcome } from './ForgeServerForm.vue';
import ForgeSignInPanel from './ForgeSignInPanel.vue';
import { isRunning } from './forge-sign-in';

const props = defineProps<{
  server: ForgeServerSummary;
  accounts: readonly ForgeAccountSummary[];
  showAvatars: boolean;
  /** No account on any server: gitlab.com's row leads with a primary "Add account" and says why. */
  emptyEverywhere: boolean;
  redirectUris: Record<ForgeKind, string>;
  managing: string | null;
  /** A sign-out core refused, by account id, shown in that account's Manage. */
  signOutErrors: ReadonlyMap<string, LocalizedText>;
}>();

const emit = defineEmits<{
  (e: 'toggleManage', accountId: string): void;
  (e: 'signOut', account: ForgeAccountSummary): void;
  (e: 'serverForm', outcome: ServerFormOutcome): void;
  (e: 'removing', requestId: string): void;
}>();

const { t } = useI18n();
const { forgeSignIns } = storeToRefs(useSettingsStore());

const host = computed(() => props.server.host);
const panelId = useId();
const formId = useId();
const addButton = ref<InstanceType<typeof SettingButton> | null>(null);
const editButton = ref<InstanceType<typeof SettingButton> | null>(null);

const flow = computed<ForgeSignInState | undefined>(() => forgeSignIns.value[props.server.id]);
// The panel the user opened, or { } for a plain "Add account"; a flow core runs keeps it open, unless the user cancelled it.
const requested = ref<{ reauth?: ForgeAccountSummary } | null>(null);
// a cancelled flow runs on until core settles it, which must not reopen the panel the user closed
const cancelled = ref(false);
const panelShown = computed(() => requested.value !== null || (isRunning(flow.value) && !cancelled.value));
const panel = ref<InstanceType<typeof ForgeSignInPanel> | null>(null);
const editing = ref(false);

const signedInLogin = ref<string | null>(null);
const arrivedId = ref<string | null>(null);

function focusAdd(): void {
  (addButton.value?.$el as HTMLElement | undefined)?.focus();
}

// A sign-in ends after a state of its own run; the settled one core posts again as a view attaches follows none, or itself.
watch(flow, async (next, previous) => {
  if (!isRunning(next)) cancelled.value = false;
  if (next?.phase !== 'signedIn' || previous === undefined || previous.phase === 'signedIn') return;
  if (!(requested.value !== null || isRunning(previous))) return;
  requested.value = null;
  signedInLogin.value = next.login;
  arrivedId.value = next.accountId;
  await nextTick();
  focusAdd();
});

function toggleAdd(): void {
  if (panel.value !== null) {
    panel.value.cancel();
    return;
  }
  signedInLogin.value = null;
  editing.value = false;
  requested.value = {};
}

async function closePanel(flowCancelled: boolean): Promise<void> {
  cancelled.value = flowCancelled;
  requested.value = null;
  await nextTick();
  focusAdd();
}

function signInAgain(account: ForgeAccountSummary): void {
  cancelled.value = false;
  signedInLogin.value = null;
  editing.value = false;
  requested.value = { reauth: account };
}

function toggleEdit(): void {
  editing.value = !editing.value;
  if (editing.value) requested.value = null;
}

async function closeForm(outcome?: ServerFormOutcome): Promise<void> {
  editing.value = false;
  if (outcome !== undefined) emit('serverForm', outcome);
  await nextTick();
  (editButton.value?.$el as HTMLElement | undefined)?.focus();
}

const badge = computed(() => {
  const version = props.server.version;
  if (version === undefined || props.server.builtIn) return null;
  if (props.server.flavor === 'gitlab') return t('settingsModal.forge.server.versionGitlab', { version });
  if (props.server.flavor === 'ghes') return t('settingsModal.forge.server.versionGhes', { version });
  return null;
});

const emptyLead = computed(() => props.emptyEverywhere && props.server.id === 'gitlab.com');

const description = computed(() => {
  const { server } = props;
  if (!server.builtIn) {
    if (server.oauthClientId !== undefined) return t(server.flavor === 'ghe.com' ? 'settingsModal.forge.server.tenantOAuth' : 'settingsModal.forge.server.selfManagedOAuth');
    return t(server.flavor === 'ghe.com' ? 'settingsModal.forge.server.tenantToken' : 'settingsModal.forge.server.selfManagedToken');
  }
  if (props.accounts.length > 0) return t('settingsModal.forge.server.accounts', { n: props.accounts.length }, props.accounts.length);
  if (emptyLead.value) return t('settingsModal.forge.server.noAccountAnywhere');
  return t('settingsModal.forge.server.noAccount', { server: host.value });
});

// Settings opened at this server with sign-in (the account chip's "Sign in to <server>..."): its panel opens, in view.
async function openSignIn(): Promise<void> {
  if (!panelShown.value) {
    cancelled.value = false;
    signedInLogin.value = null;
    editing.value = false;
    requested.value = {};
  }
  await nextTick();
  (addButton.value?.$el as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
}

defineExpose({ focusAdd, openSignIn });
</script>

<template>
  <SettingsRow
    :id="FORGE_SERVER_ROW"
    :instance="server.id"
    :label="host"
    :description="description"
  >
    <template #label-start>
      <GithubMark
        v-if="server.kind === 'github'"
        class="size-3.25"
      />
      <GitlabMark
        v-else
        class="size-3.25"
      />
    </template>
    <template #label-extra>
      <span
        v-if="badge !== null"
        class="sm-badge"
        data-testid="forge-version-badge"
      >{{ badge }}</span>
    </template>
    <template #note>
      <p
        class="sm-hint sm-hint-success"
        role="status"
        data-testid="forge-signed-in"
      >
        {{ signedInLogin === null ? '' : t('settingsModal.forge.signIn.signedInAs', { login: signedInLogin }) }}
      </p>
    </template>
    <SettingButton
      v-if="!server.builtIn"
      ref="editButton"
      :aria-label="t('settingsModal.forge.server.editServerLabel', { server: host })"
      :aria-expanded="editing ? 'true' : 'false'"
      :aria-controls="formId"
      @click="toggleEdit"
    >
      {{ t('settingsModal.forge.server.editServer') }}
    </SettingButton>
    <SettingButton
      ref="addButton"
      :variant="emptyLead ? 'primary' : 'default'"
      :aria-label="t('settingsModal.forge.server.addAccountLabel', { server: host })"
      :aria-expanded="panelShown ? 'true' : 'false'"
      :aria-controls="panelId"
      @click="toggleAdd"
    >
      {{ t('settingsModal.forge.server.addAccount') }}
    </SettingButton>
    <template #expand>
      <div
        v-if="panelShown"
        :id="panelId"
        class="sm-expand"
      >
        <ForgeSignInPanel
          ref="panel"
          :key="requested?.reauth?.id ?? 'add'"
          :server="server"
          :reauth="requested?.reauth"
          @close="closePanel"
        />
      </div>
      <div
        v-if="editing"
        :id="formId"
        class="sm-expand"
      >
        <ForgeServerForm
          :server="server"
          :redirect-uris="redirectUris"
          :account-count="accounts.length"
          @close="closeForm"
          @removing="(requestId: string) => emit('removing', requestId)"
        />
      </div>
      <div
        v-if="accounts.length > 0"
        class="sm-expand py-1"
      >
        <ul :aria-label="t('settingsModal.forge.server.accountsOn', { server: host })">
          <ForgeAccountLine
            v-for="account in accounts"
            :key="account.id"
            :account="account"
            :server="server"
            :show-avatars="showAvatars"
            :managing="managing === account.id"
            :arrived="arrivedId === account.id"
            :sign-out-error="signOutErrors.get(account.id)"
            @toggle-manage="emit('toggleManage', account.id)"
            @sign-in-again="signInAgain(account)"
            @sign-out="emit('signOut', account)"
          />
        </ul>
      </div>
    </template>
  </SettingsRow>
</template>
