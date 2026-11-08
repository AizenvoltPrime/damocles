<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { MAX_INPUT_VALUE_LENGTH } from '@shared/input-validation';
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import { overlayPickModel, type QuickPickModel } from '../quick-pick';
import QuickPick from './QuickPick.vue';

// A list main offers (a terminal's icon, color or default profile, a ref, stash, tag, remote or worktree picker), filtered as
// typed; Escape dismisses it. With pickMany its rows are checkboxes (Join Terminals...).
const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'quickPick' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const load = (query: string): Promise<QuickPickModel> => {
  const model = overlayPickModel(props.request.items, query, (typed) => t('quickPick.echo', { query: typed }));
  return Promise.resolve(props.request.pickMany ? { ...model, hint: t('quickPick.manyHint') } : model);
};
const accept = (itemId: string, _shift: boolean, query: string): void => emit('answer', { kind: 'quickPick', itemId, query });
// main parses the ids in the request's item order
const acceptMany = (ids: readonly string[]): void => emit('answer', { kind: 'quickPickMany', itemIds: props.request.items.flatMap((item) => (ids.includes(item.id) ? [item.id] : [])) });
</script>

<template>
  <QuickPick
    data-pick="list"
    :label="request.placeholder"
    :placeholder="request.placeholder"
    :load="load"
    :max-length="MAX_INPUT_VALUE_LENGTH"
    :pick-many="request.pickMany"
    @accept="accept"
    @accept-many="acceptMany"
    @cancel="emit('answer', { kind: 'dismissed' })"
  />
</template>
