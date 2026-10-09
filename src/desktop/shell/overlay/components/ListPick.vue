<script setup lang="ts">
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import { overlayPickModel, type QuickPickModel } from '../quick-pick';
import QuickPick from './QuickPick.vue';

// A list main offers (Change Icon..., Change Color..., Select Default Profile), filtered as typed; Escape dismisses it.
const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'quickPick' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();

const load = (query: string): Promise<QuickPickModel> => Promise.resolve(overlayPickModel(props.request.items, query));
</script>

<template>
  <QuickPick
    data-pick="list"
    :label="request.placeholder"
    :placeholder="request.placeholder"
    :load="load"
    @accept="emit('answer', { kind: 'quickPick', itemId: $event })"
    @cancel="emit('answer', { kind: 'dismissed' })"
  />
</template>
