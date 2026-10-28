<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleAlert, CloudOff, Copy, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { useChatHost } from '@/composables/useChatHost';
import { useCopyToClipboard } from '@/composables/useCopyToClipboard';
import { useConnectionStore } from '@/stores/useConnectionStore';

// The messages main holds while the chat's host is away, above the composer (or the read-only transcript's card).
const { t } = useI18n();
const host = useChatHost();
const store = useConnectionStore();
const { copyToClipboard } = useCopyToClipboard();

// Polite, and only for a message that was just held or just came back unsent, never for the list as a whole.
const announcement = ref('');
watch(() => store.queued, (now, before) => {
  const known = new Map((before ?? []).map((message) => [message.id, message.status]));
  const changed = now.find((message) => known.get(message.id) !== message.status);
  if (!changed || !host.value) return;
  announcement.value = changed.status === 'queued' ? t('remote.queue.announceQueued', { host: host.value.name }) : t('remote.queue.notSent');
});

const label = (text: string, imageCount: number): string => (text.trim() !== '' ? text : t('remote.queue.images', imageCount));
</script>

<template>
  <div class="@container/held">
    <!-- Every queued chip shares this status, so it shows once; each chip keeps it for screen readers. -->
    <p
      v-if="store.queued.some((message) => message.status === 'queued')"
      aria-hidden="true"
      class="mb-1 text-10.5 text-(--d-warning-text)"
      data-testid="held-messages-status"
    >
      {{ t('remote.queue.queued', { host: host?.name ?? '' }) }}
    </p>
    <TransitionGroup
      name="t-chip"
      tag="ul"
      class="flex flex-wrap gap-1.5 empty:hidden"
      :aria-label="t('remote.queue.label')"
      data-testid="held-messages"
    >
      <li
        v-for="message in store.queued"
        :key="message.id"
        data-testid="held-message"
        :data-status="message.status"
        class="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-8 border border-dashed bg-(--d-card) py-1.25 ps-2 pe-1.5 text-11.5"
        :class="message.status === 'queued' ? 'border-(--d-border2)' : 'border-(--d-danger)/45'"
      >
        <CloudOff
          v-if="message.status === 'queued'"
          aria-hidden="true"
          class="size-3 shrink-0 text-(--d-muted)"
        />
        <CircleAlert
          v-else
          aria-hidden="true"
          class="size-3 shrink-0 text-(--d-danger-text)"
        />
        <span
          class="max-w-64 min-w-0 truncate @max-[40rem]/held:max-w-20"
          :title="label(message.text, message.imageCount)"
          data-testid="held-message-text"
        >{{ label(message.text, message.imageCount) }}</span>
        <span
          v-if="message.status === 'queued'"
          class="sr-only"
        >{{ t('remote.queue.queued', { host: host?.name ?? '' }) }}</span>
        <span
          v-else
          class="min-w-0 truncate text-10.5 text-(--d-danger-text)"
          :title="t('remote.queue.notSent')"
          data-testid="held-message-not-sent"
        >{{ t('remote.queue.notSent') }}</span>
        <template v-if="message.status === 'queued'">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            class="size-5 shrink-0 rounded-6 text-(--d-muted) hover:text-(--d-text) [&_svg]:size-3"
            :title="t('remote.queue.cancel')"
            :aria-label="t('remote.queue.cancel')"
            data-testid="held-message-cancel"
            @click="store.cancel(message.id)"
          >
            <X aria-hidden="true" />
          </Button>
        </template>
        <template v-else>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="h-5 shrink-0 rounded-6 px-1.5 text-11 text-(--d-muted) hover:text-(--d-text) [&_svg]:size-3"
            data-testid="held-message-copy"
            @click="copyToClipboard(message.text)"
          >
            <Copy aria-hidden="true" />
            {{ t('remote.queue.copy') }}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="h-5 shrink-0 rounded-6 px-1.5 text-11 text-(--d-muted) hover:text-(--d-text)"
            data-testid="held-message-discard"
            @click="store.discard(message.id)"
          >
            {{ t('remote.queue.discard') }}
          </Button>
        </template>
      </li>
    </TransitionGroup>
    <p
      class="sr-only"
      aria-live="polite"
      data-testid="held-messages-announcement"
    >
      {{ announcement }}
    </p>
  </div>
</template>
