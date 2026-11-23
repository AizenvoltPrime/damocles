<script setup lang="ts">
import { Dialog, DialogContent } from '@/components/ui/dialog';
import ThemeInstallCard from '@/components/theme/ThemeInstallCard.vue';
import type { ThemeInstallAnswer, ThemeInstallPreview } from '@shared/themes/install';

// The install card as a dialog of the Settings modal: Import, Install from link, the store and damocles:// links open it.
// Closing it is Cancel.
defineProps<{
  preview: ThemeInstallPreview | undefined;
  busy: boolean;
  // why the install did not land, in the UI's language
  failure: string | undefined;
  // how far each running flash check is, by the wallpaper's sha256
  progress: Readonly<Record<string, number>>;
}>();
const emit = defineEmits<{
  (e: 'answer', answer: ThemeInstallAnswer): void;
  (e: 'allow-flash', sha256: string): void;
}>();
</script>

<template>
  <Dialog
    :open="preview !== undefined"
    @update:open="(open: boolean) => { if (!open && !busy) emit('answer', { choice: 'cancel' }) }"
  >
    <DialogContent
      class="flex max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-[44rem] flex-col gap-0 overflow-hidden p-0"
      :show-close="false"
      data-testid="theme-install-dialog"
    >
      <template v-if="preview">
        <p
          v-if="failure"
          class="sm-feedback sm-feedback-error m-3 mb-0"
          role="alert"
          data-testid="theme-install-error"
        >
          {{ failure }}
        </p>
        <ThemeInstallCard
          :preview="preview"
          variant="dialog"
          :gated="true"
          :busy="busy"
          :progress="progress"
          @answer="(answer) => emit('answer', answer)"
          @allow-flash="(sha256) => emit('allow-flash', sha256)"
        />
      </template>
    </DialogContent>
  </Dialog>
</template>
