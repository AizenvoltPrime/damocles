<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Clock, Timer } from 'lucide-vue-next';
import type { HostUpdate } from '@shared/host-update';
import { hostUpdateState } from '@/components/banner-tone';
import { minutesLeft, useUpdateClock } from '@/components/host-update-clock';
import { formatResetTime } from '@/utils/clock';

// A required switch's deadline, then its last minutes, beside the host's name. The dot's name says the same, so the tag is
// decorative.
const props = defineProps<{ update: HostUpdate | undefined }>();
const { t, locale } = useI18n();
const clock = useUpdateClock();

const tag = computed(() => {
  const deadline = props.update?.required?.deadline;
  if (!props.update || deadline === undefined) return undefined;
  const state = hostUpdateState(props.update);
  if (state === 'required') {
    const { day, time } = formatResetTime(deadline, clock.now(), locale.value, { weekday: 'short' });
    return { state, text: day === undefined ? time : t('projects.update.tagDay', { day, time }) };
  }
  if (state === 'countdown') return { state, text: t('projects.update.tagMinutes', { count: minutesLeft(deadline - clock.now()) }) };
  return undefined;
});
</script>

<template>
  <!-- keyed by state, out-in: the countdown's pill replaces the deadline's tag, never beside it -->
  <Transition
    name="t-chip"
    mode="out-in"
  >
    <span
      v-if="tag"
      :key="tag.state"
      aria-hidden="true"
      data-testid="host-update-tag"
      :data-state="tag.state"
      class="inline-flex h-4.5 shrink-0 items-center gap-1 rounded-5 text-11 font-semibold whitespace-nowrap tabular-nums"
      :class="tag.state === 'countdown' ? 'bg-(--d-danger-fill)/16 px-1.25 text-(--d-danger-text)' : 'px-0.5 text-(--d-warning-text)'"
    >
      <Timer
        v-if="tag.state === 'countdown'"
        class="size-3"
        :stroke-width="2.25"
      />
      <Clock
        v-else
        class="size-3"
        :stroke-width="2.25"
      />
      {{ tag.text }}
    </span>
  </Transition>
</template>
