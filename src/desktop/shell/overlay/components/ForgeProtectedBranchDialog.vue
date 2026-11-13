<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, GitBranchPlus, GitPullRequestArrow } from 'lucide-vue-next';
import { MAX_BRANCH_NAME_CHARS, type BranchNameCheck, type BranchNameProblem, type ProtectedPushState } from '../../../../shared/forge/protected-push';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import { answerOf } from '../popup-answer';
import OverlayDialog, { type DialogButton } from './OverlayDialog.vue';
import FlowTimeline, { type FlowRow } from './FlowTimeline.vue';

// A push the server refused because the branch is protected for the account: the question, then the new branch's name with
// git's rules checked as the user types, then the branch and push steps in the StepTimeline look and Open Pull/Merge Request.
// Main creates and pushes the branch and pushes the whole state; the local branch the push came from is never moved.
const props = defineProps<{ api: DamoclesOverlayApi; request: Extract<OverlayRequest, { kind: 'forgeProtectedBranch' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const dialog = computed(() => props.request.dialog);
const github = computed(() => dialog.value.kind === 'github');
const naming = ref(false);
const name = ref(dialog.value.suggestedName);
// undefined until a submit; refused shows the name step again
const state = shallowRef<ProtectedPushState | undefined>();
const submitting = ref(false);
const startFailed = ref(false);
const ids = { name: useId(), message: useId() };
const nameBox = ref<HTMLElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const status = ref<HTMLElement | null>(null);

// The answer for the name the field shows; an answer for an earlier value is dropped.
const check = shallowRef<BranchNameCheck | undefined>();
const checkFailed = ref(false);
// a pause in typing this long asks main once
const CHECK_DELAY_MS = 150;
let checkTimer: ReturnType<typeof setTimeout> | undefined;
onScopeDispose(() => clearTimeout(checkTimer));

async function runCheck(value: string): Promise<void> {
  if (value === '') {
    check.value = { name: value, problem: 'empty' };
    return;
  }
  let answer: BranchNameCheck | undefined;
  try {
    answer = await answerOf(props.api.forgeProtectedCheckName(dialog.value.requestId, value));
  } catch (error) {
    console.error('[protected branch] main refused the name check', error);
    if (name.value === value) checkFailed.value = true;
    return;
  }
  if (answer !== undefined && answer.name === name.value) check.value = answer;
}

function scheduleCheck(): void {
  clearTimeout(checkTimer);
  check.value = undefined;
  checkFailed.value = false;
  const value = name.value;
  checkTimer = setTimeout(() => void runCheck(value), CHECK_DELAY_MS);
}

const problem = computed((): BranchNameProblem | undefined => (check.value?.name === name.value ? check.value.problem : undefined));
const problemText = computed(() => {
  const current = problem.value;
  if (current === undefined) return '';
  return t(`forgeProtected.problem.${current}`, { name: name.value, remote: dialog.value.remote });
});

const phase = computed(() => {
  const current = state.value;
  if (current === undefined || current.phase === 'refused') return naming.value ? 'name' : 'ask';
  return current.phase;
});
const flow = computed(() => (state.value === undefined || state.value.phase === 'refused' ? undefined : state.value));

// The class comes off and goes back on, so a second refusal plays the shake again.
function shake(): void {
  const box = nameBox.value;
  if (!box) return;
  box.classList.remove('d-shake');
  void box.offsetWidth;
  box.classList.add('d-shake');
}

onScopeDispose(props.api.onForgeProtectedState((next) => {
  if (next.requestId !== dialog.value.requestId) return;
  state.value = next;
  submitting.value = false;
  if (next.phase !== 'refused') return;
  naming.value = true;
  name.value = next.name;
  check.value = { name: next.name, problem: next.problem };
  void nextTick(() => {
    shake();
    nameInput.value?.focus();
  });
}));

async function askName(): Promise<void> {
  naming.value = true;
  clearTimeout(checkTimer);
  void runCheck(name.value);
  await nextTick();
  nameInput.value?.focus();
  nameInput.value?.select();
}

function onNameInput(event: Event): void {
  name.value = (event.target as HTMLInputElement).value;
  startFailed.value = false;
  scheduleCheck();
}

async function submit(): Promise<void> {
  if (submitting.value || phase.value !== 'name') return;
  if (name.value === '' || problem.value !== undefined) {
    if (name.value === '') check.value = { name: '', problem: 'empty' };
    shake();
    nameInput.value?.focus();
    return;
  }
  clearTimeout(checkTimer);
  submitting.value = true;
  startFailed.value = false;
  try {
    // ignored: main runs nothing and pushes no state, so the form takes the next submit
    if ((await answerOf(props.api.forgeProtectedPush(dialog.value.requestId, name.value))) === 'ignored') submitting.value = false;
  } catch (error) {
    console.error('[protected branch] main refused to start the push', error);
    submitting.value = false;
    startFailed.value = true;
  }
}

const stepRows = computed((): FlowRow[] => {
  const current = flow.value;
  if (!current) return [];
  const LABELS = {
    branch: t('forgeProtected.step.branch', { name: current.name }),
    push: t('forgeProtected.step.push', { name: current.name, remote: dialog.value.remote }),
  } as const;
  return current.steps.map((step) => ({ id: step.step, state: step.state, label: LABELS[step.step], ...(step.failure !== undefined ? { failure: step.failure } : {}) }));
});

const title = computed(() => {
  const current = flow.value;
  if (current) return t(`forgeProtected.title.${current.phase}`, { name: current.name });
  return phase.value === 'name' ? t('forgeProtected.title.name') : t('forgeProtected.title.ask', { branch: dialog.value.branch, server: dialog.value.serverName });
});

const openLabel = computed(() => t(github.value ? 'forgeProtected.openPullRequest' : 'forgeProtected.openMergeRequest'));
const buttons = computed((): DialogButton[] => {
  switch (phase.value) {
    case 'ask': return [
      { label: t('forgeProtected.cancel'), variant: 'plain', testId: 'forge-protected-cancel' },
      { label: t('forgeProtected.pushToNewBranch'), variant: 'fill', icon: GitBranchPlus, testId: 'forge-protected-new-branch' },
    ];
    case 'name': return [
      { label: t('forgeProtected.cancel'), variant: 'plain', testId: 'forge-protected-cancel' },
      { label: t('forgeProtected.push'), variant: 'fill', icon: GitBranchPlus, testId: 'forge-protected-push', disabled: submitting.value || problem.value !== undefined },
    ];
    case 'running': return [];
    case 'failed': return [{ label: t('forgeProtected.close'), variant: 'fill', testId: 'forge-protected-close' }];
  }
  return [
    { label: t('forgeProtected.close'), variant: 'plain', testId: 'forge-protected-close' },
    { label: openLabel.value, variant: 'fill', icon: GitPullRequestArrow, testId: 'forge-protected-open' },
  ];
});
// the steps have started: Escape and the scrim do nothing until they end
const cancelIndex = computed(() => (phase.value === 'running' ? -1 : 0));

function onChoose(index: number): void {
  if (index < 0) return;
  if (phase.value === 'ask' && index === 1) void askName();
  else if (phase.value === 'name' && index === 1) void submit();
  else if (phase.value === 'done' && index === 1) emit('answer', { kind: 'forgeProtectedBranch', openMergeRequest: true });
  else emit('answer', { kind: 'dismissed' });
}

// A control that goes away hands focus to the next one: the dialog itself while the steps run, Close or the primary after.
watch(phase, async (now, before) => {
  if (now === before || now === 'ask' || now === 'name') return;
  await nextTick();
  const root = status.value?.closest<HTMLElement>('[data-overlay-layer]');
  const testId = now === 'failed' ? 'forge-protected-close' : now === 'done' ? 'forge-protected-open' : null;
  (testId ? root?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) : root)?.focus();
});

const failedStep = computed(() => flow.value?.steps.find((step) => step.state === 'failed')?.step);
const statusText = computed(() => {
  const current = flow.value;
  const { localBranch, remote } = dialog.value;
  if (current?.phase === 'done') return t('forgeProtected.done', { name: current.name, remote, localBranch });
  if (current?.phase !== 'failed') return '';
  return failedStep.value === 'push' ? t('forgeProtected.failedOnBranch', { name: current.name, localBranch }) : t('forgeProtected.failedBefore');
});
</script>

<template>
  <OverlayDialog
    :severity="phase === 'ask' ? 'warning' : phase === 'done' ? 'success' : 'accent'"
    :icon="phase === 'ask' ? undefined : phase === 'done' ? Check : GitBranchPlus"
    :role="phase === 'ask' ? 'alertdialog' : 'dialog'"
    :title="title"
    :buttons="buttons"
    :initial-focus="1"
    :cancel-index="cancelIndex"
    :scrim-inert="phase === 'name'"
    wide
    test-id="forge-protected"
    :data-phase="phase"
    @choose="onChoose"
  >
    <template v-if="phase === 'ask'">
      <p class="text-12.5/relaxed text-pretty text-(--d-muted)">
        <i18n-t
          :keypath="github ? 'forgeProtected.messageGithub' : 'forgeProtected.messageGitlab'"
          scope="global"
        >
          <template #server>
            <span dir="ltr">{{ dialog.serverName }}</span>
          </template>
          <template #login>
            <span
              dir="ltr"
              class="font-mono text-(--d-text)"
            >{{ dialog.login }}</span>
          </template>
          <template #branch>
            <span
              dir="ltr"
              class="font-mono text-(--d-text)"
            >{{ dialog.branch }}</span>
          </template>
        </i18n-t>
      </p>
      <p
        v-if="dialog.unpushedCount > 0"
        data-testid="forge-protected-unpushed"
        class="text-12.5/relaxed text-pretty text-(--d-muted)"
      >
        <i18n-t
          keypath="forgeProtected.unpushed"
          scope="global"
          :plural="dialog.unpushedCount"
        >
          <template #count>
            {{ dialog.unpushedCount }}
          </template>
          <template #localBranch>
            <span
              dir="ltr"
              class="font-mono text-(--d-text)"
            >{{ dialog.localBranch }}</span>
          </template>
          <template #remote>
            <span
              dir="ltr"
              class="font-mono text-(--d-text)"
            >{{ dialog.remote }}</span>
          </template>
        </i18n-t>
      </p>
    </template>
    <p
      v-else-if="phase === 'name'"
      class="text-12.5/relaxed text-pretty text-(--d-muted)"
    >
      <i18n-t
        keypath="forgeProtected.nameMessage"
        scope="global"
      >
        <template #remote>
          <span
            dir="ltr"
            class="font-mono text-(--d-text)"
          >{{ dialog.remote }}</span>
        </template>
        <template #localBranch>
          <span
            dir="ltr"
            class="font-mono text-(--d-text)"
          >{{ dialog.localBranch }}</span>
        </template>
      </i18n-t>
    </p>
    <template #controls>
      <form
        v-if="phase === 'name'"
        class="mt-2 flex flex-col gap-1.5"
        novalidate
        data-testid="forge-protected-form"
        @submit.prevent="submit"
      >
        <label
          :for="ids.name"
          class="text-12 font-medium"
        >{{ t('forgeProtected.nameLabel') }}</label>
        <div
          ref="nameBox"
          data-testid="forge-protected-name-box"
          :data-invalid="problem ? '' : undefined"
          class="flex h-8 min-w-0 items-center rounded-9 border bg-(--d-input) px-2.5"
          :class="problem ? 'border-(--d-danger)' : 'border-(--d-border2) focus-within:border-(--d-accent)'"
          @animationend="nameBox?.classList.remove('d-shake')"
        >
          <!-- A bare field in the box the shake moves: the shadcn Input part brings its own border and ring, which the box draws here. -->
          <input
            :id="ids.name"
            ref="nameInput"
            :value="name"
            type="text"
            dir="ltr"
            autocomplete="off"
            spellcheck="false"
            :maxlength="MAX_BRANCH_NAME_CHARS"
            data-overlay-initial-focus
            data-testid="forge-protected-name"
            :aria-invalid="problem ? 'true' : undefined"
            :aria-describedby="ids.message"
            class="min-w-0 flex-1 border-0 bg-transparent font-mono text-12.5 text-(--d-text) outline-none"
            @input="onNameInput"
            @keydown.enter.prevent="submit"
          >
        </div>
        <!-- polite: the check follows each pause in typing, so an alert would interrupt every word -->
        <p
          :id="ids.message"
          aria-live="polite"
          data-testid="forge-protected-name-message"
          class="text-11.5 wrap-break-word"
          :class="problem ? 'text-(--d-danger-text)' : checkFailed ? 'text-(--d-warning-text)' : 'text-(--d-muted)'"
        >
          {{ problem ? problemText : checkFailed ? t('forgeProtected.checkFailed') : t('forgeProtected.nameHint', { remote: dialog.remote }) }}
        </p>
      </form>
      <p
        v-if="startFailed"
        role="alert"
        data-testid="forge-protected-start-failed"
        class="text-12 text-(--d-danger-text)"
      >
        {{ t('forgeProtected.startFailed') }}
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
        data-testid="forge-protected-status"
        class="text-12.5/relaxed text-pretty text-(--d-muted)"
        v-text="statusText"
      />
    </template>
  </OverlayDialog>
</template>
