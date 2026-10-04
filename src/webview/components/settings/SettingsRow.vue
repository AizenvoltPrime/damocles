<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingSourceBadge from '@/components/SettingSourceBadge.vue';
import SettingsHighlight from './SettingsHighlight';
import { useSettingWritesStore } from './settings-writes';
import { rowMatches } from './settings-rows';
import { ROW_STAGGER_MS, STAGGERED_ROWS, useSettingsPage } from './settings-view';

const props = defineProps<{
  id: string;
  /** Replaces the row's static description, which search still matches. */
  description?: string | undefined;
}>();

/** How long "Saved to {file}" stays before it fades (M7). */
const SAVED_HINT_MS = 1600;

const { t } = useI18n();
const page = useSettingsPage();
const writes = useSettingWritesStore();

const meta = computed(() => {
  const found = page.meta(props.id);
  if (!found) throw new Error(`No settings row is declared with id ${props.id}`);
  return found;
});
const keys = computed(() => meta.value.keys ?? []);
const visible = computed(() => rowMatches(meta.value, page.query, t));
// The entrance plays only when the row's element is created, so a row takes a slot only as it appears.
const index = ref(visible.value ? page.nextIndex() : STAGGERED_ROWS);
watch(visible, (shown) => {
  if (shown) index.value = page.nextIndex();
});
const rowDelay = computed(() => (index.value < STAGGERED_ROWS ? `${index.value * ROW_STAGGER_MS}ms` : '0s'));

watch(visible, (shown) => (shown ? page.show(props.id, meta.value.section) : page.hide(props.id)), { immediate: true });
onBeforeUnmount(() => page.hide(props.id));

const label = computed(() => t(meta.value.label));
const descriptionText = computed(() => props.description ?? (meta.value.description ? t(meta.value.description) : ''));

const feedback = computed(() => writes.latest(keys.value));
const savedVisible = ref(false);
const popSeq = ref(0);
let hideTimer: ReturnType<typeof setTimeout> | null = null;
watch(feedback, (next, previous) => {
  if (!next || next.seq === previous?.seq || next.kind !== 'saved') return;
  popSeq.value = next.seq;
  savedVisible.value = true;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    savedVisible.value = false;
    hideTimer = null;
  }, SAVED_HINT_MS);
});
onBeforeUnmount(() => {
  if (hideTimer) clearTimeout(hideTimer);
});

// The scope in words; the source badge names the file and this hint's title holds its full path.
const savedText = computed(() => {
  const entry = feedback.value;
  if (entry?.kind !== 'saved') return '';
  return t('settingsModal.savedTo', { file: t(`settingsModal.scopeFile.${entry.scope}`) });
});
const savedPath = computed(() => (feedback.value?.kind === 'saved' ? feedback.value.file : undefined));
const errorText = computed(() => (feedback.value?.kind === 'error' ? feedback.value.error : ''));
const labelId = computed(() => `settings-row-label-${props.id}`);
</script>

<template>
  <div
    v-if="visible"
    class="sm-row"
    :style="{ '--sm-row-delay': rowDelay }"
    :data-testid="`settings-row-${id}`"
    role="group"
    :aria-labelledby="labelId"
  >
    <div class="sm-row-text">
      <div class="sm-row-label">
        <span :id="labelId"><SettingsHighlight
          :text="label"
          :query="page.query"
        /></span>
        <span
          v-if="keys.length > 0"
          :key="popSeq"
          class="sm-badge"
          :class="{ 'sm-badge-pop': popSeq > 0 }"
        ><SettingsHighlight
          :text="keys[0]!"
          :query="page.query"
        /></span>
        <SettingSourceBadge
          v-if="keys.length > 0"
          :setting-key="keys"
          :pop-seq="popSeq"
        />
      </div>
      <div
        v-if="descriptionText"
        class="sm-row-desc"
      >
        <SettingsHighlight
          :text="descriptionText"
          :query="page.query"
        />
      </div>
      <div aria-live="polite">
        <Transition name="sm-fade">
          <p
            v-if="savedVisible && savedText"
            class="sm-feedback"
            data-testid="setting-saved"
            :title="savedPath"
          >
            {{ savedText }}
          </p>
        </Transition>
      </div>
      <p
        v-if="errorText"
        class="sm-feedback sm-feedback-error"
        role="alert"
        data-testid="setting-error"
      >
        {{ errorText }}
      </p>
    </div>
    <div
      v-if="$slots.default"
      class="sm-row-control"
    >
      <slot />
    </div>
    <slot name="expand" />
  </div>
</template>
