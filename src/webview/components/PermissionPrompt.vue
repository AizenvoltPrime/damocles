<script setup lang="ts">
import { ref, computed, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { ListboxRoot, ListboxItem } from 'reka-ui';
import DockPromptOptions from './DockPromptOptions.vue';
import { FilePlus, ImagePlus, MessageSquare, PencilLine, SquareTerminal, Wrench } from 'lucide-vue-next';
import PermissionDestinationPicker from './PermissionDestinationPicker.vue';
import { isShellTool, TOOL_EDIT, TOOL_GENERATE_IMAGE, TOOL_WRITE } from '@shared/tool-names';
import type { PermissionUpdate, PermissionUpdateDestination } from '@shared/types/permissions';
import type { FilePatchOmitted } from '@shared/types/file-patch';
import { buildFileDiff, fileChangeSource } from '@/utils/parseUnifiedDiff';
import { useDockPromptDigits } from '@/composables/useDockPrompt';
import { useFolderRelativePath } from '@/composables/useFolderRelativePath';
import { useDiffStore } from '@/stores/useDiffStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { useSettingsStore } from '@/stores/useSettingsStore';

const { t } = useI18n();
const displayPath = useFolderRelativePath();
const diffStore = useDiffStore();
const editorStore = useEditorStore();
const settingsStore = useSettingsStore();

const props = defineProps<{
  visible: boolean;
  toolUseId: string;
  toolName?: string | undefined;
  toolInput?: Record<string, unknown> | undefined;
  filePath?: string | undefined;
  prompt?: string | undefined;
  imageModel?: string | undefined;
  patch?: string | undefined;
  patchOmitted?: FilePatchOmitted | undefined;
  command?: string | undefined;
  agentDescription?: string | undefined;
  queuePosition?: number | undefined;
  queueTotal?: number | undefined;
  suggestions?: PermissionUpdate[] | undefined;
  blockedPath?: string | undefined;
  decisionReason?: string | undefined;
}>();

const emit = defineEmits<{
  (e: 'approve', approved: boolean, options?: { acceptAll?: boolean; customMessage?: string; updatedPermissions?: PermissionUpdate[] }): void;
}>();

type OptionValue = 'yes' | 'yes-accept-all' | 'always-allow' | 'no' | 'always-deny';

const customMessage = ref('');
const selectedValue = ref<OptionValue>('yes');
const showDestinationPicker = ref(false);
const pendingSuggestion = ref<PermissionUpdate | null>(null);
const pendingBehavior = ref<'allow' | 'deny'>('allow');

const isShell = computed(() => isShellTool(props.toolName ?? ''));
const isGenerateImage = computed(() => props.toolName === TOOL_GENERATE_IMAGE);
const isFileChange = computed(() => props.toolName === TOOL_EDIT || props.toolName === TOOL_WRITE);
// The card of the call this prompt approves reads the same source, so both show the same lines and numbers.
const diffSource = computed(() => (isFileChange.value
  ? fileChangeSource(
    { name: props.toolName ?? '', input: props.toolInput ?? {}, status: 'awaiting_approval' },
    {
      ...(props.patch !== undefined ? { patch: props.patch } : {}),
      ...(props.patchOmitted !== undefined ? { patchOmitted: props.patchOmitted } : {}),
    },
  )
  : null));
const isNewFile = computed(() => diffSource.value?.kind === 'newFile');
// Any tool without its own view, such as a Read an ask rule names, shows its name and input.
const isGeneric = computed(() => !isShell.value && !isGenerateImage.value && !isFileChange.value);

const kindIcon = computed<Component>(() => {
  if (isShell.value) return SquareTerminal;
  if (isGenerateImage.value) return ImagePlus;
  if (isGeneric.value) return Wrench;
  return isNewFile.value ? FilePlus : PencilLine;
});

const title = computed(() => {
  if (isShell.value) return t('permission.runCommand');
  if (isGenerateImage.value) return t('permission.generateImage');
  if (isGeneric.value) return t('permission.useTool', { tool: props.toolName });
  return isNewFile.value ? t('prompts.permission.allowCreate') : t('prompts.permission.allowEdit');
});

const agentLine = computed(() => {
  const agent = props.agentDescription;
  if (!agent) return null;
  if (isShell.value) return t('permission.runCommandAgent', { agent });
  if (isGeneric.value) return t('permission.useToolAgent', { agent, tool: props.toolName });
  if (isGenerateImage.value || isNewFile.value) return t('permission.createFileAgent', { agent });
  return t('permission.editFileAgent', { agent });
});

const lineDelta = computed(() => {
  if (!diffSource.value) return null;
  const diff = buildFileDiff(diffSource.value);
  if (diff.omitted) return null;
  const { added, removed } = diff.stats;
  if (isNewFile.value) return t('prompts.permission.newLines', { n: added }, added);
  return removed > 0
    ? t('prompts.permission.changedLines', { added, removed })
    : t('prompts.permission.addedLines', { n: added }, added);
});

// A generic tool's title already names it, so it has no subtitle.
function subtitleWith(path: string | undefined): string {
  if (isShell.value) return props.command ?? '';
  if (isGeneric.value) return '';
  return [path, lineDelta.value].filter(Boolean).join(' · ');
}

const subtitle = computed(() => subtitleWith(props.filePath === undefined ? undefined : displayPath(props.filePath)));
// The tooltip names the full path, so a relative label never hides where the write lands.
const subtitleTitle = computed(() => subtitleWith(props.filePath));

const canOpenDiff = computed(() => diffSource.value !== null && props.filePath !== undefined);

// On desktop Open diff shows the Monaco proposal the host sent for this card.
function openDiff() {
  if (!props.filePath || !diffSource.value) return;
  if (settingsStore.hostCapabilities.monaco && editorStore.openProposal(props.toolUseId)) return;
  diffStore.expandDiff({
    filePath: props.filePath,
    tool: props.toolName === TOOL_WRITE ? 'Write' : 'Edit',
    source: diffSource.value,
  });
}

const suggestionLabel = computed(() => {
  if (!props.suggestions?.length) return null;
  const first = props.suggestions.find(s => s.type === 'addRules' && s.behavior === 'allow');
  if (!first || first.type !== 'addRules' || !first.rules[0]) return null;
  const rule = first.rules[0];
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
});

const options = computed(() => {
  // `extraKey` is the aria-keyshortcuts name of the visible hint; the digit and hint stay out of the accessible name.
  const list: Array<{ value: OptionValue; label: string; hint?: string; extraKey?: string }> = [
    { value: 'yes', label: t('permission.options.yes'), hint: t('prompts.keys.enter'), extraKey: 'Enter' },
    { value: 'yes-accept-all', label: t('prompts.permission.yesAcceptAll') },
  ];
  if (suggestionLabel.value) list.push({ value: 'always-allow', label: t('permission.options.alwaysAllow', { pattern: suggestionLabel.value }) });
  list.push({ value: 'no', label: t('permission.options.no'), hint: t('prompts.keys.esc'), extraKey: 'Escape' });
  if (suggestionLabel.value) list.push({ value: 'always-deny', label: t('permission.options.alwaysDeny', { pattern: suggestionLabel.value }) });
  return list.map((option, index) => {
    const key = String(index + 1);
    return { ...option, key, shortcuts: option.extraKey ? `${key} ${option.extraKey}` : key };
  });
});

function handleSelect(value: OptionValue) {
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
    case 'always-deny': {
      const suggestion = props.suggestions?.find(s => s.type === 'addRules' && s.behavior === 'allow');
      if (suggestion) {
        pendingSuggestion.value = JSON.parse(JSON.stringify(suggestion));
        pendingBehavior.value = value === 'always-allow' ? 'allow' : 'deny';
        showDestinationPicker.value = true;
      }
      break;
    }
    case 'no':
      emit('approve', false);
      resetState();
      break;
  }
}

function handleCustomSubmit() {
  const message = customMessage.value.trim();
  if (!message) return;
  emit('approve', false, { customMessage: message });
  resetState();
}

function resetState() {
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
    emit('approve', pendingBehavior.value === 'allow', { updatedPermissions: [updatedSuggestion] });
  }
  resetState();
}

function handleDestinationCancel() {
  showDestinationPicker.value = false;
  pendingSuggestion.value = null;
}

const cardRef = ref<HTMLElement | null>(null);

useDockPromptDigits(cardRef, (digit) => {
  const option = showDestinationPicker.value ? undefined : options.value[digit - 1];
  if (!option) return false;
  handleSelect(option.value);
  return true;
});

function focusOptions() {
  cardRef.value?.querySelector<HTMLElement>('[role="listbox"]')?.focus();
}

watch(() => props.toolUseId, resetState);
</script>

<template>
  <section
    v-if="visible"
    ref="cardRef"
    class="overflow-hidden rounded-[0.875rem] border border-[color-mix(in_srgb,var(--d-warning)_45%,transparent)] bg-(--d-card) text-(--d-text) shadow-(--d-shadow)"
    role="region"
    :aria-label="t('permission.ariaLabel')"
    data-dock-prompt
    data-testid="permission-card"
  >
    <header class="flex items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-warning)_10%,transparent)] to-transparent px-3 py-2">
      <span
        class="d-ring flex size-6.5 flex-none items-center justify-center rounded-8 bg-[color-mix(in_srgb,var(--d-warning)_16%,transparent)] text-(--d-warning)"
        aria-hidden="true"
      >
        <component
          :is="kindIcon"
          class="size-3.5"
        />
      </span>
      <div class="min-w-0 flex-1">
        <div
          class="font-semibold"
          data-testid="permission-title"
        >
          {{ title }}
        </div>
        <div
          v-if="subtitle"
          class="truncate font-mono text-xs text-(--d-muted)"
          :title="subtitleTitle"
          data-testid="permission-subtitle"
        >
          {{ subtitle }}
        </div>
      </div>
      <span
        v-if="queueTotal && queueTotal > 1"
        class="flex-none rounded-full border border-(--d-border2) px-2 text-11/5 text-(--d-muted)"
      >
        {{ t('permission.queuePosition', { position: queuePosition, total: queueTotal }) }}
      </span>
      <button
        v-if="canOpenDiff"
        type="button"
        class="flex-none rounded-[0.375rem] px-1 text-xs whitespace-nowrap text-(--d-accent) hover:underline focus-visible:outline-2 focus-visible:outline-(--d-accent)"
        data-testid="permission-open-diff"
        @click="openDiff"
      >
        {{ t('prompts.permission.openDiff') }}
      </button>
    </header>

    <div
      v-if="agentLine || isShell || isGeneric || isGenerateImage || decisionReason || blockedPath"
      class="space-y-2 px-3 pt-2.5 text-12.5"
    >
      <div
        v-if="agentLine"
        class="text-(--d-muted)"
      >
        {{ agentLine }}
      </div>
      <div
        v-if="isShell"
        class="max-h-40 overflow-y-auto rounded-8 border border-(--d-border) bg-(--d-code) px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap"
      >
        {{ command }}
      </div>
      <div
        v-else-if="isGeneric"
        class="max-h-40 overflow-y-auto rounded-8 border border-(--d-border) bg-(--d-code) px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-(--d-accent)"
        role="region"
        tabindex="0"
        :aria-label="title"
        data-testid="tool-permission-input"
        v-text="JSON.stringify(toolInput ?? {}, null, 2)"
      />
      <template v-else-if="isGenerateImage">
        <div
          class="rounded-8 border border-(--d-border) bg-(--d-code) px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap"
          data-testid="image-permission-path"
        >
          {{ filePath }}
        </div>
        <div class="text-xs text-(--d-muted)">
          {{ t('permission.imagePrompt') }}
        </div>
        <div
          class="max-h-40 overflow-y-auto rounded-8 border border-(--d-border) bg-(--d-code) px-2.5 py-2 text-xs wrap-break-word whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-(--d-accent)"
          role="region"
          tabindex="0"
          :aria-label="t('permission.imagePrompt')"
          data-testid="image-permission-prompt"
        >
          {{ prompt }}
        </div>
        <div
          class="text-xs text-(--d-muted)"
          data-testid="image-permission-model"
        >
          {{ t('permission.imageModel') }} <span class="font-mono break-all text-(--d-text)">{{ imageModel }}</span>
        </div>
        <div
          class="text-xs text-(--d-muted)"
          data-testid="image-permission-billing"
        >
          {{ t('permission.imageBilled') }}
        </div>
      </template>
      <div
        v-if="decisionReason || blockedPath"
        class="space-y-0.5 text-xs text-(--d-muted)"
      >
        <div v-if="decisionReason">
          {{ decisionReason }}
        </div>
        <div
          v-if="blockedPath"
          class="font-mono break-all"
        >
          {{ blockedPath }}
        </div>
      </div>
    </div>

    <div class="px-1.5 pt-1 pb-1.5">
      <ListboxRoot
        v-model="selectedValue"
        class="group/list flex flex-col"
        orientation="vertical"
        data-testid="permission-options"
        @keydown.esc.prevent.stop="handleSelect('no')"
      >
        <DockPromptOptions :aria-label="title">
          <ListboxItem
            v-for="option in options"
            :key="option.value"
            :value="option.value"
            class="group flex items-center gap-2.5 rounded-9 px-2.5 py-1.25 transition-colors outline-none data-highlighted:bg-(--d-accent-soft) data-highlighted:text-(--d-accent-text) data-[state=checked]:bg-(--d-accent-soft) data-[state=checked]:text-(--d-accent-text) group-hover/list:data-[state=checked]:not-data-highlighted:bg-transparent group-hover/list:data-[state=checked]:not-data-highlighted:text-(--d-text)"
            :aria-keyshortcuts="option.shortcuts"
            :data-testid="`permission-option-${option.value}`"
            @select="handleSelect(option.value)"
          >
            <span
              class="flex size-5 flex-none items-center justify-center rounded-[0.375rem] border border-(--d-border2) font-mono text-11 group-data-highlighted:border-(--d-accent) group-data-[state=checked]:border-(--d-accent)"
              aria-hidden="true"
            >{{ option.key }}</span>
            <span class="min-w-0 flex-1 truncate font-medium">{{ option.label }}</span>
            <!-- Enter and Esc answer only while the options hold focus, so their hints show only then. -->
            <span
              v-if="option.hint"
              class="invisible flex-none text-11 text-(--d-faint) group-focus-within/list:visible group-data-highlighted:text-(--d-faint-text) group-data-[state=checked]:text-(--d-faint-text)"
              aria-hidden="true"
            >{{ option.hint }}</span>
          </ListboxItem>
        </DockPromptOptions>
      </ListboxRoot>

      <label class="mx-1 mt-0.75 mb-0.5 flex h-7.5 items-center gap-2 rounded-9 border border-(--d-border) bg-(--d-input) px-2.5 focus-within:border-(--d-accent)">
        <MessageSquare
          class="size-3.25 flex-none text-(--d-faint)"
          aria-hidden="true"
        />
        <span class="sr-only">{{ t('permission.options.customMessage') }}</span>
        <input
          v-model="customMessage"
          type="text"
          class="min-w-0 flex-1 border-0 bg-transparent text-12.5 text-(--d-text) outline-none placeholder:text-(--d-faint)"
          :placeholder="t('prompts.permission.feedbackPlaceholder')"
          data-testid="permission-feedback"
          @keydown.enter.prevent="handleCustomSubmit"
          @keydown.esc.stop="focusOptions"
        >
      </label>
    </div>

    <PermissionDestinationPicker
      :open="showDestinationPicker"
      :pattern="suggestionLabel ?? ''"
      :behavior="pendingBehavior"
      @select="handleDestinationSelect"
      @cancel="handleDestinationCancel"
    />
  </section>
</template>
