<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronDown, KeyRound, UserRound } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import ForgeAvatar from '@/components/settings/forge/ForgeAvatar.vue';
import type { RepoAccountOption, RepoAccountsView, RepoServerAccounts } from '@shared/forge/bindings';
import type { DamoclesShellApi } from '../../preload/shell-channels';
import type { OverlayMenuItem, OverlayRect } from '../../preload/overlay-channels';
import { SECTION_CHIP_ROOM } from '../components/sidebar-section';
import { textIsCut } from '../editor/editor-place';

/**
 * Source Control's account chip, drawn like FilesBranchChip: the push server's account, "+N" for the project's other
 * servers, and a menu that binds an account per server. Its accessible name and title name every server.
 */
const props = defineProps<{
  api: DamoclesShellApi;
  repoId: string;
  view: RepoAccountsView;
  servers: readonly RepoServerAccounts[];
  // the worktree chip shows first, so this one shrinks to its avatar or icon
  compact: boolean;
}>();
// polite: an account change; alert: a choice main did not save
const emit = defineEmits<{ announce: [text: string, alert: boolean] }>();
const { t } = useI18n();

const first = computed(() => props.servers[0]!);
const extra = computed(() => props.servers.length - 1);
const warn = computed(() => first.value.state === 'choose' || first.value.state === 'signInAgain');
const signInOnly = computed(() => props.servers.length === 1 && first.value.state === 'signIn');

const settled = (server: RepoServerAccounts): server is Extract<RepoServerAccounts, { account: RepoAccountOption }> =>
  server.state === 'auto' || server.state === 'chosen' || server.state === 'signInAgain';
const firstAccount = computed(() => (settled(first.value) ? first.value.account : undefined));

function summary(server: RepoServerAccounts): string {
  if (settled(server)) return t(`forge.summary.${server.state}`, { login: server.account.login, server: server.server });
  return t(`forge.summary.${server.state}`, { server: server.server });
}

const ariaLabel = computed(() => (signInOnly.value
  ? t('forge.chip.signInAria', { server: first.value.server })
  : t('forge.chip.aria', { summary: props.servers.map(summary).join('; ') })));
const title = computed(() => (signInOnly.value ? t('forge.chip.signInTitle', { server: first.value.server }) : props.servers.map(summary).join('\n')));
// keys the label's swap: a change of the shown account or its state replays t-swap-box
const labelKey = computed(() => `${first.value.serverId}:${first.value.state}:${firstAccount.value?.id ?? ''}:${extra.value}:${props.compact}`);

// A fixed label (Choose account, Sign in, Git's own credentials) is whole or absent, as TabPlaceChip's is: with no room for
// it the chip folds to its icon, its words staying in the title and accessible name. A login is data and keeps its ellipsis.
const fixedLabel = computed(() => {
  if (firstAccount.value || props.compact) return undefined;
  if (first.value.state === 'ownCredentials') return t('forge.chip.ownCredentials');
  return first.value.state === 'choose' ? t('forge.chip.choose') : t('forge.chip.signIn');
});
const folded = ref(false);
const fixedLabelElement = useTemplateRef<HTMLElement>('fixedLabelElement');
const room = inject(SECTION_CHIP_ROOM, ref(0));
// Shows the label whole for one render and folds before the next paint.
async function refold(): Promise<void> {
  folded.value = false;
  await nextTick();
  const label = fixedLabelElement.value;
  folded.value = label !== null && textIsCut(label);
}
// Not `immediate`: its first run is in setup, and a chip mounted outside a render flush (ScmSection's out-in swap) gets its
// template refs only in the flush that follows, after the measure.
onMounted(() => void refold());
watch([fixedLabel, room, extra], () => void refold(), { flush: 'post' });

const menuOpen = ref(false);
const root = ref<InstanceType<typeof Button> | null>(null);

function rectOf(): OverlayRect {
  const element = (root.value?.$el ?? null) as HTMLElement | null;
  const rect = element?.getBoundingClientRect();
  return rect ? { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height } : { x: 0, y: 0, width: 0, height: 0 };
}

function accessHint(account: RepoAccountOption): string | undefined {
  if (account.canPush === true) return t('forge.hint.canPush');
  if (account.canPush === false) return t('forge.hint.cannotPush');
  if (account.ssoRequired) return t('forge.hint.ssoRequired');
  if (account.appNotApproved) return t('forge.hint.notApproved');
  return undefined;
}

function accountHint(server: RepoServerAccounts, account: RepoAccountOption): string | undefined {
  const parts: string[] = [];
  if (account.needsSignIn) parts.push(t('forge.hint.signInAgain'));
  else if (server.state === 'auto' && server.account.id === account.id) parts.push(t('forge.hint.auto'));
  else if (account.name) parts.push(account.name);
  const access = accessHint(account);
  if (access !== undefined) parts.push(access);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function serverHint(server: RepoServerAccounts): string {
  if (settled(server)) return t(`forge.serverHint.${server.state}`, { login: server.account.login });
  return t(`forge.serverHint.${server.state}`);
}

// Item ids carry indices into the servers the menu was built from; main checks they name an item it offered.
function serverItems(server: RepoServerAccounts, index: number): OverlayMenuItem[] {
  const bound = settled(server) ? server.account.id : undefined;
  const hint = accountHint.bind(null, server);
  const signIn: OverlayMenuItem = { kind: 'item', id: `signIn:${index}`, label: t('forge.menu.signInTo', { server: server.server }), icon: 'plus' };
  // no account on the server: signing in leads, and Git's own credentials takes the server off the project's chip
  if (server.state === 'signIn') {
    return [signIn, { kind: 'item', id: `own:${index}`, label: t('forge.menu.ownCredentials'), icon: 'key-round', hint: t('forge.menu.ownCredentialsHides') }];
  }
  return [
    ...server.accounts.map((account, at): OverlayMenuItem => ({
      kind: 'item',
      id: `pick:${index}:${at}`,
      label: account.login,
      avatar: { login: account.login, ...(account.avatarKey !== undefined ? { key: account.avatarKey } : {}) },
      ...(hint(account) !== undefined ? { hint: hint(account)! } : {}),
      checked: account.id === bound,
      radio: true,
    })),
    { kind: 'item', id: `own:${index}`, label: t('forge.menu.ownCredentials'), icon: 'key-round', checked: server.state === 'ownCredentials', radio: true },
    { kind: 'separator' },
    signIn,
  ];
}

function menuItems(servers: readonly RepoServerAccounts[]): OverlayMenuItem[] {
  const settings: OverlayMenuItem = { kind: 'item', id: 'settings', label: t('forge.menu.settings'), icon: 'settings' };
  const only = servers.length === 1 ? servers[0]! : undefined;
  if (only) return [...serverItems(only, 0), ...(only.state === 'signIn' ? [{ kind: 'separator' } as const] : []), settings];
  return [
    ...servers.map((server, index): OverlayMenuItem => ({
      kind: 'submenu',
      id: `server:${index}`,
      label: server.server,
      icon: server.kind === 'github' ? 'github' : 'gitlab',
      hint: serverHint(server),
      items: serverItems(server, index),
    })),
    { kind: 'separator' },
    { kind: 'item', id: 'signIn', label: t('forge.menu.signIn'), icon: 'plus' },
    settings,
  ];
}

async function choose(server: RepoServerAccounts, account: RepoAccountOption | null): Promise<void> {
  const project = props.view.project;
  let saved: boolean;
  try {
    saved = await props.api.forge.chooseAccount(props.repoId, server.serverId, account?.id ?? null);
  } catch {
    saved = false;
  }
  if (!saved) emit('announce', t('forge.announce.saveFailed'), true);
  else if (account) emit('announce', t('forge.announce.account', { project, login: account.login, server: server.server }), false);
  else emit('announce', t('forge.announce.ownCredentials', { project, server: server.server }), false);
}

async function openMenu(): Promise<void> {
  if (menuOpen.value) return;
  const servers = props.servers;
  const project = props.view.project;
  menuOpen.value = true;
  let answer;
  try {
    answer = await props.api.requestOverlay({
      kind: 'menu',
      label: t('forge.menu.label', { project }),
      caption: servers.length === 1 ? t('forge.menu.caption', { project, server: servers[0]!.server }) : t('forge.menu.captionMany', { project, n: servers.length }),
      anchor: rectOf(),
      items: menuItems(servers),
    });
  } finally {
    menuOpen.value = false;
  }
  if (answer.kind !== 'menu') return;
  const [action, serverAt, accountAt] = answer.itemId.split(':');
  const server = serverAt === undefined ? undefined : servers[Number(serverAt)];
  if (action === 'settings' || (action === 'signIn' && !server)) await props.api.forge.openAccounts({});
  else if (action === 'signIn' && server) await props.api.forge.openAccounts({ serverId: server.serverId, signIn: true });
  else if (action === 'own' && server) await choose(server, null);
  else if (action === 'pick' && server && accountAt !== undefined) {
    const account = server.accounts[Number(accountAt)];
    if (account) await choose(server, account);
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
  event.preventDefault();
  void openMenu();
}

defineExpose({ openMenu });

const TONE = computed(() => {
  if (warn.value) return 'bg-[color-mix(in_srgb,var(--d-warning)_14%,transparent)] text-(--d-warning-text) hover:bg-[color-mix(in_srgb,var(--d-warning)_22%,transparent)] hover:text-(--d-warning-text) aria-expanded:bg-[color-mix(in_srgb,var(--d-warning)_22%,transparent)]';
  return 'bg-(--d-hover) text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) aria-expanded:bg-(--d-border2)';
});
</script>

<template>
  <Button
    ref="root"
    type="button"
    variant="ghost"
    data-testid="forge-account-chip"
    :data-state="first.state"
    aria-haspopup="menu"
    :aria-expanded="menuOpen"
    :aria-label="ariaLabel"
    :title="title"
    class="d-press ms-1 flex h-4.5 max-w-full min-w-0 shrink justify-start gap-1 overflow-hidden rounded-full ps-0.5 pe-0 text-10.5 font-normal whitespace-nowrap focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-2.5"
    :class="TONE"
    @click.stop="openMenu"
    @keydown="onKeydown"
    @contextmenu.prevent.stop="openMenu"
  >
    <!-- out-in mounts a new label only after the old one left, so it is measured as it enters; t-swap-box keeps the flex
         line laid out meanwhile, which t-swap's inline-block would undo -->
    <Transition
      name="t-swap-box"
      mode="out-in"
      @enter="() => void refold()"
    >
      <span
        :key="labelKey"
        aria-hidden="true"
        data-testid="forge-account-chip-label"
        class="flex min-w-0 items-center gap-1"
      >
        <template v-if="firstAccount">
          <ForgeAvatar
            :login="firstAccount.login"
            :avatar-key="firstAccount.avatarKey"
            size="chip"
          />
          <template v-if="!compact">
            <span
              dir="ltr"
              class="min-w-0 truncate font-mono"
              :class="warn ? 'text-(--d-warning-text)' : 'text-(--d-text)'"
            >{{ firstAccount.login }}</span>
            <span
              v-if="first.state === 'auto'"
              class="shrink-0 text-(--d-faint-text)"
            >{{ t('forge.chip.auto') }}</span>
            <span
              v-else-if="first.state === 'signInAgain'"
              class="shrink-0"
            >{{ t('forge.chip.signInAgain') }}</span>
          </template>
        </template>
        <KeyRound
          v-else-if="first.state === 'ownCredentials'"
          class="ms-0.75 size-2.5 shrink-0"
        />
        <UserRound
          v-else
          class="ms-0.75 size-2.5 shrink-0"
        />
        <span
          v-if="fixedLabel !== undefined && !folded"
          ref="fixedLabelElement"
          class="min-w-0 truncate"
        >{{ fixedLabel }}</span>
        <span
          v-if="extra > 0 && !compact"
          class="shrink-0 font-mono text-(--d-faint-text)"
        >+{{ extra }}</span>
      </span>
    </Transition>
    <span
      aria-hidden="true"
      class="flex w-4 shrink-0 justify-center"
    >
      <ChevronDown
        class="transition-transform duration-200"
        :class="menuOpen ? 'rotate-180' : ''"
      />
    </span>
  </Button>
</template>
