<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RotateCw } from 'lucide-vue-next';
import type { DamoclesShellApi, ShellEngine } from '../../preload/shell-channels';
import { Button } from '@/components/ui/button';

const props = defineProps<{ api: DamoclesShellApi; halted: boolean; engines: readonly ShellEngine[] }>();
const { t } = useI18n();

// A host's pill shows while its engine is halted and while the Restart it offered is in flight.
const remote = computed(() => props.engines.filter((engine) => engine.state === 'halted' || engine.state === 'restarting'));

// While restarting the pill keeps focus and says so in its text, which is then its whole name; a click does nothing.
function restart(engine: ShellEngine): void {
  if (engine.state !== 'restarting') void props.api.restartEngine(engine.authority);
}

const PILL = 'title-bar-control d-press mr-1.5 flex h-6 shrink-0 gap-1.5 rounded-full border-(--d-danger)/45 bg-transparent px-2.5 text-11.5 font-medium text-(--d-danger-text) hover:border-(--d-danger) hover:bg-transparent hover:text-(--d-danger-text) [&_svg]:size-3.25';
</script>

<template>
  <Transition name="engine-pill">
    <Button
      v-if="halted"
      type="button"
      variant="outline"
      size="sm"
      data-testid="engine-pill"
      :class="PILL"
      :title="t('engine.stoppedTitle')"
      :aria-label="t('engine.restartLabel')"
      @click="api.restartEngine()"
    >
      <RotateCw
        aria-hidden="true"
        class="size-3.25 shrink-0"
      />
      <span class="max-w-60 truncate">{{ t('engine.stopped') }}</span>
    </Button>
  </Transition>
  <TransitionGroup name="engine-host-pill">
    <Button
      v-for="engine in remote"
      :key="engine.authority"
      type="button"
      variant="outline"
      size="sm"
      data-testid="engine-host-pill"
      :data-authority="engine.authority"
      :data-state="engine.state"
      :class="[PILL, 'aria-disabled:cursor-default']"
      :aria-disabled="engine.state === 'restarting' || undefined"
      :aria-busy="engine.state === 'restarting' || undefined"
      :title="engine.state === 'restarting' ? t('engine.hostRestarting', { host: engine.name }) : t('engine.hostStoppedTitle', { host: engine.name })"
      :aria-label="engine.state === 'restarting' ? undefined : t('engine.hostRestartLabel', { host: engine.name })"
      @click="restart(engine)"
    >
      <RotateCw
        aria-hidden="true"
        class="size-3.25 shrink-0"
        :class="engine.state === 'restarting' && 'd-spinning'"
      />
      <!-- A rename swaps the old name for the new one. -->
      <Transition
        name="t-swap"
        mode="out-in"
      >
        <span
          :key="engine.name"
          class="max-w-60 truncate"
        >{{ engine.state === 'restarting' ? t('engine.hostRestarting', { host: engine.name }) : t('engine.hostStopped', { host: engine.name }) }}</span>
      </Transition>
    </Button>
  </TransitionGroup>
</template>
