<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { BookOpen, FolderOpen, Link, TriangleAlert } from 'lucide-vue-next';
import OverlayShell from './OverlayShell.vue';
import LoadingSpinner from './LoadingSpinner.vue';
import SlidingIndicator from './SlidingIndicator.vue';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import { useBindPlanStore } from '@/stores/useBindPlanStore';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t, locale } = useI18n();
const { postMessage } = usePlatformBridge();
const { files, hasPlan, loaded, listFailed } = storeToRefs(useBindPlanStore());

const selected = shallowRef(0);
watch(files, () => {
  selected.value = 0;
});
const selectedFile = computed(() => files.value[selected.value]);

const list = shallowRef<HTMLElement | null>(null);
const { box, animate } = useSlidingIndicator(list, '[role="radio"]', selected);

const DAY = 86_400_000;
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [['day', DAY], ['hour', 3_600_000], ['minute', 60_000]];

/** "2 hours ago", "yesterday"; a week or older is the locale's date, which carries no clock time. */
function edited(modifiedAt: number): string {
  const elapsed = Date.now() - modifiedAt;
  if (elapsed >= 7 * DAY) return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(modifiedAt);
  const relative = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' });
  const [unit, size] = UNITS.find(([, ms]) => elapsed >= ms) ?? ['minute', 60_000];
  return relative.format(-Math.floor(elapsed / size), unit);
}

function onListKeydown(event: KeyboardEvent): void {
  const count = files.value.length;
  if (count === 0) return;
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
  let next: number | undefined;
  if (step !== undefined) next = (selected.value + step + count) % count;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = count - 1;
  if (next === undefined) return;
  event.preventDefault();
  selected.value = next;
  list.value?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}

function bind(): void {
  const file = selectedFile.value;
  if (!file) return;
  postMessage({ type: 'bindPlanToSession', candidateId: file.id });
  emit('close');
}

function browse(): void {
  postMessage({ type: 'bindPlanToSession' });
  emit('close');
}
</script>

<template>
  <OverlayShell
    :title="t('overlays.bindPlan.title')"
    :subtitle="t('overlays.bindPlan.subtitle')"
    :icon="Link"
    max-width="38.75rem"
    data-testid="bind-plan-overlay"
    @close="emit('close')"
  >
    <div class="flex flex-col gap-2.5 px-4.5 pt-4 pb-5">
      <p class="text-12.5 text-pretty text-(--d-muted)">
        {{ t('overlays.bindPlan.intro') }}
      </p>

      <div
        v-if="!loaded"
        class="flex items-center justify-center gap-2 py-6 text-12.5 text-(--d-faint)"
        role="status"
      >
        <LoadingSpinner class="size-3.25" />{{ t('overlays.bindPlan.loading') }}
      </div>
      <p
        v-else-if="listFailed"
        class="rounded-11 border border-dashed border-(--d-border2) px-3 py-4 text-center text-12.5 text-pretty text-(--d-warning)"
        role="alert"
        data-testid="bind-plan-list-failed"
      >
        {{ t('overlays.bindPlan.listFailed') }}
      </p>
      <p
        v-else-if="files.length === 0"
        class="rounded-11 border border-dashed border-(--d-border2) px-3 py-4 text-center text-12.5 text-pretty text-(--d-faint)"
        data-testid="bind-plan-empty"
      >
        {{ t('overlays.bindPlan.empty') }}
      </p>
      <div
        v-else
        ref="list"
        role="radiogroup"
        :aria-label="t('overlays.bindPlan.listLabel')"
        class="relative flex flex-col gap-2.5"
        @keydown="onListKeydown"
      >
        <SlidingIndicator
          variant="ring"
          :box="box"
          :radius="11"
          :animate="animate"
          class="z-1 text-(--d-accent)"
        />
        <div
          v-for="(file, index) in files"
          :key="file.id"
          role="radio"
          :aria-checked="index === selected"
          :tabindex="index === selected ? 0 : -1"
          :title="file.relativePath"
          class="d-arrive flex items-center gap-2.5 rounded-11 border border-(--d-border) bg-(--d-card) px-3 py-2.5 transition-colors outline-none hover:border-(--d-accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent)"
          :style="{ animationDelay: `${index * 30}ms` }"
          data-testid="bind-plan-file"
          @click="selected = index"
          @dblclick="bind"
          @keydown.enter.prevent="bind"
          @keydown.space.prevent="selected = index"
        >
          <span class="relative z-2 flex min-w-0 flex-1 items-center gap-2.5">
            <BookOpen
              class="size-3.75 flex-none text-(--d-info)"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-mono text-12.5">{{ file.relativePath }}</span>
              <span
                class="block text-11"
                :class="index === selected ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
              >{{ t('overlays.bindPlan.edited', { time: edited(file.modifiedAt) }) }}</span>
            </span>
            <span
              class="flex size-4.5 flex-none items-center justify-center rounded-full border-[1.5px] transition-colors"
              :class="index === selected ? 'border-(--d-accent)' : 'border-(--d-border2)'"
              aria-hidden="true"
            >
              <span
                class="size-2 rounded-full bg-(--d-accent) transition-[opacity,transform] duration-150"
                :class="index === selected ? 'opacity-100' : 'scale-50 opacity-0'"
              />
            </span>
          </span>
        </div>
      </div>

      <button
        type="button"
        class="d-press flex items-center gap-2 rounded-11 border border-dashed border-(--d-border2) px-3 py-2.5 text-left text-12.5 text-(--d-muted) transition-colors hover:border-(--d-accent) hover:text-(--d-accent)"
        data-testid="bind-plan-browse"
        @click="browse"
      >
        <FolderOpen
          class="size-3.5"
          aria-hidden="true"
        />{{ t('overlays.bindPlan.browse') }}
      </button>

      <p
        v-if="hasPlan"
        class="flex items-center gap-2 rounded-10 bg-[color-mix(in_srgb,var(--d-warning)_10%,transparent)] px-3 py-2.25 text-xs text-(--d-warning-text)"
        role="note"
        data-testid="bind-plan-overwrite"
      >
        <TriangleAlert
          class="size-3.25 flex-none"
          aria-hidden="true"
        />{{ t('overlays.bindPlan.overwrite') }}
      </p>
    </div>

    <template #footer>
      <footer class="flex flex-none items-center gap-2 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5">
        <span class="flex-1 text-11.5 text-(--d-faint)">{{ t('overlays.bindPlan.noTurnSpent') }}</span>
        <button
          type="button"
          class="d-press flex h-7.5 items-center rounded-9 border border-(--d-border2) px-3 text-12.5 transition-colors hover:bg-(--d-hover)"
          @click="emit('close')"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="d-press flex h-7.5 items-center gap-1.5 rounded-9 bg-(--d-accent) px-3.5 text-12.5 font-semibold text-(--d-on-accent) transition-[filter] hover:brightness-110 disabled:cursor-default disabled:opacity-40 disabled:hover:brightness-100"
          :disabled="!selectedFile"
          data-testid="bind-plan-bind"
          @click="bind"
        >
          <Link
            class="size-3.25"
            aria-hidden="true"
          />{{ t('overlays.bindPlan.bind') }}
        </button>
      </footer>
    </template>
  </OverlayShell>
</template>
