<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { MessageSquarePlus } from 'lucide-vue-next';
import type { DamoclesShellApi, ShellState } from '../preload/shell-channels';
import { applyShellLocale } from './i18n';
import { watchContentBounds } from './content-bounds';
import { MIN_MAIN_SLOT_WIDTH } from './layout';
import TitleBar from './components/TitleBar.vue';
import Sidebar from './components/Sidebar.vue';

const props = defineProps<{ api: DamoclesShellApi }>();
const { t } = useI18n();

const state = shallowRef<ShellState | null>(null);
const titleBar = ref<InstanceType<typeof TitleBar> | null>(null);
const sidebar = ref<InstanceType<typeof Sidebar> | null>(null);
const chatSlot = ref<HTMLElement | null>(null);

function applyState(next: ShellState): void {
  state.value = next;
  applyShellLocale(next.locale);
}

const stops: Array<() => void> = [];
let stopBounds: (() => void) | undefined;

onMounted(async () => {
  // Subscribed before the first read, so a change between the two is not lost.
  stops.push(props.api.onState(applyState));
  stops.push(props.api.onFocusPart(() => sidebar.value?.focusCurrentRow()));
  applyState(await props.api.getState());
});

// Main lays the selected chat's view over exactly the chat slot's rectangle.
watch(chatSlot, (element) => {
  stopBounds?.();
  stopBounds = undefined;
  const header = titleBar.value?.$el as HTMLElement | undefined;
  if (!element || !header) return;
  stopBounds = watchContentBounds(element, [header], (bounds) => props.api.reportContentBounds(bounds));
}, { flush: 'post' });

onBeforeUnmount(() => {
  for (const stop of stops) stop();
  stopBounds?.();
});
</script>

<template>
  <div
    v-if="state"
    class="flex h-full min-h-0 flex-col bg-(--d-bg) text-(--d-text)"
  >
    <TitleBar
      ref="titleBar"
      :api="api"
      :state="state"
    />
    <div class="flex min-h-0 flex-1 overflow-hidden">
      <Sidebar
        ref="sidebar"
        :api="api"
        :state="state"
      />
      <main
        ref="chatSlot"
        data-testid="chat-slot"
        class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        :style="{ minWidth: `${MIN_MAIN_SLOT_WIDTH}px` }"
      >
        <template v-if="state.selected.chatId === undefined">
          <p class="text-sm font-medium">
            {{ t('content.empty') }}
          </p>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg bg-(--d-accent) px-3 py-1.5 text-xs font-medium text-(--d-on-accent)"
            @click="api.newChat()"
          >
            <MessageSquarePlus
              aria-hidden="true"
              class="size-3.5"
            />
            {{ t('content.newChat') }}
          </button>
        </template>
      </main>
    </div>
  </div>
</template>
