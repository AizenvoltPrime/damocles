<script setup lang="ts">
import { ref, computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall, ToolResultOwner } from '@shared/types/session';
import { ChevronRight, CircleCheck, CircleX, CornerDownRight, LoaderCircle, Plug } from 'lucide-vue-next';
import MarkdownRenderer from './MarkdownRenderer.vue';
import CodeBlock from './CodeBlock.vue';
import OverlayShell from './OverlayShell.vue';
import ImageLightbox from './ImageLightbox.vue';
import ToolResultImages from './ToolResultImages.vue';
import { useToolStatusBadge } from '@/composables/useToolCardStatus';

const { t } = useI18n();

const props = defineProps<{
  tool: ToolCall;
  owner?: ToolResultOwner | undefined;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const isInputExpanded = ref(true);
const isResponseExpanded = ref(true);
const ids = useId();

const parsedToolName = computed(() => {
  const name = props.tool.name;
  if (!name.startsWith('mcp__')) {
    return { serverName: '', toolName: name };
  }
  const parts = name.split('__');
  return {
    serverName: parts[1] || '',
    toolName: parts.slice(2).join('__') || name,
  };
});

const resultText = computed(() => props.tool.result ?? '');

const isRunning = computed(() =>
  props.tool.status === 'running' || props.tool.status === 'pending'
);

const isFailed = computed(() => props.tool.status === 'failed');

const statusBadge = useToolStatusBadge(() => props.tool.status);

const hasResult = computed(() => Boolean(resultText.value.trim()) || (props.tool.imageCount ?? 0) > 0);

const hasInput = computed(() => Object.keys(props.tool.input ?? {}).length > 0);

const inputAsJson = computed(() => JSON.stringify(props.tool.input ?? {}, null, 2));

function tryParseJson(str: string): unknown | null {
  const trimmed = str.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

const parsedResponseJson = computed(() => tryParseJson(resultText.value));

const responseIsJson = computed(() => parsedResponseJson.value !== null);

const formattedResponse = computed(() => {
  if (parsedResponseJson.value !== null) {
    return JSON.stringify(parsedResponseJson.value, null, 2);
  }
  return resultText.value;
});

const lightboxImageUrl = ref<string | null>(null);

function openImageLightbox(url: string): void {
  lightboxImageUrl.value = url;
}

function closeLightbox(): void {
  lightboxImageUrl.value = null;
}

</script>

<template>
  <OverlayShell
    max-width="47.5rem"
    :title="parsedToolName.toolName"
    :subtitle="parsedToolName.serverName || undefined"
    :icon="Plug"
    :status-badge="statusBadge"
    @close="emit('close')"
  >
    <div class="flex flex-col gap-3 px-4.5 pt-3.5 pb-4.5 text-13">
      <section class="overflow-hidden rounded-10 border border-(--d-border) bg-(--d-card)">
        <button
          type="button"
          class="flex h-8.5 w-full items-center gap-2 px-3 text-left text-xs font-semibold text-(--d-muted) transition-colors hover:bg-(--d-hover)"
          :aria-expanded="isInputExpanded"
          :aria-controls="isInputExpanded ? `${ids}-input` : undefined"
          @click="isInputExpanded = !isInputExpanded"
        >
          <ChevronRight
            class="size-3.25 transition-transform duration-200"
            :class="isInputExpanded && 'rotate-90'"
            aria-hidden="true"
          />
          <CornerDownRight
            class="size-3 text-(--d-faint)"
            aria-hidden="true"
          />
          {{ t('mcpToolOverlay.input') }}
        </button>
        <Transition name="t-fade">
          <div
            v-if="isInputExpanded"
            :id="`${ids}-input`"
            class="border-t border-(--d-border)"
          >
            <CodeBlock
              v-if="hasInput"
              bare
              :code="inputAsJson"
              language="json"
            />
            <p
              v-else
              class="py-2.5 pr-3.5 pl-8.25 text-xs text-(--d-faint) italic"
            >
              {{ t('mcpToolOverlay.noInput') }}
            </p>
          </div>
        </Transition>
      </section>

      <div
        v-if="isRunning"
        class="flex items-center justify-center gap-2.25 py-6.5 text-12.5 text-(--d-muted)"
      >
        <LoaderCircle
          class="size-4 d-spinning text-(--d-accent)"
          aria-hidden="true"
        />{{ t('mcpToolOverlay.running') }}
      </div>

      <div
        v-if="isFailed && tool.errorMessage"
        role="alert"
        class="flex items-start gap-2.25 rounded-10 border border-[color-mix(in_srgb,var(--d-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--d-danger)_8%,transparent)] px-3 py-2.25 text-(--d-danger-text)"
      >
        <CircleX
          class="size-3.5 mt-0.5 flex-none"
          aria-hidden="true"
        />
        <span class="font-mono text-xs wrap-break-word">{{ tool.errorMessage }}</span>
      </div>

      <section
        v-if="hasResult"
        class="overflow-hidden rounded-10 border border-(--d-border) bg-(--d-card)"
      >
        <button
          type="button"
          class="flex h-8.5 w-full items-center gap-2 px-3 text-left text-xs font-semibold text-(--d-muted) transition-colors hover:bg-(--d-hover)"
          :aria-expanded="isResponseExpanded"
          :aria-controls="isResponseExpanded ? `${ids}-output` : undefined"
          @click="isResponseExpanded = !isResponseExpanded"
        >
          <ChevronRight
            class="size-3.25 transition-transform duration-200"
            :class="isResponseExpanded && 'rotate-90'"
            aria-hidden="true"
          />
          <component
            :is="isFailed ? CircleX : CircleCheck"
            class="size-3"
            :class="isFailed ? 'text-(--d-danger)' : 'text-(--d-success)'"
            aria-hidden="true"
          />
          {{ t('mcpToolOverlay.response') }}
        </button>
        <Transition name="t-fade">
          <div
            v-if="isResponseExpanded"
            :id="`${ids}-output`"
            class="flex flex-col gap-3 border-t border-(--d-border) bg-(--d-code)"
          >
            <template v-if="resultText.trim()">
              <CodeBlock
                v-if="responseIsJson"
                bare
                :code="formattedResponse"
                language="json"
              />
              <MarkdownRenderer
                v-else
                class="px-3.5 py-2.5"
                :content="formattedResponse"
              />
            </template>
            <ToolResultImages
              :tool="tool"
              :owner="owner"
              @open="openImageLightbox"
            />
          </div>
        </Transition>
      </section>

      <p
        v-else-if="!isFailed && !isRunning"
        class="py-6.5 text-center text-12.5 text-(--d-muted)"
      >
        {{ t('mcpToolOverlay.noResponse') }}
      </p>
    </div>

    <ImageLightbox
      :open="lightboxImageUrl !== null"
      :image-url="lightboxImageUrl ?? ''"
      @close="closeLightbox"
    />
  </OverlayShell>
</template>
