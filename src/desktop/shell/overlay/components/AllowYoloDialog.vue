<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWindowSize } from '@vueuse/core';
import { ShieldAlert } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import HostBadge from '@/components/HostBadge.vue';
import { remPx } from '@/composables/useRemPx';
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import { placePanel } from '../placement';

// Allow YOLO on a host, hung from the switch or chip that asked. Cancel is focused first and every way of closing refuses.
const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'allowYolo' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const WIDTH_REM = 20;
const viewport = useWindowSize();
const placed = computed(() => {
  const { anchor } = props.request;
  const width = Math.min(remPx(WIDTH_REM), viewport.width.value - remPx(1));
  // a control in the window's right half hangs the panel leftward from its own end
  const align = anchor.x + anchor.width / 2 > viewport.width.value / 2 ? 'end' : 'start';
  const place = placePanel(anchor, width, { width: viewport.width.value, height: viewport.height.value }, align);
  return {
    left: `${place.left}px`,
    ...('top' in place ? { top: `${place.top}px` } : { top: 'auto', bottom: `${place.bottom}px` }),
    maxHeight: `${place.maxHeight}px`,
    translate: 'none',
  };
});

let answered = false;
function choose(allow: boolean): void {
  if (answered) return;
  answered = true;
  emit('answer', { kind: 'allowYolo', allow });
}

// Allow ignores a click or key this soon after the question shows, so input meant for what lay under it cannot accept.
const INPUT_PROTECTION_MS = 500;
const shownAt = performance.now();
function accept(): void {
  if (performance.now() - shownAt >= INPUT_PROTECTION_MS) choose(true);
}

const cancelButton = ref<InstanceType<typeof Button> | null>(null);
function focusCancel(event: Event): void {
  event.preventDefault();
  (cancelButton.value?.$el as HTMLElement | undefined)?.focus();
}
</script>

<template>
  <Dialog
    :open="true"
    @update:open="(next: boolean) => !next && choose(false)"
  >
    <DialogContent
      inline
      :show-close="false"
      :scrim="false"
      data-testid="allow-yolo"
      :style="placed"
      class="flex w-[min(20rem,calc(100%-1rem))] max-w-none flex-col gap-3 overflow-x-hidden overflow-y-auto rounded-xl p-3.5"
      @open-auto-focus="focusCancel"
    >
      <div class="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          class="grid size-7 flex-none place-items-center rounded-8 bg-(--d-warning)/14 text-(--d-warning)"
        >
          <ShieldAlert class="size-3.5" />
        </span>
        <div class="flex min-w-0 flex-col gap-1">
          <HostBadge
            :name="request.hostName"
            :color="request.hostColor"
            data-testid="allow-yolo-host"
            class="self-start"
          />
          <DialogTitle class="text-13 font-semibold wrap-break-word">
            {{ t('remote.allowYolo.title', { host: request.hostName }) }}
          </DialogTitle>
          <DialogDescription class="text-12 wrap-break-word text-(--d-muted)">
            {{ t('remote.allowYolo.message', { host: request.hostName }) }}
          </DialogDescription>
        </div>
      </div>
      <div class="flex justify-end gap-1.5">
        <Button
          ref="cancelButton"
          type="button"
          variant="outline"
          size="sm"
          data-testid="allow-yolo-cancel"
          class="h-7.5 rounded-8 border-(--d-border2) bg-(--d-card) px-3 text-12"
          @click="choose(false)"
        >
          {{ t('remote.allowYolo.cancel') }}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="allow-yolo-accept"
          class="h-7.5 rounded-8 px-3 text-12 font-semibold"
          @click="accept"
        >
          {{ t('remote.allowYolo.allow') }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
