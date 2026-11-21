<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconFolder, IconLoader, IconTerminal } from '@/components/icons';
import type { AssetWithheld, SlashMenuRow, WithheldRootInfo } from '@shared/types/commands';
import type { SteerTargetInfo } from '@shared/types/subagents';
import { highlightFirstMatch } from '@/utils/highlightMatches';
import { subagentTypeLabelKey } from '@/utils/subagentTypeLabel';

const { t, te } = useI18n();
const listLabel = computed(() => (props.mode === 'agent' ? t('composer.agentList') : t('composer.commandList')));

const props = defineProps<{
  isOpen: boolean;
  /** The listbox id the composer's textarea names in aria-controls; option ids derive from it. */
  listId: string;
  commands: SlashMenuRow[];
  selectedIndex: number;
  anchorElement: HTMLElement | null;
  query: string;
  isLoading: boolean;
  mode: 'command' | 'agent';
  agents: SteerTargetInfo[];
  /** Why the unavailable row the user tried to pick cannot run, announced politely. */
  inactiveReason?: AssetWithheld | null;
}>();

const emit = defineEmits<{
  select: [index: number];
  close: [];
  'update:selectedIndex': [index: number];
}>();

const popupRef = ref<HTMLDivElement | null>(null);
const itemRefs = ref<(HTMLDivElement | null)[]>([]);
const popupStyle = ref<Record<string, string>>({});

function updatePosition() {
  if (!props.anchorElement) {
    popupStyle.value = {};
    return;
  }

  const rect = props.anchorElement.getBoundingClientRect();

  popupStyle.value = {
    position: 'fixed',
    bottom: `calc(${window.innerHeight - rect.top}px + 0.5rem)`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
  };
}

watch(() => props.isOpen, (isOpen) => {
  if (isOpen) {
    updatePosition();
    window.addEventListener('resize', updatePosition);
  } else {
    window.removeEventListener('resize', updatePosition);
  }
}, { immediate: true });

watch(() => props.selectedIndex, (newIndex) => {
  const item = itemRefs.value[newIndex];
  if (item) {
    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
});

function handleClickOutside(event: MouseEvent) {
  if (popupRef.value && !popupRef.value.contains(event.target as Node)) {
    emit('close');
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  window.removeEventListener('resize', updatePosition);
});

function highlightMatch(text: string): string {
  return highlightFirstMatch(text, props.query);
}

function isRoot(row: SlashMenuRow): row is WithheldRootInfo {
  return 'kind' in row && row.kind === 'withheldRoot';
}

function rowKey(row: SlashMenuRow): string {
  return isRoot(row) ? `${row.source}:${row.folder}/${row.assets}` : row.name;
}

/** A withheld folder's name: its source folder, what it holds, and its scope. */
function rootLabel(row: WithheldRootInfo): string {
  const scopeKey = `slashCommand.scope.${row.source}`;
  const scope = te(scopeKey) ? t(scopeKey) : row.source;
  const key = `slashCommand.withheldRoot.${row.assets}`;
  // a newer host's core may send a kind of folder this webview has no text for
  return te(key) ? t(key, { folder: row.folder, scope }) : `${row.folder} ${row.assets}, ${scope}`;
}

function isUntrusted(command: SlashMenuRow): boolean {
  // `BuiltinSlashCommandInfo` carries no `untrusted` field, so narrow the union before reading it.
  return command.source !== 'builtin' && command.untrusted === true;
}

function withheldOf(command: SlashMenuRow): AssetWithheld | undefined {
  return 'withheld' in command ? command.withheld : undefined;
}

/** A row that can neither run nor ask for trust; a `linkOutside` row stays active, as activating it asks for trust. */
function isInert(command: SlashMenuRow): boolean {
  const withheld = withheldOf(command);
  return withheld !== undefined && withheld.reason !== 'linkOutside';
}

function withheldText(withheld: AssetWithheld): string {
  switch (withheld.reason) {
    case 'broken':
      return t('slashCommand.withheld.broken', { target: withheld.target });
    case 'invalidFrontmatter':
      return t('slashCommand.withheld.invalidFrontmatter', { detail: withheld.detail });
    default: {
      const key = `slashCommand.withheld.${withheld.reason}`;
      // a newer host's core may send a reason this webview has no text for
      return te(key) ? t(key) : withheld.reason;
    }
  }
}

/** The row's second line: why it is withheld, else its description. */
function descriptionOf(command: SlashMenuRow): string {
  if (isRoot(command)) return withheldText(command.withheld);
  const withheld = withheldOf(command);
  return withheld === undefined ? command.description : withheldText(withheld);
}

function argumentHint(command: SlashMenuRow): string | null {
  // `SkillInfo` carries no `argumentHint`, so narrow the union before reading it.
  return 'argumentHint' in command ? command.argumentHint ?? null : null;
}

function getSourceBadge(command: SlashMenuRow): string | null {
  if (command.source === 'builtin') return null;
  if (command.untrusted) {
    return t('slashCommand.untrustedBadge');
  }
  // a withheld folder's label names its scope
  if (command.source === 'user' && !isRoot(command)) {
    return 'user';
  }
  return null;
}

function agentBadge(agent: SteerTargetInfo): string {
  if (agent.kind === 'team-member') return t(`steerCommand.role.${agent.role}`);
  const key = subagentTypeLabelKey(agent.agentType);
  return key ? t(key) : agent.agentType;
}

function agentLabel(agent: SteerTargetInfo): string {
  return agent.kind === 'team-member' ? `${agent.teamTitle} · ${agent.memberName}` : agent.description;
}

/** A queued subagent or an idle team member shows a hollow dot; one mid-turn pulses. */
function isActive(agent: SteerTargetInfo): boolean {
  return agent.status === 'running';
}

function agentStatusText(agent: SteerTargetInfo): string | null {
  return agent.kind === 'team-member' ? t(`team.status.${agent.status}`) : null;
}
</script>

<template>
  <Teleport to="body">
    <Transition name="t-pop-top">
      <div
        v-if="isOpen"
        ref="popupRef"
        :style="popupStyle"
        class="z-50 flex max-h-80 origin-bottom flex-col overflow-hidden rounded-xl border border-(--d-border2) bg-(--d-card) text-(--d-text) shadow-(--d-shadow)"
      >
        <div class="flex-1 min-h-0 overflow-y-auto">
          <div
            :id="listId"
            class="p-1"
            role="listbox"
            :aria-label="listLabel"
          >
            <!-- Loading State -->
            <div
              v-if="isLoading"
              class="flex items-center justify-center gap-2 px-3 py-4 text-12.5 text-(--d-muted)"
            >
              <IconLoader
                class="size-4 d-spinning text-(--d-accent)"
              />
              <span>{{ mode === 'agent' ? t('steerCommand.loadingAgents') : t('slashCommand.loading') }}</span>
            </div>

            <!-- Agent Mode -->
            <template v-else-if="mode === 'agent'">
              <!-- Agent Empty State -->
              <div
                v-if="agents.length === 0"
                class="px-3 py-4 text-center text-12.5 text-(--d-muted)"
              >
                {{ t('steerCommand.noAgents') }}
              </div>

              <!-- Agent List -->
              <div
                v-for="(agent, index) in agents"
                v-else
                :id="`${listId}-${index}`"
                :key="agent.id"
                :ref="el => itemRefs[index] = el as HTMLDivElement"
                class="flex min-h-8.5 cursor-pointer items-center gap-2.25 rounded-lg px-2.25 py-1.25 text-12.5 transition-colors duration-75"
                :class="index === selectedIndex ? 'bg-(--d-accent-soft)' : ''"
                role="option"
                :aria-selected="index === selectedIndex"
                @click="emit('select', index)"
                @mouseenter="$emit('update:selectedIndex', index)"
              >
                <!-- Status dot -->
                <span
                  class="shrink-0 size-2 rounded-full"
                  :class="isActive(agent)
                    ? 'bg-(--d-accent) animate-[d-pulse_1.4s_ease-in-out_infinite]'
                    : 'border border-(--d-warning)'"
                  aria-hidden="true"
                />

                <!-- Agent info -->
                <div class="flex-1 min-w-0 flex flex-col">
                  <div class="flex items-center gap-2">
                    <span
                      class="shrink-0 rounded-5 border border-(--d-border) bg-(--d-hover) px-1.5 text-10.5/4.25 text-(--d-muted)"
                    >
                      {{ agentBadge(agent) }}
                    </span>
                    <span class="truncate">{{ agentLabel(agent) }}</span>
                  </div>
                  <span class="text-xs text-(--d-muted)">
                    <span class="font-mono">{{ agent.id.slice(0, 8) }}</span>
                    <span v-if="agentStatusText(agent)"> · {{ agentStatusText(agent) }}</span>
                  </span>
                </div>
              </div>
            </template>

            <!-- Command Empty State -->
            <div
              v-else-if="commands.length === 0"
              class="px-3 py-4 text-center text-12.5 text-(--d-muted)"
            >
              <div class="mb-1">
                {{ t('slashCommand.noMatches') }}
              </div>
              <div class="text-xs opacity-70">
                {{ t('slashCommand.createHint') }}
              </div>
            </div>

            <!-- Command List -->
            <div
              v-for="(cmd, index) in commands"
              v-else
              :id="`${listId}-${index}`"
              :key="rowKey(cmd)"
              :ref="el => itemRefs[index] = el as HTMLDivElement"
              class="flex min-h-8.5 cursor-pointer items-center gap-2.25 rounded-lg px-2.25 py-1.25 text-12.5 transition-colors duration-75 data-disabled:cursor-default data-disabled:opacity-50"
              :class="index === selectedIndex ? 'bg-(--d-accent-soft)' : ''"
              role="option"
              :aria-selected="index === selectedIndex"
              :aria-disabled="isInert(cmd) || undefined"
              :data-disabled="isInert(cmd) ? '' : undefined"
              @click="emit('select', index)"
              @mouseenter="$emit('update:selectedIndex', index)"
            >
              <!-- Icon -->
              <IconFolder
                v-if="isRoot(cmd)"
                class="size-4 shrink-0 text-(--d-accent)"
              />
              <IconTerminal
                v-else
                class="size-4 shrink-0 text-(--d-accent)"
              />

              <!-- Command info -->
              <div class="flex-1 min-w-0 flex flex-col">
                <div class="flex items-center gap-2">
                  <!-- A withheld folder's name, or the command name -->
                  <span
                    v-if="isRoot(cmd)"
                    data-row-label
                    class="font-medium"
                  >{{ rootLabel(cmd) }}</span>
                  <!-- eslint-disable vue/no-v-html -- highlightMatch escapes the text with escapeHtml -->
                  <span
                    v-else
                    class="font-mono font-medium"
                    v-html="'/' + highlightMatch(cmd.name)"
                  />
                  <!-- eslint-enable vue/no-v-html -->
                  <!-- Argument hint -->
                  <span
                    v-if="argumentHint(cmd)"
                    class="text-xs font-mono"
                    :class="index === selectedIndex ? 'text-(--d-faint-text)' : 'text-(--d-faint)'"
                  >
                    {{ argumentHint(cmd) }}
                  </span>
                  <!-- Source badge -->
                  <span
                    v-if="getSourceBadge(cmd)"
                    class="rounded-5 border px-1.5 text-10.5/4.25"
                    :class="isUntrusted(cmd)
                      ? 'border-(--d-warning) text-(--d-warning-text)'
                      : 'border-(--d-border) bg-(--d-hover) text-(--d-muted)'"
                  >
                    {{ getSourceBadge(cmd) }}
                  </span>
                </div>
                <!-- Description, or why the row is withheld; part of the option's text, so a screen reader reads it -->
                <span
                  class="text-xs truncate"
                  :class="withheldOf(cmd) ? 'text-(--d-warning-text)' : 'text-(--d-muted)'"
                >
                  {{ descriptionOf(cmd) }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- an unavailable option stays focusable but picks nothing, so a picking key reports its reason here (a status message) -->
        <p
          class="sr-only"
          aria-live="polite"
        >
          {{ inactiveReason ? withheldText(inactiveReason) : '' }}
        </p>

        <div
          class="flex items-center gap-3.5 border-t border-(--d-border) bg-(--d-panel) px-3 py-1.75 text-11 text-(--d-faint)"
          aria-hidden="true"
        >
          <span class="flex items-center gap-1"><kbd class="rounded-md border border-(--d-border) bg-(--d-card) px-1.5 py-px font-mono text-10.5">↑↓</kbd>{{ t('composer.acNavigate') }}</span>
          <span class="flex items-center gap-1"><kbd class="rounded-md border border-(--d-border) bg-(--d-card) px-1.5 py-px font-mono text-10.5">Tab</kbd>{{ t('composer.acSelect') }}</span>
          <span class="flex items-center gap-1"><kbd class="rounded-md border border-(--d-border) bg-(--d-card) px-1.5 py-px font-mono text-10.5">Esc</kbd>{{ t('composer.acClose') }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
