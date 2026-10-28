<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, CircleX, KeyRound, LoaderCircle } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { DamoclesOverlayApi, PasswordlessRun, PasswordlessStep } from '../../../preload/overlay-channels';
import type { ShellPlatform } from '../../../preload/shell-channels';
import { answerOf } from '../popup-answer';

// Set up passwordless login: main generates a key for Damocles, installs it on the host and signs in with it; each step
// shows inline from main's run, finishing with a check.
const props = defineProps<{ api: DamoclesOverlayApi; hostId: string; hostName: string; os?: ShellPlatform | undefined; run?: PasswordlessRun | undefined }>();
const { t } = useI18n();

const STEPS: readonly PasswordlessStep[] = ['generate', 'install', 'verify'];
const states = computed(() => props.run?.steps);
const result = computed(() => props.run?.result);
// the call itself failed, before main answered
const callFailed = ref(false);
const running = computed(() => props.run !== undefined && result.value === undefined && props.run.failed !== true);

async function start(): Promise<void> {
  callFailed.value = false;
  try {
    // main answers when its run ends, which its snapshots show
    await answerOf(props.api.setUpPasswordless(props.hostId));
  } catch {
    callFailed.value = true;
  }
}

const stepLabel = (step: PasswordlessStep): string => (step === 'install'
  ? t(props.os === 'win32' ? 'remote.passwordless.step.installWindows' : 'remote.passwordless.step.install', { name: props.hostName })
  : t(`remote.passwordless.step.${step}`));

const failure = computed(() => {
  if (callFailed.value || props.run?.failed) return t('remote.passwordless.callFailed', { name: props.hostName });
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
