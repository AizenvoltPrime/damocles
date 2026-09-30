<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { usePermissionStore } from '@/stores/usePermissionStore';
import type { EditorView } from '@/stores/useEditorStore';
import EditorOverlayFrame from './EditorOverlayFrame.vue';
import EditorBodyState from './EditorBodyState.vue';
import MonacoDiffView from './MonacoDiffView.vue';
import MonacoFileView from './MonacoFileView.vue';

const props = defineProps<{ view: EditorView }>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'decide', toolUseId: string, approved: boolean): void;
}>();

const { t } = useI18n();
const permissionStore = usePermissionStore();

// Decision buttons exist only while the inline prompt for this id is pending, and decide through the same App handler it uses.
const pendingApprovalId = computed(() => {
  const view = props.view;
  if (view.kind !== 'diff' || view.purpose !== 'proposal' || view.approvalId === undefined) return null;
  return permissionStore.pendingPermissions[view.approvalId] ? view.approvalId : null;
});

const subtitle = computed(() => {
  const view = props.view;
  if (view.kind === 'diff') {
    if (view.purpose === 'checkpoint') return t('editor.checkpoint');
    return pendingApprovalId.value ? t('editor.proposal') : t('editor.proposalDecided');
  }
  if (view.untitled) return t('editor.untitled');
  const parts = [view.document.path ?? view.document.name, t('editor.readOnly')];
  if (view.line !== undefined) parts.push(t('editor.line', { line: view.line }));
  return parts.join(' · ');
});

function decide(approved: boolean): void {
  if (pendingApprovalId.value) emit('decide', pendingApprovalId.value, approved);
}
</script>

<template>
  <EditorOverlayFrame
    :title="view.title"
    :subtitle="subtitle"
    close-test-id="editor-overlay-close"
    data-testid="editor-overlay"
    :data-view-kind="view.kind"
    :data-view-id="view.viewId"
    :data-purpose="view.kind === 'diff' ? view.purpose : undefined"
    @close="emit('close')"
  >
    <template v-if="view.kind === 'diff'">
      <MonacoDiffView
        v-if="view.original.body.kind === 'text' && view.modified.body.kind === 'text'"
        :original="view.original.body"
        :modified="view.modified.body"
      />
      <div
        v-else
        class="p-4 space-y-2"
      >
        <EditorBodyState
          v-if="view.original.body.kind !== 'text'"
          :body="view.original.body"
          side="original"
        />
        <EditorBodyState
          v-if="view.modified.body.kind !== 'text'"
          :body="view.modified.body"
          side="modified"
        />
      </div>
    </template>
    <template v-else>
      <MonacoFileView
        v-if="view.document.body.kind === 'text'"
        :document="view.document.body"
        :line="view.line"
        :untitled="view.untitled === true"
      />
      <div
        v-else
        class="p-4"
      >
        <EditorBodyState
          :body="view.document.body"
          side="document"
        />
      </div>
    </template>

    <template
      v-if="pendingApprovalId"
      #footer
    >
      <footer class="flex justify-end gap-2 px-4 py-3 border-t border-border/30 bg-muted shrink-0">
        <Button
          variant="secondary"
          data-testid="editor-reject"
          @click="decide(false)"
        >
          {{ t('editor.reject') }}
        </Button>
        <Button
          data-testid="editor-approve"
          @click="decide(true)"
        >
          {{ t('editor.approve') }}
        </Button>
      </footer>
    </template>
  </EditorOverlayFrame>
</template>
