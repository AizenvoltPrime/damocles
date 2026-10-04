<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { ChevronDown, ClipboardList, FileText, Link } from 'lucide-vue-next';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MENU_CONTENT, MENU_ITEM } from './menuStyles';
import type { HeaderAction } from './headerActions';
import { remPx } from '@/composables/useRemPx';

const { t } = useI18n();
const emit = defineEmits<{ action: [action: HeaderAction] }>();
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger
      class="d-tool-btn gap-0.75"
      :title="t('chatHeader.plan')"
      :aria-label="t('chatHeader.plan')"
      data-testid="chat-header-plan"
    >
      <ClipboardList
        class="size-3.75"
        aria-hidden="true"
      />
      <ChevronDown
        class="size-2.75"
        aria-hidden="true"
      />
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="end"
      :side-offset="remPx(0.375)"
      :class="['w-55', MENU_CONTENT]"
    >
      <DropdownMenuItem
        :class="MENU_ITEM"
        @select="emit('action', 'viewPlan')"
      >
        <FileText aria-hidden="true" />{{ t('chatHeader.viewPlan') }}
      </DropdownMenuItem>
      <DropdownMenuItem
        :class="MENU_ITEM"
        @select="emit('action', 'bindPlan')"
      >
        <Link aria-hidden="true" />{{ t('chatHeader.bindPlan') }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
