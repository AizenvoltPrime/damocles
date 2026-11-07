<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowRight, ExternalLink, FileText, GitCompareArrows, Globe, Monitor, Palette } from 'lucide-vue-next';
import { issueCount, type DesignResultView } from '@shared/types/design';
import { Button } from '@/components/ui/button';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { injectSendPrompt } from '@/composables/useSendPrompt';
import { useOpenDesignInBrowser } from '@/composables/useOpenDesignInBrowser';
import { useOpenDesignPreview } from '@/composables/useOpenDesignPreview';
import { useDesignStore } from '@/stores/useDesignStore';
import { useUIStore } from '@/stores/useUIStore';
import DesignScreensMenu from './DesignScreensMenu.vue';
import DesignChangeList from './DesignChangeList.vue';
import DesignDecisionList from './DesignDecisionList.vue';
import DesignWarningList from './DesignWarningList.vue';
import DesignJourneyList from './DesignJourneyList.vue';

// The parent's "Design finished" card. Its text is a report from the design chat, never a request the user made.
const props = defineProps<{
  result: DesignResultView;
  /** The card's `damocles-design-result` entry. */
  entryId: string;
}>();
const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const sendPrompt = injectSendPrompt();
const designStore = useDesignStore();
const uiStore = useUIStore();
const { available: canOpenInBrowser } = useOpenDesignInBrowser();
const { available: canOpenPreview } = useOpenDesignPreview();

const warningCount = computed(() => issueCount(props.result.check.warnings));

const subtitle = computed(() => {
  const { screens, decisions, journeys } = props.result;
  return [
    t('design.result.screens', { n: screens.length }, screens.length),
    t('design.result.decisions', { n: decisions.length }, decisions.length),
    t('design.result.checkPassed'),
    // A finished version's journeys all passed (PD-21); a static design or REDUCED records none.
    ...(journeys.length > 0 ? [t('design.result.journeysPassed')] : []),
    ...(warningCount.value > 0 ? [t('design.result.warnings', { n: warningCount.value }, warningCount.value)] : []),
  ].join(' · ');
});

// A version that arrived after the plan's approval: the parent's version prompt decides how the run starts, never Continue.
const title = computed(() => {
  const { version, previousVersion, versionPause } = props.result;
  if (!versionPause) return t('design.result.title', { version });
  return previousVersion === null ? t('design.result.updatedTitleFirst', { version }) : t('design.result.updatedTitle', { from: previousVersion, version });
});

const changes = computed(() => (props.result.previousVersion !== null && Array.isArray(props.result.changes) ? props.result.changes : []));

// Core says which card nothing answered yet (PD-20); its Continue resumes with one click while the chat is idle.
const continueSent = ref(false);
const showContinue = computed(() => sendPrompt !== undefined && designStore.link?.awaitingContinue === props.entryId && !uiStore.isProcessing);
// A Continue whose run ended, or that core sent back, may be clicked again while core still names this card.
watch(() => uiStore.isProcessing, (processing, was) => {
  if (was && !processing) continueSent.value = false;
});

function openDesignChat(): void {
  postMessage({ type: 'openDesignChat', designId: props.result.designId });
}

function openDesignMd(): void {
  postMessage({ type: 'openDesignFile', designId: props.result.designId, file: 'design.md' });
}

function continueDesign(): void {
  if (!sendPrompt || continueSent.value) return;
  // Model-facing text through the normal send path; it is not localized.
  continueSent.value = sendPrompt(`Continue with design v${props.result.version}`);
}
</script>

<template>
  <article
    class="rounded-xl bg-linear-135 from-(--d-design) via-[color-mix(in_srgb,var(--d-design)_30%,var(--d-border2))] to-[color-mix(in_srgb,var(--d-design)_70%,var(--d-accent))] p-px shadow-[0_0.5rem_1.75rem_-0.75rem_color-mix(in_srgb,var(--d-design)_55%,transparent),0_0_0_1px_color-mix(in_srgb,var(--d-design)_10%,transparent)]"
    :aria-label="title"
    data-testid="design-result-card"
    :data-design-id="result.designId"
    :data-version="result.version"
    :data-version-pause="result.versionPause ? 'true' : undefined"
  >
    <div class="overflow-hidden rounded-11 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--d-design)_7%,var(--d-card)),var(--d-card)_4.5rem)]">
      <header class="flex items-center gap-3 px-3.5 pt-3 pb-2.5">
        <span
          class="flex size-8.5 flex-none items-center justify-center rounded-10 bg-linear-135 from-(--d-design) to-[color-mix(in_srgb,var(--d-design)_55%,var(--d-accent))] text-(--d-on-design) shadow-[0_0.25rem_0.75rem_-0.25rem_color-mix(in_srgb,var(--d-design)_70%,transparent)]"
          aria-hidden="true"
        >
          <GitCompareArrows
            v-if="result.versionPause"
            class="size-4"
          />
          <Palette
            v-else
            class="size-4"
          />
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <p
            class="truncate text-13.5 font-semibold"
            data-testid="design-result-title"
          >
            {{ title }}
          </p>
          <p
            class="truncate text-11.5 text-(--d-muted)"
            :title="result.title"
          >
            <span class="text-(--d-text)">{{ result.title }}</span>
            <span aria-hidden="true"> · </span>
            <span data-testid="design-result-subtitle">{{ subtitle }}</span>
          </p>
        </div>
      </header>

      <div class="flex flex-col gap-2.5 px-3.5 pb-3 text-xs">
        <section
          v-if="result.decisions.length > 0"
          data-testid="design-result-decisions"
        >
          <p class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-faint) uppercase">
            {{ t('design.result.decisionsLabel') }}
          </p>
          <DesignDecisionList :decisions="result.decisions" />
        </section>

        <section
          v-if="result.check.warnings.length > 0"
          data-testid="design-result-warnings"
        >
          <p class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-warning-text) uppercase">
            {{ t('design.result.warningsLabel') }}
          </p>
          <DesignWarningList :warnings="result.check.warnings" />
        </section>

        <DesignJourneyList
          v-if="result.journeys.length > 0"
          :journeys="result.journeys"
        />

        <section
          v-if="changes.length > 0"
          data-testid="design-result-changes"
        >
          <p class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-faint-text) uppercase">
            {{ t('design.result.changedSince', { version: result.previousVersion }) }}
          </p>
          <DesignChangeList :changes="changes" />
        </section>
      </div>

      <footer class="flex flex-wrap items-center gap-1.5 border-t border-[color-mix(in_srgb,var(--d-design)_18%,var(--d-border))] px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          class="d-press d-tone-design h-7 gap-1.5 rounded-7 bg-(--tone)/12 px-2.5 text-xs font-semibold hover:bg-(--tone)/20 hover:text-(--d-design-text) focus-visible:ring-1 focus-visible:ring-(--d-design) focus-visible:ring-offset-0 [&_svg]:size-3"
          data-testid="design-result-open-chat"
          @click="openDesignChat"
        >
          <ExternalLink aria-hidden="true" />{{ t('design.result.openDesignChat') }}
        </Button>
        <Button
          type="button"
          variant="ghost"
          class="d-press h-7 gap-1.5 rounded-7 px-2.5 font-mono text-11.5 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-3"
          data-testid="design-result-open-md"
          @click="openDesignMd"
        >
          <FileText aria-hidden="true" />{{ t('design.result.designMd') }}
        </Button>
        <DesignScreensMenu
          v-if="canOpenPreview"
          :design-id="result.designId"
          target="preview"
        >
          <Button
            type="button"
            variant="ghost"
            class="d-press h-7 gap-1.5 rounded-7 px-2.5 text-xs text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-3"
            data-testid="design-result-open-preview"
          >
            <Monitor aria-hidden="true" />{{ t('design.preview.open') }}
          </Button>
        </DesignScreensMenu>
        <DesignScreensMenu
          v-if="canOpenInBrowser"
          :design-id="result.designId"
          target="browser"
        >
          <Button
            type="button"
            variant="ghost"
            class="d-press h-7 gap-1.5 rounded-7 px-2.5 text-xs text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-3"
            data-testid="design-result-open-browser"
          >
            <Globe aria-hidden="true" />{{ t('design.browser.open') }}
          </Button>
        </DesignScreensMenu>
        <span class="flex-1" />
        <Transition name="t-pop">
          <Button
            v-if="showContinue"
            type="button"
            class="d-press h-7 gap-1.5 rounded-7 bg-(--d-design) px-3 text-xs font-semibold text-(--d-on-design) hover:bg-(--d-design) hover:brightness-110 focus-visible:ring-1 focus-visible:ring-(--d-design) focus-visible:ring-offset-1 focus-visible:ring-offset-(--d-card) [&_svg]:size-3"
            :aria-label="t('design.result.continueAria', { version: result.version })"
            :disabled="continueSent"
            data-testid="design-result-continue"
            @click="continueDesign"
          >
            {{ t('design.result.continue') }}<ArrowRight aria-hidden="true" />
          </Button>
        </Transition>
      </footer>
    </div>
  </article>
</template>
