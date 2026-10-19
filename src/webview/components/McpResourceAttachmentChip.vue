<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { FileText, X } from "lucide-vue-next";
import type { McpResourceAttachmentInfo } from "@shared/types/chat-attachment";
import { visibleText } from "@shared/visible-text";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HOVER_CLOSE_MS, HOVER_OPEN_MS, useHoverPreview } from "@/composables/useHoverPreview";
import { mcpResourceAttachmentLabel } from "@/utils/chat-attachment-label";

// An MCP resource attached to a message: a chip naming the resource and its server whose popover shows its URI; core reads
// it only when the message is sent. Removable while it waits in the composer.
const props = defineProps<{ attachment: McpResourceAttachmentInfo; removable?: boolean }>();
const emit = defineEmits<{ remove: [id: string] }>();
const { t } = useI18n();

const { open, schedule, onTriggerPress, onOpenChange, onOpenAutoFocus } = useHoverPreview();

const label = computed(() => mcpResourceAttachmentLabel(props.attachment, t));
</script>

<template>
  <div
    class="group/chip inline-flex h-7 max-w-full min-w-0 items-center rounded-full border border-(--d-border2) bg-(--d-card) text-xs text-(--d-text) transition-colors hover:border-(--d-accent)"
    data-testid="mcp-resource-attachment-chip"
    :data-attachment-id="attachment.id"
    :data-uri="attachment.uri"
  >
    <Popover
      :open="open"
      @update:open="onOpenChange"
    >
      <PopoverTrigger as-child>
        <Button
          variant="ghost"
          class="d-press h-full min-w-0 gap-1.5 rounded-full py-0 ps-0.75 hover:bg-transparent hover:text-(--d-text)"
          :class="removable ? 'pe-1' : 'pe-2.5'"
          :title="t('mcp.resourceChip.title', { name: attachment.name, serverName: attachment.server, uri: visibleText(attachment.uri) })"
          :aria-label="t('mcp.resourceChip.preview', { label })"
          data-testid="mcp-resource-attachment-preview-button"
          @pointerenter="schedule(true, HOVER_OPEN_MS)"
          @pointerleave="schedule(false, HOVER_CLOSE_MS)"
          @pointerdown="onTriggerPress"
          @keydown="onTriggerPress"
        >
          <span
            class="d-tone-accent flex size-5.5 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--tone)_16%,transparent)]"
            aria-hidden="true"
          >
            <FileText class="size-3" />
          </span>
          <span
            class="max-w-60 min-w-0 truncate"
            aria-hidden="true"
            data-testid="mcp-resource-attachment-name"
          >{{ attachment.name }}</span>
          <span
            class="max-w-30 min-w-0 shrink-0 truncate text-(--d-muted)"
            aria-hidden="true"
            data-testid="mcp-resource-attachment-server"
          >{{ attachment.server }}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        class="w-md max-w-[calc(100vw-2rem)] border-(--d-border2) bg-(--d-card) p-0 text-(--d-text)"
        data-testid="mcp-resource-attachment-preview"
        @open-auto-focus="onOpenAutoFocus"
        @pointerenter="schedule(true, 0)"
        @pointerleave="schedule(false, HOVER_CLOSE_MS)"
      >
        <div class="flex items-start gap-2 px-3 py-2">
          <FileText
            class="mt-0.5 size-3.5 shrink-0 text-(--d-muted)"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <p class="text-11.5 wrap-break-word text-(--d-text)">
              {{ attachment.name }}
            </p>
            <p
              class="mt-0.5 text-11 text-(--d-muted)"
              data-testid="mcp-resource-attachment-details"
            >
              {{ attachment.mimeType ? t("mcp.resourceChip.details", { serverName: attachment.server, type: attachment.mimeType }) : attachment.server }}
            </p>
            <p
              tabindex="0"
              class="mt-1 font-mono text-11 break-all text-(--d-text) outline-none focus-visible:ring-1 focus-visible:ring-(--d-accent)"
              data-testid="mcp-resource-attachment-uri"
            >
              {{ visibleText(attachment.uri) }}
            </p>
            <p
              v-if="removable"
              class="mt-1 text-10.5 text-(--d-faint)"
            >
              {{ t("mcp.resourceChip.readAtSend") }}
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
    <Button
      v-if="removable"
      variant="ghost"
      size="icon"
      class="d-press me-0.75 size-5 shrink-0 rounded-full text-(--d-faint) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3"
      :aria-label="t('mcp.resourceChip.remove', { label })"
      :title="t('mcp.resourceChip.removeTitle')"
      data-testid="mcp-resource-attachment-remove"
      @click="emit('remove', attachment.id)"
    >
      <X aria-hidden="true" />
    </Button>
  </div>
</template>
