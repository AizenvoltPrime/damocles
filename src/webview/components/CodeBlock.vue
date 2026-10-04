<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { IconCheck, IconCopy } from "@/components/icons";
import { useCopyToClipboard } from "@/composables/useCopyToClipboard";
import { getHighlighter, codeHighlightTheme, normalizeLanguage, isHighlighterReady } from "@/composables/useShikiHighlighter";
import { useSettingsStore } from "@/stores/useSettingsStore";

const { t } = useI18n();
const settingsStore = useSettingsStore();

const props = defineProps<{
  code: string;
  language?: string;
  /** Only the highlighted code: no frame, language header or copy button, for a host that draws its own. */
  bare?: boolean;
}>();

const { hasCopied, copyToClipboard } = useCopyToClipboard();
const highlightedHtml = ref<string>("");
const isHovering = ref(false);
const isMounted = ref(true);

const normalizedLang = computed(() => normalizeLanguage(props.language));

const displayLanguage = computed(() => {
  const lang = props.language?.toLowerCase();
  if (!lang || lang === "txt" || lang === "text" || lang === "plaintext") return null;
  return lang;
});

async function highlight() {
  if (!isMounted.value) return;

  const fallbackHtml = `<pre style="padding:0;margin:0;color:inherit;"><code class="hljs">${escapeHtml(props.code)}</code></pre>`;

  const theme = codeHighlightTheme(settingsStore.hostCapabilities.damoclesTheme);
  if (!isHighlighterReady(normalizedLang.value, theme)) {
    highlightedHtml.value = fallbackHtml;
  }

  try {
    const highlighter = await getHighlighter(normalizedLang.value, theme);
    if (!isMounted.value) return;

    const html = highlighter.codeToHtml(props.code, {
      lang: normalizedLang.value,
      theme,
      transformers: [
        {
          pre(node) {
            node.properties.style = "padding:0;margin:0;background:transparent;color:inherit;";
            return node;
          },
          code(node) {
            node.properties.class = `hljs language-${normalizedLang.value}`;
            node.properties.style = "white-space:normal;";
            return node;
          },
          line(node) {
            node.properties.style = "display:block;white-space:pre;line-height:1.5;min-height:1.5em;";
            return node;
          },
        },
      ],
    });

    if (isMounted.value) {
      highlightedHtml.value = html;
    }
  } catch (e) {
    console.error("[CodeBlock] Highlighting failed:", e);
    if (isMounted.value) {
      highlightedHtml.value = fallbackHtml;
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function handleCopy() {
  copyToClipboard(props.code);
}

watch(() => [props.code, props.language, settingsStore.hostCapabilities.damoclesTheme], highlight, { immediate: true });

onMounted(() => {
  isMounted.value = true;
});

onUnmounted(() => {
  isMounted.value = false;
});
</script>

<template>
  <!-- eslint-disable vue/no-v-html -- Shiki output, or the escaped fallback -->
  <div
    v-if="bare"
    class="code-block-content overflow-x-auto"
    v-html="highlightedHtml"
  />
  <!-- eslint-enable vue/no-v-html -->
  <div
    v-else
    class="code-block-container group my-2 rounded-xl border border-border overflow-hidden"
    @mouseenter="isHovering = true"
    @mouseleave="isHovering = false"
  >
    <div class="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border">
      <span v-if="displayLanguage" class="text-xs font-mono text-muted-foreground select-none">
        {{ displayLanguage }}
      </span>
      <span v-else></span>

      <Button
        variant="ghost"
        size="icon-sm"
        class="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary size-6 -mr-1"
        :class="{ 'opacity-100 text-success': hasCopied }"
        :title="t('codeBlock.copyCode')"
        @click="handleCopy"
      >
        <IconCheck v-if="hasCopied" class="size-3.5" />
        <IconCopy v-else class="size-3.5" />
      </Button>
    </div>

    <div class="code-block-content overflow-x-auto" v-html="highlightedHtml" />
  </div>
</template>

<style scoped>
.code-block-container {
  box-shadow: 0 4px 12px -2px rgba(0, 0, 0, 0.25), 0 2px 6px -1px rgba(0, 0, 0, 0.2);
}

.code-block-content {
  background: var(--d-code);
  padding: 0.75rem 1rem;
  color: var(--d-text);
}

.code-block-content :deep(pre) {
  margin: 0;
  padding: 0;
  background: transparent !important;
}

.code-block-content :deep(code) {
  font-size: 0.85em;
  font-family: var(--d-mono);
  white-space: pre;
  background: transparent !important;
}

.code-block-content :deep(.line) {
  display: block;
  background: transparent !important;
}

.code-block-content :deep(span) {
  background: transparent !important;
}
</style>
