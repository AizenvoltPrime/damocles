<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowUpFromLine, Check, ChevronRight, CircleX, Gauge, LoaderCircle } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { visibleLines, visibleText } from '@shared/visible-text';
import { WSL_CONVERSION_STEPS, type DamoclesOverlayApi, type RemovalRun } from '../../../preload/overlay-channels';
import { useHostOperations } from '../host-operations';
import { answerOf } from '../popup-answer';
import { useConfirmedRunFocus } from '../confirmed-run-focus';
import ConvertWsl2Dialog from './ConvertWsl2Dialog.vue';

// A WSL 1 distro's polling note with Convert to WSL 2. Main owns the conversion run, as it owns removal: the confirmation lists
// what main says runs, and the steps, wsl.exe's output and the result come from the host's operations, so a view mounted
// mid-run shows the same run.
// connected: main lists the running work from the distro's daemon, so the conversion starts from a connection
const props = defineProps<{ api: DamoclesOverlayApi; hostId: string; hostName: string; distro: string; version: 1 | 2; connected: boolean }>();
// busy: the conversion runs, whose progress the card shows
const emit = defineEmits<{ busy: [busy: boolean] }>();
const { t } = useI18n();

const operations = useHostOperations(props.api, () => props.hostId);
const run = computed(() => operations.value?.conversion);
const running = computed(() => run.value !== undefined && run.value.result === undefined && run.value.failed !== true);
watch(running, (busy) => emit('busy', busy), { immediate: true });

// the confirmation's runs while it is open
const asked = shallowRef<readonly RemovalRun[] | undefined>();
// a call that failed before main answered
const failedCall = ref<'info' | 'convert' | undefined>();

async function ask(): Promise<void> {
  failedCall.value = undefined;
  try {
    const info = await answerOf(props.api.conversionInfo(props.hostId));
    if (info) asked.value = info.runs;
  } catch {
    failedCall.value = 'info';
  }
}

const stepsList = ref<HTMLElement | null>(null);
const convertButton = ref<InstanceType<typeof Button> | null>(null);
const runFocus = useConfirmedRunFocus(stepsList, () => convertButton.value?.$el as HTMLElement | undefined, () => failedCall.value === 'convert');
const needsConnectionId = useId();

async function choose(convert: boolean): Promise<void> {
  runFocus.chose(convert);
  asked.value = undefined;
  if (!convert) return;
  try {
    // main answers when its run ends, which its snapshots show; a run already going is joined
    await answerOf(props.api.convertToWsl2(props.hostId));
  } catch {
    failedCall.value = 'convert';
  }
}

const result = computed(() => run.value?.result);
const failure = computed(() => {
  if (failedCall.value === 'info') return { code: 'info', text: t('remote.wsl.failure.info', { name: props.hostName }) };
  if (failedCall.value === 'convert' || run.value?.failed) return { code: 'call', text: t('remote.wsl.failure.call', { name: props.hostName }) };
  const current = result.value;
  return current && !current.ok ? { code: current.code, text: t(`remote.wsl.failure.${current.code}`, { name: props.hostName, distro: props.distro }), message: current.message } : undefined;
});

// The tail follows wsl.exe's newest line unless the user scrolled up to read. Not a reka Collapsible: its trigger renders
// before its content names itself, so a tail open on mount would carry an empty aria-controls.
const outputOpen = ref(true);
const outputId = useId();
const outputBox = ref<HTMLElement | null>(null);
const setOutputBox = (element: unknown): void => {
  outputBox.value = element instanceof HTMLElement ? element : null;
};
const output = computed(() => run.value?.output ?? []);
watch(() => output.value.length, async () => {
  const box = outputBox.value;
  const atEnd = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 2;
  await nextTick();
  if (atEnd && outputBox.value) outputBox.value.scrollTop = outputBox.value.scrollHeight;
});
</script>

<template>
  <div
    v-if="version === 1 || run"
    class="flex flex-col gap-2.5"
    data-testid="wsl-conversion"
  >
    <Transition name="t-tuck">
      <div
        v-if="version === 1"
        data-testid="host-wsl1-note"
        class="flex gap-2 rounded-8 bg-(--d-warning)/12 px-2.5 py-2 text-12 text-(--d-warning-text)"
      >
        <Gauge
          aria-hidden="true"
          class="mt-0.5 size-3.5 shrink-0"
        />
        <span class="flex min-w-0 flex-col items-start gap-2">
          <span>{{ t('remote.wsl.note') }}</span>
          <!-- Hidden while main runs a conversion, whose steps follow; main joins a start from another view. -->
          <Button
            v-if="!running"
            ref="convertButton"
            type="button"
            variant="outline"
            size="sm"
            data-testid="convert-wsl2"
            class="h-7 rounded-8 border-(--d-border2) bg-(--d-card) px-2.5 text-12 text-(--d-text)"
            :disabled="!connected"
            :aria-describedby="connected ? undefined : needsConnectionId"
            @click="ask"
          >
            <ArrowUpFromLine aria-hidden="true" />
            {{ t('remote.wsl.convert') }}
          </Button>
          <Transition name="t-tuck">
            <span
              v-if="!running && !connected"
              :id="needsConnectionId"
              data-testid="convert-wsl2-needs-connection"
              class="-mt-0.5 text-11/snug"
            >
              {{ t('remote.wsl.needsConnection', { name: hostName }) }}
            </span>
          </Transition>
        </span>
      </div>
    </Transition>

    <Transition name="t-tuck">
      <ol
        v-if="run"
        ref="stepsList"
        tabindex="-1"
        data-testid="convert-wsl2-steps"
        :aria-label="t('remote.wsl.steps', { name: hostName })"
        class="flex flex-col gap-1.5 rounded-6 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent)"
      >
        <li
          v-for="step in WSL_CONVERSION_STEPS"
          :key="step"
          data-testid="convert-wsl2-step"
          :data-step="step"
          :data-state="run.steps[step]"
          class="flex flex-col gap-1.5 text-12"
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
            <span class="min-w-0">{{ t(`remote.wsl.step.${step}`) }}</span>
            <span class="sr-only">{{ t(`remote.passwordless.state.${run.steps[step]}`) }}</span>
          </span>
          <!-- wsl.exe's own lines, newest last, as a tail that folds away. -->
          <div
            v-if="step === 'converting' && run.steps.converting !== 'pending'"
            class="ms-6 flex flex-col gap-1"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="convert-wsl2-output-toggle"
              class="h-6 self-start rounded-6 px-1.5 text-11 text-(--d-muted) hover:text-(--d-text)"
              :aria-expanded="outputOpen"
              :aria-controls="outputId"
              @click="outputOpen = !outputOpen"
            >
              <ChevronRight
                aria-hidden="true"
                class="size-3 transition-transform duration-150 ease-out rtl:-scale-x-100"
                :class="outputOpen ? 'rotate-90' : ''"
              />
              {{ t('remote.wsl.output') }}
              <span class="text-(--d-faint-text) tabular-nums">· {{ t('remote.wsl.outputLines', { count: output.length }, output.length) }}</span>
            </Button>
            <Transition name="t-tuck">
              <pre
                v-show="outputOpen"
                :id="outputId"
                :ref="setOutputBox"
                data-testid="convert-wsl2-output"
                dir="ltr"
                tabindex="0"
                :aria-label="t('remote.wsl.output')"
                class="m-0 max-h-30 overflow-y-auto rounded-8 border border-(--d-border) bg-(--d-code) px-2.5 py-2 font-mono text-11/relaxed whitespace-pre-wrap text-(--d-text) focus-visible:outline-1 focus-visible:outline-(--d-accent)"
              ><template v-if="output.length === 0"><span class="text-(--d-faint-text)">{{ t('remote.wsl.outputEmpty') }}</span></template><span
                v-for="(line, index) in output"
                v-else
                :key="index"
                class="block"
              >{{ visibleText(line) }}</span></pre>
            </Transition>
          </div>
        </li>
      </ol>
    </Transition>

    <div aria-live="polite">
      <!-- The steps above show the progress; this line says it to assistive technology. -->
      <p
        v-if="running"
        data-testid="convert-wsl2-progress"
        class="sr-only"
      >
        {{ t('remote.wsl.running', { name: hostName }) }}
      </p>
      <p
        v-else-if="result?.ok"
        role="status"
        data-testid="convert-wsl2-done"
        class="text-12 text-(--d-success-text)"
      >
        {{ t('remote.wsl.done', { name: hostName }) }}
      </p>
    </div>
    <div
      v-if="failure"
      role="alert"
      data-testid="convert-wsl2-failure"
      :data-code="failure.code"
      class="timeline-grow flex flex-col gap-1.5 rounded-8 bg-(--d-danger)/12 px-2.5 py-2 text-12 text-(--d-danger-text)"
    >
      <p>{{ failure.text }}</p>
      <template v-if="failure.message">
        <p class="text-11 text-(--d-muted)">
          {{ t('remote.wsl.said') }}
        </p>
        <pre
          dir="ltr"
          data-testid="convert-wsl2-message"
          class="m-0 font-mono text-11.5 whitespace-pre-wrap text-(--d-danger-text)"
        >{{ visibleLines(failure.message) }}</pre>
      </template>
    </div>
    <ConvertWsl2Dialog
      :host-name="hostName"
      :distro="distro"
      :runs="asked"
      @choose="choose"
      @close-auto-focus="runFocus.closeAutoFocus"
    />
  </div>
</template>
