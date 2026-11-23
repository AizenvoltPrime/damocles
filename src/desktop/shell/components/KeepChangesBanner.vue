<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Palette } from 'lucide-vue-next';
import type { KeepChangesState } from '@shared/themes/agent';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import TrustedCheckingNote from '@/components/TrustedCheckingNote.vue';
import { IsolatedText } from '@/components/isolated-text';
import { isolated } from '@shared/bidi-isolate';
import { useTrustedVisibility } from '@/composables/useTrustedVisibility';

// The keep-changes banner under the title bar: trusted UI, and main keeps it on the palette from before the change, so Revert
// stays readable whatever the change did. Main owns the countdown and the revert; this only shows its state.
const props = defineProps<{ state: KeepChangesState }>();
const emit = defineEmits<{
  (e: 'keep'): void;
  (e: 'revert'): void;
}>();

const { t } = useI18n();

// How often the shown count and bar follow the clock; main reverts at endsAt whatever this shows.
const TICK_MS = 250;
const now = ref(Date.now());
// Reduce motion (the host's setting or the OS's), read with the clock so a change applies on the next tick.
const reduced = ref(prefersReducedMotion());
function tick(): void {
  now.value = Date.now();
  reduced.value = prefersReducedMotion();
}
let timer: ReturnType<typeof setInterval> | undefined;
watch(() => props.state.phase, (phase) => {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  tick();
  if (phase === 'counting') timer = setInterval(tick, TICK_MS);
}, { immediate: true });
onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer);
  clearTimeout(firstAnnouncement);
});

// never more than the whole countdown, whatever the clock did between two samples
const leftMs = computed(() => Math.min(props.state.durationMs, Math.max(0, props.state.endsAt - now.value)));
const seconds = computed(() => Math.ceil(leftMs.value / 1000));
const totalSeconds = computed(() => Math.round(props.state.durationMs / 1000));
// Under reduce motion the bar holds still at full width; the count and the live region carry the time.
const percent = computed(() => {
  if (reduced.value) return 100;
  return props.state.durationMs > 0 ? Math.min(100, (leftMs.value / props.state.durationMs) * 100) : 0;
});

// The polite live region speaks at the start, on a restart and every 5 s, never every second. It mounts empty and is filled
// a tick later, since a screen reader may not announce the text a live region is inserted with.
const announced = ref<number | null>(null);
let firstAnnouncement: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
  firstAnnouncement = setTimeout(() => { announced.value = seconds.value; }, TICK_MS);
});
watch(seconds, (value) => {
  if (announced.value !== null && value > 0 && (value === totalSeconds.value || value % 5 === 0)) announced.value = value;
});
// a restart keeps the phase, so the clock is sampled here: the count is of the new deadline from now, never from the last tick
watch(() => props.state.endsAt, () => {
  tick();
  if (announced.value !== null) announced.value = seconds.value;
});

const counting = computed(() => props.state.phase === 'counting');
// Why no answer is taken now, as main says: one is on its way to core, or no engine runs to carry one out.
const held = computed(() => {
  if (!counting.value) return undefined;
  if (props.state.engineDown) return t('themes.keep.engineDown');
  if (props.state.ending) return props.state.ending === 'kept' ? t('themes.keep.keeping') : t('themes.keep.reverting');
  return undefined;
});
function answer(choice: 'keep' | 'revert'): void {
  if (held.value !== undefined) return;
  if (choice === 'keep') emit('keep');
  else emit('revert');
}
// The theme the latest change names; an undo names the change it reverted, a schedule names none. Marked as user text
// (isolated), as the chat's title and the previous theme's name are: IsolatedText shows the sentences.
const themeName = computed(() => {
  const change = props.state.change.kind === 'restore' ? props.state.change.before : props.state.change;
  return 'theme' in change ? isolated(change.theme) : undefined;
});
const lead = computed(() => {
  const { chatTitle, change, changeCount, several } = props.state;
  if (several) return t('themes.keep.several', { n: changeCount });
  const who = chatTitle ? t('themes.keep.who', { chat: isolated(chatTitle) }) : t('themes.keep.whoUntitled');
  if (changeCount > 1) return t('themes.keep.many', { who, n: changeCount });
  if (change.kind === 'schedule') return t('themes.keep.schedule', { who });
  if (change.kind === 'wallpapersOff') return t('themes.keep.wallpapersOff', { who });
  if (change.kind === 'restore' && change.before.kind === 'wallpapersOff') return t('themes.keep.undidWallpapersOff', { who });
  if (change.kind === 'restore') return themeName.value ? t('themes.keep.undid', { who, theme: themeName.value }) : t('themes.keep.undidChange', { who });
  return themeName.value ? t('themes.keep.applied', { who, theme: themeName.value }) : t('themes.keep.changed', { who });
});
// Who reverted, as main says; nothing is said of it when main names nobody.
const revertedBy = computed(() => {
  const { endedBy, several } = props.state;
  if (endedBy === 'user') return several ? t('themes.keep.revertedByUserSeveral') : t('themes.keep.revertedByUser');
  if (endedBy === 'timeout') return several ? t('themes.keep.revertedByTimeoutSeveral') : t('themes.keep.revertedByTimeout');
  if (endedBy === 'engineStart') return several ? t('themes.keep.revertedByEngineSeveral') : t('themes.keep.revertedByEngine');
  return undefined;
});
const done = computed(() => {
  const { phase, several, endedBy } = props.state;
  const previousName = props.state.previousName ? isolated(props.state.previousName) : undefined;
  if (phase === 'kept') {
    // the engine's start keeps only a change it could not revert
    if (endedBy === 'engineStart') return { title: t('themes.keep.kept'), text: several ? t('themes.keep.keptByEngineSeveral') : t('themes.keep.keptByEngine') };
    if (several) return { title: t('themes.keep.kept'), text: t('themes.keep.keptSeveral') };
    // a kept undo names the theme whose change was taken back, which is not the one that stays
    const theme = props.state.change.kind === 'restore' ? undefined : themeName.value;
    if (!theme) return { title: t('themes.keep.kept'), text: t('themes.keep.keptChange') };
    return { title: t('themes.keep.kept'), text: previousName ? t('themes.keep.keptBack', { theme, previous: previousName }) : t('themes.keep.keptNoPrevious', { theme }) };
  }
  if (phase === 'reverted') {
    const back = several ? t('themes.keep.revertedSeveral') : previousName ? t('themes.keep.revertedBack', { previous: previousName }) : t('themes.keep.revertedNoPrevious');
    return { title: t('themes.keep.reverted'), text: revertedBy.value === undefined ? back : `${back} ${revertedBy.value}` };
  }
  return undefined;
});

const bannerRef = ref<HTMLElement | null>(null);
const { isVisible, explain } = useTrustedVisibility(bannerRef, true);

const keepRef = ref<InstanceType<typeof Button> | null>(null);
defineExpose({
  // F6 lands on Keep while the banner counts; the button stays focusable while it takes no answer.
  focus: (): boolean => {
    const element = keepRef.value?.$el as HTMLElement | undefined;
    element?.focus();
    return element !== undefined;
  },
});
</script>

<template>
  <div
    ref="bannerRef"
    role="region"
    aria-labelledby="keep-changes-title"
    data-trusted
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-(--d-border2) bg-(--d-card) py-2 ps-4 pe-3 text-12 text-(--d-text)"
    data-testid="keep-changes-banner"
    :data-phase="state.phase"
  >
    <span
      class="flex size-6.5 flex-none items-center justify-center rounded-8 bg-(--d-accent-soft) text-(--d-accent-text)"
      aria-hidden="true"
    >
      <Palette class="size-4" />
    </span>
    <!-- The text scrolls inside its own bounded box, so the banner fits the window whole however long a name is. -->
    <div class="relative min-w-0 flex-[1_1_16rem]">
      <p class="max-h-18 overflow-y-auto text-pretty">
        <strong
          id="keep-changes-title"
          class="font-semibold"
        >{{ done ? done.title : t('themes.keep.title') }}</strong>
        <template v-if="counting">
          {{ ' ' }}
          <span
            id="keep-changes-desc"
            class="text-(--d-muted)"
          >
            <IsolatedText :text="lead" />{{ ' ' }}<span
              v-if="held !== undefined"
              data-testid="keep-changes-held"
            >{{ held }}</span>
            <i18n-t
              v-else
              keypath="themes.keep.reverts"
              scope="global"
            >
              <template #count>
                <span
                  class="font-semibold text-(--d-text) tabular-nums"
                  data-testid="keep-changes-count"
                >{{ seconds }}</span>
              </template>
            </i18n-t>
          </span>
        </template>
      </p>
      <TrustedCheckingNote
        cover
        :shown="counting && explain"
        :text="t('themes.checkingVisible')"
      />
    </div>
    <div
      v-if="counting"
      class="flex flex-wrap gap-1.5"
      role="group"
      aria-labelledby="keep-changes-title"
      :aria-disabled="!isVisible || held !== undefined || undefined"
    >
      <!-- aria-disabled, never disabled: a disabled button would drop the keyboard focus F6 put on it -->
      <Button
        ref="keepRef"
        type="button"
        size="sm"
        class="h-7 rounded-8 px-3 text-12 font-semibold aria-disabled:bg-(--d-border2) aria-disabled:text-(--d-muted) aria-disabled:hover:bg-(--d-border2)"
        data-testid="keep-changes-keep"
        :aria-disabled="held !== undefined || undefined"
        @click="answer('keep')"
      >
        {{ t('themes.keep.keep') }}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="h-7 rounded-8 border-(--d-border2) bg-transparent px-3 text-12 aria-disabled:text-(--d-muted) aria-disabled:hover:bg-transparent"
        data-testid="keep-changes-revert"
        :aria-disabled="held !== undefined || undefined"
        @click="answer('revert')"
      >
        {{ t('themes.keep.revert') }}
      </Button>
    </div>
    <Progress
      v-if="counting && held === undefined"
      :model-value="percent"
      :get-value-label="() => t('themes.keep.timeLeft')"
      :get-value-text="() => t('themes.keep.secondsLeft', { n: seconds }, seconds)"
      class="h-0.75 flex-[1_1_100%] bg-(--d-border) *:duration-300 *:ease-linear"
      data-testid="keep-changes-bar"
      :data-percent="Math.round(percent)"
    />
    <!-- One live region for the whole life of the banner, so the end is announced as the countdown was. -->
    <p
      id="keep-changes-done"
      role="status"
      aria-live="polite"
      :class="counting ? 'sr-only' : 'flex-[1_1_100%] text-(--d-muted)'"
      data-testid="keep-changes-live"
    >
      <IsolatedText :text="done ? done.text : announced === null ? '' : held ?? t('themes.keep.announce', { n: announced }, announced)" />
    </p>
  </div>
</template>
