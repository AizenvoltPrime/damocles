<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Building2, Check, CloudUpload, Globe, LoaderCircle, Lock, RotateCw, TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import type { SegmentedOption } from '@/components/SegmentedToggle.vue';
import { isRepositoryName, sanitizeRepositoryName, typedRepositoryName, type PublishAccount, type PublishNamespace, type PublishState, type PublishVisibility } from '../../../../shared/forge/publish';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import { answerOf } from '../popup-answer';
import OverlayDialog, { type DialogButton } from './OverlayDialog.vue';
import FlowTimeline, { type FlowRow } from './FlowTimeline.vue';

// Publish: the Owner, Name and Visibility form, then Create, Add as origin and Push in the StepTimeline look. Main runs
// the steps and pushes the whole state; this page sends back the Owner value core issued, the sanitized name and a visibility.
// The dialog opens with each account's own namespace; its organizations or groups load here, per account.
const props = defineProps<{ api: DamoclesOverlayApi; request: Extract<OverlayRequest, { kind: 'forgePublish' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const dialog = computed(() => props.request.dialog);
const owner = ref(dialog.value.defaultOwner);

type OwnerListing =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly owners: readonly PublishNamespace[]; readonly truncated: boolean }
  | { readonly status: 'error'; readonly message: string };
const listings = shallowRef<Readonly<Record<string, OwnerListing>>>({});
// the latest listing asked per account; an answer to an older one is dropped
const asked = new Map<string, number>();
let askSeq = 0;
const listingOf = (accountId: string): OwnerListing => listings.value[accountId] ?? { status: 'loading' };
const ownersOf = (accountId: string): readonly PublishNamespace[] => {
  const listing = listingOf(accountId);
  return listing.status === 'loaded' ? listing.owners : [];
};

function setListing(account: PublishAccount, listing: OwnerListing): void {
  // an owner of the account that is no longer offered falls back to the account's own namespace, so the select stays valid
  if (listing.status !== 'loaded' && ownersOf(account.accountId).some((each) => each.value === owner.value)) owner.value = account.personal.value;
  listings.value = { ...listings.value, [account.accountId]: listing };
}

async function listOwners(account: PublishAccount): Promise<void> {
  const seq = ++askSeq;
  asked.set(account.accountId, seq);
  setListing(account, { status: 'loading' });
  let answer;
  try {
    answer = await answerOf(props.api.forgePublishOwners(dialog.value.requestId, account.accountId));
  } catch (error) {
    console.error('[publish] main refused the owner listing', error);
    if (asked.get(account.accountId) === seq) setListing(account, { status: 'error', message: t('forgePublish.owners.askFailed', { login: account.login, server: account.serverName }) });
    return;
  }
  // undefined: the dialog is closing; cancelled: a newer listing of this account or the close replaced it
  if (answer === undefined || answer.status === 'cancelled' || asked.get(account.accountId) !== seq) return;
  setListing(account, answer);
}

onMounted(() => {
  for (const account of dialog.value.accounts) void listOwners(account);
});

// Try again leaves with its error line, so focus goes to the Owner select.
const ownerSelect = ref<HTMLSelectElement | null>(null);
function tryAgain(account: PublishAccount): void {
  void listOwners(account);
  ownerSelect.value?.focus();
}

const truncated = (accountId: string): boolean => {
  const listing = listingOf(accountId);
  return listing.status === 'loaded' && listing.truncated;
};
const nounKey = (account: PublishAccount): 'groups' | 'orgs' => (account.kind === 'gitlab' ? 'groups' : 'orgs');
const errors = computed(() => dialog.value.accounts.flatMap((account) => {
  const listing = listingOf(account.accountId);
  return listing.status === 'error' ? [{ account, message: listing.message }] : [];
}));
const name = ref(dialog.value.defaultName);
const visibility = ref<PublishVisibility>('private');
// undefined until the first submit; refused shows the form again
const state = shallowRef<PublishState | undefined>();
const submitting = ref(false);
// main refused to start the publish, which is no fault of the name
const startFailed = ref(false);
// why the name was refused: the server's reason or the local rule
const refusal = ref<string | undefined>();
const nameBox = ref<HTMLElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const ids = { owner: useId(), ownerHint: useId(), name: useId(), nameMessage: useId(), visibility: useId() };

const selected = computed((): { readonly account: PublishAccount; readonly namespace: PublishNamespace } | undefined => {
  for (const account of dialog.value.accounts) {
    const namespace = [account.personal, ...ownersOf(account.accountId)].find((each) => each.value === owner.value);
    if (namespace) return { account, namespace };
  }
  return undefined;
});
const prefix = computed(() => (selected.value ? `${selected.value.account.serverName}/${selected.value.namespace.path}/` : ''));
const ownerHint = computed(() => {
  const pick = selected.value;
  if (!pick) return '';
  const { account, namespace } = pick;
  if (namespace.kind === 'personal') return t('forgePublish.hint.personal', { server: account.serverName });
  return namespace.kind === 'group' ? t('forgePublish.hint.group', { login: account.login }) : t('forgePublish.hint.org', { login: account.login, server: account.serverName });
});

const VISIBILITY_ICONS = { private: Lock, internal: Building2, public: Globe } as const;
const visibilities = computed((): SegmentedOption<PublishVisibility>[] => (['private', 'internal', 'public'] as const)
  .filter((value) => value !== 'internal' || selected.value?.namespace.internal === true)
  .map((value) => ({ value, label: t(`forgePublish.visibility.${value}`), icon: VISIBILITY_ICONS[value] })));

watch(owner, () => {
  refusal.value = undefined;
  if (visibility.value === 'internal' && selected.value?.namespace.internal !== true) visibility.value = 'private';
});

const phase = computed(() => (state.value === undefined || state.value.phase === 'refused' ? 'form' : state.value.phase));
const flow = computed(() => (state.value === undefined || state.value.phase === 'refused' ? undefined : state.value));

// The class comes off and goes back on, so a second refusal plays the shake again.
function shake(): void {
  const box = nameBox.value;
  if (!box) return;
  box.classList.remove('d-shake');
  void box.offsetWidth;
  box.classList.add('d-shake');
}

async function refuse(reason: string): Promise<void> {
  refusal.value = reason;
  await nextTick();
  shake();
  nameInput.value?.focus();
}

onScopeDispose(props.api.onForgePublishState((next) => {
  if (next.requestId !== dialog.value.requestId) return;
  state.value = next;
  submitting.value = false;
  if (next.phase === 'refused') void refuse(next.reason);
}));

function onNameInput(event: Event): void {
  const field = event.target as HTMLInputElement;
  const typed = typedRepositoryName(field.value);
  // the bound value may already equal the dashed text, so the field is written directly; the dashes keep the length, so the caret stays
  if (typed !== field.value) {
    const { selectionStart, selectionEnd } = field;
    field.value = typed;
    field.setSelectionRange(selectionStart, selectionEnd);
  }
  name.value = typed;
  refusal.value = undefined;
  startFailed.value = false;
}

async function submit(): Promise<void> {
  if (submitting.value || phase.value !== 'form' || selected.value === undefined) return;
  const clean = sanitizeRepositoryName(name.value);
  name.value = clean;
  if (!isRepositoryName(clean)) {
    await refuse(t('forgePublish.nameRule'));
    return;
  }
  refusal.value = undefined;
  startFailed.value = false;
  submitting.value = true;
  try {
    // ignored: main runs nothing and pushes no state, so the form takes the next submit
    if ((await answerOf(props.api.forgePublishSubmit(dialog.value.requestId, owner.value, clean, visibility.value))) === 'ignored') submitting.value = false;
  } catch (error) {
    console.error('[publish] main refused the submit', error);
    submitting.value = false;
    startFailed.value = true;
  }
}

const stepRows = computed((): FlowRow[] => {
  const current = flow.value;
  if (!current) return [];
  const { target } = current;
  const LABELS = {
    create: t('forgePublish.step.create', { path: target.path, server: target.serverName }),
    origin: t('forgePublish.step.origin'),
    push: t('forgePublish.step.push', { branch: target.branch, login: target.login }),
  } as const;
  return current.steps.map((step) => ({ id: step.step, state: step.state, label: LABELS[step.step], ...(step.failure !== undefined ? { failure: step.failure } : {}) }));
});

const doneText = computed(() => {
  const current = flow.value;
  return current?.phase === 'done' ? t('forgePublish.done', { server: current.target.serverName, path: current.target.path, login: current.target.login }) : '';
});

const title = computed(() => {
  const current = flow.value;
  if (!current) return t('forgePublish.title', { project: dialog.value.project });
  return t(current.phase === 'done' ? 'forgePublish.titleDone' : 'forgePublish.titleRunning', { path: current.target.path });
});

const cancellable = computed(() => flow.value?.phase === 'running' && flow.value.cancellable);
const buttons = computed((): DialogButton[] => {
  if (phase.value === 'form') {
    return [
      { label: t('forgePublish.cancel'), variant: 'plain', testId: 'forge-publish-cancel' },
      { label: t('forgePublish.publish'), variant: 'fill', icon: CloudUpload, testId: 'forge-publish-go', disabled: submitting.value || selected.value === undefined },
    ];
  }
  if (phase.value === 'running') return cancellable.value ? [{ label: t('forgePublish.cancel'), variant: 'plain', testId: 'forge-publish-cancel' }] : [];
  return [{ label: t('forgePublish.close'), variant: 'fill', testId: 'forge-publish-close' }];
});
// running past the point of no return: Escape and the scrim do nothing
const cancelIndex = computed(() => (phase.value === 'running' && !cancellable.value ? -1 : 0));

function onChoose(index: number): void {
  if (index < 0) return;
  if (phase.value === 'form' && index === 1) void submit();
  else emit('answer', { kind: 'dismissed' });
}

// A control that goes away hands focus to the next one: Close once the flow ends, else the dialog itself.
const status = ref<HTMLElement | null>(null);
const panel = (): HTMLElement | null => status.value?.closest<HTMLElement>('[data-overlay-layer]') ?? null;
watch([phase, cancellable], async ([now, canCancel], [before, couldCancel]) => {
  if (now === before && canCancel === couldCancel) return;
  await nextTick();
  if (now === 'form') return;
  const target = now === 'running' ? (canCancel ? '[data-testid="forge-publish-cancel"]' : null) : '[data-testid="forge-publish-close"]';
  const root = panel();
  (target ? root?.querySelector<HTMLElement>(target) : root)?.focus();
});
</script>

<template>
  <OverlayDialog
    :severity="phase === 'done' ? 'success' : 'accent'"
    :icon="phase === 'done' ? Check : CloudUpload"
    role="dialog"
    :title="title"
    :buttons="buttons"
    :initial-focus="1"
    :cancel-index="cancelIndex"
    :scrim-inert="phase === 'form' || phase === 'running'"
    wide
    test-id="forge-publish"
    :data-phase="phase"
    @choose="onChoose"
  >
    <p
      v-if="phase === 'form'"
      class="text-12.5/relaxed text-pretty text-(--d-muted)"
    >
      <i18n-t
        keypath="forgePublish.message"
        scope="global"
      >
        <template #origin>
          <span
            dir="ltr"
            class="font-mono text-(--d-text)"
          >origin</span>
        </template>
        <template #branch>
          <span
            dir="ltr"
            class="font-mono text-(--d-text)"
          >{{ dialog.branch }}</span>
        </template>
      </i18n-t>
    </p>
    <template #controls>
      <form
        v-show="phase === 'form'"
        class="mt-2 flex flex-col gap-3"
        novalidate
        data-testid="forge-publish-form"
        @submit.prevent="submit"
      >
        <div class="flex flex-col gap-1.5">
          <label
            :for="ids.owner"
            class="text-12 font-medium"
          >{{ t('forgePublish.owner') }}</label>
          <!-- A native select: optgroups per account, and the journey picks by the opaque value. -->
          <select
            :id="ids.owner"
            ref="ownerSelect"
            v-model="owner"
            data-overlay-initial-focus
            data-testid="forge-publish-owner"
            :aria-describedby="ids.ownerHint"
            class="h-8 w-full min-w-0 cursor-pointer rounded-9 border border-(--d-border2) bg-(--d-input) px-2.5 text-12.5 text-(--d-text) outline-none hover:border-(--d-accent) focus-visible:border-(--d-accent)"
          >
            <optgroup
              v-for="account in dialog.accounts"
              :key="account.accountId"
              :label="t('forgePublish.accountOn', { login: account.login, server: account.serverName })"
            >
              <option :value="account.personal.value">
                {{ t('forgePublish.you', { login: account.login }) }}
              </option>
              <option
                v-for="namespace in ownersOf(account.accountId)"
                :key="namespace.value"
                :value="namespace.value"
              >
                {{ namespace.path }}
              </option>
              <option
                v-if="listingOf(account.accountId).status === 'loading'"
                disabled
                value=""
                data-testid="forge-publish-owner-loading-option"
              >
                {{ t(`forgePublish.owners.loadingOption.${nounKey(account)}`) }}
              </option>
            </optgroup>
          </select>
          <p
            :id="ids.ownerHint"
            data-testid="forge-publish-owner-hint"
            class="text-11.5 text-(--d-muted)"
          >
            {{ ownerHint }}
          </p>
          <!-- polite and not atomic: each account's line is read out on its own as its listing changes -->
          <div
            role="status"
            aria-atomic="false"
            data-testid="forge-publish-owners-status"
            class="flex flex-col gap-1 empty:hidden"
          >
            <template
              v-for="account in dialog.accounts"
              :key="account.accountId"
            >
              <p
                v-if="listingOf(account.accountId).status === 'loading'"
                class="flex items-center gap-1.5 text-11.5 text-(--d-muted)"
                data-testid="forge-publish-owners-loading"
                :data-account="account.accountId"
              >
                <span
                  class="grid size-3 shrink-0 place-items-center"
                  aria-hidden="true"
                >
                  <LoaderCircle class="timeline-spinner d-spinning size-3" />
                  <span class="timeline-ellipsis text-11 leading-none font-semibold">…</span>
                </span>
                <span class="min-w-0">{{ t(`forgePublish.owners.loading.${nounKey(account)}`, { login: account.login, server: account.serverName }) }}</span>
                <span
                  class="relative block h-2 w-16 shrink-0 overflow-hidden rounded-5 bg-(--d-hover) text-(--d-text)"
                  aria-hidden="true"
                ><span class="d-sheen" /></span>
              </p>
              <template v-else-if="listingOf(account.accountId).status === 'loaded'">
                <p
                  v-if="truncated(account.accountId)"
                  class="text-11.5 text-(--d-warning-text)"
                  data-testid="forge-publish-owners-truncated"
                  :data-account="account.accountId"
                >
                  {{ t(`forgePublish.owners.truncated.${nounKey(account)}`, { count: ownersOf(account.accountId).length, login: account.login, server: account.serverName }) }}
                </p>
                <p
                  v-else
                  class="sr-only"
                  data-testid="forge-publish-owners-loaded"
                >
                  {{ t(`forgePublish.owners.loaded.${nounKey(account)}`, { login: account.login, server: account.serverName, count: ownersOf(account.accountId).length }, ownersOf(account.accountId).length) }}
                </p>
              </template>
            </template>
          </div>
          <div
            v-for="{ account, message } in errors"
            :key="account.accountId"
            class="flex items-start gap-1.5 text-11.5 text-(--d-warning-text)"
            data-testid="forge-publish-owners-error"
            :data-account="account.accountId"
          >
            <TriangleAlert
              class="mt-0.5 size-3 shrink-0"
              aria-hidden="true"
            />
            <p
              role="alert"
              class="min-w-0 flex-1 wrap-break-word"
            >
              {{ message }}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              class="d-press h-6 shrink-0 gap-1 rounded-7 border-(--d-border2) bg-transparent px-2 text-11.5 font-normal text-(--d-text) hover:bg-(--d-hover) [&_svg]:size-3"
              data-testid="forge-publish-owners-retry"
              :aria-label="t('forgePublish.owners.tryAgainFor', { login: account.login, server: account.serverName })"
              @click="tryAgain(account)"
            >
              <RotateCw aria-hidden="true" />{{ t('forgePublish.owners.tryAgain') }}
            </Button>
          </div>
        </div>
        <div class="flex flex-col gap-1.5">
          <label
            :for="ids.name"
            class="text-12 font-medium"
          >{{ t('forgePublish.name') }}</label>
          <div
            ref="nameBox"
            data-testid="forge-publish-name-box"
            :data-invalid="refusal ? '' : undefined"
            class="flex h-8 min-w-0 items-center gap-1 rounded-9 border bg-(--d-input) px-2.5"
            :class="refusal ? 'border-(--d-danger)' : 'border-(--d-border2) focus-within:border-(--d-accent)'"
            @animationend="nameBox?.classList.remove('d-shake')"
          >
            <span
              aria-hidden="true"
              dir="ltr"
              data-testid="forge-publish-prefix"
              class="max-w-[55%] shrink-0 truncate font-mono text-12 text-(--d-faint-text)"
            >{{ prefix }}</span>
            <!-- A bare field beside the owner prefix: the shadcn Input part draws its own border and ring, which the box around both draws here. -->
            <input
              :id="ids.name"
              ref="nameInput"
              :value="name"
              type="text"
              dir="ltr"
              autocomplete="off"
              spellcheck="false"
              data-testid="forge-publish-name"
              :aria-invalid="refusal ? 'true' : undefined"
              :aria-describedby="ids.nameMessage"
              class="min-w-0 flex-1 border-0 bg-transparent font-mono text-12.5 text-(--d-text) outline-none"
              @input="onNameInput"
              @keydown.enter.prevent="submit"
            >
          </div>
          <p
            v-show="!refusal"
            :id="refusal ? undefined : ids.nameMessage"
            class="text-11.5 text-(--d-muted)"
          >
            {{ t('forgePublish.nameHint') }}
          </p>
          <p
            v-if="refusal"
            :id="ids.nameMessage"
            role="alert"
            data-testid="forge-publish-refusal"
            class="text-11.5 wrap-break-word text-(--d-danger-text)"
          >
            {{ refusal }}
          </p>
        </div>
        <div class="flex flex-col gap-1.5">
          <span
            :id="ids.visibility"
            class="text-12 font-medium"
          >{{ t('forgePublish.visibilityLabel') }}</span>
          <SettingSeg
            v-model="visibility"
            :options="visibilities"
            :label="t('forgePublish.visibilityLabel')"
            :aria-labelledby="ids.visibility"
            radios
            class="self-start"
            data-testid="forge-publish-visibility"
          />
        </div>
      </form>
      <p
        v-if="startFailed"
        role="alert"
        data-testid="forge-publish-start-failed"
        class="text-12 text-(--d-danger-text)"
      >
        {{ t('forgePublish.submitFailed') }}
      </p>
      <FlowTimeline
        v-if="flow"
        class="mt-1"
        :rows="stepRows"
        :failed="flow.phase === 'failed'"
      />
      <p
        ref="status"
        role="status"
        data-testid="forge-publish-status"
        class="text-12.5/relaxed text-pretty"
        v-text="doneText"
      />
    </template>
  </OverlayDialog>
</template>
