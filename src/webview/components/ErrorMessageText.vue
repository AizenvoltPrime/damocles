<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { usePlatformBridge } from "@/composables/usePlatformBridge";

const props = defineProps<{ text: string }>();

const { t } = useI18n();
const { postMessage } = usePlatformBridge();

// pi appends this exact URL to ChatGPT usage-limit errors; it is the only text an error may turn into a link.
const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
// A longer URL that merely starts or ends with the usage URL stays plain text.
const USAGE_URL_PATTERN = /(?<![\w/.:@?=&%~+#-])https:\/\/chatgpt\.com\/settings\/usage(?![\w/?#=&%~+-])/g;

type Segment = { kind: "text"; value: string } | { kind: "usage-link" };

const segments = computed<Segment[]>(() => {
  const parts: Segment[] = [];
  let last = 0;
  for (const match of props.text.matchAll(USAGE_URL_PATTERN)) {
    if (match.index > last) parts.push({ kind: "text", value: props.text.slice(last, match.index) });
    parts.push({ kind: "usage-link" });
    last = match.index + match[0].length;
  }
  if (last < props.text.length) parts.push({ kind: "text", value: props.text.slice(last) });
  return parts;
});

function openUsage(): void {
  postMessage({ type: "openExternalUrl", url: CHATGPT_USAGE_URL });
}
</script>

<template>
  <span>
    <template
      v-for="(segment, index) in segments"
      :key="index"
    >
      <template v-if="segment.kind === 'text'">{{ segment.value }}</template>
      <Button
        v-else
        variant="link"
        class="h-auto p-0 align-baseline whitespace-normal text-[length:inherit] font-normal"
        :title="t('usage.openChatGPTUsage')"
        @click="openUsage"
      >{{ CHATGPT_USAGE_URL }}</Button>
    </template>
  </span>
</template>
