<script setup lang="ts">
import { computed } from 'vue';
import type { DamoclesShellApi, ShellEditorTab, ShellPatchTab } from '../../preload/shell-channels';
import type { ChangesSource } from './changes-source';
import ChangesTab from './ChangesTab.vue';

// Two files' read-only patch (the damocles command's --diff): one diff, titled with both names, with no actions or comments.
const props = defineProps<{ api: DamoclesShellApi; tab: ShellEditorTab & { patch: ShellPatchTab } }>();

const source = computed<ChangesSource>(() => {
  const { left, right, content } = props.tab.patch;
  return {
    entries: [{ path: right.path, letter: 'M', tone: 'modified', status: '', strike: false, version: props.tab.id }],
    emptyText: '',
    pair: { left, right },
    fileDiff: async () => {
      if (content.kind !== 'patch') return { kind: content.kind };
      const document = await props.api.getDocument(content.documentId);
      if (document.kind !== 'text') throw new Error(`The patch of ${props.tab.id} is not text`);
      return { kind: 'patch', patch: document.text };
    },
  };
});
</script>

<template>
  <ChangesTab
    data-source="patch"
    :source="source"
    :lead="tab.title"
  />
</template>
