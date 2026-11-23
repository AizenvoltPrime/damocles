<script setup lang="ts">
import { Comment, Fragment, Text, Transition, h, inject, type Component, type FunctionalComponent, type VNode } from 'vue';
import { useI18n } from 'vue-i18n';
import { ShieldBan } from 'lucide-vue-next';
import type { ToolAbandonReason, ToolCall } from '@shared/types/session';
import { formatToolDuration, toolHookStatus, useToolCardStatus, useToolStatusNote } from '@/composables/useToolCardStatus';
import { IN_TRANSCRIPT } from '@/composables/transcript-scope';

/**
 * The reference's tool card (Chat Panel.dc.html m.isTool): a 36px row with the tile, the name, a mono argument,
 * optional meta, the status icon and trailing controls, over the card's own body. An `expandable` card emits
 * `expand` on a click anywhere on it and on Enter or Space on the name, its keyboard target. In a row of the main transcript
 * the card sits in a transcript scope root, and its data-tool-card, data-tool, data-tool-status and data-part attributes are
 * the hooks docs/themes.md promises theme CSS.
 */
defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  /** The tool's own name (`Bash`, `ThemeSet`), never the shown one: theme CSS selects on it. */
  tool: string;
  icon: Component;
  name: string;
  arg?: string | undefined;
  /** The argument's tooltip, such as the full path behind a folder-relative one; defaults to `arg`. */
  argTitle?: string | undefined;
  status: ToolCall['status'];
  expandable?: boolean;
  /** The icon tile's tint and color. */
  tileClass?: string;
  /** pi's measured `execute()` time, shown after the meta; absent for a call that never ran. */
  durationMs?: number | undefined;
  /** Shows the note for a call that never ran, was cancelled or has no recorded outcome, under the card's body. */
  statusNote?: boolean;
  abandonReason?: ToolAbandonReason | undefined;
}>(), { expandable: false, tileClass: 'bg-(--d-accent-soft) text-(--d-accent)', statusNote: false });

const emit = defineEmits<{
  (e: 'expand'): void;
}>();

const { t } = useI18n();
const { statusIcon, statusIconKind, statusClass, cardClass } = useToolCardStatus(() => props.status);
const note = useToolStatusNote(() => props.status, () => props.abandonReason);
const inTranscript = inject(IN_TRANSCRIPT, false);

// A Transition is read through to its child: around a false v-if it renders nothing.
function hasContent(nodes: readonly VNode[]): boolean {
  return nodes.some((node) => {
    if (node.type === Comment) return false;
    if (node.type === Transition) return hasContent((node.children as { default?: () => VNode[] } | null)?.default?.() ?? []);
    if (node.type === Text) return typeof node.children === 'string' && node.children.trim() !== '';
    if (node.type === Fragment) return Array.isArray(node.children) && hasContent(node.children as VNode[]);
    return true;
  });
}

// A caller's default slot always exists once it holds a v-if, so the body part is drawn from what the slot renders.
const CardBody: FunctionalComponent = (_props, { slots }) => {
  const nodes = slots.default?.() ?? [];
  return hasContent(nodes) ? h('div', { 'data-part': 'body' }, nodes) : undefined;
};

function handleCardClick(): void {
  if (props.expandable) emit('expand');
}

function handleNameKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  emit('expand');
}
</script>

<template>
  <!-- The scope root wraps the card with the same box: theme CSS reaches only a root's descendants, and the hooks are on the
       card, which also takes the caller's attributes. -->
  <div :data-theme-scope="inTranscript ? 'transcript' : undefined">
    <div
      class="overflow-hidden rounded-11 border bg-(--surface-card) text-13 transition-[border-color,opacity] duration-300"
      :class="cardClass"
      data-tool-card
      :data-tool="tool"
      :data-tool-status="toolHookStatus(status)"
      data-testid="tool-card-frame"
      v-bind="$attrs"
      @click="handleCardClick"
    >
      <div
        class="flex h-9 w-full min-w-0 items-center gap-2.5 pr-2.5 pl-2"
        :class="expandable && 'cursor-pointer transition-colors hover:bg-(--d-hover)'"
        data-part="header"
      >
        <span
          class="flex size-5.5 flex-none items-center justify-center rounded-md"
          :class="tileClass"
          aria-hidden="true"
          data-part="tile"
        >
          <component
            :is="icon"
            class="size-3"
          />
        </span>
        <!-- The name, not the card, takes role="button": on the card it would hide the Stop button from assistive tech. -->
        <span
          v-if="expandable"
          role="button"
          tabindex="0"
          aria-haspopup="dialog"
          :aria-label="t('toolCall.expandDetails', { name })"
          class="max-w-[60%] flex-none truncate rounded-sm text-12.5 font-semibold focus-visible:outline-2 focus-visible:outline-(--d-accent-fill)"
          @keydown="handleNameKeydown"
        >{{ name }}</span>
        <span
          v-else
          class="max-w-[60%] flex-none truncate text-12.5 font-semibold"
        >{{ name }}</span>
        <span
          class="flex min-w-0 flex-1"
          data-part="summary"
        >
          <slot name="arg">
            <span
              class="min-w-0 flex-1 truncate font-mono text-11.5 text-(--d-muted)"
              :title="argTitle ?? arg"
            >{{ arg }}</span>
          </slot>
        </span>
        <slot name="meta" />
        <span
          v-if="durationMs !== undefined"
          class="flex-none font-mono text-10.5 text-(--d-faint)"
          data-testid="tool-card-duration"
        >{{ formatToolDuration(durationMs) }}</span>
        <span
          v-if="status === 'awaiting_approval'"
          class="flex flex-none items-center gap-1.25 rounded-full bg-[color-mix(in_srgb,var(--d-warning-fill)_13%,transparent)] py-px pr-2 pl-1.5 text-11 font-medium text-(--d-warning-text)"
        >
          <span
            class="d-pulsing size-1.5 rounded-full bg-(--d-warning-fill)"
            aria-hidden="true"
          />{{ t('toolCall.awaitingApproval') }}
        </span>
        <!-- A card whose outcome the status cannot express (an answer in the warning tone) puts its own mark here. -->
        <slot name="status">
          <Transition
            name="t-badge"
            mode="out-in"
          >
            <!-- Rule 10: a policy block, D62's isolation included, reads "Blocked" rather than a rejection. -->
            <span
              v-if="status === 'blocked'"
              class="flex h-4.5 flex-none items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--d-warning-fill)_16%,transparent)] px-1.5 text-10.5 font-medium text-(--d-warning-text)"
              data-testid="tool-card-blocked"
            >
              <ShieldBan
                class="size-2.75"
                aria-hidden="true"
              />{{ t('toolOverlay.statusBlocked') }}
            </span>
            <!-- The wrapper takes the badge's animation: on the spinning icon itself, its endless spin would replace it. -->
            <span
              v-else
              :key="statusIconKind"
              class="flex flex-none"
              data-testid="tool-card-status-icon"
            >
              <component
                :is="statusIcon"
                class="size-3.5 flex-none"
                :class="statusClass"
                aria-hidden="true"
              />
            </span>
          </Transition>
        </slot>
        <slot name="trailing" />
      </div>
      <CardBody><slot /></CardBody>
      <div
        v-if="statusNote && note"
        class="flex items-start gap-2 border-t border-(--d-border) px-3 py-2 text-xs text-(--d-muted)"
        data-testid="tool-card-status-note"
      >
        <component
          :is="note.icon"
          class="mt-px size-3.25 flex-none text-(--d-faint)"
          aria-hidden="true"
        />
        <span><span class="font-semibold text-(--d-text)">{{ note.title }}</span><template v-if="note.description"> · {{ note.description }}</template></span>
      </div>
    </div>
  </div>
</template>
