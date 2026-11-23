<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ListboxItem, ListboxRoot } from 'reka-ui';
import { CircleAlert, Eye, History, LoaderCircle, Maximize2, Minus, Monitor, Palette, SendHorizontal, Square, X } from 'lucide-vue-next';
import HostBadge from '../HostBadge.vue';
import { IsolatedText } from '../isolated-text';
import { isolated } from '@shared/bidi-isolate';
import type { ThemeChangeChoice, ThemeShowNote } from '@shared/themes/agent';
import { MAX_PROMPT_ANSWER_CHARS } from '@shared/types/constants';
import type { LookKind } from '@shared/themes/tokens';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import DockPromptOptions from '../DockPromptOptions.vue';
import ThemeMiniature from './ThemeMiniature.vue';
import { changeItemText, contrastText, droppedCssText, looksText } from './theme-words';
import { isHexColor } from './theme-view';
import { useThemePromptStore } from '@/stores/useThemePromptStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useDockPromptDigits } from '@/composables/useDockPrompt';
import { useAttentionCard } from '@/composables/useAttention';
import { useDockCardVisibility } from '@/composables/useDockCardVisibility';
import TrustedCheckingNote from '../TrustedCheckingNote.vue';

// The agent's theme proposal: nothing changes until the user answers. Trusted UI, so while Show in window paints the
// proposal on the window, main keeps this card on the palette from before it.
const emit = defineEmits<{
  /** The card left while it held focus; the page hands focus on. */
  (e: 'release-focus'): void;
}>();

// why Show in window is off, per note: a note core gains does not compile without its sentence
const SHOW_NOTES: Record<ThemeShowNote, string> = {
  takenOver: 'themeAgent.card.takenOver',
  forcedColors: 'themeAgent.card.forcedColors',
  safeStart: 'themeAgent.card.safeStart',
};

const { t, locale } = useI18n();
const words = computed(() => ({ t, locale: locale.value }));
const store = useThemePromptStore();
const { postMessage } = usePlatformBridge();

const current = computed(() => store.changePrompts[0]);
const cardRef = ref<HTMLElement | null>(null);
useAttentionCard('approval', cardRef);

const { isVisible, explain, refuse } = useDockCardVisibility(cardRef);
const checking = computed(() => !isVisible.value);
const outdated = computed(() => current.value?.state === 'outdated');
// A remote chat's card on a device the change does not land on: it names the computer that changes and offers Discard only.
const otherDevice = computed(() => current.value?.otherDevice);
const discardOnly = computed(() => outdated.value || otherDevice.value !== undefined);
// The answer this view sent and core has not answered. Core answers every one by posting the card again, changed, as it
// stands or closed, so any post of the card clears it; the card's own state is core's alone and is never set here.
const sent = ref<ThemeChangeChoice | null>(null);
watch(current, () => {
  sent.value = null;
});
// core took an Apply: no answer is taken until it ends
const applying = computed(() => current.value?.state === 'applying');
// Nothing acts while held. While only this view's answer is out, Discard still acts: core takes it whenever it takes an answer.
const held = computed(() => checking.value || applying.value);
const locked = computed(() => held.value || sent.value !== null);
// The status line above the options: an answer on its way.
const status = computed<'applying' | 'answering' | undefined>(() => {
  if (applying.value || sent.value === 'apply') return 'applying';
  return sent.value !== null ? 'answering' : undefined;
});
// What a held control names as its reason.
const reasonId = computed(() => (status.value ? 'theme-change-check-reason' : explain.value ? 'theme-change-checking' : undefined));
const name = computed(() => current.value?.themeName ?? current.value?.theme?.name ?? '');
const looks = computed(() => (current.value ? looksText(t, current.value.looks) : ''));

const title = computed(() => {
  const prompt = current.value;
  if (!prompt) return '';
  if (prompt.action === 'schedule') return t('themeAgent.card.titleSchedule');
  if (prompt.action === 'undo') return t('themeAgent.card.titleUndo');
  if (prompt.action === 'project') return t('themeAgent.card.titleProject');
  if (prompt.action === 'wallpapersOff') return t('themeAgent.card.titleWallpapersOff');
  return prompt.isNew ? t('themeAgent.card.titleNew') : t('themeAgent.card.titleChange');
});
// What the subtitle ends with.
const tailKind = computed(() => {
  if (outdated.value) return 'outOfDate';
  if (otherDevice.value?.computer !== undefined) return 'appliesOn';
  return otherDevice.value ? 'appliesElsewhere' : 'nothingChanges';
});
// The subtitle that names the computer is one message with the computer's badge as a part of it.
const computerSubtitleKey = computed(() => {
  if (!name.value) return 'themeAgent.card.appliesOn';
  return looks.value ? 'themeAgent.card.subtitleOn' : 'themeAgent.card.subtitleNoLooksOn';
});
const subtitle = computed(() => {
  const prompt = current.value;
  if (!prompt || tailKind.value === 'appliesOn') return '';
  const tail = t(`themeAgent.card.${tailKind.value}`);
  if (!name.value) return tail;
  return looks.value ? t('themeAgent.card.subtitle', { name: isolated(name.value), looks: looks.value, tail }) : t('themeAgent.card.subtitleNoLooks', { name: isolated(name.value), tail });
});

// A theme with both looks draws split, dark top left; the expanded preview can show either look alone.
const miniMode = computed<'split' | LookKind>(() => {
  const theme = current.value?.theme;
  if (theme?.looks.dark && theme.looks.light) return 'split';
  return theme?.looks.light ? 'light' : 'dark';
});
const miniLabel = (mode: 'split' | LookKind, large = false): string => t(large ? 'themeAgent.card.miniLabelLarge' : 'themeAgent.card.miniLabel', {
  name: name.value,
  looks: mode === 'split' ? t('themeAgent.looks.bothLooks') : t(`themeAgent.looks.${mode}Look`),
});

const expanded = ref(false);
const pick = ref<'split' | LookKind>('split');
const picks = computed(() => (['split', 'dark', 'light'] as const).filter((mode) => (mode === 'split' ? miniMode.value === 'split' : current.value?.theme?.looks[mode] !== undefined)));
function openPreview(): void {
  pick.value = miniMode.value;
  expanded.value = true;
}

// A swatch per color line, painted from the proposal's own seed and only when that is a hex color.
const changes = computed(() => (current.value?.changes ?? []).map((item, index) => ({
  key: `${item.kind}-${index}`,
  text: changeItemText(words.value, item),
  swatch: item.kind === 'color' && isHexColor(item.hex) ? item.hex : undefined,
})));
const contrast = computed(() => (current.value?.contrast ?? []).map((issue, index) => ({ key: `${issue.look}-${issue.fg}-${issue.bg}-${index}`, look: issue.look, text: contrastText(words.value, issue) })));
const droppedMore = computed(() => current.value?.droppedCssMore ?? 0);
// the miniature, or on another device the note that stands in for it
const hasPreviewColumn = computed(() => current.value?.theme !== undefined || otherDevice.value !== undefined);
const dropped = computed(() => (current.value?.droppedCss ?? []).map((part, index) => ({ key: `${part.region}-${part.reason}-${index}`, reason: part.reason, code: part.text, text: droppedCssText(words.value, part) })));

// Each option names its prompt, so a leaving card's option never answers the next one.
const choices = computed<{ value: ThemeChangeChoice; label: string; promptId: string }[]>(() => {
  const prompt = current.value;
  if (!prompt) return [];
  if (discardOnly.value) return [{ value: 'discard', label: t('themeAgent.card.discard'), promptId: prompt.promptId }];
  return [
    { value: 'apply', label: t('themeAgent.card.apply'), promptId: prompt.promptId },
    { value: 'discard', label: t('themeAgent.card.discard'), promptId: prompt.promptId },
    { value: 'change', label: t('themeAgent.card.change'), promptId: prompt.promptId },
  ];
});
const selected = ref<ThemeChangeChoice>(discardOnly.value ? 'discard' : 'apply');
const writing = ref(false);
const note = ref('');
const canSend = computed(() => note.value.trim().length > 0);
const noteRef = ref<{ $el?: HTMLElement } | null>(null);
const optionsRef = ref<HTMLElement | null>(null);
const toggleRef = ref<InstanceType<typeof Button> | null>(null);
const previewRef = ref<HTMLElement | null>(null);

// The expanded preview is portaled out of the card, so focus inside it is the card's too.
function holdsFocus(): boolean {
  const active = document.activeElement;
  return cardRef.value?.contains(active) === true || previewRef.value?.contains(active) === true;
}
const listbox = (): HTMLElement | null => optionsRef.value?.querySelector<HTMLElement>('[role="listbox"]') ?? null;

// Runs before the card's DOM changes, so focus is still inside a card that is leaving.
watch([() => current.value?.promptId, discardOnly], ([id, only], [was]) => {
  selected.value = only ? 'discard' : 'apply';
  if (id !== was) {
    if (was !== undefined && holdsFocus()) emit('release-focus');
    writing.value = false;
    note.value = '';
    expanded.value = false;
    return;
  }
  if (!only) return;
  // The answers changed under the open card (core turned it outdated): focus goes to them when its control is gone.
  const focused = cardRef.value?.contains(document.activeElement) === true ? document.activeElement : null;
  writing.value = false;
  if (focused) void nextTick(() => {
    if (!focused.isConnected || !cardRef.value?.contains(document.activeElement)) listbox()?.focus();
  });
}, { flush: 'pre' });
onBeforeUnmount(() => {
  if (holdsFocus()) emit('release-focus');
});

function answer(promptId: string, choice: ThemeChangeChoice, feedback?: string): void {
  const prompt = current.value;
  if (!prompt || prompt.promptId !== promptId || held.value) return;
  if (choice !== 'discard' && (discardOnly.value || sent.value !== null)) return;
  postMessage(feedback === undefined
    ? { type: 'resolveThemeChange', promptId, choice }
    : { type: 'resolveThemeChange', promptId, choice, note: feedback });
  // The card stays until core closes it.
  sent.value = choice;
}

function select(promptId: string, choice: ThemeChangeChoice): void {
  if (choice !== 'change') {
    answer(promptId, choice);
    return;
  }
  if (locked.value) return;
  selected.value = 'change';
  writing.value = true;
  void nextTick(() => noteRef.value?.$el?.focus());
}

function sendNote(): void {
  const prompt = current.value;
  const feedback = note.value.trim();
  if (!prompt || feedback === '') return;
  answer(prompt.promptId, 'change', feedback);
}

function back(): void {
  writing.value = false;
  void nextTick(() => listbox()?.focus());
}

function setShowing(on: boolean): void {
  const prompt = current.value;
  if (!prompt || locked.value) return;
  postMessage({ type: 'setThemeShowInWindow', promptId: prompt.promptId, on });
}

function stopShowing(): void {
  setShowing(false);
  (toggleRef.value?.$el as HTMLElement | undefined)?.focus();
}

const showsToggle = computed(() => current.value?.canShowInWindow === true && !outdated.value);

useDockPromptDigits(cardRef, (digit) => {
  const choice = writing.value || held.value ? undefined : choices.value[digit - 1];
  if (!choice) return false;
  select(choice.promptId, choice.value);
  return true;
}, refuse);
</script>

<template>
  <Transition name="t-up">
    <div
      v-if="current"
      class="d-dock-shadow rounded-14"
      data-trusted
    >
      <!-- One bounded element: the details scroll inside it, so the whole card always fits the dock. -->
      <!-- Keyed by the request: the next request is a new element, which starts held (useTrustedVisibility). -->
      <section
        ref="cardRef"
        :key="current.promptId"
        class="@container/pcard flex max-h-[70dvh] min-h-0 flex-col overflow-x-hidden overflow-y-auto rounded-14 border border-[color-mix(in_srgb,var(--d-accent-fill)_40%,var(--d-border))] bg-(--d-card) text-(--d-text) [--attention-ring:var(--d-accent-fill)]"
        role="region"
        :aria-label="title"
        data-dock-prompt
        data-trusted
        data-testid="theme-change-card"
        :data-state="current.state"
        :data-action="current.action"
      >
        <header class="flex flex-none items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-accent-fill)_12%,transparent)] to-transparent px-3 py-2">
          <span
            class="d-ring [--tone:var(--d-accent-fill)] flex size-6.5 flex-none items-center justify-center rounded-8 bg-[color-mix(in_srgb,var(--d-accent-fill)_16%,transparent)] text-(--d-accent)"
            aria-hidden="true"
          >
            <Palette class="size-3.5" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="text-13 font-semibold text-pretty">
              {{ title }}
            </h2>
            <p
              class="flex flex-wrap items-center gap-x-1.5 text-xs text-pretty text-(--d-muted)"
              data-testid="theme-change-subtitle"
            >
              <i18n-t
                v-if="tailKind === 'appliesOn' && otherDevice?.computer !== undefined"
                :keypath="computerSubtitleKey"
                tag="span"
                scope="global"
              >
                <template #name>
                  <bdi>{{ name }}</bdi>
                </template>
                <template #looks>
                  <span>{{ looks }}</span>
                </template>
                <template #computer>
                  <HostBadge
                    :name="otherDevice.computer"
                    data-testid="theme-change-computer"
                  />
                </template>
              </i18n-t>
              <span v-else><IsolatedText :text="subtitle" /></span>
            </p>
          </div>
        </header>

        <!-- Scrolls when long; focusable so a keyboard user can scroll it too. -->
        <div
          class="flex max-h-72 min-h-0 flex-col gap-2.5 overflow-y-auto px-3.5 pt-2.5 pb-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-(--d-accent-fill) focus-visible:ring-inset"
          role="region"
          :aria-label="t('themeAgent.card.details')"
          tabindex="0"
          data-testid="theme-change-details"
        >
          <div
            v-if="outdated"
            class="flex items-start gap-2 rounded-9 border border-[color-mix(in_srgb,var(--d-warning-fill)_40%,var(--d-border))] bg-[color-mix(in_srgb,var(--d-warning-fill)_9%,var(--d-card))] px-2.5 py-2"
            data-testid="theme-change-outdated"
          >
            <History
              class="mt-0.5 size-3.5 flex-none text-(--d-warning)"
              aria-hidden="true"
            />
            <p class="text-pretty">
              {{ t('themeAgent.card.outdatedNote') }}
            </p>
          </div>
          <div
            v-if="otherDevice"
            class="flex items-start gap-2 rounded-9 border border-(--d-border) bg-(--d-panel) px-2.5 py-2"
            data-testid="theme-change-other-device"
          >
            <Monitor
              class="mt-0.5 size-3.5 flex-none text-(--d-muted)"
              aria-hidden="true"
            />
            <p class="text-pretty">
              {{ otherDevice.computer !== undefined ? t('themeAgent.card.otherDeviceNote', { computer: otherDevice.computer }) : t('themeAgent.card.otherDeviceNoteUnnamed') }}
            </p>
          </div>
          <p
            v-if="current.planMode"
            class="flex items-start gap-2 rounded-9 border border-(--d-border) bg-(--d-panel) px-2.5 py-2 text-pretty"
            data-testid="theme-change-plan-mode"
          >
            {{ t('themeAgent.card.planMode') }}
          </p>

          <div
            class="grid grid-cols-1 items-start gap-x-4 gap-y-2.5"
            :class="hasPreviewColumn ? '@min-[36rem]/pcard:grid-cols-[17rem_minmax(0,1fr)]' : ''"
            data-testid="theme-change-grid"
          >
            <figure
              v-if="current.theme"
              class="m-0 flex flex-col gap-1.5"
            >
              <ThemeMiniature
                :theme="current.theme"
                :mode="miniMode"
                :label="miniLabel(miniMode)"
                class="border border-(--d-border)"
              />
              <figcaption class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-11 text-(--d-faint-text)">
                <span>{{ miniMode === 'split' ? t('themeAgent.card.splitCaption') : looks }}</span>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-6 px-1 py-0.5 text-xs font-medium text-(--d-accent-text) hover:bg-(--d-hover) focus-visible:outline-2 focus-visible:outline-(--d-accent-fill)"
                  data-view-only
                  data-testid="theme-change-expand"
                  @click="openPreview"
                >
                  <Maximize2
                    class="size-3"
                    aria-hidden="true"
                  />{{ t('themeAgent.card.expand') }}
                </button>
              </figcaption>
            </figure>
            <div
              v-else-if="otherDevice"
              class="flex min-h-24 items-center justify-center gap-2 rounded-10 border border-dashed border-(--d-border2) bg-[repeating-linear-gradient(135deg,var(--d-hover)_0_0.375rem,transparent_0.375rem_0.75rem)] px-3 py-4 text-center text-xs text-(--d-muted)"
              data-testid="theme-change-other-placeholder"
            >
              <Monitor
                class="size-3.5 flex-none"
                aria-hidden="true"
              />
              <span class="text-pretty">{{ otherDevice.computer !== undefined ? t('themeAgent.card.otherDevicePreview', { computer: otherDevice.computer }) : t('themeAgent.card.otherDevicePreviewUnnamed') }}</span>
            </div>

            <div class="flex min-w-0 flex-col gap-3">
              <section
                v-if="changes.length > 0 && !outdated"
                :aria-label="t('themeAgent.card.changes')"
                data-testid="theme-change-changes"
              >
                <h3 class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-faint-text) uppercase">
                  {{ t('themeAgent.card.changes') }}
                </h3>
                <ul class="flex flex-col gap-1">
                  <li
                    v-for="item in changes"
                    :key="item.key"
                    class="flex min-w-0 items-start gap-2 text-pretty"
                  >
                    <span
                      v-if="item.swatch"
                      class="mt-0.5 size-3 flex-none rounded-sm shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--d-text)_18%,transparent)]"
                      :style="{ backgroundColor: item.swatch }"
                      data-testid="theme-change-swatch"
                      aria-hidden="true"
                    />
                    <span class="min-w-0 wrap-anywhere"><IsolatedText :text="item.text" /></span>
                  </li>
                </ul>
              </section>

              <section
                v-if="contrast.length > 0 && !outdated"
                :aria-label="t('themeAgent.card.contrast')"
                data-testid="theme-change-contrast"
              >
                <h3 class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-warning-text) uppercase">
                  {{ t('themeAgent.card.contrast') }}
                </h3>
                <ul class="flex flex-col gap-1">
                  <li
                    v-for="issue in contrast"
                    :key="issue.key"
                    class="flex min-w-0 items-start gap-2 text-pretty text-(--d-warning-text)"
                  >
                    <CircleAlert
                      class="mt-0.5 size-3 flex-none"
                      aria-hidden="true"
                    />
                    <span class="min-w-0 wrap-anywhere">
                      <span class="me-1 rounded-5 border border-(--d-border2) px-1 text-10.5 text-(--d-muted)">{{ t(`themeAgent.look.${issue.look}Title`) }}</span>{{ issue.text }}
                    </span>
                  </li>
                </ul>
              </section>

              <section
                v-if="dropped.length > 0 && !outdated"
                :aria-label="t('themeAgent.dropped.title')"
                data-testid="theme-change-dropped"
              >
                <h3 class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-warning-text) uppercase">
                  {{ t('themeAgent.dropped.title') }}
                </h3>
                <ul class="flex flex-col gap-1">
                  <li
                    v-for="part in dropped"
                    :key="part.key"
                    class="flex min-w-0 items-start gap-2 text-pretty"
                    :data-reason="part.reason"
                  >
                    <Minus
                      class="mt-0.5 size-3 flex-none text-(--d-warning-text)"
                      aria-hidden="true"
                    />
                    <span class="flex min-w-0 flex-col gap-0.5">
                      <code class="self-start rounded-5 bg-(--d-hover) px-1 font-mono text-10.5 wrap-anywhere">{{ part.code }}</code>
                      <span class="text-(--d-muted)">{{ part.text }}</span>
                    </span>
                  </li>
                </ul>
                <p
                  v-if="droppedMore > 0"
                  class="mt-1 text-(--d-muted)"
                  data-testid="theme-change-dropped-more"
                >
                  {{ t('themeAgent.dropped.more', { n: droppedMore }, droppedMore) }}
                </p>
              </section>
            </div>
          </div>
        </div>

        <!-- Show in window: paints the real window until stopped or answered. -->
        <div
          v-if="showsToggle"
          class="flex flex-none flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-(--d-border) px-3 py-2 text-xs"
          data-testid="theme-change-show-row"
        >
          <Button
            ref="toggleRef"
            type="button"
            variant="outline"
            size="sm"
            class="h-7 gap-1.5 rounded-8 border-(--d-border2) bg-transparent px-2.5 text-xs font-medium aria-pressed:border-(--d-accent-fill) aria-pressed:bg-(--d-accent-soft) aria-pressed:text-(--d-accent-text) aria-disabled:opacity-(--d-opacity-disabled) [&_svg]:size-3.5"
            :aria-pressed="current.showInWindow"
            :aria-disabled="locked || undefined"
            :aria-describedby="reasonId"
            data-testid="theme-change-show"
            @click="setShowing(!current.showInWindow)"
          >
            <Eye aria-hidden="true" />{{ t('themeAgent.card.showInWindow') }}
          </Button>
          <span
            v-if="!current.showInWindow && current.showNote === undefined"
            class="min-w-0 text-pretty text-(--d-muted)"
          >{{ t('themeAgent.card.showHint') }}</span>
          <!-- A live region: it says that the window shows the proposal, or why it stopped or cannot. -->
          <span
            role="status"
            class="min-w-0 text-pretty text-(--d-muted)"
            data-testid="theme-change-showing"
          >{{ current.showInWindow ? t('themeAgent.card.showing') : current.showNote !== undefined ? t(SHOW_NOTES[current.showNote]) : '' }}</span>
          <button
            v-if="current.showInWindow"
            type="button"
            class="inline-flex items-center gap-1 rounded-6 px-1 py-0.5 text-xs font-medium text-(--d-accent-text) hover:bg-(--d-hover) focus-visible:outline-2 focus-visible:outline-(--d-accent-fill) aria-disabled:opacity-(--d-opacity-disabled)"
            :aria-disabled="locked || undefined"
            :aria-describedby="reasonId"
            data-testid="theme-change-stop"
            @click="stopShowing"
          >
            <Square
              class="size-3"
              aria-hidden="true"
            />{{ t('themeAgent.card.stopShowing') }}
          </button>
        </div>

        <div
          v-if="status"
          id="theme-change-check-reason"
          role="status"
          class="flex flex-none items-center gap-2 border-t border-(--d-border) px-3 py-2 text-xs text-(--d-muted)"
          :data-testid="`theme-change-${status}`"
        >
          <LoaderCircle
            class="d-spinning size-3.5 text-(--d-accent)"
            aria-hidden="true"
          />
          <span>{{ t(`themeAgent.card.${status}`) }}</span>
        </div>
        <TrustedCheckingNote
          id="theme-change-checking"
          overlay
          class="bottom-0"
          :shown="explain"
          :text="t('trusted.checkingVisible')"
        />

        <div
          v-if="!writing"
          ref="optionsRef"
          class="flex-none border-t border-(--d-border) px-1.5 pt-1 pb-1.5"
        >
          <!-- Keyed by its set of answers: a new set mounts as new options do, so it never takes focus from the composer. -->
          <ListboxRoot
            :key="discardOnly ? 'discard' : 'answers'"
            v-model="selected"
            class="flex flex-col outline-none"
            orientation="vertical"
            :disabled="applying || explain"
          >
            <DockPromptOptions
              :aria-label="t('themeAgent.card.answer')"
              :aria-disabled="held || undefined"
              :aria-describedby="reasonId"
            >
              <ListboxItem
                v-for="(option, index) in choices"
                :key="option.value"
                :value="option.value"
                :disabled="sent !== null && option.value !== 'discard'"
                class="group flex items-center gap-2.5 rounded-9 px-2.5 py-1.25 transition-colors outline-none data-disabled:opacity-(--d-opacity-disabled) data-highlighted:bg-[color-mix(in_srgb,var(--d-accent-fill)_14%,transparent)] data-highlighted:text-(--d-accent-text)"
                :data-testid="`theme-change-option-${option.value}`"
                @select="select(option.promptId, option.value)"
              >
                <span
                  class="flex size-5 flex-none items-center justify-center rounded-md border font-mono text-11"
                  :class="option.value === 'apply'
                    ? 'border-transparent bg-(--d-accent-fill) text-(--d-on-accent)'
                    : 'border-(--d-border2) group-data-highlighted:border-(--d-accent-fill)'"
                  aria-hidden="true"
                >{{ index + 1 }}</span>
                <span
                  class="min-w-0 flex-1 truncate"
                  :class="option.value === 'apply' ? 'font-semibold' : 'font-medium'"
                >{{ option.label }}</span>
              </ListboxItem>
            </DockPromptOptions>
          </ListboxRoot>
        </div>

        <form
          v-else
          class="flex flex-none flex-col gap-2 border-t border-(--d-border) px-3 pt-2.5 pb-3"
          data-testid="theme-change-note-form"
          @submit.prevent="sendNote"
        >
          <label
            class="text-xs font-medium text-(--d-text)"
            for="theme-change-note"
          >{{ t('themeAgent.card.noteLabel') }}</label>
          <Textarea
            id="theme-change-note"
            ref="noteRef"
            v-model="note"
            class="max-h-32 min-h-20 resize-none rounded-10 border-(--d-border2) bg-(--d-input) text-12.5 focus:border-(--d-accent-fill)"
            :placeholder="t('themeAgent.card.notePlaceholder')"
            :maxlength="MAX_PROMPT_ANSWER_CHARS"
            data-testid="theme-change-note"
            @keydown.enter.ctrl.prevent="sendNote"
            @keydown.enter.meta.prevent="sendNote"
            @keydown.esc.stop="back"
          />
          <div class="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              class="d-press flex h-7.5 items-center rounded-9 px-3 text-12.5 transition-colors hover:bg-(--d-hover) focus-visible:outline-2 focus-visible:outline-(--d-accent-fill)"
              data-testid="theme-change-back"
              @click="back"
            >
              {{ t('common.back') }}
            </button>
            <button
              type="submit"
              class="d-press flex h-7.5 items-center gap-1.5 rounded-9 bg-(--d-accent-fill) px-3.5 text-12.5 font-semibold text-(--d-on-accent) transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent-fill) disabled:cursor-default disabled:opacity-40 disabled:hover:brightness-100"
              :disabled="!canSend || locked"
              data-testid="theme-change-send-note"
            >
              <SendHorizontal
                class="size-3.25"
                aria-hidden="true"
              />
              {{ t('themeAgent.card.sendNote') }}
            </button>
          </div>
        </form>

        <Dialog v-model:open="expanded">
          <DialogContent
            v-if="current.theme"
            class="w-[calc(100%-2rem)] max-w-[60rem] gap-3 p-0"
            :show-close="false"
            data-trusted
            data-testid="theme-change-preview"
          >
            <div
              ref="previewRef"
              class="contents"
            >
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3">
                <DialogTitle class="min-w-0 flex-[1_1_12rem] text-15 font-semibold">
                  <IsolatedText :text="t('themeAgent.card.previewTitle', { name: isolated(name) })" />
                </DialogTitle>
                <div
                  role="group"
                  :aria-label="t('themeAgent.card.lookShown')"
                  class="flex rounded-9 border border-(--d-border2) p-0.5"
                >
                  <button
                    v-for="mode in picks"
                    :key="mode"
                    type="button"
                    class="rounded-7 px-2.5 py-1 text-xs font-medium text-(--d-muted) aria-pressed:bg-(--d-accent-soft) aria-pressed:text-(--d-accent-text) focus-visible:outline-2 focus-visible:outline-(--d-accent-fill)"
                    :aria-pressed="pick === mode"
                    :data-testid="`theme-change-pick-${mode}`"
                    @click="pick = mode"
                  >
                    {{ t(`themeAgent.card.pick.${mode}`) }}
                  </button>
                </div>
                <DialogClose
                  class="flex size-7.5 items-center justify-center rounded-9 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:outline-2 focus-visible:outline-(--d-accent-fill)"
                  :aria-label="t('themeAgent.card.closePreview')"
                >
                  <X
                    class="size-4"
                    aria-hidden="true"
                  />
                </DialogClose>
              </div>
              <div class="flex flex-col gap-2 px-4 pb-4">
                <ThemeMiniature
                  :theme="current.theme"
                  :mode="pick"
                  :label="miniLabel(pick, true)"
                  class="border border-(--d-border)"
                  data-testid="theme-change-preview-mini"
                  :data-mode="pick"
                />
                <DialogDescription class="text-xs text-pretty text-(--d-muted)">
                  {{ t('themeAgent.card.previewNote') }}
                </DialogDescription>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </section>
    </div>
  </Transition>
</template>
