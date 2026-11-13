<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, shallowRef, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, KeyRound, Laptop, LoaderCircle, Plus, UserRound } from 'lucide-vue-next';
import HostBadge from '@/components/HostBadge.vue';
import ForgeAvatar from '@/components/settings/forge/ForgeAvatar.vue';
import type { RepoAccountOption } from '@shared/forge/bindings';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import OverlayDialog, { type DialogButton } from './OverlayDialog.vue';

// Ask once (the Choose account dialog): which account the project uses on the server, before the user's own git operation. The rows follow the access
// check as it answers; digits 1 to 4 pick a row, arrows move, Enter confirms. Cancel, Escape and the scrim answer dismissed, so
// the operation does not run.
const props = defineProps<{ api: DamoclesOverlayApi; request: Extract<OverlayRequest, { kind: 'forgeChooseAccount' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const dialog = computed(() => props.request.dialog);
const rows = shallowRef({ accounts: dialog.value.accounts, checking: dialog.value.checking, preselectId: dialog.value.preselectId });
type Choice = { readonly kind: 'account'; readonly account: RepoAccountOption } | { readonly kind: 'own' } | { readonly kind: 'signIn' };
const choices = computed((): Choice[] => [...rows.value.accounts.map((account): Choice => ({ kind: 'account', account })), { kind: 'own' }, { kind: 'signIn' }]);

const preselected = (): number => Math.max(0, rows.value.accounts.findIndex((account) => account.id === rows.value.preselectId));
const active = ref(preselected());
// the user moved the selection, so a later preselection from the access check leaves it where it is
let moved = false;

onScopeDispose(props.api.onForgeChooseAccountRows((next) => {
  if (next.requestId !== dialog.value.requestId) return;
  const current = choices.value[active.value];
  rows.value = { accounts: next.accounts, checking: next.checking, preselectId: next.preselectId };
  if (!moved) active.value = preselected();
  else if (current?.kind === 'account') active.value = Math.max(0, next.accounts.findIndex((account) => account.id === current.account.id));
  else active.value = next.accounts.length + (current?.kind === 'own' ? 0 : 1);
}));

const CANCEL = 0;
const CONFIRM = 1;
const confirmLabel = computed(() => {
  const choice = choices.value[active.value];
  if (choice?.kind === 'account') return t('forgeAsk.use', { login: choice.account.login });
  return choice?.kind === 'own' ? t('forgeAsk.useOwn') : t('forgeAsk.signIn');
});
const buttons = computed((): DialogButton[] => [
  { label: t('forgeAsk.cancel'), variant: 'plain', testId: 'forge-ask-cancel' },
  { label: confirmLabel.value, variant: 'fill', testId: 'forge-ask-confirm' },
]);

const messageOf = (key: 'forgeAsk.message' | 'forgeAsk.messageChecking'): string => t(key, { n: rows.value.accounts.length, server: dialog.value.server }, rows.value.accounts.length);

function confirm(): void {
  const choice = choices.value[active.value];
  if (!choice) return;
  if (choice.kind === 'signIn') emit('answer', { kind: 'forgeChooseAccount', signIn: true });
  else emit('answer', { kind: 'forgeChooseAccount', accountId: choice.kind === 'account' ? choice.account.id : null });
}

function onChoose(button: number): void {
  if (button === CONFIRM) confirm();
  else emit('answer', { kind: 'dismissed' });
}

const listId = useId();
const optionId = (index: number): string => `${listId}-${index}`;
// digits pick the first rows, as PermissionPrompt's numbered options do
const DIGITS = 4;

function moveTo(index: number): void {
  moved = true;
  active.value = Math.min(Math.max(index, 0), choices.value.length - 1);
  void nextTick(() => document.getElementById(optionId(active.value))?.scrollIntoView({ block: 'nearest' }));
}

function onKeydown(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
  if (event.key === 'ArrowDown') moveTo(active.value + 1);
  else if (event.key === 'ArrowUp') moveTo(active.value - 1);
  else if (event.key === 'Home') moveTo(0);
  else if (event.key === 'End') moveTo(choices.value.length - 1);
  else if (digit >= 1 && digit <= Math.min(DIGITS, choices.value.length)) moveTo(digit - 1);
  else if (event.key === 'Enter') confirm();
  else return;
  event.preventDefault();
}

const ACCESS_WORDS = ['signInAgain', 'canPush', 'readOnly', 'ssoRequired', 'notApproved'] as const;
function access(account: RepoAccountOption): (typeof ACCESS_WORDS)[number] | undefined {
  if (account.needsSignIn) return 'signInAgain';
  if (account.canPush === true) return 'canPush';
  if (account.canPush === false) return 'readOnly';
  if (account.ssoRequired) return 'ssoRequired';
  if (account.appNotApproved) return 'notApproved';
  return undefined;
}

const checkingRow = (account: RepoAccountOption): boolean => account.checking === true;
const ownerChip = (account: RepoAccountOption): boolean => account.owner === true && account.id === rows.value.preselectId;
const ownerWord = computed(() => t(dialog.value.kind === 'github' ? 'forgeAsk.admin' : 'forgeAsk.owner'));
</script>

<template>
  <!-- initial-focus marks the primary button, but the list, earlier in the dialog, carries its own mark and takes focus first. -->
  <OverlayDialog
    severity="accent"
    :icon="UserRound"
    :title="t('forgeAsk.title', { server: dialog.server, project: dialog.project })"
    :buttons="buttons"
    :initial-focus="CONFIRM"
    :cancel-index="CANCEL"
    wide
    test-id="forge-ask"
    @choose="onChoose"
  >
    <p
      class="flex min-w-0 flex-wrap items-center gap-1.5 text-12 text-(--d-muted)"
      data-testid="forge-ask-where"
    >
      <Laptop
        v-if="!dialog.where"
        aria-hidden="true"
        class="size-3 shrink-0"
      />
      <span
        dir="ltr"
        class="font-mono text-(--d-text)"
      >{{ dialog.project }}</span>
      <template v-if="dialog.where">
        <span>{{ t('forgeAsk.on') }}</span>
        <HostBadge
          :name="dialog.where.hostName"
          :color="dialog.where.color"
          data-testid="forge-ask-host"
        />
      </template>
      <ChevronRight
        aria-hidden="true"
        class="size-3 shrink-0"
      />
      <span
        dir="ltr"
        class="min-w-0 font-mono break-all text-(--d-text)"
      >{{ dialog.server }}/{{ dialog.repoPath }}</span>
    </p>
    <!-- v-show and fixed texts here and in the rows: a node the rows update removed would make the alert dialog's focus scope move focus to the panel -->
    <p
      v-for="key in ['forgeAsk.messageChecking', 'forgeAsk.message'] as const"
      v-show="rows.checking === (key === 'forgeAsk.messageChecking')"
      :key="key"
      class="text-12.5/relaxed text-pretty text-(--d-muted)"
      data-testid="forge-ask-message"
    >
      {{ messageOf(key) }}
    </p>
    <!-- The list is outside the description, which holds the where-line and the message alone. -->
    <template #controls>
      <!-- Custom markup: src/webview/components/ui has no single-select listbox; its command part is a filtered combobox. -->
      <ul
        :id="listId"
        role="listbox"
        tabindex="0"
        data-overlay-initial-focus
        data-testid="forge-ask-list"
        :aria-label="t('forgeAsk.listLabel', { server: dialog.server })"
        :aria-activedescendant="optionId(active)"
        :aria-busy="rows.checking || undefined"
        class="mt-1.5 flex flex-col gap-0.5 rounded-9 outline-none focus-visible:ring-1 focus-visible:ring-(--d-accent)"
        @keydown="onKeydown"
      >
        <li
          v-for="(choice, index) in choices"
          :id="optionId(index)"
          :key="choice.kind === 'account' ? choice.account.id : choice.kind"
          role="option"
          :data-testid="`forge-ask-option-${choice.kind}`"
          :aria-selected="index === active"
          :aria-keyshortcuts="index < DIGITS ? String(index + 1) : undefined"
          class="group flex cursor-pointer items-center gap-2.5 rounded-9 px-2.5 py-1.25 transition-colors duration-150"
          :class="index === active ? 'bg-(--d-accent-soft) text-(--d-accent-text)' : 'hover:bg-(--d-hover)'"
          @mousedown.prevent
          @click="moveTo(index)"
          @dblclick="confirm"
        >
          <span
            aria-hidden="true"
            class="flex size-5 flex-none items-center justify-center rounded-6 border font-mono text-11"
            :class="index === active ? 'border-(--d-accent)' : 'border-(--d-border2)'"
          >{{ index < DIGITS ? index + 1 : '' }}</span>
          <ForgeAvatar
            v-if="choice.kind === 'account'"
            :login="choice.account.login"
            :avatar-key="choice.account.avatarKey"
            size="item"
          />
          <KeyRound
            v-else-if="choice.kind === 'own'"
            aria-hidden="true"
            class="mx-0.5 size-4 shrink-0"
          />
          <Plus
            v-else
            aria-hidden="true"
            class="mx-0.5 size-4 shrink-0"
          />
          <span class="flex min-w-0 flex-1 flex-col">
            <template v-if="choice.kind === 'account'">
              <span
                dir="ltr"
                class="truncate text-start text-12.5 font-medium"
              >{{ choice.account.login }}</span>
              <span
                class="inline-flex min-w-0 flex-wrap items-center gap-1 text-11"
                :class="index === active ? 'text-(--d-accent-text)' : 'text-(--d-faint-text)'"
              >
                <span
                  v-show="choice.account.name"
                  class="truncate"
                >{{ choice.account.name }}</span>
                <span
                  v-show="choice.account.name && (checkingRow(choice.account) || access(choice.account))"
                  aria-hidden="true"
                >·</span>
                <span
                  v-show="checkingRow(choice.account)"
                  class="inline-flex items-center gap-1"
                  data-testid="forge-ask-checking"
                >
                  <LoaderCircle
                    aria-hidden="true"
                    class="d-spinning size-3"
                  />{{ t('forgeAsk.access.checking') }}
                </span>
                <span
                  v-for="word in ACCESS_WORDS"
                  v-show="!checkingRow(choice.account) && access(choice.account) === word"
                  :key="word"
                >{{ t(`forgeAsk.access.${word}`) }}</span>
                <span
                  v-show="ownerChip(choice.account)"
                  data-testid="forge-ask-owner"
                  class="rounded-5 bg-[color-mix(in_srgb,var(--d-success)_14%,transparent)] px-1.5 text-10/4 whitespace-nowrap text-(--d-success-text)"
                >{{ ownerWord }}</span>
              </span>
            </template>
            <template v-else>
              <span class="truncate text-12.5 font-medium">{{ choice.kind === 'own' ? t('forgeAsk.useOwn') : t('forgeAsk.signInAnother') }}</span>
              <span
                class="truncate text-11"
                :class="index === active ? 'text-(--d-accent-text)' : 'text-(--d-faint-text)'"
              >{{ choice.kind === 'own' ? t('forgeAsk.ownHint') : t('forgeAsk.signInHint') }}</span>
            </template>
          </span>
        </li>
      </ul>
    </template>
  </OverlayDialog>
</template>
