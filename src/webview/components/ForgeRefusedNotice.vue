<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import type { AcceptableValue } from 'reka-ui';
import { KeyRound, Settings } from 'lucide-vue-next';
import type { ForgeAccountSummary } from '@shared/forge/accounts';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MENU_CONTENT, MENU_ITEM } from '@/components/chat-header/menuStyles';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useForgeRefusalStore, type ForgeRefusal } from '@/stores/useForgeRefusalStore';
import ForgeAvatar from './settings/forge/ForgeAvatar.vue';
import TranscriptNotice from './TranscriptNotice.vue';

// The refused notice: the agent's git or forge tool was refused an account. Choose account binds the project through core, which checks the
// refusal is one it posted; the org action opens the address core recorded for it.
// dismissible: the dock's notice, which a Dismiss button takes away
const props = defineProps<{ refusal: ForgeRefusal; dismissible?: boolean }>();
const emit = defineEmits<{ dismiss: [] }>();

const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const store = useForgeRefusalStore();
const { menuRequest } = storeToRefs(store);
const { forgeAccounts } = storeToRefs(useSettingsStore());
const titleId = useId();

const refused = computed(() => props.refusal.refused);
const choice = computed(() => props.refusal.choice);
const server = computed(() => refused.value.serverLabel);
const showAvatars = computed(() => forgeAccounts.value?.showAvatars ?? true);
// Accounts and their "Agent shells may use this account" switches come from core's forgeAccountsChanged, which it posts to this panel before the refusal.
const accounts = computed<ForgeAccountSummary[]>(() => forgeAccounts.value?.accounts.filter((account) => account.serverId === refused.value.serverId) ?? []);
const shellsWord = (account: ForgeAccountSummary): string => t(account.agentShells ? 'forgeRefused.shellsAllowed' : 'forgeRefused.shellsNotAllowed');
const checkedId = computed(() => (choice.value?.state === 'saved' ? choice.value.accountId : refused.value.account?.id));
// a forge tool's refusal names it; a shell's does not
const tool = computed(() => refused.value.tool);
const org = computed(() => (refused.value.reason === 'orgAccess' ? refused.value.org : undefined));
// core says whether it recorded a project to bind; an org's refusal is fixed on the server, not by another account
const canChoose = computed(() => refused.value.canBind === true && org.value === undefined);

const chosenAccount = computed(() => (choice.value?.state === 'saved' ? accounts.value.find((account) => account.id === choice.value!.accountId) : undefined));
const title = computed(() => (choice.value?.state === 'saved'
  ? t('forgeRefused.nowUses', { project: refused.value.project, login: choice.value.login })
  : tool.value === undefined ? t('forgeRefused.title') : t('forgeRefused.toolTitle', { tool: tool.value })));

const open = ref(false);
const menuId = useId();
const menuLabelId = useId();
const status = ref('');

// Focus starts on the checked account, else the first item, whether a click, a key or the toast opened the menu.
function focusChecked(event: Event): void {
  event.preventDefault();
  void nextTick(() => {
    const root = document.getElementById(menuId);
    const target = root?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? root?.querySelector<HTMLElement>('[role^="menuitem"]');
    target?.focus();
  });
}

// a request for this notice is spent here, also when it has no menu, so it never opens one later
watch(menuRequest, (toolCallId) => {
  if (toolCallId !== refused.value.toolCallId) return;
  store.menuOpened();
  if (canChoose.value) open.value = true;
}, { immediate: true });

function choose(value: AcceptableValue): void {
  if (typeof value !== 'string' || value === checkedId.value) return;
  const account = accounts.value.find((candidate) => candidate.id === value);
  if (!account) return;
  store.choose(refused.value.toolCallId, account.id, account.login);
  postMessage({ type: 'forgeRefusedBind', toolCallId: refused.value.toolCallId, accountId: account.id });
}

function orgAction(): void {
  postMessage({ type: 'forgeRefusedOrgAction', toolCallId: refused.value.toolCallId });
}

function openSettings(): void {
  postMessage({ type: 'forgeRefusedOpenSettings', toolCallId: refused.value.toolCallId });
}

// The status line speaks the outcome once; the notice's own text holds it after.
watch(() => choice.value?.state, (state) => {
  const current = choice.value;
  if (current === undefined || state === 'saving') return;
  status.value = state === 'saved'
    ? t('forgeRefused.announce', { project: refused.value.project, login: current.login, server: server.value })
    : t('forgeRefused.saveFailed');
});
</script>

<template>
  <TranscriptNotice
    tone="warning"
    :icon="KeyRound"
    :title="title"
    :title-id="titleId"
    :dismissible="dismissible"
    data-testid="forge-refused-notice"
    :data-reason="refused.reason"
    @dismiss="emit('dismiss')"
  >
    <p
      v-if="choice?.state === 'saved'"
      data-testid="forge-refused-message"
    >
      {{ tool !== undefined
        ? t('forgeRefused.toolNowUses', { login: choice.login, server })
        : chosenAccount?.agentShells === false
          ? t('forgeRefused.nowUsesNotAllowed', { login: choice.login })
          : t('forgeRefused.nowUsesAllowed', { login: choice.login, server }) }}
    </p>
    <i18n-t
      v-else-if="refused.reason === 'agentShellsOff' && refused.account"
      keypath="forgeRefused.agentShellsOff"
      tag="p"
      scope="global"
      data-testid="forge-refused-message"
    >
      <template #server>
        <span dir="ltr">{{ server }}</span>
      </template>
      <template #login>
        <span
          class="inline-flex items-center gap-1 align-middle font-mono text-(--d-text)"
          dir="ltr"
        >
          <ForgeAvatar
            :login="refused.account.login"
            :avatar-key="showAvatars ? refused.account.avatarKey : undefined"
            size="chip"
          />{{ refused.account.login }}</span>
      </template>
    </i18n-t>
    <p
      v-else-if="org"
      data-testid="forge-refused-message"
    >
      {{ t(org.kind === 'sso' ? 'forgeRefused.orgSso' : 'forgeRefused.orgApproval', { org: org.name, server }) }}
    </p>
    <p
      v-else-if="tool !== undefined"
      data-testid="forge-refused-message"
    >
      {{ t('forgeRefused.toolNoAccount', { server, tool }) }}
    </p>
    <p
      v-else
      data-testid="forge-refused-message"
    >
      {{ t('forgeRefused.noAccount', { server }) }}
    </p>
    <p
      v-if="choice?.state === 'failed'"
      class="text-(--d-danger-text)"
      data-testid="forge-refused-failed"
    >
      {{ t('forgeRefused.saveFailed') }}
    </p>

    <div class="mt-1.5 flex flex-wrap gap-1.5">
      <Button
        v-if="org"
        type="button"
        class="h-7 rounded-8 bg-(--d-accent) px-2.75 text-xs font-semibold text-(--d-on-accent) hover:bg-(--d-accent) hover:brightness-110"
        :aria-describedby="titleId"
        data-testid="forge-refused-org"
        @click="orgAction"
      >
        {{ t(org.kind === 'sso' ? 'forgeRefused.orgAuthorize' : 'forgeRefused.orgRequest', { org: org.name }) }}
      </Button>
      <DropdownMenu
        v-if="canChoose"
        v-model:open="open"
      >
        <DropdownMenuTrigger as-child>
          <Button
            type="button"
            class="h-7 rounded-8 bg-(--d-accent) px-2.75 text-xs font-semibold text-(--d-on-accent) hover:bg-(--d-accent) hover:brightness-110"
            :aria-describedby="titleId"
            data-testid="forge-refused-choose"
          >
            {{ t('forgeRefused.chooseAccount') }}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          :id="menuId"
          side="bottom"
          align="start"
          :aria-labelledby="menuLabelId"
          :class="['w-max max-w-80 min-w-57.5', MENU_CONTENT]"
          data-testid="forge-refused-menu"
          @open-auto-focus="focusChecked"
        >
          <!-- reka names the menu by its trigger; this one names it for the server -->
          <span
            :id="menuLabelId"
            class="sr-only"
          >{{ t('forgeRefused.menuLabel', { server }) }}</span>
          <DropdownMenuLabel
            class="px-2.25 pt-1.5 pb-0.5 font-mono text-11 font-normal text-(--d-faint-text)"
            dir="ltr"
          >
            {{ t('forgeRefused.menuCaption', { project: refused.project, server }) }}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            :model-value="checkedId ?? ''"
            @update:model-value="choose"
          >
            <DropdownMenuRadioItem
              v-for="account in accounts"
              :key="account.id"
              :value="account.id"
              :class="[MENU_ITEM, 'ps-8']"
              data-testid="forge-refused-account"
              :aria-label="t('forgeRefused.accountItem', { login: account.login, shells: shellsWord(account) })"
            >
              <ForgeAvatar
                :login="account.login"
                :avatar-key="showAvatars ? account.avatarKey : undefined"
                size="item"
              />
              <!-- named by aria-label: the column's block lines would read with a space before a hidden comma -->
              <span class="flex min-w-0 flex-1 flex-col">
                <span
                  class="truncate"
                  dir="ltr"
                >{{ account.login }}</span>
                <span class="text-10.5 text-(--d-faint-text)">{{ shellsWord(account) }}</span>
              </span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator
            v-if="accounts.length > 0"
            class="mx-0.5 my-1 bg-(--d-border)"
          />
          <DropdownMenuItem
            :class="MENU_ITEM"
            data-testid="forge-refused-menu-settings"
            @select="openSettings"
          >
            <Settings aria-hidden="true" />
            {{ t('forgeRefused.openSettings') }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="outline"
        class="h-7 gap-1.5 rounded-8 border-(--d-border2) bg-transparent px-2.75 text-xs font-normal text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3"
        data-testid="forge-refused-settings"
        @click="openSettings"
      >
        <Settings aria-hidden="true" />
        {{ t('forgeRefused.openSettings') }}
      </Button>
    </div>
    <p
      class="sr-only"
      role="status"
      data-testid="forge-refused-status"
    >
      {{ status }}
    </p>
  </TranscriptNotice>
</template>
