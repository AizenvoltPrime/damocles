<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, CircleX, KeyRound, LoaderCircle } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { DamoclesOverlayApi, PasswordlessResult, PasswordlessStep } from '../../../preload/overlay-channels';
import type { ShellPlatform } from '../../../preload/shell-channels';
import { answerOf } from '../popup-answer';

type StepState = 'pending' | 'running' | 'done' | 'failed';

// Set up passwordless login: main generates a key for Damocles, installs it on the host and signs in with it; each step
// shows inline as main reports it, finishing with a check.
const props = defineProps<{ api: DamoclesOverlayApi; hostId: string; hostName: string; os?: ShellPlatform | undefined }>();
const emit = defineEmits<{ started: []; running: [running: boolean] }>();
const { t } = useI18n();

const STEPS: readonly PasswordlessStep[] = ['generate', 'install', 'verify'];
const states = ref<Record<PasswordlessStep, StepState> | undefined>();
const result = shallowRef<PasswordlessResult | undefined>();
// the call itself failed, before main answered
const callFailed = ref(false);
const running = computed(() => states.value !== undefined && result.value === undefined && !callFailed.value);
watch(running, (now) => emit('running', now));

onScopeDispose(props.api.onPasswordlessStep((event) => {
  if (event.hostId !== props.hostId || !states.value) return;
  states.value = { ...states.value, [event.step]: event.state };
}));

async function start(): Promise<void> {
  emit('started');
  states.value = { generate: 'pending', install: 'pending', verify: 'pending' };
  result.value = undefined;
  callFailed.value = false;
  try {
    const answer = await answerOf(props.api.setUpPasswordless(props.hostId));
    if (!answer) return;
    result.value = answer;
    if (!answer.ok) states.value = { ...states.value, [answer.step]: 'failed' };
  } catch {
    callFailed.value = true;
  }
}

const stepLabel = (step: PasswordlessStep): string => (step === 'install'
  ? t(props.os === 'win32' ? 'remote.passwordless.step.installWindows' : 'remote.passwordless.step.install', { name: props.hostName })
  : t(`remote.passwordless.step.${step}`));

const failure = computed(() => {
  if (callFailed.value) return t('remote.passwordless.callFailed', { name: props.hostName });
  const current = result.value;
  return current && !current.ok ? t(`remote.passwordless.failure.${current.code}`, { name: props.hostName, ...current.params }) : undefined;
});
</script>

<template>
  <div
    class="flex flex-col gap-2"
    data-testid="passwordless"
  >
    <Button
      v-if="!running && !result?.ok"
      type="button"
      size="sm"
      data-testid="passwordless-start"
      class="h-7.5 self-start rounded-8 px-3 text-12 font-semibold"
      @click="start"
    >
      <KeyRound aria-hidden="true" />
      {{ t('remote.passwordless.start') }}
    </Button>
    <ol
      v-if="states"
      :aria-label="t('remote.passwordless.steps', { name: hostName })"
      class="flex flex-col gap-1.5"
    >
      <li
        v-for="step in STEPS"
        :key="step"
        data-testid="passwordless-step"
        :data-step="step"
        :data-state="states[step]"
        class="flex items-center gap-2 text-12"
        :class="states[step] === 'pending' ? 'text-(--d-faint-text)' : 'text-(--d-text)'"
      >
        <span
          aria-hidden="true"
          class="grid size-4 shrink-0 place-items-center"
        >
          <LoaderCircle
            v-if="states[step] === 'running'"
            class="size-3.5 d-spinning text-(--d-accent-text)"
          />
          <Check
            v-else-if="states[step] === 'done'"
            class="size-3.5 animate-[d-icon-in_.3s_var(--ease-spring)] text-(--d-success-text)"
          />
          <CircleX
            v-else-if="states[step] === 'failed'"
            class="size-3.5 animate-[d-icon-in_.3s_var(--ease-spring)] text-(--d-danger-text)"
          />
          <span
            v-else
            class="size-1.5 rounded-full bg-(--d-border2)"
          />
        </span>
        <span class="min-w-0">{{ stepLabel(step) }}</span>
        <span class="sr-only">{{ t(`remote.passwordless.state.${states[step]}`) }}</span>
      </li>
    </ol>
    <div aria-live="polite">
      <p
        v-if="result?.ok"
        data-testid="passwordless-done"
        class="text-12 text-(--d-success-text)"
      >
        {{ t('remote.passwordless.done', { name: hostName }) }}
      </p>
    </div>
    <p
      v-if="failure"
      role="alert"
      data-testid="passwordless-failure"
      class="rounded-8 bg-(--d-danger)/12 px-2.5 py-2 text-12 text-(--d-danger-text)"
    >
      {{ failure }}
    </p>
  </div>
</template>
