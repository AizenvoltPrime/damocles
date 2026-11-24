<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Camera, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import HostBadge from '@/components/HostBadge.vue';
import TrustedCheckingNote from '@/components/TrustedCheckingNote.vue';
import { IsolatedText } from '@/components/isolated-text';
import { isolated, withoutIsolates } from '@shared/bidi-isolate';
import { useTrustedVisibility } from '@/composables/useTrustedVisibility';
import type { ScreenshotNoticeHold, ShellScreenshotNotice } from '../../preload/shell-channels';

// A screenshot taken under a chat's grant while another chat is on screen: trusted UI naming the granting chat, with Revoke.
// Main publishes it and owns its lifetime. A newer notice replaces this one in place; one of another chat has a new id, for
// which Revoke is held again and the notice speaks again.
const props = defineProps<{ notice: ShellScreenshotNotice }>();
const emit = defineEmits<{
  (e: 'revoke', id: string): void;
  (e: 'dismiss', id: string): void;
  (e: 'hold', id: string, reason: ScreenshotNoticeHold, held: boolean): void;
}>();

const { t } = useI18n();
const noticeRef = ref<HTMLElement | null>(null);
const { isVisible, explain } = useTrustedVisibility(noticeRef, true, { request: () => props.notice.id });

// The chat's title and the host's name are their users' text, marked isolated as every name the shell shows.
const body = computed(() => {
  const { chat, host } = props.notice;
  if (host) {
    const name = isolated(host.name);
    return chat ? t('themes.screenshot.bodyOnHost', { chat: isolated(chat), host: name }) : t('themes.screenshot.bodyUntitledOnHost', { host: name });
  }
  return chat ? t('themes.screenshot.body', { chat: isolated(chat) }) : t('themes.screenshot.bodyUntitled');
});

// A live region speaks text added after it is in the page, not the text it is inserted with, so it is filled a moment later,
// and emptied once spoken, so browse mode does not read the notice a second time.
const ANNOUNCE_AFTER_MS = 250;
const ANNOUNCED_FOR_MS = 4_000;
const speaking = ref(false);
const announced = computed(() => (speaking.value ? `${t('themes.screenshot.title')} ${withoutIsolates(body.value)}` : ''));
let announceTimers: Array<ReturnType<typeof setTimeout>> = [];
function stopAnnouncing(): void {
  for (const timer of announceTimers) clearTimeout(timer);
  announceTimers = [];
}
watch(() => props.notice.id, () => {
  stopAnnouncing();
  speaking.value = false;
  announceTimers = [
    setTimeout(() => (speaking.value = true), ANNOUNCE_AFTER_MS),
    setTimeout(() => (speaking.value = false), ANNOUNCE_AFTER_MS + ANNOUNCED_FOR_MS),
  ];
}, { immediate: true });
onBeforeUnmount(stopAnnouncing);

// The pointer or keyboard focus in the notice holds its time in main, which takes a hold only for the notice it shows, so a
// replacement under a new id hears the holds again.
const holds = new Set<ScreenshotNoticeHold>();
function hold(reason: ScreenshotNoticeHold, held: boolean): void {
  if (held === holds.has(reason)) return;
  if (held) holds.add(reason);
  else holds.delete(reason);
  emit('hold', props.notice.id, reason, held);
}
function focusOut(event: FocusEvent): void {
  if (event.relatedTarget instanceof Node && noticeRef.value?.contains(event.relatedTarget)) return;
  hold('focus', false);
}
watch(() => props.notice.id, (id) => {
  for (const reason of holds) emit('hold', id, reason, true);
});

function revoke(): void {
  if (isVisible.value) emit('revoke', props.notice.id);
}
</script>

<template>
  <div
    ref="noticeRef"
    role="region"
    aria-labelledby="screenshot-notice-title"
    data-trusted
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color-mix(in_srgb,var(--d-warning-fill)_45%,var(--d-border2))] bg-(--d-card) py-2 ps-4 pe-3 text-12 text-(--d-text)"
    data-testid="screenshot-notice"
    @pointerenter="hold('pointer', true)"
    @pointerleave="hold('pointer', false)"
    @focusin="hold('focus', true)"
    @focusout="focusOut"
  >
    <span
      class="d-tone-warning flex size-6.5 flex-none items-center justify-center rounded-8 bg-(--tone)/15"
      aria-hidden="true"
    >
      <Camera class="size-4" />
    </span>
    <!-- The text scrolls inside its own bounded box, so the notice fits the window whole however long a chat's title is. -->
    <div class="relative min-w-0 flex-[1_1_16rem]">
      <p class="max-h-18 overflow-y-auto text-pretty">
        <strong
          id="screenshot-notice-title"
          class="font-semibold"
        >{{ t('themes.screenshot.title') }}</strong>
        {{ ' ' }}
        <HostBadge
          v-if="notice.host"
          :name="notice.host.name"
          :color="notice.host.color"
          class="me-1"
          data-testid="screenshot-notice-host"
        />
        <span
          id="screenshot-notice-body"
          class="text-(--d-muted)"
          data-testid="screenshot-notice-body"
        ><IsolatedText :text="body" /></span>
      </p>
      <TrustedCheckingNote
        cover
        :shown="explain"
        :text="t('themes.checkingVisible')"
      />
    </div>
    <div class="flex items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="h-7 rounded-8 border-(--d-border2) bg-transparent px-3 text-12 aria-disabled:text-(--d-muted) aria-disabled:hover:bg-transparent"
        aria-describedby="screenshot-notice-body"
        :aria-disabled="!isVisible || undefined"
        data-testid="screenshot-notice-revoke"
        @click="revoke"
      >
        {{ t('themes.screenshot.revoke') }}
      </Button>
      <!-- Dismiss decides nothing, so it acts while the notice is held. Sized as the chat header's icon buttons, so the hit
           floor a compact theme sets stays in force. -->
      <button
        type="button"
        class="d-tool-btn w-7.5 px-0"
        :title="t('themes.screenshot.dismiss')"
        :aria-label="t('themes.screenshot.dismiss')"
        data-view-only
        data-testid="screenshot-notice-dismiss"
        @click="emit('dismiss', notice.id)"
      >
        <X
          class="size-3.25"
          aria-hidden="true"
        />
      </button>
    </div>
    <p
      role="status"
      aria-live="polite"
      class="sr-only"
      data-testid="screenshot-notice-live"
    >
      {{ announced }}
    </p>
  </div>
</template>
