<script setup lang="ts">
/**
 * Lists rules in files Damocles must not rewrite (committed project settings, Claude settings, hook
 * matchers) that still name an MCP tool by its old name. Rule text is file content: render as text only.
 */
import type { McpRenamedToolRuleNotice } from '@shared/types/mcp';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { IconWarning, IconXMark } from '@/components/icons';

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
  <Alert
    data-testid="mcp-renamed-rules-banner"
    class="flex items-start gap-3 px-4 py-2 rounded-none border-x-0 border-t-0 bg-warning/30 border-warning/50"
  >
    <IconWarning
      :size="20"
      class="shrink-0 mt-0.5"
      aria-hidden="true"
    />

    <div class="flex-1 min-w-0">
      <AlertTitle class="font-medium text-warning mb-0">
        {{ t('mcp.renamedRules.title') }}
      </AlertTitle>
      <AlertDescription class="text-xs opacity-80 mt-0.5">
        {{ t('mcp.renamedRules.description') }}
      </AlertDescription>

      <!-- Focusable so a keyboard user can scroll a long list. -->
      <div
        class="mt-1.5 max-h-40 overflow-y-auto space-y-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
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
            <span class="font-mono break-all min-w-0">{{ notice.displayPath }}</span>
            <Button
              size="sm"
              variant="ghost"
              class="h-6 px-2 text-xs shrink-0"
              :aria-label="t('mcp.renamedRules.openFileAria', { file: notice.displayPath })"
              @click="emit('openFile', notice.path)"
            >
              {{ t('mcp.renamedRules.openFile') }}
            </Button>
          </div>
          <ul class="mt-0.5 space-y-0.5 pl-2">
            <li
              v-for="rule in notice.rules"
              :key="rule.old"
              data-testid="mcp-renamed-rule"
              class="font-mono break-all"
            >
              <span>{{ rule.old }}</span>
              <span aria-hidden="true"> → </span>
              <span class="sr-only"> {{ t('mcp.renamedRules.becomes') }} </span>
              <span>{{ rule.new }}</span>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <Button
      variant="ghost"
      size="icon-sm"
      class="opacity-50 hover:opacity-100 h-6 w-6 shrink-0"
      :title="t('common.dismiss')"
      :aria-label="t('common.dismiss')"
      data-testid="mcp-renamed-rules-dismiss"
      @click="emit('dismiss')"
    >
      <IconXMark :size="12" />
    </Button>
  </Alert>
</template>
