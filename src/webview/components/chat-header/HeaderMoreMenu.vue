<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Brain,
  ChartLine,
  ChartPie,
  Ellipsis,
  FileText,
  Gauge,
  Globe,
  Link,
  MessageCircleQuestion,
  Plug,
  RotateCcw,
  Sparkles,
  SquareTerminal,
  Wrench,
} from 'lucide-vue-next';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MENU_CONTENT, MENU_HINT, MENU_ITEM } from './menuStyles';
import type { HeaderAction } from './headerActions';
import { remPx } from '@/composables/useRemPx';

const props = defineProps<{
  /** The header is 720px or wider, so it shows Memory consolidation itself. */
  wide: boolean;
  /** The header is 560px or wider, so it shows the plan, memory, browser, MCP and tools controls and the terminal toggle itself. */
  roomy: boolean;
  mcpConnected: number;
  toolsEnabled: number;
  /** MCP and Tools open only while no turn runs, as their header buttons do. */
  panelsDisabled: boolean;
  hasAside: boolean;
  /** The host lays out a terminal pane, whose header toggle folds in below 560px. */
  terminal: boolean;
  terminalShortcut?: string | undefined;
}>();

const emit = defineEmits<{ action: [action: HeaderAction] }>();
const { t } = useI18n();

interface MoreItem {
  action: HeaderAction;
  icon: Component;
  label: string;
  hint?: string;
  disabled?: boolean;
}

const folded = computed<MoreItem[]>(() => [
  ...(props.wide ? [] : [{ action: 'consolidation' as const, icon: Sparkles, label: t('chatHeader.consolidation') }]),
  ...(props.roomy
    ? []
    : [
        { action: 'viewPlan' as const, icon: FileText, label: t('chatHeader.viewPlan') },
        { action: 'bindPlan' as const, icon: Link, label: t('chatHeader.bindPlan') },
        { action: 'memory' as const, icon: Brain, label: t('chatHeader.memory'), hint: '/memories' },
        { action: 'browser' as const, icon: Globe, label: t('chatHeader.openBrowser') },
        { action: 'mcp' as const, icon: Plug, label: t('chatHeader.mcpCount', { n: props.mcpConnected }), disabled: props.panelsDisabled },
        { action: 'tools' as const, icon: Wrench, label: t('chatHeader.toolsCount', { n: props.toolsEnabled }), disabled: props.panelsDisabled },
        ...(props.terminal ? [{ action: 'terminal' as const, icon: SquareTerminal, label: t('chatHeader.toggleTerminal'), ...(props.terminalShortcut ? { hint: props.terminalShortcut } : {}) }] : []),
      ]),
]);

const always = computed<MoreItem[]>(() => [
  { action: 'rewind', icon: RotateCcw, label: t('chatHeader.rewind'), hint: 'Esc Esc' },
  props.hasAside
    ? { action: 'viewAside', icon: MessageCircleQuestion, label: t('chatHeader.viewAside') }
    : { action: 'sideQuestion', icon: MessageCircleQuestion, label: t('chatHeader.sideQuestion') },
  { action: 'context', icon: ChartPie, label: t('chatHeader.contextUsage'), hint: '/context' },
  { action: 'usage', icon: Gauge, label: t('chatHeader.subscriptionUsage'), hint: '/usage' },
  { action: 'stats', icon: ChartLine, label: t('chatHeader.usageStatistics'), hint: '/stats' },
]);
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger
      class="d-tool-btn w-7.5 px-0"
      :title="t('chatHeader.more')"
      :aria-label="t('chatHeader.more')"
      data-testid="chat-header-more"
    >
      <Ellipsis
        class="size-4"
        aria-hidden="true"
      />
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="end"
      :side-offset="remPx(0.375)"
      :class="['w-59', MENU_CONTENT]"
      data-testid="chat-header-more-menu"
    >
      <template v-if="folded.length > 0">
        <DropdownMenuItem
          v-for="item in folded"
          :key="item.action"
          :class="MENU_ITEM"
          :disabled="item.disabled === true"
          :data-action="item.action"
          @select="emit('action', item.action)"
        >
          <component
            :is="item.icon"
            aria-hidden="true"
          />
          <span class="truncate">{{ item.label }}</span>
          <span
            v-if="item.hint"
            :class="MENU_HINT"
          >{{ item.hint }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator class="mx-1 my-1.25 bg-(--d-border)" />
      </template>
      <DropdownMenuItem
        v-for="item in always"
        :key="item.action"
        :class="MENU_ITEM"
        :data-action="item.action"
        @select="emit('action', item.action)"
      >
        <component
          :is="item.icon"
          aria-hidden="true"
        />
        <span class="truncate">{{ item.label }}</span>
        <span
          v-if="item.hint"
          :class="MENU_HINT"
        >{{ item.hint }}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
