<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { CiStatusView } from '@shared/forge/ci';
import type { DamoclesShellApi } from '../../preload/shell-channels';
import { ciLook, ciOtherCommit, ciPipelineName, ciStateWord } from './ci-view';

/**
 * The CI chip between the branch and sync buttons, drawn like SyncButton: the pipeline's state icon, "done/total" while it
 * runs, the failed count once it failed. A click opens the job list in the overlay, end-aligned to the chip.
 */
const props = defineProps<{ api: DamoclesShellApi; repoId: string; status: Exclude<CiStatusView, { status: 'none' }> }>();
const { t } = useI18n();

const pipeline = computed(() => (props.status.status === 'ready' ? props.status.pipeline : undefined));
const look = computed(() => (pipeline.value ? ciLook(pipeline.value.state) : undefined));
const text = computed(() => {
  const shown = pipeline.value;
  if (shown?.state === 'running') return `${shown.jobsDone}/${shown.jobsTotal}`;
  if (shown?.state === 'failed' && shown.failedCount > 0) return String(shown.failedCount);
  return '';
});
const name = computed(() => {
  const shown = pipeline.value;
  if (props.status.status === 'error') return t('forge.ci.chip.error');
  if (!shown) return t('forge.ci.chip.loading');
  const named = { name: ciPipelineName(shown, (key, values) => (values ? t(key, values) : t(key))), state: ciStateWord(shown.state, t) };
  if (shown.state === 'running') return t('forge.ci.chip.running', { ...named, done: shown.jobsDone, total: shown.jobsTotal });
  if (shown.state === 'failed' && shown.failedCount > 0) return t('forge.ci.chip.failed', { ...named, count: shown.failedCount }, shown.failedCount);
  return t('forge.ci.chip.state', named);
});
const otherCommit = computed(() => (props.status.status === 'ready' ? ciOtherCommit(props.status) : undefined));
const title = computed(() => {
  if (props.status.status === 'error') return props.status.message;
  if (!pipeline.value) return name.value;
  return otherCommit.value === undefined ? t('forge.ci.chip.title', { name: name.value }) : t('forge.ci.chip.titleOther', { name: name.value, sha: otherCommit.value });
});
// keys the icon's swap: a new state replays t-icon
const iconKey = computed(() => (props.status.status === 'ready' ? props.status.pipeline.state : props.status.status));

const open = ref(false);
const root = ref<InstanceType<typeof Button> | null>(null);

async function showJobs(): Promise<void> {
  const element = (root.value?.$el ?? null) as HTMLElement | null;
  if (open.value || !element || props.status.status === 'loading') return;
  const rect = element.getBoundingClientRect();
  open.value = true;
  try {
    await props.api.forge.showPipeline(props.repoId, { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height });
  } finally {
    open.value = false;
  }
}

defineExpose({ showJobs });
</script>

<template>
  <span
    v-if="status.status === 'loading'"
    role="status"
    aria-busy="true"
    :aria-label="name"
    data-testid="forge-ci-chip-loading"
    class="flex h-7 shrink-0 items-center rounded-7 border border-(--d-border2) bg-(--d-card) px-2.25"
  >
    <span
      aria-hidden="true"
      class="relative block h-2 w-6 overflow-hidden rounded-full bg-(--d-border2) text-(--d-text)"
    ><span class="d-sheen" /></span>
  </span>
  <Button
    v-else
    ref="root"
    type="button"
    variant="ghost"
    data-testid="forge-ci-chip"
    :data-state="iconKey"
    aria-haspopup="dialog"
    :aria-expanded="open"
    :aria-label="name"
    :title="title"
    class="d-press h-7 shrink-0 gap-1.25 rounded-7 border border-(--d-border2) bg-(--d-card) px-2.25 py-0 font-mono text-11 font-normal text-(--d-muted) transition-colors duration-150 hover:border-(--d-accent) hover:bg-(--d-card) hover:text-(--d-text) focus-visible:border-(--d-accent) focus-visible:ring-0 focus-visible:ring-offset-0 aria-expanded:border-(--d-accent) aria-expanded:text-(--d-text) [&_svg]:size-3"
    @click="showJobs"
  >
    <!-- The spin sits on the wrapper, so the icon's own t-icon entrance never fights it. -->
    <span
      aria-hidden="true"
      data-testid="forge-ci-chip-spinner"
      class="inline-flex size-3 items-center justify-center"
      :class="look?.spin ? 'd-spinning' : ''"
    >
      <Transition
        name="t-icon"
        mode="out-in"
      >
        <TriangleAlert
          v-if="status.status === 'error'"
          key="error"
          data-testid="forge-ci-chip-icon"
          data-icon="error"
          class="text-(--d-warning-text)"
        />
        <span
          v-else-if="look"
          :key="iconKey"
          data-testid="forge-ci-chip-icon"
          :data-icon="iconKey"
          class="inline-flex"
          :class="look.tone"
        ><component :is="look.icon" /></span>
      </Transition>
    </span>
    <!-- The chip gives way before the branch name: a narrow row keeps its icon, and its name keeps the count. -->
    <span
      v-if="text"
      aria-hidden="true"
      data-testid="forge-ci-chip-text"
      class="@max-[14rem]/branchrow:hidden"
      :class="look?.tone"
    >{{ text }}</span>
  </Button>
</template>
