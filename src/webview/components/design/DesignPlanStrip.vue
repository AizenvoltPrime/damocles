<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, ExternalLink, FileText, Monitor, Palette, Stamp } from 'lucide-vue-next';
import { issueCount, type PlanApprovalDesignLink } from '@shared/types/design';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useOpenDesignPreview } from '@/composables/useOpenDesignPreview';
import { useTKnown } from '@/composables/useTKnown';
import DesignScreensMenu from './DesignScreensMenu.vue';

// The plan approval's linked design: the version this approval records, and the warnings that travel with it (PD-52).
const props = defineProps<{ link: PlanApprovalDesignLink }>();
const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const { available: canOpenPreview } = useOpenDesignPreview();
const tKnown = useTKnown();

const warningsOpen = ref(true);
const counts = computed(() => {
  const { screens, decisions, warnings, journeysPassed } = props.link;
  return [
    t('design.result.screens', { n: screens }, screens),
    t('design.result.decisions', { n: decisions }, decisions),
    t('design.result.warnings', { n: issueCount(warnings) }, issueCount(warnings)),
    ...(journeysPassed === true ? [t('design.result.journeysPassed')] : []),
  ].join(' · ');
});

function openDesignChat(): void {
  postMessage({ type: 'openDesignChat', designId: props.link.designId });
}

function openDesignMd(): void {
  postMessage({ type: 'openDesignFile', designId: props.link.designId, file: 'design.md' });
}
</script>

<template>
  <section
    class="@container overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--d-design)_40%,var(--d-border))] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--d-design)_8%,var(--d-card)),var(--d-card))]"
    :aria-label="t('design.planStrip.label')"
    data-testid="design-plan-strip"
    :data-design-id="link.designId"
    :data-version="link.version"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
      <span
        class="flex size-8 flex-none items-center justify-center rounded-9 bg-linear-135 from-(--d-design) to-[color-mix(in_srgb,var(--d-design)_55%,var(--d-accent))] text-(--d-on-design)"
        aria-hidden="true"
      >
        <Palette class="size-3.75" />
      </span>
      <div class="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <p class="text-10.5 font-semibold tracking-[.06em] text-(--d-design-text) uppercase">
          {{ t('design.planStrip.label') }}
        </p>
        <p class="flex min-w-0 items-center gap-1.5">
          <span
            class="truncate text-13 font-semibold text-(--d-text)"
            :title="link.title"
            data-testid="design-plan-strip-title"
          >{{ link.title }}</span>
          <span
            class="flex-none rounded-full bg-[color-mix(in_srgb,var(--d-design)_16%,transparent)] px-1.75 py-px font-mono text-11 font-semibold text-(--d-design-text)"
            data-testid="design-plan-strip-version"
          >{{ t('design.header.version', { version: link.version }) }}</span>
        </p>
        <p
          class="truncate text-11.5 text-(--d-muted)"
          data-testid="design-plan-strip-counts"
        >
          {{ counts }}
        </p>
      </div>
      <div class="flex w-full flex-wrap items-center gap-1.5 @min-[34rem]:w-auto @min-[34rem]:flex-none">
        <span
          class="me-auto flex items-center gap-1.25 rounded-full border border-[color-mix(in_srgb,var(--d-design)_35%,var(--d-border))] px-2 py-0.5 text-11 font-medium text-(--d-design-text) @min-[34rem]:me-1"
          data-testid="design-plan-strip-records"
        >
          <Stamp
            class="size-3"
            aria-hidden="true"
          />{{ t('design.planStrip.records', { version: link.version }) }}
        </span>
        <Button
          type="button"
          variant="ghost"
          class="d-press h-7 gap-1.5 rounded-7 px-2.5 font-mono text-11.5 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-3"
          data-testid="design-plan-strip-open-md"
          @click="openDesignMd"
        >
          <FileText aria-hidden="true" />{{ t('design.result.designMd') }}
        </Button>
        <Button
          type="button"
          variant="ghost"
          class="d-press d-tone-design h-7 gap-1.5 rounded-7 bg-(--tone)/12 px-2.5 text-xs font-semibold hover:bg-(--tone)/20 hover:text-(--d-design-text) focus-visible:ring-1 focus-visible:ring-(--d-design) focus-visible:ring-offset-0 [&_svg]:size-3"
          data-testid="design-plan-strip-open-chat"
          @click="openDesignChat"
        >
          <ExternalLink aria-hidden="true" />{{ t('design.result.openDesignChat') }}
        </Button>
        <DesignScreensMenu
          v-if="canOpenPreview"
          :design-id="link.designId"
          target="preview"
        >
          <Button
            type="button"
            variant="ghost"
            class="d-press h-7 gap-1.5 rounded-7 px-2.5 text-xs text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-3"
            data-testid="design-plan-strip-open-preview"
          >
            <Monitor aria-hidden="true" />{{ t('design.preview.open') }}
          </Button>
        </DesignScreensMenu>
      </div>
    </div>

    <Collapsible
      v-if="link.warnings.length > 0"
      v-model:open="warningsOpen"
      class="border-t border-[color-mix(in_srgb,var(--d-design)_18%,var(--d-border))] px-3 py-1.5"
      data-testid="design-plan-strip-warnings"
    >
      <CollapsibleTrigger as-child>
        <Button
          variant="ghost"
          class="h-6 gap-1 rounded-md px-1 text-xs font-semibold text-(--d-warning-text) hover:bg-(--d-hover) hover:text-(--d-warning-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-3"
          data-testid="design-plan-strip-warnings-toggle"
        >
          <ChevronRight
            class="transition-transform duration-200 ease-out"
            :class="warningsOpen && 'rotate-90'"
            aria-hidden="true"
          />
          {{ t('design.result.warnings', { n: issueCount(link.warnings) }, issueCount(link.warnings)) }}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul class="flex flex-col gap-1 py-1 ps-5 text-xs">
          <li
            v-for="(warning, index) in link.warnings"
            :key="`${warning.rule}:${warning.screen}:${index}`"
            class="flex min-w-0 items-start gap-2"
          >
            <span
              class="mt-1.25 size-1.5 flex-none rotate-45 bg-(--d-warning)"
              aria-hidden="true"
            />
            <span class="min-w-0 text-pretty">
              <span class="font-medium text-(--d-text)">{{ `${tKnown('design.check.rule', warning.rule, warning.rule)} ` }}</span>
              <span class="font-mono text-11 text-(--d-faint-text)">{{ `${warning.screen} ` }}</span>
              <span
                v-if="warning.element"
                class="font-mono text-11 wrap-anywhere text-(--d-muted)"
                dir="ltr"
              >{{ warning.element }}</span>
              <span
                v-if="warning.more"
                class="block text-11 text-(--d-muted)"
              >{{ t('design.check.more', { n: warning.more }, warning.more) }}</span>
            </span>
          </li>
        </ul>
      </CollapsibleContent>
    </Collapsible>
  </section>
</template>
