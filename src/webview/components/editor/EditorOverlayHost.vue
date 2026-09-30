<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useEditorStore } from '@/stores/useEditorStore';
import EditorViewOverlay from './EditorViewOverlay.vue';
import SettingsJsonEditor from './SettingsJsonEditor.vue';

const emit = defineEmits<{
  (e: 'decide', toolUseId: string, approved: boolean): void;
}>();

const editorStore = useEditorStore();
const { view, settingsEditorScope } = storeToRefs(editorStore);
</script>

<template>
  <!-- Keyed so a replacing view mounts fresh editors and the replaced one disposes its own. -->
  <EditorViewOverlay
    v-if="view"
    :key="view.viewId"
    :view="view"
    @close="editorStore.dismissView()"
    @decide="(toolUseId, approved) => emit('decide', toolUseId, approved)"
  />
  <SettingsJsonEditor
    v-if="settingsEditorScope"
    :key="settingsEditorScope"
    :scope="settingsEditorScope"
    @close="editorStore.closeSettingsEditor()"
  />
</template>
