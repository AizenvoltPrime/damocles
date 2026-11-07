<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleCheck, CircleHelp, CircleMinus, FileImage } from 'lucide-vue-next';
import type { MapReferenceDetails, ReferenceRowStatus } from '@shared/types/design';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useTKnown } from '@/composables/useTKnown';
import { useDesignStore } from '@/stores/useDesignStore';

// MapReference's result (UI reference: MapReference card): each element of the reference image and what it maps to in the app.
const props = defineProps<{ details: MapReferenceDetails }>();
const { t } = useI18n();
const tKnown = useTKnown();
const { postMessage } = usePlatformBridge();
const designStore = useDesignStore();

const STATUS: Record<ReferenceRowStatus, { tone: string; icon: typeof CircleCheck }> = {
  mapped: { tone: 'd-tone-success', icon: CircleCheck },
  needsDecision: { tone: 'd-tone-warning', icon: CircleHelp },
  out: { tone: 'd-tone-faint', icon: CircleMinus },
};
const ORDER: readonly ReferenceRowStatus[] = ['mapped', 'needsDecision', 'out'];
const statusStyle = (status: ReferenceRowStatus): (typeof STATUS)[ReferenceRowStatus] => STATUS[status] ?? STATUS.out;

const summary = computed(() => ORDER.flatMap((status) => {
  const n = props.details.rows.filter((row) => row.status === status).length;
  return n > 0 ? [t(`design.reference.count.${status}`, { n }, n)] : [];
}).join(' · '));
const designId = computed(() => designStore.design?.designId);
const imageName = computed(() => props.details.image.split('/').at(-1) ?? props.details.image);

function openImage(): void {
  if (designId.value) postMessage({ type: 'openDesignFile', designId: designId.value, file: props.details.image });
}
</script>

<template>
  <div
    class="@container border-t border-(--d-border) text-xs"
    data-testid="design-map-reference"
    :data-reference="details.reference"
    @click.stop
  >
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2 pb-1">
      <span
        v-if="summary"
        class="text-11 text-(--d-muted)"
        data-testid="design-map-reference-summary"
      >{{ summary }}</span>
      <Button
        variant="ghost"
        data-testid="design-map-reference-image"
        :title="t('design.reference.open', { file: details.image })"
        :disabled="!designId"
        class="ms-auto h-6 gap-1 rounded-6 px-1.5 font-mono text-11 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3"
        @click="openImage"
      >
        <FileImage aria-hidden="true" />{{ imageName }}
      </Button>
    </div>
    <Table class="text-xs">
      <TableHeader>
        <TableRow class="border-(--d-border) hover:bg-transparent">
          <TableHead class="h-7 px-3 text-start text-11 font-medium text-(--d-faint-text)">
            {{ t('design.reference.element') }}
          </TableHead>
          <TableHead class="h-7 px-2 text-start text-11 font-medium text-(--d-faint-text)">
            {{ t('design.reference.mapsTo') }}
          </TableHead>
          <TableHead class="h-7 px-3 text-end text-11 font-medium text-(--d-faint-text)">
            {{ t('design.reference.status') }}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="(row, index) in details.rows"
          :key="`${index}:${row.element}`"
          data-testid="design-map-reference-row"
          :data-status="row.status"
          class="border-(--d-border) last:border-b-0 hover:bg-(--d-hover)"
        >
          <TableCell class="max-w-0 px-3 py-1.5 font-medium wrap-break-word text-(--d-text)">
            {{ row.element }}
          </TableCell>
          <TableCell class="px-2 py-1.5">
            <span
              v-if="row.mapsTo"
              dir="ltr"
              class="font-mono text-11 break-all text-(--d-text)"
            >{{ row.mapsTo }}</span>
            <span
              v-else
              class="text-(--d-faint-text)"
            >{{ t('design.reference.unmapped') }}</span>
          </TableCell>
          <TableCell class="px-3 py-1.5 text-end">
            <span
              class="inline-flex h-5 items-center gap-1 rounded-full bg-(--tone)/12 px-1.75 text-11 font-medium whitespace-nowrap"
              :class="statusStyle(row.status).tone"
              data-testid="design-map-reference-status"
            >
              <component
                :is="statusStyle(row.status).icon"
                aria-hidden="true"
                class="size-3 flex-none"
              />
              <span class="@max-[22rem]:sr-only">{{ tKnown('design.reference.statusName', row.status, row.status) }}</span>
            </span>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
