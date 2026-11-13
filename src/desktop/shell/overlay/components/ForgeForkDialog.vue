<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, GitFork, GitPullRequestArrow } from 'lucide-vue-next';
import type { ForkState } from '../../../../shared/forge/publish';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import { answerOf } from '../popup-answer';
import OverlayDialog, { type DialogButton } from './OverlayDialog.vue';
import FlowTimeline, { type FlowRow } from './FlowTimeline.vue';

// Fork on a denied push: the warning naming the account and branch, then Fork and Push in the StepTimeline look,
// cancellable until the push starts, and on success the remotes and Open Merge Request (Open Pull Request on GitHub).
const props = defineProps<{ api: DamoclesOverlayApi; request: Extract<OverlayRequest, { kind: 'forgeFork' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const dialog = computed(() => props.request.dialog);
// undefined: the warning, before Fork and Push
const state = shallowRef<ForkState | undefined>();
const starting = ref(false);
const startFailed = ref(false);

onScopeDispose(props.api.onForgeForkState((next) => {
  if (next.requestId !== dialog.value.requestId) return;
  state.value = next;
  starting.value = false;
}));

const phase = computed(() => state.value?.phase ?? 'ask');
const cancellable = computed(() => state.value?.phase === 'running' && state.value.cancellable);
const github = computed(() => dialog.value.kind === 'github');

async function start(): Promise<void> {
  if (starting.value) return;
  starting.value = true;
  startFailed.value = false;
  try {
    // ignored: main runs nothing and pushes no state, so Fork and Push takes the next click
    if ((await answerOf(props.api.forgeForkStart(dialog.value.requestId))) === 'ignored') starting.value = false;
  } catch (error) {
    console.error('[fork] main refused to start Fork and Push', error);
    starting.value = false;
    startFailed.value = true;
  }
}

const stepRows = computed((): FlowRow[] => {
  const current = state.value;
  if (!current) return [];
  const { path, login, serverName, remote, upstreamName, branch } = dialog.value;
  const LABELS = {
    fork: t('forgeFork.step.fork', { path, login }),
    rename: t('forgeFork.step.rename', { remote, upstream: upstreamName }),
    origin: t('forgeFork.step.origin'),
    push: t('forgeFork.step.push', { branch }),
  } as const;
  return current.steps.map((step) => ({
    id: step.step,
    state: step.state,
    label: LABELS[step.step],
    ...(step.step === 'fork' ? { sub: t('forgeFork.waiting', { server: serverName }) } : {}),
    ...(step.failure !== undefined ? { failure: step.failure } : {}),
  }));
});

const title = computed(() => {
  if (phase.value === 'ask') return t('forgeFork.title', { path: dialog.value.path });
  return phase.value === 'done' ? t('forgeFork.titleDone') : t('forgeFork.titleRunning', { path: dialog.value.path });
});

const openLabel = computed(() => t(github.value ? 'forgeFork.openPullRequest' : 'forgeFork.openMergeRequest'));
const buttons = computed((): DialogButton[] => {
  if (phase.value === 'ask') {
    return [
      { label: t('forgeFork.cancel'), variant: 'plain', testId: 'forge-fork-cancel' },
      { label: t('forgeFork.forkAndPush'), variant: 'fill', icon: GitFork, testId: 'forge-fork-go', disabled: starting.value },
    ];
  }
  if (phase.value === 'running') return cancellable.value ? [{ label: t('forgeFork.cancel'), variant: 'plain', testId: 'forge-fork-cancel' }] : [];
  if (phase.value === 'failed') return [{ label: t('forgeFork.close'), variant: 'fill', testId: 'forge-fork-close' }];
  return [
    { label: t('forgeFork.close'), variant: 'plain', testId: 'forge-fork-close' },
    { label: openLabel.value, variant: 'fill', icon: GitPullRequestArrow, testId: 'forge-fork-open' },
  ];
});
// the push has started: Escape and the scrim do nothing until it ends
const cancelIndex = computed(() => (phase.value === 'running' && !cancellable.value ? -1 : 0));

function onChoose(index: number): void {
  if (index < 0) return;
  if (phase.value === 'ask' && index === 1) void start();
  else if (phase.value === 'done' && index === 1) emit('answer', { kind: 'forgeFork', openMergeRequest: true });
  else emit('answer', { kind: 'dismissed' });
}

// A control that goes away hands focus to the next one: Cancel while it lasts, the primary at the end, else the dialog itself.
const status = ref<HTMLElement | null>(null);
watch([phase, cancellable], async ([now, canCancel], [before, couldCancel]) => {
  if (now === before && canCancel === couldCancel) return;
  await nextTick();
  const root = status.value?.closest<HTMLElement>('[data-overlay-layer]');
  const FOCUS = { ask: null, running: canCancel ? 'forge-fork-cancel' : null, failed: 'forge-fork-close', done: 'forge-fork-open' } as const;
  const testId = FOCUS[now];
  (testId ? root?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) : root)?.focus();
});

const statusText = computed(() => {
  const current = state.value;
  if (current?.phase === 'failed') {
    if (current.restored) return t('forgeFork.restored');
    // a failed restore is told in the failure box, and the remotes are then in no layout this line could name
    return current.restoreFailed ? '' : t('forgeFork.keptLayout', { upstream: dialog.value.upstreamName, server: dialog.value.serverName, path: dialog.value.path });
  }
  return current?.phase === 'done' ? t('forgeFork.pushed', { branch: dialog.value.branch }) : '';
});
</script>

<template>
  <OverlayDialog
    :severity="phase === 'ask' ? 'warning' : phase === 'done' ? 'success' : 'accent'"
    :icon="phase === 'ask' ? undefined : phase === 'done' ? Check : GitFork"
    :role="phase === 'ask' ? 'alertdialog' : 'dialog'"
    :title="title"
    :buttons="buttons"
    :initial-focus="0"
    :cancel-index="cancelIndex"
    :scrim-inert="phase === 'running'"
    wide
    test-id="forge-fork"
    :data-phase="phase"
    @choose="onChoose"
  >
    <template v-if="phase === 'ask'">
      <p class="text-12.5/relaxed text-pretty text-(--d-muted)">
        <i18n-t
          :keypath="github ? 'forgeFork.messageGithub' : 'forgeFork.messageGitlab'"
          scope="global"
        >
          <template #login>
            <span
              dir="ltr"
            >{{ dialog.login }}</span>
          </template>
          <template #server>
            <span
              dir="ltr"
            >{{ dialog.serverName }}</span>
          </template>
          <template #path>
            <span
              dir="ltr"
              class="font-mono text-(--d-text)"
            >{{ dialog.path }}</span>
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
        v-if="dialog.upstreamExists"
        data-testid="forge-fork-upstream-exists"
        class="text-12.5/relaxed text-pretty text-(--d-warning-text)"
      >
        <i18n-t
          keypath="forgeFork.upstreamExists"
          scope="global"
        >
          <template #taken>
            <span
              dir="ltr"
              class="font-mono"
            >upstream</span>
          </template>
          <template #upstream>
            <span
              dir="ltr"
              class="font-mono"
            >{{ dialog.upstreamName }}</span>
          </template>
        </i18n-t>
      </p>
    </template>
    <template #controls>
      <p
        v-if="startFailed"
        role="alert"
        data-testid="forge-fork-start-failed"
        class="text-12 text-(--d-danger-text)"
      >
        {{ t('forgeFork.startFailed') }}
      </p>
      <FlowTimeline
        v-if="state"
        class="mt-1"
        :rows="stepRows"
        :failed="state.phase === 'failed'"
      />
      <dl
        v-if="state?.phase === 'done'"
        :aria-label="t('forgeFork.remotes')"
        data-testid="forge-fork-remotes"
        class="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-8 bg-(--d-hover) px-2.5 py-2 font-mono text-11.5"
      >
        <template
          v-for="row in state.remotes"
          :key="row.name"
        >
          <dt
            dir="ltr"
            class="text-(--d-faint-text)"
          >
            {{ row.name }}
          </dt>
          <dd
            dir="ltr"
            class="m-0 wrap-anywhere"
          >
            {{ row.display }}
          </dd>
        </template>
      </dl>
      <p
        ref="status"
        role="status"
        data-testid="forge-fork-status"
        class="text-12.5/relaxed text-pretty text-(--d-muted)"
        v-text="statusText"
      />
    </template>
  </OverlayDialog>
</template>
