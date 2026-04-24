<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { ListboxRoot, ListboxItem, ListboxContent } from 'reka-ui';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import PermissionDestinationPicker from './PermissionDestinationPicker.vue';
import { isShellTool } from '@shared/tool-names';
import type { PermissionUpdate, PermissionUpdateDestination } from '@shared/types/permissions';

const { t } = useI18n();

const props = defineProps<{
  visible: boolean;
  toolUseId: string;
  toolName?: string;
  filePath?: string;
  originalContent?: string;
  proposedContent?: string;
  command?: string;
  agentDescription?: string;
  queuePosition?: number;
  queueTotal?: number;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
}>();

const emit = defineEmits<{
  (e: 'approve', approved: boolean, options?: { acceptAll?: boolean; customMessage?: string; updatedPermissions?: PermissionUpdate[] }): void;
}>();

const showCustomInput = ref(false);
const customMessage = ref('');
const selectedValue = ref<string>('yes');
const listboxRef = ref<InstanceType<typeof ListboxRoot> | null>(null);
const textareaRef = ref<{ $el?: HTMLElement } | null>(null);
const showDestinationPicker = ref(false);
const pendingSuggestion = ref<PermissionUpdate | null>(null);
const pendingBehavior = ref<'allow' | 'deny'>('allow');

const isShell = computed(() => isShellTool(props.toolName ?? ''));
const isNewFile = computed(() => !props.originalContent);

const actionLabel = computed(() => {
  if (props.agentDescription) {
    if (isShell.value) return t('permission.runCommandAgent', { agent: props.agentDescription });
    if (isNewFile.value) return t('permission.createFileAgent', { agent: props.agentDescription });
    return t('permission.editFileAgent', { agent: props.agentDescription });
  }
  if (isShell.value) return t('permission.runCommand');
  if (isNewFile.value) return t('permission.createFile');
  return t('permission.editFile');
});

const suggestionLabel = computed(() => {
  if (!props.suggestions?.length) return null;
  const first = props.suggestions.find(s => s.type === 'addRules' && s.behavior === 'allow');
  if (!first || first.type !== 'addRules' || !first.rules[0]) return null;
  const rule = first.rules[0];
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
});

const options = computed(() => {
  const base: Array<{ value: string; label: string; shortcut: string | null }> = [
    { value: 'yes', label: t('permission.options.yes'), shortcut: '1' },
    { value: 'yes-accept-all', label: t('permission.options.yesAcceptAll'), shortcut: '2' },
  ];

  if (suggestionLabel.value) {
    base.push({
      value: 'always-allow',
      label: t('permission.options.alwaysAllow', { pattern: suggestionLabel.value }),
      shortcut: '3',
    });
    base.push({
      value: 'no',
      label: t('permission.options.no'),
      shortcut: '4',
    });
    base.push({
      value: 'always-deny',
      label: t('permission.options.alwaysDeny', { pattern: suggestionLabel.value }),
      shortcut: '5',
    });
  } else {
    base.push({
      value: 'no',
      label: t('permission.options.no'),
      shortcut: '3',
    });
  }

  base.push({ value: 'custom', label: t('permission.options.customMessage'), shortcut: null });

  return base;
});

function handleSelect(value: string) {
  switch (value) {
    case 'yes':
      emit('approve', true);
      resetState();
      break;
    case 'yes-accept-all':
      emit('approve', true, { acceptAll: true });
      resetState();
      break;
    case 'always-allow':
      if (props.suggestions?.length) {
        const suggestion = props.suggestions.find(s => s.type === 'addRules' && s.behavior === 'allow');
        if (suggestion) {
          pendingSuggestion.value = JSON.parse(JSON.stringify(suggestion));
          pendingBehavior.value = 'allow';
          showDestinationPicker.value = true;
        }
      }
      break;
    case 'always-deny':
      if (props.suggestions?.length) {
        const suggestion = props.suggestions.find(s => s.type === 'addRules' && s.behavior === 'allow');
        if (suggestion) {
          pendingSuggestion.value = JSON.parse(JSON.stringify(suggestion));
          pendingBehavior.value = 'deny';
          showDestinationPicker.value = true;
        }
      }
      break;
    case 'no':
      emit('approve', false);
      resetState();
      break;
    case 'custom':
      showCustomInput.value = true;
      nextTick(() => {
        textareaRef.value?.$el?.focus();
      });
      break;
  }
}

function handleCustomSubmit() {
  if (customMessage.value.trim()) {
    emit('approve', false, { customMessage: customMessage.value.trim() });
    resetState();
  }
}

function handleCustomBack() {
  showCustomInput.value = false;
  customMessage.value = '';
  nextTick(() => {
    (listboxRef.value?.$el as HTMLElement)?.focus();
  });
}

function resetState() {
  showCustomInput.value = false;
  customMessage.value = '';
  selectedValue.value = 'yes';
  showDestinationPicker.value = false;
  pendingSuggestion.value = null;
  pendingBehavior.value = 'allow';
}

function handleDestinationSelect(destination: PermissionUpdateDestination) {
  if (pendingSuggestion.value && pendingSuggestion.value.type === 'addRules') {
    const updatedSuggestion: PermissionUpdate = {
      ...pendingSuggestion.value,
      behavior: pendingBehavior.value,
      destination,
    };
    const approved = pendingBehavior.value === 'allow';
    emit('approve', approved, { updatedPermissions: [updatedSuggestion] });
  }
  resetState();
}

function handleDestinationCancel() {
  showDestinationPicker.value = false;
  pendingSuggestion.value = null;
}

function handleKeydown(e: KeyboardEvent) {
  if (showCustomInput.value || showDestinationPicker.value) return;

  const shortcutMap: Record<string, string> = suggestionLabel.value
    ? { '1': 'yes', '2': 'yes-accept-all', '3': 'always-allow', '4': 'no', '5': 'always-deny' }
    : { '1': 'yes', '2': 'yes-accept-all', '3': 'no' };

  if (shortcutMap[e.key]) {
    e.preventDefault();
    handleSelect(shortcutMap[e.key]);
  }
}

watch(() => props.visible, (visible) => {
  if (visible) {
    resetState();
    nextTick(() => {
      (listboxRef.value?.$el as HTMLElement)?.focus();
    });
  }
});
</script>

<template>
  <div
    v-if="visible"
    class="border-t border-border bg-background"
    role="region"
    aria-label="Permission request"
  >
    <!-- Header with queue indicator -->
    <div v-if="queueTotal && queueTotal > 1" class="px-4 pt-2 flex items-center justify-end">
      <span class="text-xs text-muted-foreground">
        {{ t('permission.queuePosition', { position: queuePosition, total: queueTotal }) }}
      </span>
    </div>

    <!-- Header question -->
    <div class="px-4 py-3 text-sm text-foreground">
      <template v-if="isShell">
        <div>{{ actionLabel }}</div>
        <div class="mt-2 p-2 bg-card rounded font-mono text-xs text-primary break-all whitespace-pre-wrap">{{ command }}</div>
      </template>
      <template v-else>
        <div class="flex items-baseline gap-1 flex-wrap">
          <span>{{ actionLabel }}</span>
          <span class="text-muted-foreground break-all">{{ filePath }}</span>?
        </div>
      </template>
      <div v-if="decisionReason || blockedPath" class="mt-1.5 text-xs text-muted-foreground space-y-0.5">
        <div v-if="decisionReason">{{ decisionReason }}</div>
        <div v-if="blockedPath" class="font-mono break-all">{{ blockedPath }}</div>
      </div>
    </div>

    <!-- Options list using Reka UI Listbox -->
    <ListboxRoot
      v-if="!showCustomInput"
      ref="listboxRef"
      v-model="selectedValue"
      class="flex flex-col outline-none"
      orientation="vertical"
      @keydown="handleKeydown"
    >
      <ListboxContent>
        <ListboxItem
          v-for="option in options"
          :key="option.value"
          :value="option.value"
          class="flex items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors cursor-pointer outline-none data-highlighted:bg-primary data-highlighted:text-primary-foreground data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground hover:bg-card"
          :class="option.value === 'custom' ? 'border-t border-border/30 text-muted-foreground' : 'text-foreground'"
          @select="handleSelect(option.value)"
        >
          <span v-if="option.shortcut" class="font-medium w-4">{{ option.shortcut }}</span>
          <span v-else class="w-4" />
          <span>{{ option.label }}</span>
        </ListboxItem>
      </ListboxContent>
    </ListboxRoot>

    <!-- Custom input mode -->
    <div v-else class="px-4 pb-4">
      <Textarea
        ref="textareaRef"
        v-model="customMessage"
        class="min-h-20 bg-card border-border resize-none focus:border-primary mb-3 max-h-32"
        :placeholder="t('permission.customPlaceholder')"
        @keydown.enter.ctrl="handleCustomSubmit"
        @keydown.escape="handleCustomBack"
      />
      <div class="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          @click="handleCustomBack"
        >
          {{ t('common.back') }}
        </Button>
        <Button
          size="sm"
          :disabled="!customMessage.trim()"
          @click="handleCustomSubmit"
        >
          {{ t('permission.sendToClaude') }}
        </Button>
      </div>
    </div>

    <!-- Destination Picker for "Always Allow" / "Always Deny" -->
    <PermissionDestinationPicker
      :open="showDestinationPicker"
      :pattern="suggestionLabel ?? ''"
      :behavior="pendingBehavior"
      @select="handleDestinationSelect"
      @cancel="handleDestinationCancel"
    />
  </div>
</template>
