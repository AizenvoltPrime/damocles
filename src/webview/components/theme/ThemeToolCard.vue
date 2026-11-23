<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleCheck, CircleX, Eye, ImageOff, MessageSquare, Palette, History, Undo2 } from 'lucide-vue-next';
import type { ToolCall } from '@shared/types/session';
import { KEEP_CHANGES_MS, type ThemeOutcome } from '@shared/themes/agent';
import { parseThemeToolDetails } from '@shared/themes/tool-details';
import { TOOL_THEME_READ } from '@shared/tool-names';
import { isolated } from '@shared/bidi-isolate';
import { IsolatedText } from '../isolated-text';
import ToolCardFrame from '../ToolCardFrame.vue';
import ToolErrorStrip from '../ToolErrorStrip.vue';
import ToolBlockedReason from '../ToolBlockedReason.vue';
import ToolResultImages from '../ToolResultImages.vue';
import ThemeMiniature from './ThemeMiniature.vue';
import { historyChangeText, looksText } from './theme-words';
import { useThemePromptStore } from '@/stores/useThemePromptStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSettingsStore } from '@/stores/useSettingsStore';

// A ThemeRead, ThemeSet or ThemeSchedule call: it waits on its card, then shows the outcome from the result's details.
// Image bytes come only through ToolResultImages (requestToolResultImages), never from a store.
const props = defineProps<{ toolCall: ToolCall }>();
const emit = defineEmits<{ openLightbox: [image: string] }>();
const { t, locale } = useI18n();
const words = computed(() => ({ t, locale: locale.value }));
const uiStore = useUIStore();
const settingsStore = useSettingsStore();
const prompts = useThemePromptStore();
const keptText = computed(() => t('themeAgent.result.kept', { n: KEEP_CHANGES_MS / 1000 }, KEEP_CHANGES_MS / 1000));

const SESSION_OWNER = { kind: 'session' } as const;

// Details are persisted with the result and cross the wire for a remote chat, so the card reads only what parses.
const details = computed(() => parseThemeToolDetails(props.toolCall.metadata));
const outcome = computed(() => details.value?.outcome);
const droppedCount = computed(() => (details.value?.droppedCss?.length ?? 0) + (details.value?.droppedCssMore ?? 0));
// The miniature loads the app's own URLs, which only the desktop app serves.
const theme = computed(() => (settingsStore.hostCapabilities.damoclesTheme ? details.value?.theme : undefined));
const awaiting = computed(() => (props.toolCall.status === 'running' || props.toolCall.status === 'pending') && prompts.awaitedBy(props.toolCall.id));

type Tone = 'success' | 'danger' | 'warning';
const OUTCOMES: Record<ThemeOutcome, { tone: Tone; icon: Component }> = {
  applied: { tone: 'success', icon: CircleCheck },
  kept: { tone: 'success', icon: CircleCheck },
  staged: { tone: 'success', icon: CircleCheck },
  undone: { tone: 'success', icon: Undo2 },
  installed: { tone: 'success', icon: CircleCheck },
  installCancelled: { tone: 'danger', icon: CircleX },
  reverted: { tone: 'danger', icon: CircleX },
  discarded: { tone: 'danger', icon: CircleX },
  // An answer, not a failure: the warning tone.
  changesRequested: { tone: 'warning', icon: MessageSquare },
  // Time ran out and nobody refused: the warning tone.
  outdated: { tone: 'warning', icon: History },
  installExpired: { tone: 'warning', icon: History },
};
const TONE_TEXT: Record<Tone, string> = { success: 'text-(--d-success)', danger: 'text-(--d-danger)', warning: 'text-(--d-warning)' };

// A finished ThemeRead that asked for a screenshot and has no answer recorded: nobody answered its card, or the window let go of the image.
const shotNotSent = computed(() => props.toolCall.name === TOOL_THEME_READ && props.toolCall.input['screenshot'] === true && props.toolCall.status === 'completed'
  && details.value !== undefined && details.value.screenshot === undefined);

const mark = computed(() => {
  if (awaiting.value) return undefined;
  const value = outcome.value;
  if (value) return { ...OUTCOMES[value], label: t(`themeAgent.outcome.${value}`) };
  const shot = details.value?.screenshot;
  if (shot === 'sent') return { tone: 'success' as const, icon: CircleCheck, label: t('themeAgent.result.sentLabel') };
  if (shot === 'denied') return { tone: 'danger' as const, icon: CircleX, label: t('themeAgent.result.deniedLabel') };
  if (shotNotSent.value) return { tone: 'warning' as const, icon: ImageOff, label: t('themeAgent.result.notSentLabel') };
  return undefined;
});

const frameStatus = computed<ToolCall['status']>(() => {
  if (awaiting.value) return 'awaiting_approval';
  if (mark.value) return mark.value.tone === 'danger' ? 'denied' : 'completed';
  return props.toolCall.status;
});

const name = computed(() => details.value?.themeName ?? (typeof props.toolCall.input['name'] === 'string' ? props.toolCall.input['name'] : undefined));
// ThemeSet install's host, the part of its URL the card names; undefined for any other call.
const installHost = computed(() => {
  const install = props.toolCall.input['install'] as { url?: unknown } | undefined;
  const url = typeof install?.url === 'string' && URL.canParse(install.url) ? new URL(install.url) : undefined;
  // a URL with no host (mailto:) names no install host
  return url !== undefined && url.host !== '' ? url.host : undefined;
});
const arg = computed(() => {
  if (props.toolCall.name === TOOL_THEME_READ && props.toolCall.input['screenshot'] === true) return t('themeAgent.result.screenshotArg');
  if (props.toolCall.input['undo'] === true) return t('themeAgent.result.undoArg');
  if (installHost.value !== undefined) return t('themeAgent.result.installArg', { host: installHost.value });
  return name.value;
});
// The theme as a result line names it, its name marked as user text (isolated).
const named = computed(() => {
  const looks = details.value?.looks;
  if (!name.value) return '';
  return looks && looks.length > 0 ? t('themeAgent.result.named', { name: isolated(name.value), looks: looksText(t, looks) }) : isolated(name.value);
});

// One line in bold, then optional quiet lines, per outcome.
const lines = computed<{ lead: string; quote?: string; sub?: string; more?: string } | undefined>(() => {
  const value = details.value;
  if (!value) return undefined;
  switch (value.outcome) {
    case 'applied':
      return { lead: t('themeAgent.result.applied', { name: named.value }), sub: t('themeAgent.result.appliedSub') };
    case 'kept':
      // an on-the-fly undo is kept on the banner like any other change
      return value.undone
        ? { lead: t('themeAgent.result.undone', { change: historyChangeText(words.value, value.undone) }), sub: keptText.value }
        : { lead: keptText.value, sub: t('themeAgent.result.keptSub') };
    case 'reverted':
      return { lead: t('themeAgent.result.reverted'), sub: t('themeAgent.result.revertedSub') };
    case 'discarded':
      return { lead: t('themeAgent.result.discarded') };
    case 'changesRequested':
      return { lead: t('themeAgent.result.changesRequested'), quote: value.note ?? '', sub: t('themeAgent.result.changesRequestedSub') };
    case 'outdated':
      return { lead: t('themeAgent.result.outdated', { name: isolated(name.value ?? '') }), sub: t('themeAgent.result.outdatedSub') };
    case 'undone':
      return { lead: value.undone ? t('themeAgent.result.undone', { change: historyChangeText(words.value, value.undone) }) : t('themeAgent.outcome.undone') };
    case 'staged':
      return { lead: t('themeAgent.result.staged', { name: named.value }), sub: t('themeAgent.result.stagedSub') };
    case 'installed':
      return {
        lead: t('themeAgent.result.installed', { name: isolated(value.themeName ?? '') }),
        sub: t('themeAgent.result.installedSub'),
        ...(value.useArrangement === true ? { more: t('themeAgent.result.installedArrangement') } : {}),
      };
    case 'installCancelled':
      return { lead: t('themeAgent.result.installCancelled'), sub: t('themeAgent.result.installCancelledSub') };
    case 'installExpired':
      return { lead: t('themeAgent.result.installExpired'), sub: t('themeAgent.result.installExpiredSub') };
    case undefined:
      break;
  }
  if (value.laterChange) {
    const actor = value.laterChange.actor.kind === 'user' ? t('themeAgent.result.actorUser') : t('themeAgent.result.actorChat', { title: value.laterChange.actor.title });
    return { lead: t('themeAgent.result.undoRefused', { change: historyChangeText(words.value, value.laterChange.change), actor }) };
  }
  if (value.screenshot === 'sent') return { lead: t('themeAgent.result.sent'), sub: t('themeAgent.result.sentSub') };
  if (value.screenshot === 'denied') return { lead: t('themeAgent.result.denied'), sub: t('themeAgent.result.deniedSub') };
  if (shotNotSent.value) return { lead: t('themeAgent.result.notSent'), sub: t('themeAgent.result.notSentSub') };
  return undefined;
});

const miniMode = computed(() => {
  if (theme.value?.looks.dark && theme.value.looks.light) return 'split' as const;
  return theme.value?.looks.light ? 'light' as const : 'dark' as const;
});
const miniLabel = computed(() => t('themeAgent.card.miniLabel', {
  name: theme.value?.name ?? '',
  looks: miniMode.value === 'split' ? t('themeAgent.looks.bothLooks') : t(`themeAgent.looks.${miniMode.value}Look`),
}));

const errorText = computed(() => (props.toolCall.status === 'failed' && !lines.value ? props.toolCall.errorMessage : undefined));
</script>

<template>
  <ToolCardFrame
    :icon="toolCall.name === TOOL_THEME_READ ? Eye : Palette"
    :name="toolCall.name"
    :arg="arg"
    :status="frameStatus"
    expandable
    :duration-ms="toolCall.durationMs"
    :status-note="!mark"
    :abandon-reason="toolCall.abandonReason"
    :tool="toolCall.name"
    :data-outcome="outcome ?? details?.screenshot ?? (shotNotSent ? 'notSent' : undefined)"
    data-testid="theme-tool-card"
    @expand="uiStore.expandTool(toolCall.id, 'session')"
  >
    <template
      v-if="mark"
      #status
    >
      <span
        class="flex flex-none items-center"
        :class="TONE_TEXT[mark.tone]"
        data-testid="theme-tool-outcome"
      >
        <component
          :is="mark.icon"
          class="size-3.5"
          aria-hidden="true"
        />
        <span class="sr-only">{{ mark.label }}</span>
      </span>
    </template>

    <p
      v-if="awaiting"
      class="border-t border-(--d-border) px-3 py-2 text-xs text-pretty text-(--d-muted)"
      data-testid="theme-tool-waiting"
    >
      {{ toolCall.name === TOOL_THEME_READ ? t('themeAgent.result.waitingShot') : installHost !== undefined ? t('themeAgent.result.waitingInstall') : t('themeAgent.result.waiting') }}
    </p>
    <div
      v-else-if="lines"
      class="flex gap-3 border-t border-(--d-border) px-3 py-2 text-xs"
      data-testid="theme-tool-body"
    >
      <div
        v-if="theme"
        class="w-[6.5rem] flex-none"
      >
        <ThemeMiniature
          :theme="theme"
          :mode="miniMode"
          :label="miniLabel"
          class="border border-(--d-border)"
        />
      </div>
      <div class="flex min-w-0 flex-1 flex-col gap-1 text-pretty">
        <p>
          <strong
            class="font-semibold"
            :class="mark?.tone === 'warning' ? 'text-(--d-warning-text)' : 'text-(--d-text)'"
          ><IsolatedText :text="lines.lead" /></strong>
          <template v-if="lines.quote !== undefined">
            {{ ' ' }}<span
              class="wrap-anywhere whitespace-pre-line"
              data-testid="theme-tool-note"
            >{{ t('themeAgent.result.changesNote', { note: lines.quote }) }}</span>
          </template>
        </p>
        <p
          v-if="lines.sub"
          class="text-(--d-muted)"
        >
          {{ lines.sub }}
        </p>
        <p
          v-if="lines.more"
          class="text-(--d-muted)"
        >
          {{ lines.more }}
        </p>
        <p
          v-if="droppedCount > 0"
          class="text-(--d-warning-text)"
          data-testid="theme-tool-dropped-css"
        >
          {{ t('themeAgent.result.droppedCss', { n: droppedCount }, droppedCount) }}
        </p>
      </div>
    </div>

    <div
      v-if="(toolCall.imageCount ?? 0) > 0 && toolCall.status === 'completed'"
      class="border-t border-(--d-border) px-3 py-2"
      data-testid="theme-tool-images"
      @click.stop
    >
      <ToolResultImages
        :tool="toolCall"
        :owner="SESSION_OWNER"
        @open="emit('openLightbox', $event)"
      />
    </div>

    <ToolErrorStrip
      v-if="errorText"
      :message="errorText"
    />
    <ToolBlockedReason
      v-else-if="toolCall.status === 'blocked' && toolCall.feedback"
      :reason="toolCall.feedback"
    />
  </ToolCardFrame>
</template>
