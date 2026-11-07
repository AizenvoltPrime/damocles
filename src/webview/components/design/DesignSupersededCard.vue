<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { ArrowUpRight, GitBranch } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { usePlatformBridge } from '@/composables/usePlatformBridge';

// PD-36: a rewind moved this design to another chat, so this one is read-only history; the card takes the composer's place.
const props = defineProps<{ designId: string }>();
const { t } = useI18n();
const { postMessage } = usePlatformBridge();

// Core resolves the design's current chat from link.json; this chat's own designId names the design.
function openCurrent(): void {
  postMessage({ type: 'openDesignChat', designId: props.designId });
}
</script>

<template>
  <div
    class="@container"
    role="status"
    data-testid="design-superseded"
  >
    <div class="flex items-center gap-3 rounded-2xl border border-[color-mix(in_srgb,var(--d-design)_35%,var(--d-border2))] bg-[color-mix(in_srgb,var(--d-design)_6%,var(--d-card))] py-2.5 ps-3 pe-2.5 @max-[30rem]:flex-wrap">
      <span
        class="d-tone-design flex size-8 flex-none animate-[d-icon-in_.36s_var(--ease-spring)_.08s_both] items-center justify-center rounded-10 bg-(--tone)/16"
        aria-hidden="true"
      >
        <GitBranch class="size-4" />
      </span>
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="font-medium text-pretty">{{ t('design.superseded.title') }}</span>
        <span class="text-11.5 text-pretty text-(--d-faint-text)">{{ t('design.superseded.note') }}</span>
      </div>
      <Button
        type="button"
        class="d-press h-7.5 shrink-0 gap-1.5 rounded-8 bg-(--d-design) px-3 text-xs font-semibold text-(--d-on-design) hover:bg-(--d-design) hover:brightness-110 focus-visible:ring-1 focus-visible:ring-(--d-design) focus-visible:ring-offset-1 focus-visible:ring-offset-(--d-card) @max-[30rem]:w-full [&_svg]:size-3.25"
        data-testid="design-superseded-open"
        @click="openCurrent"
      >
        {{ t('design.superseded.open') }}<ArrowUpRight aria-hidden="true" />
      </Button>
    </div>
  </div>
</template>
