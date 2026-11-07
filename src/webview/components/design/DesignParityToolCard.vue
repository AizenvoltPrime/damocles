<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, CircleAlert, CircleCheck, CircleX, Eye, FileText, Scale, X } from 'lucide-vue-next';
import type { ToolCall } from '@shared/types/session';
import { DESIGN_PARITY_CHECK_COUNT, type DesignParityDetails, type DesignParityStatus, type DesignParityWidth } from '@shared/design-parity';
import type { LocalizedText } from '@shared/localized-text';
import type { ImageBlock } from '@shared/types/content';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Table, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLocalizedText } from '@/composables/useLocalizedText';
import { useTKnown } from '@/composables/useTKnown';
import { useUIStore } from '@/stores/useUIStore';
import ToolCardFrame from '../ToolCardFrame.vue';
import ToolErrorStrip from '../ToolErrorStrip.vue';
import ToolBlockedReason from '../ToolBlockedReason.vue';
import ToolResultImages from '../ToolResultImages.vue';
import { DESIGN_TILE } from './design-tone';

// A DesignParity call (UI reference: Parity card): each width's score of n/12 fixed checks, its failed checks on expand.
const props = defineProps<{ toolCall: ToolCall }>();
const emit = defineEmits<{ openLightbox: [image: string | ImageBlock] }>();
const { t, te } = useI18n();
const { rt } = useLocalizedText();
const tKnown = useTKnown();
const uiStore = useUIStore();

const SESSION_OWNER = { kind: 'session' } as const;
const STATUS: Record<DesignParityStatus, { tone: string; icon: Component }> = {
  verified: { tone: 'd-tone-success', icon: CircleCheck },
  needs_review: { tone: 'd-tone-info', icon: Eye },
  needs_iteration: { tone: 'd-tone-warning', icon: CircleAlert },
  failed: { tone: 'd-tone-danger', icon: CircleX },
};
const statusStyle = (status: DesignParityStatus): (typeof STATUS)[DesignParityStatus] => STATUS[status] ?? STATUS.needs_review;
const SEGMENTS = Array.from({ length: DESIGN_PARITY_CHECK_COUNT }, (_, index) => index);

const details = computed(() => {
  const value = props.toolCall.metadata as Partial<DesignParityDetails> | undefined;
  return props.toolCall.status === 'completed' && Array.isArray(value?.widths) ? (value as DesignParityDetails) : undefined;
});
const awaiting = computed(() => props.toolCall.status === 'pending' || props.toolCall.status === 'running');

// Until the result lands the card shows the widths the call asked for; an aborted call's stored arguments may be partial.
const askedWidths = computed(() => {
  const widths = props.toolCall.input['widths'];
  return Array.isArray(widths) ? widths.filter((width): width is number => typeof width === 'number' && Number.isFinite(width)) : [];
});

const widthLabel = (width: Pick<DesignParityWidth, 'width' | 'breakpoint'>): string => (width.breakpoint
  ? t('design.check.atBreakpoint', { breakpoint: width.breakpoint, width: width.width })
  : t('design.check.atWidth', { width: width.width }));
// The check id is the catalog key; core's English label shows only for an id this build does not know.
const checkLabel = (check: { id: string; label: string }): string => (te(`design.parity.check.${check.id}`) ? t(`design.parity.check.${check.id}`) : check.label);
const dimensionLabel = (id: string): string | undefined => {
  const dimension = id.split('.')[0];
  return dimension && te(`design.parity.dimension.${dimension}`) ? t(`design.parity.dimension.${dimension}`) : undefined;
};

const rows = computed(() => (details.value?.widths ?? []).map((width) => ({
  ...width,
  key: String(width.width),
  label: widthLabel(width),
  failed: width.failed.map((check) => ({ id: check.id, label: checkLabel(check), dimension: dimensionLabel(check.id), reason: check.reason })),
})));

const open = ref<Record<string, boolean>>({});

// Only a result that lands while the card is shown plays its entrance; a history load or a remount shows it at rest.
const live = ref(false);
watch(() => props.toolCall.status, (status, previous) => {
  live.value = (previous === 'pending' || previous === 'running') && status === 'completed';
});

const weakest = computed(() => {
  const widths = details.value?.widths ?? [];
  if (widths.length === 0) return undefined;
  return widths.reduce((low, width) => (width.passes < low.passes ? width : low));
});

// One caption per image the result carries, in its order; core lists them, so the card never infers them from the count.
const images = computed(() => (Array.isArray(details.value?.images) ? details.value.images : []));
const captions = computed(() => images.value.map((image) => {
  const row = rows.value.find((candidate) => candidate.width === image.width);
  return t('design.parity.imageCaption', { width: row?.label ?? t('design.check.atWidth', { width: image.width }), source: tKnown('design.parity.source', image.kind, image.kind) });
}));
// Each image's box keeps its capture's aspect ratio when the result records its height, so the row never moves as they load.
const imageSizes = computed(() => images.value.map((image) => (typeof image.cssHeight === 'number' ? { width: image.width, height: image.cssHeight } : undefined)));

// A refusal names what is missing in the user's language, parsed at the page's bridge; an unexpected failure carries only its English message.
const errorText = computed(() => {
  if (props.toolCall.status !== 'failed') return undefined;
  const refusal = props.toolCall.metadata?.['refusal'] as LocalizedText | undefined;
  return refusal ? rt(refusal) : props.toolCall.errorMessage;
});

const arg = computed(() => {
  const screen = details.value?.screen ?? props.toolCall.input['screen'];
  const url = details.value?.url ?? props.toolCall.input['url'];
  return [screen, url].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ') || undefined;
});
</script>

<template>
  <ToolCardFrame
    :icon="Scale"
    :name="t('design.tools.designParity')"
    :arg="arg"
    :status="toolCall.status"
    :tile-class="DESIGN_TILE"
    expandable
    :duration-ms="toolCall.durationMs"
    status-note
    :abandon-reason="toolCall.abandonReason"
    :data-tool="toolCall.name"
    data-testid="design-parity-card"
    @expand="uiStore.expandTool(toolCall.id, 'session')"
  >
    <template #meta>
      <Badge
        v-if="weakest"
        variant="tone"
        class="h-4.5 flex-none rounded-full border-0 bg-(--tone)/14 px-1.75 py-0 font-mono text-10.5 font-semibold tabular-nums"
        :class="[statusStyle(weakest.status).tone, live && 'animate-[d-badge-pop_.34s_var(--ease-spring)_both]']"
        data-testid="design-parity-weakest"
      >
        <span aria-hidden="true">{{ weakest.passes }}/{{ DESIGN_PARITY_CHECK_COUNT }}</span>
        <span class="sr-only">{{ t('design.parity.weakestAria', { passes: weakest.passes, total: DESIGN_PARITY_CHECK_COUNT }) }}</span>
      </Badge>
    </template>

    <!-- Stops the click so opening a width's failed checks or an image does not open the tool overlay. -->
    <div
      v-if="details || awaiting"
      class="@container border-t border-(--d-border) text-xs"
      @click.stop
    >
      <Table
        v-if="details"
        class="table-fixed text-xs"
        data-testid="design-parity-table"
      >
        <caption class="sr-only">
          {{ t('design.parity.caption', { screen: details.screen, url: details.url }) }}
        </caption>
        <colgroup>
          <col class="w-[42%]">
          <col>
          <col class="w-[34%] @max-[24rem]:w-10">
        </colgroup>
        <TableHeader>
          <TableRow class="border-(--d-border) hover:bg-transparent">
            <TableHead
              scope="col"
              class="h-7 ps-3 pe-2 text-start text-11 font-medium text-(--d-faint-text)"
            >
              {{ t('design.parity.width') }}
            </TableHead>
            <TableHead
              scope="col"
              class="h-7 px-2 text-start text-11 font-medium text-(--d-faint-text)"
            >
              {{ t('design.parity.score') }}
            </TableHead>
            <TableHead
              scope="col"
              class="h-7 ps-2 pe-3 text-end text-11 font-medium text-(--d-faint-text)"
            >
              <span class="@max-[24rem]:sr-only">{{ t('design.parity.status') }}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <!-- One tbody per width (valid HTML), so its row and its failed-checks row open and close together. -->
        <Collapsible
          v-for="(row, rowIndex) in rows"
          :key="row.key"
          :open="open[row.key] === true"
          as="tbody"
          :disabled="row.failed.length === 0"
          data-testid="design-parity-width"
          :data-width="row.width"
          :data-status="row.status"
          :data-passes="row.passes"
          @update:open="open[row.key] = $event"
        >
          <TableRow
            class="border-(--d-border) hover:bg-(--d-hover)"
            :class="[live && 'd-row-reveal', open[row.key] && 'bg-(--d-hover)']"
            :style="live ? { '--reveal-index': rowIndex } : undefined"
            data-testid="design-parity-row"
          >
            <TableHead
              scope="row"
              class="h-auto p-0 text-start font-normal"
            >
              <CollapsibleTrigger
                v-if="row.failed.length > 0"
                class="group/trigger flex min-h-8 w-full min-w-0 items-center gap-1.5 ps-2 pe-2 text-start text-(--d-text) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--d-accent)"
                data-testid="design-parity-toggle"
              >
                <ChevronRight
                  class="size-3 flex-none text-(--d-faint-text) transition-transform duration-200 ease-out group-data-[state=open]/trigger:rotate-90"
                  aria-hidden="true"
                />
                <span class="min-w-0 truncate font-mono text-11.5 tabular-nums">{{ row.label }}</span>
                <span class="sr-only">, {{ t('design.parity.failedCount', { n: row.failed.length }, row.failed.length) }}</span>
              </CollapsibleTrigger>
              <span
                v-else
                class="flex min-h-8 min-w-0 items-center gap-1.5 ps-6.5 pe-2 text-(--d-text)"
              >
                <span class="min-w-0 truncate font-mono text-11.5 tabular-nums">{{ row.label }}</span>
              </span>
            </TableHead>
            <TableCell class="px-2 py-1.5">
              <span
                class="flex min-w-0 items-center gap-2"
                :class="statusStyle(row.status).tone"
              >
                <span
                  class="flex h-1.5 min-w-0 flex-1 gap-px @max-[18rem]:hidden"
                  aria-hidden="true"
                  data-testid="design-parity-meter"
                >
                  <span
                    v-for="segment in SEGMENTS"
                    :key="segment"
                    class="h-full min-w-0 flex-1 first:rounded-s-full last:rounded-e-full"
                    :class="[segment < row.passes ? 'bg-(--tone)' : 'bg-(--d-border2)', live && segment < row.passes && 'animate-[d-scale-in_.24s_var(--ease-spring)_both]']"
                    :style="live && segment < row.passes ? { animationDelay: `${rowIndex * 60 + segment * 24}ms` } : undefined"
                  />
                </span>
                <span
                  class="flex-none font-mono text-11.5 font-semibold tabular-nums"
                  data-testid="design-parity-score"
                >
                  <span aria-hidden="true">{{ row.passes }}/{{ DESIGN_PARITY_CHECK_COUNT }}</span>
                  <span class="sr-only">{{ t('design.parity.scoreAria', { passes: row.passes, total: DESIGN_PARITY_CHECK_COUNT }) }}</span>
                </span>
              </span>
            </TableCell>
            <TableCell class="ps-2 pe-3 py-1.5 text-end">
              <Badge
                variant="tone"
                class="h-5 gap-1 rounded-full border-0 bg-(--tone)/12 px-1.75 py-0 text-11 font-medium whitespace-nowrap"
                :class="statusStyle(row.status).tone"
                data-testid="design-parity-status"
              >
                <component
                  :is="statusStyle(row.status).icon"
                  class="size-3 flex-none"
                  aria-hidden="true"
                />
                <span class="@max-[24rem]:sr-only">{{ tKnown('design.parity.statusName', row.status, row.status) }}</span>
              </Badge>
            </TableCell>
          </TableRow>
          <CollapsibleContent
            as="tr"
            class="border-b border-(--d-border) bg-[color-mix(in_srgb,var(--d-hover)_55%,transparent)] last:border-b-0"
            data-testid="design-parity-failed"
          >
            <td
              colspan="3"
              class="ps-6.5 pe-3 pt-1 pb-2"
            >
              <ul
                class="flex flex-col gap-1.5"
                :aria-label="t('design.parity.failedAt', { width: row.label })"
              >
                <li
                  v-for="(check, checkIndex) in row.failed"
                  :key="check.id"
                  class="d-row-reveal flex min-w-0 items-start gap-2"
                  :style="{ '--reveal-index': checkIndex }"
                  data-testid="design-parity-check"
                  :data-check="check.id"
                >
                  <span
                    class="mt-px flex size-3.75 flex-none items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--d-danger)_16%,transparent)] text-(--d-danger-text)"
                    aria-hidden="true"
                  >
                    <X
                      class="size-2.5"
                      stroke-width="3"
                    />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                      <span
                        class="font-medium text-(--d-text)"
                        data-testid="design-parity-check-label"
                      >{{ check.label }}</span>
                      <span
                        v-if="check.dimension"
                        class="text-10.5 text-(--d-faint-text)"
                      >{{ check.dimension }}</span>
                    </span>
                    <span
                      v-if="check.reason"
                      class="text-pretty wrap-anywhere text-(--d-muted)"
                      data-testid="design-parity-check-reason"
                    >{{ check.reason }}</span>
                  </span>
                </li>
              </ul>
            </td>
          </CollapsibleContent>
        </Collapsible>
      </Table>

      <template v-else>
        <p
          class="px-3 pt-2 text-(--d-muted)"
          data-testid="design-parity-running"
        >
          {{ t('design.parity.running') }}
        </p>
        <ul
          v-if="askedWidths.length > 0"
          class="flex flex-col gap-1 px-3 pt-1.5 pb-2"
          aria-hidden="true"
        >
          <li
            v-for="width in askedWidths"
            :key="width"
            class="flex items-center gap-3"
          >
            <span class="w-24 flex-none font-mono text-11.5 text-(--d-muted) tabular-nums">{{ t('design.check.atWidth', { width }) }}</span>
            <span class="d-pulsing h-1.5 flex-1 rounded-full bg-(--d-hover)" />
          </li>
        </ul>
        <div
          v-else
          class="pb-2"
        />
      </template>

      <template v-if="details">
        <div
          v-if="images.length > 0"
          class="px-3 pt-2"
          data-testid="design-parity-images"
        >
          <ToolResultImages
            :tool="toolCall"
            :owner="SESSION_OWNER"
            :captions="captions"
            :sizes="imageSizes"
            @open="emit('openLightbox', $event)"
          />
        </div>
        <p
          v-else
          class="flex items-start gap-2 px-3 pt-2 text-pretty text-(--d-muted)"
          data-testid="design-parity-no-images"
        >
          <FileText
            class="mt-px size-3.25 flex-none text-(--d-faint-text)"
            aria-hidden="true"
          />
          {{ t('design.parity.noImages') }}
        </p>
        <p
          class="px-3 pt-2 pb-2.5 text-11 text-pretty text-(--d-faint-text)"
          data-testid="design-parity-footer"
        >
          {{ t('design.parity.footer', { n: DESIGN_PARITY_CHECK_COUNT }) }}
        </p>
      </template>
    </div>

    <ToolErrorStrip
      v-if="errorText"
      :message="errorText"
      data-testid="design-parity-error"
    />
    <ToolBlockedReason
      v-else-if="toolCall.status === 'blocked' && toolCall.feedback"
      :reason="toolCall.feedback"
    />
    <div
      v-if="awaiting"
      class="d-sweep-bar h-0.5 bg-(--d-hover) text-(--d-design)"
      aria-hidden="true"
    />
  </ToolCardFrame>
</template>
