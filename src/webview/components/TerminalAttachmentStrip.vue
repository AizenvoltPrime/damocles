<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ChatAttachmentInfo } from "@shared/types/chat-attachment";
import { chatAttachmentLabel } from "@/utils/chat-attachment-label";
import CommitAttachmentChip from "./CommitAttachmentChip.vue";
import McpResourceAttachmentChip from "./McpResourceAttachmentChip.vue";
import TerminalAttachmentChip from "./TerminalAttachmentChip.vue";

// The composer's pending attachments, terminal output, commits and MCP resources; each chip pops in when the host adds it
// and shrinks out when it leaves.
const props = defineProps<{ attachments: readonly ChatAttachmentInfo[] }>();
const emit = defineEmits<{ remove: [id: string]; focusComposer: [] }>();
const { t } = useI18n();

const ADDED_KEYS: Record<ChatAttachmentInfo["kind"], string> = {
  terminal: "terminalAttachment.added",
  commit: "commitAttachment.added",
  mcpResource: "mcp.resourceChip.added",
};

const list = ref<HTMLElement | null>(null);
// What screen readers hear when an attachment arrives; the chip itself is announced only when reached.
const announcement = ref("");
// A chip removed while it held focus hands focus on once core's update drops it: the next chip, else the previous, else the composer.
let refocus: { readonly id: string; readonly index: number } | null = null;

function chipItem(id: string): HTMLElement | null {
  return list.value?.querySelector<HTMLElement>(`[data-attachment-id="${CSS.escape(id)}"]`) ?? null;
}

function onRemove(id: string): void {
  const held = chipItem(id)?.contains(document.activeElement) ?? false;
  refocus = held ? { id, index: props.attachments.findIndex((attachment) => attachment.id === id) } : null;
  emit("remove", id);
}

watch(() => props.attachments, (next, before) => {
  const known = new Set(before?.map((attachment) => attachment.id));
  const added = next.filter((attachment) => !known.has(attachment.id));
  if (added.length > 0) announcement.value = added.map((attachment) => t(ADDED_KEYS[attachment.kind], { label: chatAttachmentLabel(attachment, t) })).join(" ");
  const pending = refocus;
  if (!pending || next.some((attachment) => attachment.id === pending.id)) return;
  refocus = null;
  const target = next[Math.min(pending.index, next.length - 1)];
  void nextTick(() => {
    if (target) chipItem(target.id)?.querySelector<HTMLElement>('[data-testid$="-attachment-preview-button"]')?.focus();
    else emit("focusComposer");
  });
});

// A leaving chip leaves the flow at its own place, so the chips after it slide over (t-chip-move) while it shrinks out.
function pinLeaving(element: Element): void {
  const item = element as HTMLElement;
  item.style.left = `${item.offsetLeft}px`;
  item.style.top = `${item.offsetTop}px`;
  item.style.width = `${item.offsetWidth}px`;
  item.style.position = "absolute";
}
</script>

<template>
  <div ref="list">
    <TransitionGroup
      name="t-chip"
      tag="div"
      :aria-label="t('terminalAttachment.listLabel')"
      role="list"
      class="relative flex flex-wrap gap-1.5 px-2.5"
      :class="attachments.length > 0 ? 'pt-2.5' : ''"
      data-testid="terminal-attachments"
      @before-leave="pinLeaving"
    >
      <div
        v-for="attachment in attachments"
        :key="attachment.id"
        role="listitem"
        class="min-w-0"
      >
        <CommitAttachmentChip
          v-if="attachment.kind === 'commit'"
          :attachment="attachment"
          removable
          @remove="onRemove"
        />
        <McpResourceAttachmentChip
          v-else-if="attachment.kind === 'mcpResource'"
          :attachment="attachment"
          removable
          @remove="onRemove"
        />
        <TerminalAttachmentChip
          v-else
          :attachment="attachment"
          removable
          @remove="onRemove"
        />
      </div>
    </TransitionGroup>
    <p
      class="sr-only"
      aria-live="polite"
    >
      {{ announcement }}
    </p>
  </div>
</template>
