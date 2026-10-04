<script setup lang="ts">
/**
 * Lists rules in files Damocles must not rewrite (committed project settings, Claude settings, hook
 * matchers) that still name an MCP tool by its old name. Rule text is file content: render as text only.
 */
import type { McpRenamedToolRuleNotice } from '@shared/types/mcp';
import { useI18n } from 'vue-i18n';
import { TriangleAlert } from 'lucide-vue-next';
import DockBanner from './DockBanner.vue';

const { t } = useI18n();

defineProps<{
  notices: McpRenamedToolRuleNotice[];
}>();

const emit = defineEmits<{
  (e: 'openFile', path: string): void;
  (e: 'dismiss'): void;
}>();
</script>

<template>
  <DockBanner
    tone="warning"
    :icon="TriangleAlert"
    :title="t('mcp.renamedRules.title')"
    role="alert"
    data-testid="mcp-renamed-rules-banner"
    @dismiss="emit('dismiss')"
  >
    <p class="text-xs text-(--d-muted)">
      {{ t('mcp.renamedRules.description') }}
    </p>

    <!-- Focusable so a keyboard user can scroll a long list. -->
    <div
      class="mt-1.5 max-h-40 space-y-2 overflow-y-auto rounded-lg pb-0.5"
      tabindex="0"
      role="region"
      :aria-label="t('mcp.renamedRules.title')"
    >
      <section
        v-for="notice in notices"
        :key="notice.path"
        data-testid="mcp-renamed-rules-file"
        class="text-xs"
      >
        <div class="flex items-center gap-2">
          <span class="min-w-0 break-all font-mono text-(--d-text)">{{ notice.displayPath }}</span>
          <button
            type="button"
            class="d-tool-btn h-6 shrink-0 px-2 text-xs text-(--d-accent)"
            :aria-label="t('mcp.renamedRules.openFileAria', { file: notice.displayPath })"
            @click="emit('openFile', notice.path)"
          >
            {{ t('mcp.renamedRules.openFile') }}
          </button>
        </div>
        <ul class="mt-0.5 space-y-0.5 ps-2">
          <li
            v-for="rule in notice.rules"
            :key="rule.old"
            data-testid="mcp-renamed-rule"
            class="break-all font-mono text-(--d-muted)"
          >
            <span>{{ rule.old }}</span>
            <span aria-hidden="true"> → </span>
            <span class="sr-only"> {{ t('mcp.renamedRules.becomes') }} </span>
            <span>{{ rule.new }}</span>
          </li>
        </ul>
      </section>
    </div>
  </DockBanner>
</template>
