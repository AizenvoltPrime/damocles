<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ListboxItem, ListboxRoot } from 'reka-ui';
import { Globe, Monitor, Palette, SendHorizontal } from 'lucide-vue-next';
import type { DesignApprovalChoice } from '@shared/types/design';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import DockPromptOptions from '../DockPromptOptions.vue';
import DesignChangeList from './DesignChangeList.vue';
import DesignDecisionList from './DesignDecisionList.vue';
import DesignWarningList from './DesignWarningList.vue';
import { useDesignStore } from '@/stores/useDesignStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useOpenDesignPreview } from '@/composables/useOpenDesignPreview';
import { useOpenDesignInBrowser } from '@/composables/useOpenDesignInBrowser';
import { useDockPromptDigits } from '@/composables/useDockPrompt';
import { useAttentionCard } from '@/composables/useAttention';

// FinishDesign's approval: the gate passed, and only an answer here makes the version.
const emit = defineEmits<{
  /** The card left while it held focus; the page hands focus on. */
  (e: 'release-focus'): void;
}>();

const { t, te } = useI18n();
const store = useDesignStore();
const { postMessage } = usePlatformBridge();
const preview = useOpenDesignPreview();
const browser = useOpenDesignInBrowser();

const current = computed(() => store.approvalPrompts[0]);
const cardRef = ref<HTMLElement | null>(null);
useAttentionCard('approval', cardRef);

// One line per cause; a cause from a newer core than this page reads as the generic one.
const uncheckedLines = computed(() => (current.value?.uncheckedDecisions ?? []).filter((group) => group.ids.length > 0).map((group) => {
  const causeKey = `design.approval.uncheckedCause.${group.cause}`;
  const cause = te(causeKey) ? t(causeKey) : t('design.approval.uncheckedCause.other');
  return t('design.approval.unchecked', { ids: group.ids.join(', '), cause }, group.ids.length);
}));

const title = computed(() => t('design.approval.title'));
const subtitle = computed(() => (current.value?.hasParent ? t('design.approval.subtitle') : t('design.approval.subtitleNoParent')));

// The desktop preview tab where the host has it, else the browser where the host's rule set opens designs from the chat.
const screenOpener = computed(() => {
  if (preview.available.value) return { open: preview.open, icon: Monitor, key: 'design.preview.openScreen' };
  if (browser.available.value) return { open: browser.open, icon: Globe, key: 'design.browser.openScreen' };
  return undefined;
});

// Each option names its prompt, so a leaving card's option, rendered for the prompt it showed, never answers the next one.
const choices = computed<{ value: DesignApprovalChoice; label: string; promptId: string }[]>(() => {
  const prompt = current.value;
  if (!prompt) return [];
  return [
    { value: 'approve', label: prompt.hasParent ? t('design.approval.approve') : t('design.approval.approveNoParent'), promptId: prompt.promptId },
    { value: 'changes', label: t('design.approval.requestChanges'), promptId: prompt.promptId },
    { value: 'stop', label: t('design.approval.stop'), promptId: prompt.promptId },
  ];
});
const selected = ref<DesignApprovalChoice>('approve');
const writing = ref(false);
const note = ref('');
const canSend = computed(() => note.value.trim().length > 0);
const noteRef = ref<{ $el?: HTMLElement } | null>(null);

// Runs before the card's DOM changes, so focus is still inside a card that is leaving.
watch(() => current.value?.promptId, (_id, was) => {
  if (was !== undefined && cardRef.value?.contains(document.activeElement)) emit('release-focus');
  selected.value = 'approve';
  writing.value = false;
  note.value = '';
}, { flush: 'pre' });

function answer(promptId: string, choice: DesignApprovalChoice, feedback?: string): void {
  const prompt = current.value;
  if (!prompt || prompt.promptId !== promptId) return;
  postMessage(feedback === undefined
    ? { type: 'resolveDesignApproval', promptId, choice }
    : { type: 'resolveDesignApproval', promptId, choice, feedback });
  store.removeApprovalPrompt(promptId);
}

function select(promptId: string, choice: DesignApprovalChoice): void {
  if (choice !== 'changes') {
    answer(promptId, choice);
    return;
  }
  selected.value = 'changes';
  writing.value = true;
  void nextTick(() => noteRef.value?.$el?.focus());
}

function sendNote(): void {
  const prompt = current.value;
  const feedback = note.value.trim();
  if (!prompt || feedback === '') return;
  answer(prompt.promptId, 'changes', feedback);
}

function back(): void {
  writing.value = false;
}

useDockPromptDigits(cardRef, (digit) => {
  const choice = writing.value ? undefined : choices.value[digit - 1];
  if (!choice) return false;
  select(choice.promptId, choice.value);
  return true;
});
</script>

<template>
  <Transition
    name="t-up"
    mode="out-in"
  >
    <section
      v-if="current"
      :key="current.promptId"
      ref="cardRef"
      class="overflow-hidden rounded-[0.875rem] border border-[color-mix(in_srgb,var(--d-design)_45%,var(--d-border))] bg-(--d-card) text-(--d-text) shadow-(--d-shadow) [--attention-ring:var(--d-design)]"
      role="region"
      :aria-label="title"
      data-dock-prompt
      data-testid="design-approval-card"
      :data-design-id="current.designId"
      :data-has-parent="current.hasParent"
    >
      <header class="flex items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-design)_12%,transparent)] to-transparent px-3 py-2">
        <span
          class="d-ring flex size-6.5 flex-none items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--d-design)_16%,transparent)] text-(--d-design)"
          aria-hidden="true"
        >
          <Palette class="size-3.5" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="font-semibold text-pretty">
            {{ title }}
          </div>
          <div
            class="text-xs text-pretty text-(--d-muted)"
            data-testid="design-approval-subtitle"
          >
            {{ subtitle }}
          </div>
        </div>
      </header>

      <!-- Scrolls when long; focusable so a keyboard user can scroll it too. -->
      <div
        class="flex max-h-64 flex-col gap-2.5 overflow-y-auto px-3.5 pt-2.5 pb-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-(--d-design) focus-visible:ring-inset"
        role="region"
        :aria-label="t('design.approval.details')"
        tabindex="0"
        data-testid="design-approval-details"
      >
        <p
          class="text-12.5 text-pretty wrap-anywhere whitespace-pre-line text-(--d-text)"
          data-testid="design-approval-summary"
          v-text="current.summary"
        />

        <section data-testid="design-approval-changes">
          <template v-if="current.previousVersion !== null">
            <p class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-faint-text) uppercase">
              {{ t('design.result.changedSince', { version: current.previousVersion }) }}
            </p>
            <DesignChangeList
              v-if="current.changes.length > 0"
              :changes="current.changes"
            />
            <p
              v-else
              class="text-(--d-muted)"
            >
              {{ t('design.approval.noChanges') }}
            </p>
          </template>
          <p
            v-else
            class="text-(--d-muted)"
          >
            {{ t('design.approval.firstVersion') }}
          </p>
        </section>

        <section
          v-if="current.warnings.length > 0"
          data-testid="design-approval-warnings"
        >
          <p class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-warning-text) uppercase">
            {{ t('design.result.warningsLabel') }}
          </p>
          <DesignWarningList :warnings="current.warnings" />
        </section>

        <p
          v-for="line in uncheckedLines"
          :key="line"
          class="text-pretty text-(--d-warning-text)"
          data-testid="design-approval-unchecked"
        >
          {{ line }}
        </p>

        <section
          v-if="current.decisions.length > 0"
          data-testid="design-approval-decisions"
        >
          <p class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-faint-text) uppercase">
            {{ t('design.result.decisionsLabel') }}
          </p>
          <DesignDecisionList :decisions="current.decisions" />
        </section>
      </div>

      <div
        v-if="screenOpener && current.screens.length > 0"
        class="flex flex-wrap items-center gap-1.5 border-t border-(--d-border) px-3 py-2"
        data-testid="design-approval-screens"
      >
        <span class="me-0.5 text-10.5 font-semibold tracking-[.06em] text-(--d-faint-text) uppercase">{{ t('design.browser.screens') }}</span>
        <Button
          v-for="screen in current.screens"
          :key="screen.file"
          type="button"
          variant="ghost"
          class="d-press h-6.5 gap-1.5 rounded-7 bg-[color-mix(in_srgb,var(--d-design)_10%,transparent)] px-2 font-mono text-11.5 text-(--d-design-text) hover:bg-[color-mix(in_srgb,var(--d-design)_18%,transparent)] hover:text-(--d-design-text) focus-visible:ring-1 focus-visible:ring-(--d-design) focus-visible:ring-offset-0 [&_svg]:size-3"
          :aria-label="t(screenOpener.key, { file: screen.file })"
          :title="screen.file"
          data-testid="design-approval-screen"
          :data-file="screen.file"
          @click="screenOpener.open(current.designId, screen.file)"
        >
          <component
            :is="screenOpener.icon"
            aria-hidden="true"
          />{{ screen.id }}
        </Button>
      </div>

      <div
        v-if="!writing"
        class="border-t border-(--d-border) px-1.5 pt-1 pb-1.5"
      >
        <ListboxRoot
          v-model="selected"
          class="flex flex-col outline-none"
          orientation="vertical"
        >
          <DockPromptOptions :aria-label="title">
            <ListboxItem
              v-for="(option, index) in choices"
              :key="option.value"
              :value="option.value"
              class="group flex items-center gap-2.5 rounded-9 px-2.5 py-1.25 transition-colors outline-none data-highlighted:bg-[color-mix(in_srgb,var(--d-design)_14%,transparent)] data-highlighted:text-(--d-design-text)"
              :data-testid="`design-approval-option-${option.value}`"
              @select="select(option.promptId, option.value)"
            >
              <span
                class="flex size-5 flex-none items-center justify-center rounded-md border font-mono text-11"
                :class="option.value === 'approve'
                  ? 'border-transparent bg-(--d-design) text-(--d-on-design)'
                  : 'border-(--d-border2) group-data-highlighted:border-(--d-design)'"
                aria-hidden="true"
              >{{ index + 1 }}</span>
              <span
                class="min-w-0 flex-1 truncate"
                :class="option.value === 'approve' ? 'font-semibold' : 'font-medium'"
              >{{ option.label }}</span>
            </ListboxItem>
          </DockPromptOptions>
        </ListboxRoot>
      </div>

      <form
        v-else
        class="flex flex-col gap-2 border-t border-(--d-border) px-3 pt-2.5 pb-3"
        data-testid="design-approval-note-form"
        @submit.prevent="sendNote"
      >
        <label
          class="text-xs font-medium text-(--d-text)"
          for="design-approval-note"
        >{{ t('design.approval.noteLabel') }}</label>
        <Textarea
          id="design-approval-note"
          ref="noteRef"
          v-model="note"
          class="max-h-32 min-h-20 resize-none rounded-10 border-(--d-border2) bg-(--d-input) text-12.5 focus:border-(--d-design)"
          :placeholder="t('design.approval.notePlaceholder')"
          data-testid="design-approval-note"
          @keydown.enter.ctrl.prevent="sendNote"
          @keydown.enter.meta.prevent="sendNote"
          @keydown.esc.stop="back"
        />
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="d-press flex h-7.5 items-center rounded-9 px-3 text-12.5 transition-colors hover:bg-(--d-hover) focus-visible:outline-2 focus-visible:outline-(--d-design)"
            @click="back"
          >
            {{ t('common.back') }}
          </button>
          <button
            type="submit"
            class="d-press flex h-7.5 items-center gap-1.5 rounded-9 bg-(--d-design) px-3.5 text-12.5 font-semibold text-(--d-on-design) transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--d-design) disabled:cursor-default disabled:opacity-40 disabled:hover:brightness-100"
            :disabled="!canSend"
            data-testid="design-approval-send-note"
          >
            <SendHorizontal
              class="size-3.25"
              aria-hidden="true"
            />
            {{ t('design.approval.sendNote') }}
          </button>
        </div>
      </form>
    </section>
  </Transition>
</template>
