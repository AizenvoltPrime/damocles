<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, CircleX, LoaderCircle, RefreshCcw, TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { visibleLines } from '@shared/visible-text';
import { CONTAINER_REBUILD_STEPS, type DamoclesOverlayApi, type RemovalRun } from '../../../preload/overlay-channels';
import { useHostOperations } from '../host-operations';
import { answerOf } from '../popup-answer';
import { useConfirmedRunFocus } from '../confirmed-run-focus';
import BuildLogTail from './BuildLogTail.vue';
import RebuildContainerDialog from './RebuildContainerDialog.vue';

// Rebuild Container on a container's card. Main owns the run, as it owns Convert to WSL 2: the confirmation lists what main says
// stops, and the steps, the build log and the result come from the host's operations, so a view mounted mid-run shows the same run.
// ask: the card opened to rebuild (the project menu's Rebuild Container...); the confirmation opens when it turns true
// withoutDataVolume: the container keeps ~/.damocles inside it, so a rebuild loses its chats and settings
const props = defineProps<{ api: DamoclesOverlayApi; hostId: string; hostName: string; ask?: boolean; withoutDataVolume?: boolean }>();
// busy: the rebuild runs, whose progress the card shows
const emit = defineEmits<{ busy: [busy: boolean] }>();
const { t } = useI18n();

const operations = useHostOperations(props.api, () => props.hostId);
const run = computed(() => operations.value?.rebuild);
const running = computed(() => run.value !== undefined && run.value.result === undefined && run.value.failed !== true);
watch(running, (busy) => emit('busy', busy), { immediate: true });

// the confirmation's runs while it is open
const asked = shallowRef<readonly RemovalRun[] | undefined>();
// a call that failed before main answered
const failedCall = ref<'info' | 'rebuild' | undefined>();

async function confirmRebuild(): Promise<void> {
  failedCall.value = undefined;
  try {
    const info = await answerOf(props.api.rebuildInfo(props.hostId));
    if (info) asked.value = info.runs;
  } catch {
    failedCall.value = 'info';
  }
}
watch(() => props.ask, (now) => now && void confirmRebuild(), { immediate: true });

const stepsList = ref<HTMLElement | null>(null);
const rebuildButton = ref<InstanceType<typeof Button> | null>(null);
const runFocus = useConfirmedRunFocus(stepsList, () => rebuildButton.value?.$el as HTMLElement | undefined, () => failedCall.value === 'rebuild');

async function choose(rebuild: boolean): Promise<void> {
  runFocus.chose(rebuild);
  asked.value = undefined;
  if (!rebuild) return;
  try {
    // main answers when its run ends, which its snapshots show; a run already going is joined
    await answerOf(props.api.rebuildContainer(props.hostId));
  } catch {
    failedCall.value = 'rebuild';
  }
}

const result = computed(() => run.value?.result);
const failure = computed(() => {
  if (failedCall.value === 'info') return { code: 'info', text: t('remote.rebuild.failure.info', { name: props.hostName }) };
  if (failedCall.value === 'rebuild' || run.value?.failed) return { code: 'call', text: t('remote.rebuild.failure.call', { name: props.hostName }) };
  const current = result.value;
  return current && !current.ok ? { code: current.code, text: t(`remote.rebuild.failure.${current.code}`, { name: props.hostName }), message: current.message } : undefined;
});
</script>

<template>
  <section
    class="flex flex-col gap-2.5"
    data-testid="container-rebuild"
  >
    <div class="flex flex-wrap items-center gap-2">
      <h3 class="flex-1 text-11 font-semibold tracking-wide text-(--d-muted) uppercase">
        {{ t('remote.rebuild.heading') }}
      </h3>
      <!-- Hidden while main runs a rebuild, whose steps follow; main joins a start from another view. -->
      <Button
        v-if="!running"
        ref="rebuildButton"
        type="button"
        variant="outline"
        size="sm"
        data-testid="rebuild-container"
        class="h-7 rounded-8 border-(--d-border2) bg-(--d-card) px-2.5 text-12 text-(--d-text)"
        @click="confirmRebuild"
      >
        <RefreshCcw aria-hidden="true" />
        {{ t('remote.rebuild.action') }}
      </Button>
    </div>
    <Transition name="t-tuck">
      <p
        v-if="withoutDataVolume"
        data-testid="rebuild-container-volume"
        class="flex gap-2 rounded-8 bg-(--d-warning)/12 px-2.5 py-2 text-12 text-(--d-warning-text)"
      >
        <TriangleAlert
          aria-hidden="true"
          class="mt-0.5 size-3.5 shrink-0"
        />
        <span class="min-w-0">{{ t('remote.rebuild.withoutVolume', { name: hostName }) }}</span>
      </p>
    </Transition>
    <p
      v-if="!run && !withoutDataVolume"
      class="text-12 text-(--d-faint-text)"
    >
      {{ t('remote.rebuild.hint') }}
    </p>

    <Transition name="t-tuck">
      <ol
        v-if="run"
        ref="stepsList"
        tabindex="-1"
        data-testid="rebuild-container-steps"
        :aria-label="t('remote.rebuild.steps', { name: hostName })"
        class="flex flex-col gap-1.5 rounded-6 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent)"
      >
        <li
          v-for="step in CONTAINER_REBUILD_STEPS"
          :key="step"
          data-testid="rebuild-container-step"
          :data-step="step"
          :data-state="run.steps[step]"
          class="flex flex-col gap-1 text-12"
          :class="run.steps[step] === 'pending' ? 'text-(--d-faint-text)' : 'text-(--d-text)'"
        >
          <span class="flex items-center gap-2">
            <span
              aria-hidden="true"
              class="grid size-4 shrink-0 place-items-center"
            >
              <LoaderCircle
                v-if="run.steps[step] === 'running'"
                class="size-3.5 d-spinning text-(--d-accent-text)"
              />
              <Check
                v-else-if="run.steps[step] === 'done'"
                class="size-3.5 animate-[d-icon-in_.3s_var(--ease-spring)] text-(--d-success-text)"
              />
              <CircleX
                v-else-if="run.steps[step] === 'failed'"
                class="size-3.5 animate-[d-icon-in_.3s_var(--ease-spring)] text-(--d-danger-text)"
              />
              <span
                v-else
                class="size-1.5 rounded-full bg-(--d-border2)"
              />
            </span>
            <span class="min-w-0">{{ t(`remote.rebuild.step.${step}`) }}</span>
            <span class="sr-only">{{ t(`remote.passwordless.state.${run.steps[step]}`) }}</span>
          </span>
          <BuildLogTail
            v-if="step === 'building' && run.steps.building !== 'pending'"
            class="ms-6"
            :lines="run.log.lines"
            :total="run.log.total"
            :host-name="hostName"
          />
        </li>
      </ol>
    </Transition>

    <div aria-live="polite">
      <!-- The steps above show the progress; this line says it to assistive technology. -->
      <p
        v-if="running"
        data-testid="rebuild-container-progress"
        class="sr-only"
      >
        {{ t('remote.rebuild.running', { name: hostName }) }}
      </p>
      <p
        v-else-if="result?.ok"
        role="status"
        data-testid="rebuild-container-done"
        class="text-12 text-(--d-success-text)"
      >
        {{ t('remote.rebuild.done', { name: hostName }) }}
      </p>
    </div>
    <div
      v-if="failure"
      role="alert"
      data-testid="rebuild-container-failure"
      :data-code="failure.code"
      class="timeline-grow flex flex-col gap-1.5 rounded-8 bg-(--d-danger)/12 px-2.5 py-2 text-12 text-(--d-danger-text)"
    >
      <p>{{ failure.text }}</p>
      <pre
        v-if="failure.message"
        dir="ltr"
        data-testid="rebuild-container-message"
        class="m-0 font-mono text-11.5 whitespace-pre-wrap text-(--d-danger-text)"
      >{{ visibleLines(failure.message) }}</pre>
    </div>
    <RebuildContainerDialog
      :host-name="hostName"
      :runs="asked"
      :without-data-volume="withoutDataVolume === true"
      @choose="choose"
      @close-auto-focus="runFocus.closeAutoFocus"
    />
  </section>
</template>
