<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { History } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { IsolatedText } from '@/components/isolated-text';
import { withoutIsolates } from '@shared/bidi-isolate';
import type { ThemeHistoryEntry } from '@shared/themes/changes';
import { HISTORY_LIMIT } from '@shared/themes/limits';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import { changeText, restoredChangeText, whoAndWhen } from './theme-text';

// The theme history (newest first): each entry says what changed and who changed it, and Restore puts back what it and
// every later entry changed, as one change Undo can reverse.
const props = defineProps<{
  open: boolean;
  entries: readonly ThemeHistoryEntry[];
  busy: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', open: boolean): void;
  (e: 'restore', entryId: string): void;
}>();

const { t, locale } = useI18n();

// A Restore reaches its entry and every later one, so none is offered from the newest entry this Damocles cannot undo on down.
const firstFixed = computed(() => props.entries.findIndex((entry) => entry.cannotUndo === true));
const restorable = (index: number): boolean => firstFixed.value < 0 || index < firstFixed.value;
</script>

<template>
  <Dialog
    :open="open"
    @update:open="(next: boolean) => emit('update:open', next)"
  >
    <DialogContent
      class="max-w-120 gap-3 p-0"
      data-testid="theme-history"
    >
      <div class="flex flex-col gap-1 border-b border-(--d-border) px-4 pt-3 pb-2">
        <DialogTitle class="text-13">
          {{ t('settingsHost.themes.history.title') }}
        </DialogTitle>
        <DialogDescription class="text-12 text-(--d-muted)">
          {{ t('settingsHost.themes.history.intro', { n: HISTORY_LIMIT }, HISTORY_LIMIT) }}
        </DialogDescription>
      </div>
      <div class="px-4 pb-3">
        <div
          v-if="entries.length === 0"
          class="flex flex-col items-center gap-2 rounded-11 border border-dashed border-(--d-border2) px-4 py-8 text-center"
        >
          <History
            class="size-6 text-(--d-faint-text)"
            aria-hidden="true"
          />
          <h3 class="text-13 font-semibold">
            {{ t('settingsHost.themes.history.empty.title') }}
          </h3>
          <p class="max-w-md text-12 text-(--d-muted)">
            {{ t('settingsHost.themes.history.empty.body') }}
          </p>
        </div>
        <p
          v-if="entries.length > 0 && firstFixed >= 0"
          class="pb-1 text-11 text-(--d-muted)"
          data-testid="theme-history-cannot-restore"
        >
          {{ t('settingsHost.themes.history.cannotRestore') }}
        </p>
        <ul
          v-if="entries.length > 0"
          class="flex max-h-80 flex-col overflow-y-auto"
        >
          <li
            v-for="(entry, index) in entries"
            :key="entry.id"
            class="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 border-b border-(--d-border) py-2 text-12"
            :data-testid="`theme-history-${entry.id}`"
          >
            <span class="font-medium"><IsolatedText :text="changeText(t, entry.change)" /></span>
            <SettingButton
              v-if="restorable(index)"
              class="row-span-2"
              :disabled="busy"
              :aria-label="withoutIsolates(t('settingsHost.themes.history.restoreLabel', { change: restoredChangeText(t, entry.change) }))"
              @click="emit('restore', entry.id)"
            >
              {{ t('settingsHost.themes.history.restore') }}
            </SettingButton>
            <span class="col-start-1 text-11 text-(--d-faint-text)"><IsolatedText :text="whoAndWhen(t, entry, locale)" /></span>
          </li>
        </ul>
      </div>
    </DialogContent>
  </Dialog>
</template>
