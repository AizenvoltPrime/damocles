<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Globe, Info, Link, LoaderCircle, Lock, Search, ShieldAlert, TriangleAlert, UserRound } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import ForgeAvatar from '@/components/settings/forge/ForgeAvatar.vue';
import type { DamoclesOverlayApi, OverlayAnswer } from '../../../preload/overlay-channels';
import type { CloneAccountsView, CloneSearchAnswer } from '../../../preload/forge-channels';
import { fromNow } from '../../scm/scm-list';
import { answerOf } from '../popup-answer';
import { highlightSegments } from '../quick-pick';
import { MAX_CLONE_PASTE_CHARS, MAX_CLONE_QUERY_CHARS, type CloneAccount, type CloneEmptyReason, type ClonePasteRow, type CloneProtocol, type CloneRow, type CloneSource } from '../../../../shared/forge/clone';
import { applyAnswer, initialSections, isPending, looksLikeUrl, noResults, queryMatches, startSearch, type CloneSection } from '../clone-picker';

// The clone picker: a combobox over one section per account, each searched on its own as the query changes,
// a pasted URL as one Clone from URL row. Main looks the clone URL up by the row's key; this page never sees one.
const props = defineProps<{ api: DamoclesOverlayApi }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t, locale } = useI18n();

// a keystroke burst asks each server once (VS Code's remoteSource.ts debounces its search 300 ms)
const QUERY_DEBOUNCE_MS = 300;

const query = ref('');
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const listId = useId();
// undefined until main listed the accounts
const accounts = shallowRef<readonly CloneAccount[] | undefined>();
const emptyReason = ref<CloneEmptyReason | undefined>();
const protocol = ref<CloneProtocol>('https');
const loadFailed = ref(false);
const sections = shallowRef<readonly CloneSection[]>([]);
// the pasted text core read as a repository URL; null: it is not one; undefined: none pasted or not answered yet
const paste = shallowRef<{ readonly text: string; readonly row: ClonePasteRow | null } | undefined>();
const starting = ref(false);
const refused = ref('');
const activeId = ref<string | undefined>();

let nextRequestId = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;
let pasteGeneration = 0;

const pasted = computed(() => looksLikeUrl(query.value));
const pending = computed(() => !pasted.value && (accounts.value === undefined ? !loadFailed.value : isPending(sections.value)));

async function loadAccounts(): Promise<void> {
  loadFailed.value = false;
  emptyReason.value = undefined;
  accounts.value = undefined;
  let view: CloneAccountsView | undefined;
  try {
    view = await answerOf(props.api.forgeCloneAccounts());
  } catch (error) {
    console.error('[clone] main refused the account list', error);
    loadFailed.value = true;
    return;
  }
  if (view === undefined) return;
  if ('empty' in view) {
    emptyReason.value = view.empty;
    accounts.value = [];
    return;
  }
  accounts.value = view.accounts;
  protocol.value = view.protocol;
  sections.value = initialSections(view.accounts);
  if (!pasted.value) searchAll();
}

function retryAccounts(): void {
  void loadAccounts();
  input.value?.focus();
}

async function search(accountId: string): Promise<void> {
  const requestId = nextRequestId++;
  sections.value = startSearch(sections.value, accountId, requestId);
  let answer: CloneSearchAnswer | undefined;
  try {
    // main refuses a longer query; the field holds more only for a pasted address
    answer = await answerOf(props.api.forgeCloneSearch(accountId, query.value.trim().slice(0, MAX_CLONE_QUERY_CHARS), requestId));
  } catch (error) {
    // main aborts a section's search once a newer one replaces it, so only the newest one's failure is the server's
    if (sections.value.find((section) => section.account.accountId === accountId)?.requestId !== requestId) return;
    console.error('[clone] main refused a repository search', error);
    answer = { requestId, accountId, error: 'unreachable' };
  }
  if (answer) sections.value = applyAnswer(sections.value, answer);
}

function searchAll(): void {
  for (const section of sections.value) if (!section.account.needsSignIn) void search(section.account.accountId);
}

async function readPaste(text: string): Promise<void> {
  const generation = ++pasteGeneration;
  paste.value = undefined;
  let row: ClonePasteRow | null;
  try {
    const answer = await answerOf(props.api.forgeClonePaste(text));
    if (answer === undefined) return;
    row = answer.row;
  } catch (error) {
    console.error('[clone] main refused to read a pasted URL', error);
    row = null;
  }
  if (generation === pasteGeneration) paste.value = { text, row };
}

watch(query, (text) => {
  clearTimeout(debounce);
  refused.value = '';
  activeId.value = undefined;
  if (looksLikeUrl(text)) {
    void readPaste(text.trim());
    return;
  }
  pasteGeneration++;
  paste.value = undefined;
  // each section shows it is searching at once; the servers are asked once the typing pauses
  for (const section of sections.value) if (!section.account.needsSignIn) sections.value = startSearch(sections.value, section.account.accountId, nextRequestId++);
  debounce = setTimeout(searchAll, QUERY_DEBOUNCE_MS);
});
onBeforeUnmount(() => clearTimeout(debounce));

type PasteEntry = { readonly id: string; readonly kind: 'paste'; readonly text: string; readonly row: ClonePasteRow; readonly account?: string };
type Entry =
  | { readonly id: string; readonly kind: 'repo'; readonly section: CloneSection; readonly row: CloneRow; readonly updated?: string }
  | { readonly id: string; readonly kind: 'retry'; readonly section: CloneSection }
  | { readonly id: string; readonly kind: 'signIn'; readonly section: CloneSection }
  | { readonly id: string; readonly kind: 'refused'; readonly section: CloneSection }
  | PasteEntry;
type SectionEntry = Exclude<Entry, PasteEntry>;

// The sections shown: under a query a section that answered with no row leaves the list, as the design's does.
const shownSections = computed(() => (pasted.value ? [] : sections.value.filter((section) => query.value.trim() === '' || section.state.status !== 'ready' || section.state.rows.length > 0)));

function updated(row: CloneRow): string | undefined {
  const time = row.updatedAt === undefined ? Number.NaN : Date.parse(row.updatedAt);
  return Number.isNaN(time) ? undefined : fromNow(time, Date.now(), locale.value);
}

// over ssh git signs in with the user's own keys; the account is still the one the new project uses
function pasteAccount(row: ClonePasteRow): string | undefined {
  if (row.login === undefined || row.serverName === undefined) return undefined;
  return t(row.protocol === 'ssh' ? 'clonePicker.pasteAccountSsh' : 'clonePicker.pasteAccount', { login: row.login, server: row.serverName });
}
const pasteEntry = computed((): PasteEntry | undefined => {
  const read = paste.value;
  if (!pasted.value || !read?.row) return undefined;
  const account = pasteAccount(read.row);
  return { id: 'paste', kind: 'paste', text: read.text, row: read.row, ...(account !== undefined ? { account } : {}) };
});

const sectionEntries = computed(() => new Map(shownSections.value.map((section): [CloneSection, SectionEntry[]] => {
  const { state } = section;
  const id = section.account.accountId;
  if (state.status === 'error') {
    if (state.error === 'unreachable') return [section, [{ id: `retry:${id}`, kind: 'retry', section }]];
    return [section, [state.error === 'signInAgain' ? { id: `signIn:${id}`, kind: 'signIn', section } : { id: `refused:${id}`, kind: 'refused', section }]];
  }
  if (state.status !== 'ready') return [section, []];
  return [section, state.rows.map((row) => {
    const when = updated(row);
    return { id: `repo:${id}:${row.key}`, kind: 'repo', section, row, ...(when !== undefined ? { updated: when } : {}) };
  })];
})));

const entries = computed((): Entry[] => (pasteEntry.value ? [pasteEntry.value] : [...sectionEntries.value.values()].flat()));
const active = computed(() => entries.value.find((entry) => entry.id === activeId.value) ?? entries.value[0]);
const optionId = (entry: Entry): string => `${listId}-${entry.id}`;
// an account with no repository at all, which an empty query lists
const listsNothing = (section: CloneSection): boolean => query.value.trim() === '' && section.state.status === 'ready' && section.state.rows.length === 0;

const accountName = (account: CloneAccount): string => t('clonePicker.accountOn', { login: account.login, server: account.serverName });
const refusedText = (account: CloneAccount): string => t('clonePicker.refused', { server: account.serverName, login: account.login });
const fullPath = (row: CloneRow): string => `${row.namespace}/${row.name}`;
function optionName(entry: Entry): string {
  if (entry.kind === 'repo') return t('clonePicker.option', { path: fullPath(entry.row), visibility: t(`clonePicker.visibility.${entry.row.visibility}`), account: accountName(entry.section.account) });
  if (entry.kind === 'retry') return `${t('clonePicker.unreachable', { server: entry.section.account.serverName })} ${t('clonePicker.retry')}`;
  if (entry.kind === 'signIn') return t('clonePicker.signInAgain', { server: entry.section.account.serverName });
  if (entry.kind === 'refused') return `${refusedText(entry.section.account)} ${t('clonePicker.openAccounts')}`;
  return [t('clonePicker.fromUrl'), entry.row.displayPath, ...(entry.account !== undefined ? [entry.account] : [])].join(', ');
}

// The label's highlights over namespace/name, cut where the muted namespace ends.
function labelParts(row: CloneRow): Array<{ readonly text: string; readonly match: boolean; readonly namespace: boolean }> {
  const split = row.namespace.length + 1;
  let at = 0;
  return highlightSegments(fullPath(row), queryMatches(fullPath(row), query.value)).flatMap((segment) => {
    const start = at;
    at += segment.text.length;
    if (at <= split) return [{ ...segment, namespace: true }];
    if (start >= split) return [{ ...segment, namespace: false }];
    return [{ text: segment.text.slice(0, split - start), match: segment.match, namespace: true }, { text: segment.text.slice(split - start), match: segment.match, namespace: false }];
  });
}

const accountCount = computed(() => accounts.value?.length ?? 0);
const showNoResults = computed(() => !pasted.value && noResults(sections.value, query.value));
const showEmpty = computed(() => !pasted.value && accounts.value !== undefined && accounts.value.length === 0);
const notUrl = computed(() => pasted.value && paste.value?.row === null);
const repoCount = computed(() => entries.value.filter((entry) => entry.kind === 'repo' || entry.kind === 'paste').length);
const status = computed(() => {
  if (pending.value) return '';
  if (showNoResults.value) return t('clonePicker.noResults', { query: query.value.trim(), n: accountCount.value }, accountCount.value);
  return repoCount.value === 0 ? '' : t('clonePicker.count', { n: repoCount.value }, repoCount.value);
});

function move(delta: number): void {
  const all = entries.value;
  if (all.length === 0) return;
  const from = active.value ? all.indexOf(active.value) : 0;
  const next = all[Math.min(Math.max(from + delta, 0), all.length - 1)]!;
  activeId.value = next.id;
  void nextTick(() => document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' }));
}

async function start(source: CloneSource): Promise<void> {
  if (starting.value) return;
  starting.value = true;
  refused.value = '';
  try {
    const result = await answerOf(props.api.forgeCloneStart(source));
    // cancelled: Escape closed the picker while main looked the address up, so nothing started
    if (result === undefined || result.kind === 'cancelled') return;
    if (result.kind === 'refused') {
      refused.value = result.reason;
      return;
    }
    emit('answer', { kind: 'dismissed' });
  } catch (error) {
    console.error('[clone] main refused to start the clone', error);
    refused.value = t('clonePicker.startFailed');
  } finally {
    starting.value = false;
  }
}

function openAccounts(): void {
  emit('answer', { kind: 'cloneFromAccount', openAccounts: true });
}

function activate(entry: Entry | undefined): void {
  if (!entry) return;
  activeId.value = entry.id;
  if (entry.kind === 'repo') void start({ accountId: entry.section.account.accountId, key: entry.row.key });
  else if (entry.kind === 'paste') void start({ pasteText: entry.text });
  else if (entry.kind === 'retry') void search(entry.section.account.accountId);
  // signIn and refused: the account needs attention in Settings › Models & accounts › Git hosting
  else openAccounts();
}

function clearSearch(): void {
  query.value = '';
  input.value?.focus();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') move(1);
  else if (event.key === 'ArrowUp') move(-1);
  else if (event.key === 'Home' && event.ctrlKey) move(-entries.value.length);
  else if (event.key === 'End' && event.ctrlKey) move(entries.value.length);
  else if (event.key === 'Enter') activate(active.value);
  else return;
  event.preventDefault();
  event.stopPropagation();
}

// Escape closes the picker from anywhere in it, a focused button included; a clone already asked for answers cancelled then.
function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  emit('answer', { kind: 'dismissed' });
}

// A press outside the field must not take focus from it, or Enter, Escape and the arrows stop answering.
function keepFocus(event: MouseEvent): void {
  if (event.target !== input.value && !(event.target instanceof Element && event.target.closest('button'))) event.preventDefault();
}

onMounted(() => {
  void loadAccounts();
  void nextTick(() => input.value?.focus());
});
</script>

<template>
  <div
    role="dialog"
    :aria-label="t('clonePicker.dialog')"
    data-testid="clone-picker"
    class="quick-pick @container/clone fixed top-11.5 left-1/2 flex w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-xl border border-(--d-border2) bg-(--d-card) p-1.5 text-(--d-text) shadow-(--d-shadow)"
    @mousedown="keepFocus"
    @keydown="onDialogKeydown"
  >
    <label class="flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-lg border border-(--d-accent) bg-(--d-input) px-2.5 shadow-[0_0_0_3px_var(--d-accent-soft)]">
      <Search
        aria-hidden="true"
        class="size-3.5 shrink-0 text-(--d-faint)"
      />
      <!-- A combobox input: no shadcn part combines one with this sectioned listbox. -->
      <input
        ref="input"
        v-model="query"
        type="text"
        role="combobox"
        spellcheck="false"
        autocomplete="off"
        data-testid="clone-picker-input"
        aria-autocomplete="list"
        aria-expanded="true"
        :aria-controls="listId"
        :aria-activedescendant="active ? optionId(active) : undefined"
        :aria-label="t('clonePicker.label')"
        :placeholder="t('clonePicker.placeholder')"
        :readonly="starting"
        :maxlength="MAX_CLONE_PASTE_CHARS"
        class="min-w-0 flex-1 border-0 bg-transparent text-13 text-(--d-text) outline-none placeholder:text-(--d-faint)"
        @keydown="onKeydown"
      >
      <LoaderCircle
        v-if="pending || starting"
        aria-hidden="true"
        data-testid="clone-picker-busy"
        class="d-spinning size-3 shrink-0 text-(--d-faint)"
      />
    </label>
    <p
      v-if="accountCount > 0"
      data-testid="clone-picker-hint"
      class="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-11.5 text-(--d-faint-text)"
    >
      <Info
        aria-hidden="true"
        class="size-3 shrink-0"
      /><span class="min-w-0">{{ t(protocol === 'ssh' ? 'clonePicker.hintSsh' : 'clonePicker.hint', { n: accountCount }, accountCount) }}</span>
    </p>
    <div
      :id="listId"
      ref="list"
      role="listbox"
      :aria-label="t('clonePicker.listLabel')"
      data-testid="clone-picker-list"
      class="quick-pick-list mt-1 max-h-80 overflow-x-hidden overflow-y-auto overscroll-contain outline-none"
    >
      <div
        v-if="pasteEntry"
        :id="optionId(pasteEntry)"
        role="option"
        :aria-selected="pasteEntry === active"
        :aria-label="optionName(pasteEntry)"
        data-testid="clone-picker-paste"
        class="d-row-arrive flex min-h-7.5 cursor-pointer items-center gap-2.25 rounded-7 px-2 hover:bg-(--d-hover) aria-selected:bg-(--d-accent-soft)"
        @mousedown.prevent
        @click="activate(pasteEntry)"
      >
        <Link
          aria-hidden="true"
          class="size-3.5 shrink-0 text-(--d-faint-text)"
        />
        <span class="shrink-0 font-mono text-12 whitespace-nowrap">{{ t('clonePicker.fromUrl') }}</span>
        <span
          dir="ltr"
          class="min-w-0 flex-1 truncate text-11 text-(--d-faint-text)"
        >{{ pasteEntry.row.displayPath }}</span>
        <span
          v-if="pasteEntry.account"
          data-testid="clone-picker-paste-account"
          class="max-w-1/2 min-w-0 shrink truncate text-11 text-(--d-faint-text)"
        >{{ pasteEntry.account }}</span>
      </div>
      <div
        v-for="(section, index) in shownSections"
        :key="section.account.accountId"
        role="group"
        :aria-label="accountName(section.account)"
        data-testid="clone-picker-section"
        :data-account="section.account.accountId"
      >
        <div
          aria-hidden="true"
          data-testid="clone-picker-section-label"
          class="flex items-end gap-1.5 px-2 pt-2 pb-0.5 text-10.5 text-(--d-faint-text)"
          :class="index === 0 ? '' : 'border-t border-(--d-border)'"
        >
          <ForgeAvatar
            :login="section.account.login"
            :avatar-key="section.account.avatarKey"
            size="chip"
          />
          <span>{{ section.account.login }}</span><span>·</span><span
            dir="ltr"
            class="min-w-0 flex-1 truncate"
          >{{ section.account.serverName }}</span>
        </div>
        <div
          v-if="section.state.status === 'loading'"
          aria-hidden="true"
          data-testid="clone-picker-loading"
          class="flex min-h-7.5 items-center gap-2 px-2 text-11.5 text-(--d-faint-text)"
        >
          <LoaderCircle class="d-spinning size-3 shrink-0" />
          <span class="min-w-0 truncate">{{ t('clonePicker.searching', { server: section.account.serverName }) }}</span>
          <span class="clone-picker-skeleton ms-auto h-2 w-32 shrink rounded-5" />
        </div>
        <div
          v-if="listsNothing(section)"
          role="option"
          aria-disabled="true"
          aria-selected="false"
          data-testid="clone-picker-none"
          class="d-row-arrive flex min-h-7.5 items-center px-2 text-11.5 text-(--d-faint-text)"
        >
          {{ t('clonePicker.noRepositories') }}
        </div>
        <div
          v-for="entry in sectionEntries.get(section)"
          :id="optionId(entry)"
          :key="entry.id"
          role="option"
          :aria-selected="entry === active"
          :aria-label="optionName(entry)"
          :data-testid="entry.kind === 'repo' ? 'clone-picker-row' : 'clone-picker-error'"
          class="d-row-arrive flex min-h-7.5 cursor-pointer items-center gap-2.25 rounded-7 px-2 hover:bg-(--d-hover) aria-selected:bg-(--d-accent-soft)"
          @mousedown.prevent
          @click="activate(entry)"
        >
          <template v-if="entry.kind === 'repo'">
            <component
              :is="entry.row.visibility === 'public' ? Globe : Lock"
              aria-hidden="true"
              class="size-3 shrink-0 text-(--d-faint-text)"
            />
            <span
              dir="ltr"
              class="shrink-0 font-mono text-12 whitespace-nowrap"
            ><template
              v-for="(part, partIndex) in labelParts(entry.row)"
              :key="partIndex"
            ><mark
              v-if="part.match"
              class="quick-pick-match"
            >{{ part.text }}</mark><span
              v-else-if="part.namespace"
              class="text-(--d-muted)"
            >{{ part.text }}</span><template v-else>{{ part.text }}</template></template></span>
            <span
              data-testid="clone-picker-description"
              class="min-w-0 flex-1 truncate text-11 text-(--d-faint-text) @max-[34rem]/clone:hidden"
            ><template
              v-for="(segment, segmentIndex) in highlightSegments(entry.row.description ?? '', queryMatches(entry.row.description ?? '', query))"
              :key="segmentIndex"
            ><mark
              v-if="segment.match"
              class="quick-pick-match"
            >{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></span>
            <span
              v-if="entry.row.visibility !== 'public'"
              data-testid="clone-picker-pill"
              class="shrink-0 rounded-full border border-(--d-border2) px-1.5 text-10/4 text-(--d-faint-text) @max-[34rem]/clone:ms-auto"
            >{{ t(`clonePicker.visibility.${entry.row.visibility}`) }}</span>
            <span
              v-if="entry.row.pill"
              data-testid="clone-picker-pill"
              class="shrink-0 rounded-full border border-(--d-border2) px-1.5 text-10/4 text-(--d-faint-text)"
            >{{ t(`clonePicker.pill.${entry.row.pill}`) }}</span>
            <span
              v-if="entry.updated"
              data-testid="clone-picker-updated"
              class="shrink-0 text-10.5 text-(--d-faint-text) @max-[34rem]/clone:hidden"
            >{{ entry.updated }}</span>
          </template>
          <template v-else-if="entry.kind === 'retry'">
            <TriangleAlert
              aria-hidden="true"
              class="size-3 shrink-0 text-(--d-warning-text)"
            />
            <span class="min-w-0 truncate text-11.5 text-(--d-warning-text)">{{ t('clonePicker.unreachable', { server: entry.section.account.serverName }) }}</span>
            <span class="shrink-0 text-11.5 text-(--d-accent-text)">{{ t('clonePicker.retry') }}</span>
          </template>
          <template v-else-if="entry.kind === 'signIn'">
            <UserRound
              aria-hidden="true"
              class="size-3 shrink-0 text-(--d-warning-text)"
            />
            <span class="min-w-0 truncate text-11.5 text-(--d-warning-text)">{{ t('clonePicker.signInAgain', { server: entry.section.account.serverName }) }}</span>
          </template>
          <template v-else>
            <ShieldAlert
              aria-hidden="true"
              class="size-3 shrink-0 text-(--d-warning-text)"
            />
            <span class="min-w-0 truncate text-11.5 text-(--d-warning-text)">{{ refusedText(entry.section.account) }}</span>
            <span class="shrink-0 text-11.5 text-(--d-accent-text)">{{ t('clonePicker.openAccounts') }}</span>
          </template>
        </div>
      </div>
    </div>
    <div
      v-if="showNoResults"
      data-testid="clone-picker-no-results"
      class="flex flex-col items-start gap-2 px-3 py-4 text-12 text-(--d-muted)"
    >
      <span>{{ t('clonePicker.noResults', { query: query.trim(), n: accountCount }, accountCount) }}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="clone-picker-clear"
        class="d-press h-7 rounded-8 border-(--d-border2) bg-transparent px-2.75 text-12 font-normal text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text)"
        @click="clearSearch"
      >
        {{ t('clonePicker.clear') }}
      </Button>
    </div>
    <div
      v-if="showEmpty"
      data-testid="clone-picker-empty"
      class="flex flex-col items-start gap-2 px-3 py-4 text-12 text-(--d-muted)"
    >
      <span v-if="emptyReason === 'notLoaded'"><b class="font-semibold text-(--d-text)">{{ t('clonePicker.notLoadedTitle') }}</b> {{ t('clonePicker.notLoadedBody') }}</span>
      <span v-else><b class="font-semibold text-(--d-text)">{{ t('clonePicker.emptyTitle') }}</b> {{ t('clonePicker.emptyBody') }}</span>
      <Button
        v-if="emptyReason === 'notLoaded'"
        type="button"
        variant="outline"
        size="sm"
        data-testid="clone-picker-retry-accounts"
        class="d-press h-7 rounded-8 border-(--d-border2) bg-transparent px-2.75 text-12 font-normal text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text)"
        @click="retryAccounts"
      >
        {{ t('clonePicker.retry') }}
      </Button>
      <Button
        v-else
        type="button"
        variant="outline"
        size="sm"
        data-testid="clone-picker-open-accounts"
        class="d-press h-7 rounded-8 border-(--d-border2) bg-transparent px-2.75 text-12 font-normal text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text)"
        @click="openAccounts"
      >
        {{ t('clonePicker.openAccounts') }}
      </Button>
    </div>
    <p
      v-if="notUrl"
      data-testid="clone-picker-not-url"
      class="p-3 text-12 text-(--d-faint)"
    >
      {{ t('clonePicker.notUrl') }}
    </p>
    <div
      v-if="loadFailed"
      class="flex flex-col items-start gap-2 p-3"
    >
      <p
        role="alert"
        data-testid="clone-picker-failed"
        class="text-12 text-(--d-danger-text)"
      >
        {{ t('clonePicker.loadFailed') }}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="clone-picker-retry-accounts"
        class="d-press h-7 rounded-8 border-(--d-border2) bg-transparent px-2.75 text-12 font-normal text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text)"
        @click="retryAccounts"
      >
        {{ t('clonePicker.retry') }}
      </Button>
    </div>
    <p
      v-if="refused"
      role="alert"
      data-testid="clone-picker-failed"
      class="p-3 text-12 text-(--d-danger-text)"
    >
      {{ refused }}
    </p>
    <p
      role="status"
      data-testid="clone-picker-status"
      class="sr-only"
    >
      {{ status }}
    </p>
    <div
      aria-hidden="true"
      class="mt-1 flex flex-wrap items-center gap-3 border-t border-(--d-border) px-2 pt-2 pb-0.5 text-11 text-(--d-faint-text)"
    >
      <span><kbd class="clone-picker-key">↑</kbd> <kbd class="clone-picker-key">↓</kbd> {{ t('clonePicker.keys.choose') }}</span>
      <span><kbd class="clone-picker-key">Enter</kbd> {{ t('clonePicker.keys.clone') }}</span>
      <span><kbd class="clone-picker-key">Esc</kbd> {{ t('clonePicker.keys.close') }}</span>
    </div>
  </div>
</template>
