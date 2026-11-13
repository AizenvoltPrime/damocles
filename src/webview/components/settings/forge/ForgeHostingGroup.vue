<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { LogOut, Server, TriangleAlert } from 'lucide-vue-next';
import type { ForgeAccountSummary, ForgeServerSummary } from '@shared/forge/accounts';
import type { LocalizedText } from '@shared/localized-text';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useLocalizedText } from '@/composables/useLocalizedText';
import { useOpenerFocus } from '@/composables/useOpenerFocus';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import ConfirmDialogLayout from '@/components/ConfirmDialogLayout.vue';
import SettingsRow from '../SettingsRow.vue';
import SettingButton from '../controls/SettingButton.vue';
import { FORGE_ADD_SERVER_ROW, FORGE_SERVER_ROW, rowMatches } from '../settings-rows';
import { useHostGroupRows, useSettingsPage, useSettingsTarget } from '../settings-view';
import ForgeServerForm, { type ServerFormOutcome } from './ForgeServerForm.vue';
import ForgeServerRow from './ForgeServerRow.vue';

const { t } = useI18n();
const { rt } = useLocalizedText();
const { postMessage, onMessage } = usePlatformBridge();
const page = useSettingsPage();
const { forgeAccounts } = storeToRefs(useSettingsStore());

const loading = computed(() => forgeAccounts.value === null || forgeAccounts.value.status === 'loading');
const state = computed(() => (loading.value ? null : forgeAccounts.value));

// The group follows its server row's listing, which has no key, so only the User tab lists it. Search shows the servers
// part when the server row's words or a server's host match, or when the Add server row's own words do; each row inside
// then matches on its own, and the host's rows after it too.
const serverMeta = computed(() => page.meta(FORGE_SERVER_ROW));
const addServerMeta = computed(() => page.meta(FORGE_ADD_SERVER_ROW));
const groupListed = computed(() => serverMeta.value !== undefined && page.listed(serverMeta.value));
const hostMatches = computed(() => state.value?.servers.some((server) => server.host.toLocaleLowerCase().includes(page.query)) === true);
const groupShown = computed(() => groupListed.value && (
  rowMatches(serverMeta.value!, page.query, t)
  || hostMatches.value
  || (addServerMeta.value !== undefined && rowMatches(addServerMeta.value, page.query, t))
));
const headShown = computed(() => groupListed.value && page.query === '');
const groupRows = useHostGroupRows();
const hostRows = computed(() => groupRows('forgeHosting'));

const accountsOf = (serverId: string): ForgeAccountSummary[] => state.value?.accounts.filter((account) => account.serverId === serverId) ?? [];
const emptyEverywhere = computed(() => state.value?.accounts.length === 0);
// No file could be read: nothing changes until a restart, so no server can be added and no file shown.
const loadFailed = computed(() => state.value?.error?.kind === 'loadFailed');

const managing = ref<string | null>(null);
function toggleManage(accountId: string): void {
  managing.value = managing.value === accountId ? null : accountId;
}

const rows = new Map<string, InstanceType<typeof ForgeServerRow>>();
function rowRef(serverId: string, row: unknown): void {
  if (row === null) rows.delete(serverId);
  else rows.set(serverId, row as InstanceType<typeof ForgeServerRow>);
}

// Settings opened at a server with its sign-in (the account chip, the ask-once dialog): that row's panel opens once the rows are in.
const target = useSettingsTarget();
// each target opens its panel once, so a later accounts change never reopens a panel the user closed
let opened: unknown = null;
// Settings opened at an account (the agent's refused git): its Manage opens, in view.
const groupRoot = ref<HTMLElement | null>(null);
watch([() => target.value, state], async ([next, ready]) => {
  const serverId = next?.forgeServer;
  if (serverId === undefined || !ready || opened === next) return;
  const accountId = next?.forgeAccount;
  if (accountId !== undefined && ready.accounts.some((account) => account.id === accountId && account.serverId === serverId)) {
    opened = next;
    managing.value = accountId;
    await nextTick();
    [...(groupRoot.value?.querySelectorAll<HTMLElement>('[data-account-id]') ?? [])].find((line) => line.dataset['accountId'] === accountId)?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (next?.forgeSignIn !== true) return;
  opened = next;
  await nextTick();
  await rows.get(serverId)?.openSignIn();
}, { immediate: true });

const newRequestId = (kind: string): string => `forge-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// The account stays after the dialog closes, so its text holds through the exit.
const signOutOpen = ref(false);
const signOutAccount = ref<ForgeAccountSummary | null>(null);
const signOutServer = computed(() => state.value?.servers.find((server) => server.id === signOutAccount.value?.serverId)?.host ?? '');
const signOutText = computed(() => {
  const account = signOutAccount.value;
  if (account === null) return '';
  const { projects, hosts } = account.bindings;
  return [
    t(account.route === 'token' ? 'settingsModal.forge.signOut.token' : 'settingsModal.forge.signOut.oauth'),
    ...(projects > 0 ? [t('settingsModal.forge.signOut.projects', { n: projects }, projects)] : []),
    ...(hosts > 0 ? [t('settingsModal.forge.signOut.hosts', { n: hosts }, hosts)] : []),
  ].join(' ');
});
const returnFocus = useOpenerFocus(() => signOutOpen.value);
let signedOutFrom: string | null = null;
// A refused sign-out keeps its line, whose Manage reopens with the reason.
const signOuts = new Map<string, ForgeAccountSummary>();
const signOutErrors = ref<ReadonlyMap<string, LocalizedText>>(new Map());

function askSignOut(account: ForgeAccountSummary): void {
  signOutAccount.value = account;
  signOutOpen.value = true;
}

function confirmSignOut(): void {
  const account = signOutAccount.value;
  signOutOpen.value = false;
  if (account === null) return;
  const requestId = newRequestId('sign-out');
  signOuts.set(requestId, account);
  const errors = new Map(signOutErrors.value);
  errors.delete(account.id);
  signOutErrors.value = errors;
  postMessage({ type: 'forgeSignOut', requestId, accountId: account.id });
  signedOutFrom = account.serverId;
  managing.value = null;
}

// A confirmed sign-out removes the line that opened the dialog, so focus goes to that row's Add account.
function signOutClosed(event: Event): void {
  const serverId = signedOutFrom;
  signedOutFrom = null;
  if (serverId === null) {
    returnFocus(event);
    return;
  }
  event.preventDefault();
  void nextTick(() => rows.get(serverId)?.focusAdd());
}

const addingServer = ref(false);
const addServerFormId = useId();
const addServerButton = ref<InstanceType<typeof SettingButton> | null>(null);
const formOutcome = ref<ServerFormOutcome | null>(null);

function toggleAddServer(): void {
  addingServer.value = !addingServer.value;
  if (addingServer.value) formOutcome.value = null;
}

async function closeAddServer(outcome?: ServerFormOutcome): Promise<void> {
  addingServer.value = false;
  if (outcome !== undefined) formOutcome.value = outcome;
  await nextTick();
  (addServerButton.value?.$el as HTMLElement | undefined)?.focus();
}

function serverFormDone(outcome: ServerFormOutcome): void {
  formOutcome.value = outcome;
}

// The removed server's row is gone before core's answer arrives, so the group hears its success and moves focus to Add server.
const removals = new Map<string, ForgeServerSummary>();
function removing(server: ForgeServerSummary, requestId: string): void {
  removals.set(requestId, server);
}

// The webview never opens a URL or a file: core reveals the file it failed to parse and opens the revoke page it holds.
const reveal = ref<{ requestId: string; error?: LocalizedText } | null>(null);
const revealErrorId = useId();
function revealFile(): void {
  const requestId = newRequestId('reveal');
  reveal.value = { requestId };
  postMessage({ type: 'forgeRevealAccountsFile', requestId });
}
function openRevokePage(noticeId: string): void {
  postMessage({ type: 'forgeOpenPage', page: 'revoke', noticeId });
}
function dismissNotice(noticeId: string): void {
  postMessage({ type: 'forgeDismissNotice', noticeId });
}

async function handleRemoval(message: Extract<ExtensionToWebviewMessage, { type: 'forgeServerFormResult' }>): Promise<void> {
  const server = removals.get(message.requestId);
  if (server === undefined) return;
  removals.delete(message.requestId);
  if (!message.ok) return;
  formOutcome.value = { kind: 'removed', serverId: server.id, host: server.host };
  await nextTick();
  (addServerButton.value?.$el as HTMLElement | undefined)?.focus();
}

function handleAction(message: Extract<ExtensionToWebviewMessage, { type: 'forgeAccountActionResult' }>): void {
  if (message.requestId === reveal.value?.requestId) {
    reveal.value = message.ok ? null : { requestId: message.requestId, error: message.message };
    return;
  }
  const account = signOuts.get(message.requestId);
  if (account === undefined) return;
  signOuts.delete(message.requestId);
  if (message.ok) return;
  signOutErrors.value = new Map(signOutErrors.value).set(account.id, message.message);
  managing.value = account.id;
}

let stopListening: (() => void) | null = null;
onMounted(() => {
  stopListening = onMessage((message) => {
    if (message.type === 'forgeServerFormResult') void handleRemoval(message);
    else if (message.type === 'forgeAccountActionResult') handleAction(message);
  });
});
onUnmounted(() => stopListening?.());

// The outcome names the server as the form knew it, so no later publish changes it or announces it again.
const outcomeText = computed(() => {
  const outcome = formOutcome.value;
  if (outcome === null) return '';
  return t(`settingsModal.forge.serverForm.${outcome.kind}`, { server: outcome.host });
});
</script>

<template>
  <div
    v-if="groupShown || (groupListed && hostRows.length > 0)"
    ref="groupRoot"
    class="@container"
    data-testid="forge-hosting"
  >
    <template v-if="headShown">
      <div
        class="sm-group-head"
        data-testid="forge-hosting-head"
      >
        {{ t('settingsModal.forge.title') }}
      </div>
      <p class="max-w-130 text-12 text-(--d-muted)">
        {{ t('settingsModal.forge.intro') }}
      </p>
    </template>

    <div
      v-if="groupShown && loading"
      class="flex flex-col"
      aria-busy="true"
      :aria-label="t('settingsModal.forge.loading')"
      role="group"
      data-testid="forge-loading"
    >
      <div
        v-for="index in 2"
        :key="index"
        class="sm-row"
      >
        <div class="sm-row-text flex flex-col gap-2">
          <span class="relative block h-2.5 w-30 overflow-hidden rounded-5 bg-(--d-hover) text-(--d-text)"><span class="d-sheen" /></span>
          <span class="relative block h-2.5 w-48 overflow-hidden rounded-5 bg-(--d-hover) text-(--d-text)"><span class="d-sheen" /></span>
        </div>
        <div class="sm-row-control">
          <span class="relative block h-7 w-22 overflow-hidden rounded-8 bg-(--d-hover) text-(--d-text)"><span class="d-sheen" /></span>
        </div>
        <div
          v-if="index === 1"
          class="sm-expand flex items-center gap-2.5"
        >
          <span class="relative block size-7 overflow-hidden rounded-full bg-(--d-hover) text-(--d-text)"><span class="d-sheen" /></span>
          <span class="flex flex-1 flex-col gap-1.5">
            <span class="relative block h-2.5 w-32 overflow-hidden rounded-5 bg-(--d-hover) text-(--d-text)"><span class="d-sheen" /></span>
            <span class="relative block h-2.5 w-44 overflow-hidden rounded-5 bg-(--d-hover) text-(--d-text)"><span class="d-sheen" /></span>
          </span>
        </div>
      </div>
    </div>

    <template v-else-if="groupShown && state !== null">
      <div
        v-if="state.error"
        class="sm-banner sm-banner-warning"
        role="alert"
        :data-error-kind="state.error.kind"
        data-testid="forge-error"
      >
        <TriangleAlert
          class="size-3.5 flex-none"
          aria-hidden="true"
        />
        <span class="sm-banner-text">{{ rt(state.error.message) }}</span>
        <SettingButton
          v-if="state.error.kind === 'brokenFile'"
          :aria-describedby="reveal?.error === undefined ? undefined : revealErrorId"
          @click="revealFile"
        >
          {{ t('settingsModal.forge.showFile') }}
        </SettingButton>
      </div>
      <p
        v-if="state.error && reveal?.error !== undefined"
        :id="revealErrorId"
        class="sm-hint sm-hint-error d-arrive -mt-1 mb-2.5 px-3"
        role="alert"
        data-testid="forge-reveal-error"
      >
        {{ rt(reveal.error) }}
      </p>

      <div
        v-for="notice in state.notices"
        :key="notice.id"
        class="sm-banner sm-banner-warning"
        role="alert"
        data-testid="forge-notice"
      >
        <LogOut
          class="size-3.5 flex-none"
          aria-hidden="true"
        />
        <span class="sm-banner-text">{{ rt(notice.message) }}</span>
        <SettingButton @click="openRevokePage(notice.id)">
          {{ t('settingsModal.forge.notice.openRevokePage') }}
        </SettingButton>
        <SettingButton @click="dismissNotice(notice.id)">
          {{ t('settingsModal.forge.notice.dismiss') }}
        </SettingButton>
      </div>

      <ForgeServerRow
        v-for="server in state.servers"
        :key="server.id"
        :ref="(row) => rowRef(server.id, row)"
        :server="server"
        :accounts="accountsOf(server.id)"
        :show-avatars="state.showAvatars"
        :empty-everywhere="emptyEverywhere"
        :redirect-uris="state.redirectUris"
        :managing="managing"
        :sign-out-errors="signOutErrors"
        @toggle-manage="toggleManage"
        @sign-out="askSignOut"
        @server-form="serverFormDone"
        @removing="(requestId: string) => removing(server, requestId)"
      />

      <SettingsRow
        v-if="!loadFailed"
        :id="FORGE_ADD_SERVER_ROW"
      >
        <template #label-start>
          <Server
            class="size-3.25"
            aria-hidden="true"
          />
        </template>
        <template #note>
          <p
            class="sm-hint sm-hint-success"
            role="status"
            data-testid="forge-server-outcome"
          >
            {{ outcomeText }}
          </p>
        </template>
        <SettingButton
          ref="addServerButton"
          :aria-expanded="addingServer ? 'true' : 'false'"
          :aria-controls="addServerFormId"
          @click="toggleAddServer"
        >
          {{ t('settingsModal.forge.serverForm.add') }}
        </SettingButton>
        <template #expand>
          <div
            v-if="addingServer"
            :id="addServerFormId"
            class="sm-expand"
          >
            <ForgeServerForm
              :redirect-uris="state.redirectUris"
              :account-count="0"
              @close="closeAddServer"
            />
          </div>
        </template>
      </SettingsRow>
    </template>

    <component
      :is="hostRow"
      v-for="(hostRow, index) in hostRows"
      :key="index"
    />

    <AlertDialog
      :open="signOutOpen"
      @update:open="(next: boolean) => (signOutOpen = next)"
    >
      <AlertDialogContent
        class="max-w-md gap-0 overflow-hidden p-0"
        data-testid="forge-sign-out-confirm"
        @close-auto-focus="signOutClosed"
      >
        <ConfirmDialogLayout
          :icon="LogOut"
          tone="danger"
          :title="t('settingsModal.forge.signOut.title', { login: signOutAccount?.login ?? '', server: signOutServer })"
          :description="signOutText"
          :cancel-label="t('common.cancel')"
          :confirm-label="t('settingsModal.forge.signOut.confirm')"
          danger
          @cancel="signOutOpen = false"
          @confirm="confirmSignOut"
        />
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
