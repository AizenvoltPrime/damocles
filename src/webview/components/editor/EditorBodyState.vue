<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { EditorDocumentBody } from '@shared/types/messages';

const props = defineProps<{
  body: Exclude<EditorDocumentBody, { kind: 'text' }>;
  side: 'original' | 'modified';
}>();

const { t } = useI18n();
const MIB = 1024 * 1024;

const testId = computed(() => ({ tooLarge: 'editor-body-too-large', binary: 'editor-body-binary', unreadable: 'editor-body-unreadable' })[props.body.kind]);

const message = computed(() => {
  const body = props.body;
  if (body.kind === 'tooLarge') return t('editor.body.tooLarge', { size: (body.bytes / MIB).toFixed(1), limit: Number((body.limitBytes / MIB).toFixed(1)) });
  if (body.kind === 'binary') return t('editor.body.binary');
  return t('editor.body.unreadable', { error: body.error });
});
</script>

<template>
  <div
    :data-testid="testId"
    :data-side="side"
    class="rounded border border-border bg-muted px-4 py-3 text-sm text-foreground"
  >
    <span class="font-medium">{{ t(`editor.side.${side}`) }}:</span>
    {{ message }}
  </div>
</template>
