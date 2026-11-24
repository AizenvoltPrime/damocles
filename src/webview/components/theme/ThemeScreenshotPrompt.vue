<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ListboxItem, ListboxRoot } from 'reka-ui';
import { Camera, ImageOff, TriangleAlert } from 'lucide-vue-next';
import type { ThemeScreenshotChoice } from '@shared/themes/agent';
import type { LookKind } from '@shared/themes/tokens';
import { isThemeShotUrl } from '@shared/themes/wallpapers';
import { isolated } from '@shared/bidi-isolate';
import { IsolatedText } from '../isolated-text';
import DockPromptOptions from '../DockPromptOptions.vue';
import ThemeMiniature from './ThemeMiniature.vue';
import { useThemePromptStore } from '@/stores/useThemePromptStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useDockPromptDigits } from '@/composables/useDockPrompt';
import { useAttentionCard } from '@/composables/useAttention';
import { useDockCardVisibility } from '@/composables/useDockCardVisibility';
import TrustedCheckingNote from '../TrustedCheckingNote.vue';

// ThemeRead asks to send a screenshot of the window. Of the window as it is, the card shows the very image main holds before
// anything is sent; of a draft, it shows the draft's miniature, since main paints and captures the draft only after an Allow.
const emit = defineEmits<{
  /** The card left while it held focus; the page hands focus on. */
  (e: 'release-focus'): void;
}>();

const { t } = useI18n();
const store = useThemePromptStore();
const { postMessage } = usePlatformBridge();

const current = computed(() => store.screenshotPrompts[0]);
const cardRef = ref<HTMLElement | null>(null);
useAttentionCard('approval', cardRef);
const { isVisible, explain, refuse } = useDockCardVisibility(cardRef);

const draft = computed(() => current.value?.draft);
// The prompt whose image did not load: main let go of the screenshot.
const failed = ref<string | null>(null);
// The capture the card shows: one from main's own screenshot path that loaded.
const shot = computed(() => {
  const prompt = current.value;
  return prompt?.url !== undefined && isThemeShotUrl(prompt.url) && failed.value !== prompt.promptId
    ? { url: prompt.url, width: prompt.width, height: prompt.height }
    : undefined;
});
// The Allows are offered for the capture the card shows, or for a draft, which main captures only after one.
const allowable = computed(() => draft.value !== undefined || shot.value !== undefined);
// The answer this view sent; core answers every one by closing the card or posting it again, which clears it.
const sent = ref<ThemeScreenshotChoice | null>(null);
watch(current, () => {
  sent.value = null;
});

const title = computed(() => t(draft.value ? 'themeAgent.shot.titleDraft' : 'themeAgent.shot.title'));
// Allow once leads, Allow for this chat follows it, Deny ends the list: the digits and arrows take them in that order.
const choices = computed<{ value: ThemeScreenshotChoice; label: string; hint?: string; promptId: string }[]>(() => {
  const prompt = current.value;
  if (!prompt) return [];
  const deny = { value: 'deny' as const, label: t('themeAgent.shot.deny'), promptId: prompt.promptId };
  if (!allowable.value) return [deny];
  return [
    { value: 'allow', label: t('themeAgent.shot.allow'), promptId: prompt.promptId },
    { value: 'allowChat', label: t('themeAgent.shot.allowChat'), hint: t('themeAgent.shot.allowChatHint'), promptId: prompt.promptId },
    deny,
  ];
});
const selected = ref<ThemeScreenshotChoice>(allowable.value ? 'allow' : 'deny');
const optionsRef = ref<HTMLElement | null>(null);

// A draft with both looks draws split, dark top left, as the theme card draws it.
const miniMode = computed<'split' | LookKind>(() => {
  const looks = draft.value?.theme.looks;
  if (looks?.dark && looks.light) return 'split';
  return looks?.light ? 'light' : 'dark';
});
const miniLabel = computed(() => t('themeAgent.card.miniLabel', {
  name: draft.value?.name ?? '',
  looks: miniMode.value === 'split' ? t('themeAgent.looks.bothLooks') : t(`themeAgent.looks.${miniMode.value}Look`),
}));

// Runs before the card's DOM changes, so focus is still inside a card that is leaving.
watch([() => current.value?.promptId, allowable], ([id, has], [was]) => {
  selected.value = has ? 'allow' : 'deny';
  if (id !== was) {
    if (was !== undefined && cardRef.value?.contains(document.activeElement)) emit('release-focus');
    return;
  }
  // The Allows left the open card: focus goes to the answers when it was on one of them.
  const focused = cardRef.value?.contains(document.activeElement) === true ? document.activeElement : null;
  if (focused) void nextTick(() => {
    if (!focused.isConnected) optionsRef.value?.querySelector<HTMLElement>('[role="listbox"]')?.focus();
  });
}, { flush: 'pre' });
onBeforeUnmount(() => {
  if (cardRef.value?.contains(document.activeElement)) emit('release-focus');
});

function imageFailed(): void {
  failed.value = current.value?.promptId ?? null;
}

function answer(promptId: string, choice: ThemeScreenshotChoice): void {
  const prompt = current.value;
  if (!prompt || prompt.promptId !== promptId || !isVisible.value) return;
  if (sent.value !== null || (choice !== 'deny' && !allowable.value)) return;
  postMessage({ type: 'resolveThemeScreenshot', promptId, choice });
  // The card stays until core closes it.
  sent.value = choice;
}

useDockPromptDigits(cardRef, (digit) => {
  const choice = choices.value[digit - 1];
  if (!choice) return false;
  answer(choice.promptId, choice.value);
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
      <!-- One bounded element: the image scrolls inside it, so the whole card always fits the dock. -->
      <!-- Keyed by the request: the next request is a new element, which starts held (useTrustedVisibility). -->
      <section
        ref="cardRef"
        :key="current.promptId"
        class="flex max-h-[70dvh] min-h-0 flex-col overflow-x-hidden overflow-y-auto rounded-14 border border-[color-mix(in_srgb,var(--d-warning-fill)_45%,transparent)] bg-(--d-card) text-(--d-text) [--attention-ring:var(--d-warning-fill)]"
        role="region"
        :aria-label="title"
        data-dock-prompt
        data-trusted
        data-testid="theme-screenshot-card"
      >
        <header class="flex flex-none items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-warning-fill)_10%,transparent)] to-transparent px-3 py-2">
          <span
            class="d-ring [--tone:var(--d-warning-fill)] flex size-6.5 flex-none items-center justify-center rounded-8 bg-[color-mix(in_srgb,var(--d-warning-fill)_16%,transparent)] text-(--d-warning)"
            aria-hidden="true"
          >
            <Camera class="size-3.5" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="text-13 font-semibold text-pretty">
              {{ title }}
            </h2>
            <p class="text-xs text-pretty text-(--d-muted)">
              {{ t(draft ? 'themeAgent.shot.subtitleDraft' : 'themeAgent.shot.subtitle') }}
            </p>
          </div>
        </header>
        <TrustedCheckingNote
          v-if="sent !== null"
          id="theme-screenshot-status"
          class="flex-none border-b border-(--d-border) px-3 py-2"
          shown
          :text="t('themeAgent.card.answering')"
        />
        <TrustedCheckingNote
          id="theme-screenshot-checking"
          overlay
          class="bottom-0"
          :shown="explain"
          :text="t('trusted.checkingVisible')"
        />

        <div
          class="flex max-h-[30rem] min-h-0 flex-col gap-2.5 overflow-y-auto px-3.5 pt-2.5 pb-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-(--d-accent-fill) focus-visible:ring-inset"
          role="region"
          :aria-label="t('themeAgent.shot.details')"
          tabindex="0"
        >
          <figure
            v-if="draft"
            class="m-0 flex max-w-[17rem] flex-col gap-1.5"
            data-testid="theme-screenshot-draft"
          >
            <ThemeMiniature
              :theme="draft.theme"
              :mode="miniMode"
              :label="miniLabel"
              class="border border-(--d-border)"
            />
            <figcaption class="flex min-w-0 flex-col gap-0.5 text-11 text-(--d-faint-text)">
              <span
                class="font-medium wrap-anywhere text-(--d-text)"
                data-testid="theme-screenshot-draft-name"
              ><IsolatedText :text="t('themeAgent.shot.draftCaption', { name: isolated(draft.name) })" /></span>
              <span v-if="miniMode === 'split'">{{ t('themeAgent.card.splitCaption') }}</span>
            </figcaption>
          </figure>
          <figure
            v-else-if="shot"
            class="m-0 flex max-w-[34rem] flex-col gap-1.5"
          >
            <img
              :src="shot.url"
              :alt="t('themeAgent.shot.alt', { width: shot.width, height: shot.height })"
              :width="shot.width"
              :height="shot.height"
              class="h-auto w-full rounded-8 border border-(--d-border)"
              data-testid="theme-screenshot-image"
              @error="imageFailed"
            >
            <figcaption class="text-11 text-(--d-faint-text)">
              {{ t('themeAgent.shot.caption', { width: shot.width, height: shot.height }) }}
            </figcaption>
          </figure>
          <p
            v-else
            class="flex items-start gap-2 rounded-9 border border-(--d-border) px-2.5 py-2 text-pretty"
            role="status"
            data-testid="theme-screenshot-gone"
          >
            <ImageOff
              class="mt-0.5 size-3.5 flex-none text-(--d-muted)"
              aria-hidden="true"
            />
            <span>{{ t('themeAgent.shot.gone') }}</span>
          </p>
          <p
            v-if="allowable"
            class="flex items-start gap-2 rounded-9 border border-[color-mix(in_srgb,var(--d-warning-fill)_40%,var(--d-border))] bg-[color-mix(in_srgb,var(--d-warning-fill)_9%,var(--d-card))] px-2.5 py-2 text-pretty"
            data-testid="theme-screenshot-note"
          >
            <TriangleAlert
              class="mt-0.5 size-3.5 flex-none text-(--d-warning)"
              aria-hidden="true"
            />
            <span>{{ t(draft ? 'themeAgent.shot.draftNote' : 'themeAgent.shot.note') }}</span>
          </p>
        </div>

        <div
          ref="optionsRef"
          class="flex-none border-t border-(--d-border) px-1.5 pt-1 pb-1.5"
        >
          <!-- Keyed by its set of answers: a new set mounts as new options do, so it never takes focus from the composer. -->
          <ListboxRoot
            :key="allowable ? 'answers' : 'deny'"
            v-model="selected"
            class="flex flex-col transition-opacity outline-none"
            :class="{ 'opacity-(--d-opacity-disabled)': sent !== null }"
            orientation="vertical"
            :disabled="explain || sent !== null"
          >
            <DockPromptOptions
              :aria-label="t('themeAgent.shot.answer')"
              :aria-disabled="!isVisible || sent !== null || undefined"
              :aria-describedby="explain ? 'theme-screenshot-checking' : sent !== null ? 'theme-screenshot-status' : undefined"
            >
              <ListboxItem
                v-for="(option, index) in choices"
                :key="option.value"
                :value="option.value"
                class="group flex items-start gap-2.5 rounded-9 px-2.5 py-1.25 transition-colors outline-none data-highlighted:bg-[color-mix(in_srgb,var(--d-warning-fill)_14%,transparent)]"
                :data-testid="`theme-screenshot-option-${option.value}`"
                @select="answer(option.promptId, option.value)"
              >
                <span
                  class="flex size-5 flex-none items-center justify-center rounded-md border font-mono text-11"
                  :class="{
                    'border-transparent bg-(--d-warning-fill) text-(--d-on-warning)': option.value === 'allow',
                    'border-[color-mix(in_srgb,var(--d-warning-fill)_55%,var(--d-border2))] bg-[color-mix(in_srgb,var(--d-warning-fill)_12%,transparent)] text-(--d-warning-text)': option.value === 'allowChat',
                    'border-(--d-border2) group-data-highlighted:border-(--d-warning-fill)': option.value === 'deny',
                  }"
                  aria-hidden="true"
                >{{ index + 1 }}</span>
                <span class="flex min-w-0 flex-1 flex-col gap-px py-px">
                  <span
                    class="text-pretty wrap-anywhere"
                    :class="option.value === 'allow' ? 'font-semibold' : 'font-medium'"
                    data-testid="theme-screenshot-option-label"
                  >{{ option.label }}</span>
                  <span
                    v-if="option.hint"
                    class="text-11 text-pretty text-(--d-muted)"
                    data-testid="theme-screenshot-option-hint"
                  >{{ option.hint }}</span>
                </span>
              </ListboxItem>
            </DockPromptOptions>
          </ListboxRoot>
        </div>
      </section>
    </div>
  </Transition>
</template>
