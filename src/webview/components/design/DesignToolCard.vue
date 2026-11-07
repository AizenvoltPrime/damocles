<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { BookOpenCheck, Boxes, Camera, ChevronRight, FileDown, FileText, Images, Milestone, ScanSearch, SlidersHorizontal, SwatchBook } from 'lucide-vue-next';
import type { ToolCall } from '@shared/types/session';
import { TOOL_DECLARE_TWEAKS, TOOL_DESIGN_CHECK, TOOL_DESIGN_SCREENSHOT, TOOL_EXTRACT_TOKENS, TOOL_IMPORT_ASSET, TOOL_INVENTORY, TOOL_LOAD_DESIGN_SKILL, TOOL_MAP_REFERENCE, TOOL_RECORD_DECISION } from '@shared/tool-names';
import {
  DESIGN_DECISIONS_DETAIL_KEY,
  issueCount,
  parseDesignCheckSummary,
  parseDesignScreenshotDetails,
  parseExtractTokensDetails,
  parseInventoryDetails,
  type DeclareTweaksDetails,
  type DesignDecisionView,
  type DesignInventoryCategoryKey,
  type ImportAssetDetails,
  type LoadDesignSkillDetails,
  type MapReferenceDetails,
} from '@shared/types/design';
import type { ImageBlock } from '@shared/types/content';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useTKnown } from '@/composables/useTKnown';
import { useUIStore } from '@/stores/useUIStore';
import { formatBytes } from '@/utils/format-bytes';
import ToolCardFrame from '../ToolCardFrame.vue';
import ToolErrorStrip from '../ToolErrorStrip.vue';
import ToolBlockedReason from '../ToolBlockedReason.vue';
import ToolResultImages from '../ToolResultImages.vue';
import DesignCheckReport from './DesignCheckReport.vue';
import DesignDecisionChip from './DesignDecisionChip.vue';
import DeclareTweaksList from './DeclareTweaksList.vue';
import MapReferenceTable from './MapReferenceTable.vue';
import { DESIGN_TILE } from './design-tone';

// The design chat's grounding and check tools; StartDesign and FinishDesign have their own cards.
const props = defineProps<{ toolCall: ToolCall }>();
const emit = defineEmits<{ openLightbox: [image: string | ImageBlock] }>();
const { t, locale } = useI18n();
const tKnown = useTKnown();
const uiStore = useUIStore();

const TOOLS: Record<string, { icon: Component; nameKey: string }> = {
  [TOOL_INVENTORY]: { icon: Boxes, nameKey: 'design.tools.inventory' },
  [TOOL_EXTRACT_TOKENS]: { icon: SwatchBook, nameKey: 'design.tools.extractTokens' },
  [TOOL_IMPORT_ASSET]: { icon: FileDown, nameKey: 'design.tools.importAsset' },
  [TOOL_DESIGN_CHECK]: { icon: ScanSearch, nameKey: 'design.tools.designCheck' },
  [TOOL_RECORD_DECISION]: { icon: Milestone, nameKey: 'design.tools.recordDecision' },
  [TOOL_DESIGN_SCREENSHOT]: { icon: Camera, nameKey: 'design.tools.screenshot' },
  [TOOL_LOAD_DESIGN_SKILL]: { icon: BookOpenCheck, nameKey: 'design.tools.loadDesignSkill' },
  [TOOL_DECLARE_TWEAKS]: { icon: SlidersHorizontal, nameKey: 'design.tools.declareTweaks' },
  [TOOL_MAP_REFERENCE]: { icon: Images, nameKey: 'design.tools.mapReference' },
};
const SESSION_OWNER = { kind: 'session' } as const;
const CATEGORY_ORDER: readonly DesignInventoryCategoryKey[] = ['components', 'tokens', 'breakpoints', 'types', 'screens'];

const tool = computed(() => TOOLS[props.toolCall.name] ?? { icon: Boxes, nameKey: 'design.tools.inventory' });
const completed = computed(() => props.toolCall.status === 'completed');
// Details reach the card only on a result; an older or failed call has none, and the card shows its row alone.
const details = computed(() => (completed.value ? props.toolCall.metadata : undefined));

const inventory = computed(() => {
  const value = props.toolCall.name === TOOL_INVENTORY ? parseInventoryDetails(details.value) : undefined;
  if (!value) return undefined;
  const rank = (key: DesignInventoryCategoryKey): number => (CATEGORY_ORDER.includes(key) ? CATEGORY_ORDER.indexOf(key) : CATEGORY_ORDER.length);
  // core lists at most MAX_INVENTORY_REFS refs of a category; `count` is the full number
  return [...value.categories].sort((a, b) => rank(a.key) - rank(b.key)).map((category) => ({ ...category, more: Math.max(0, category.count - category.refs.length) }));
});

const tokens = computed(() => (props.toolCall.name === TOOL_EXTRACT_TOKENS ? parseExtractTokensDetails(details.value) : undefined));
const breakpoints = computed(() => Object.entries(tokens.value?.breakpoints.values ?? {}).sort((a, b) => a[1] - b[1]));

const asset = computed(() => {
  const value = details.value as ImportAssetDetails | undefined;
  return props.toolCall.name === TOOL_IMPORT_ASSET && typeof value?.asset === 'string' ? value : undefined;
});

const check = computed(() => (props.toolCall.name === TOOL_DESIGN_CHECK ? parseDesignCheckSummary(details.value) : undefined));
const checkErrors = computed(() => (check.value ? issueCount(check.value.errors) : 0));

const decisions = computed(() => {
  const value = details.value?.[DESIGN_DECISIONS_DETAIL_KEY];
  return props.toolCall.name === TOOL_RECORD_DECISION && Array.isArray(value) ? (value as DesignDecisionView[]) : [];
});

const screenshot = computed(() => (props.toolCall.name === TOOL_DESIGN_SCREENSHOT ? parseDesignScreenshotDetails(details.value) : undefined));
// One chip per image, in the result's image order: screens in order, each screen's widths ascending.
const screenshotCaptions = computed(() => {
  const screens = screenshot.value?.screens ?? [];
  return screens.flatMap((screen) => screen.widths.map((width) => {
    const at = width.breakpoint ? t('design.check.atBreakpoint', { breakpoint: width.breakpoint, width: width.width }) : t('design.check.atWidth', { width: width.width });
    return screens.length > 1 ? `${screen.screen} · ${at}` : at;
  }));
});
// Each image's box keeps its capture's aspect ratio, so the row never moves as the images load.
const screenshotSizes = computed(() => (screenshot.value?.screens ?? []).flatMap((screen) => screen.widths.map((width) => ({ width: width.width, height: width.cssHeight }))));

const skills = computed(() => {
  const value = details.value as LoadDesignSkillDetails | undefined;
  return props.toolCall.name === TOOL_LOAD_DESIGN_SKILL && Array.isArray(value?.skills) ? value.skills : undefined;
});

const tweaks = computed(() => {
  const value = details.value as DeclareTweaksDetails | undefined;
  return props.toolCall.name === TOOL_DECLARE_TWEAKS && Array.isArray(value?.controls) ? value : undefined;
});

const reference = computed(() => {
  const value = details.value as MapReferenceDetails | undefined;
  return props.toolCall.name === TOOL_MAP_REFERENCE && Array.isArray(value?.rows) ? value : undefined;
});

// A tweak's ref is its control id; a reference's is 'R<n>#<element>', an element of that reference's mapping.
function sourceText(source: DesignDecisionView['source']): string {
  if (source.kind === 'tweak') return t('design.decision.sourceRef.tweak', { ref: source.ref });
  if (source.kind === 'reference') {
    const split = source.ref.indexOf('#');
    if (split > 0) return t('design.decision.sourceRef.reference', { reference: source.ref.slice(0, split), element: source.ref.slice(split + 1) });
  }
  return tKnown('design.decision.source', source.kind, source.kind);
}

const arg = computed(() => {
  const input = props.toolCall.input;
  if (props.toolCall.name === TOOL_IMPORT_ASSET && typeof input['path'] === 'string') return input['path'];
  if (props.toolCall.name === TOOL_RECORD_DECISION && typeof input['title'] === 'string') return input['title'];
  if (checkErrors.value > 0) return t('design.check.errors', { n: checkErrors.value }, checkErrors.value);
  if (tokens.value) return t('design.tools.tokenCount', { n: tokens.value.count }, tokens.value.count);
  if (screenshot.value) {
    const widths = screenshotCaptions.value.length;
    return screenshot.value.outline ? t('design.screenshot.outlineArg', { n: widths }, widths) : t('design.check.widths', { n: widths }, widths);
  }
  if (skills.value) return skills.value.map((skill) => skill.name).join(', ');
  if (tweaks.value) return tweaks.value.controls.map((control) => control.label).join(', ');
  if (props.toolCall.name === TOOL_MAP_REFERENCE && typeof input['reference'] === 'string') return input['reference'];
  return undefined;
});
</script>

<template>
  <ToolCardFrame
    :icon="tool.icon"
    :name="t(tool.nameKey)"
    :arg="arg"
    :status="toolCall.status"
    :tile-class="DESIGN_TILE"
    expandable
    :duration-ms="toolCall.durationMs"
    status-note
    :abandon-reason="toolCall.abandonReason"
    :data-tool="toolCall.name"
    data-testid="design-tool-card"
    @expand="uiStore.expandTool(toolCall.id, 'session')"
  >
    <!-- Stops the click so opening a category does not open the tool overlay. -->
    <ul
      v-if="inventory"
      class="border-t border-(--d-border) py-1"
      data-testid="design-inventory"
      @click.stop
    >
      <li
        v-for="category in inventory"
        :key="category.key"
      >
        <Collapsible v-slot="{ open }">
          <CollapsibleTrigger
            :disabled="category.refs.length === 0"
            class="group/row flex h-7 w-full items-center gap-2 px-3 text-start text-xs transition-colors enabled:hover:bg-(--d-hover) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--d-accent) disabled:cursor-default"
            :data-category="category.key"
          >
            <ChevronRight
              class="size-3 flex-none text-(--d-faint) transition-transform duration-200 ease-out"
              :class="[open && 'rotate-90', category.refs.length === 0 && 'invisible']"
              aria-hidden="true"
            />
            <span class="flex-1 font-medium text-(--d-text)">{{ tKnown('design.tools.category', category.key, category.key) }}</span>
            <span class="d-tone-design rounded-full bg-(--tone)/12 px-1.75 font-mono text-10.5 font-semibold">{{ category.count }}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <!-- Scrolls when long; focusable so a keyboard user can scroll it too. -->
            <ul
              class="flex max-h-48 flex-col gap-0.5 overflow-y-auto pt-0.5 pe-3 pb-1.5 ps-8 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--d-accent)"
              tabindex="0"
              :aria-label="tKnown('design.tools.category', category.key, category.key)"
              data-testid="design-inventory-refs"
            >
              <li
                v-for="ref in category.refs"
                :key="ref"
                class="truncate font-mono text-11 text-(--d-muted)"
                :title="ref"
                dir="ltr"
              >
                {{ ref }}
              </li>
              <li
                v-if="category.more > 0"
                class="text-11 text-(--d-faint-text)"
                data-testid="design-inventory-more"
              >
                {{ t('design.tools.moreRefs', { n: category.more }, category.more) }}
              </li>
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </li>
    </ul>

    <div
      v-else-if="tokens"
      class="flex flex-col gap-1.5 border-t border-(--d-border) px-3 py-2 text-xs"
      data-testid="design-tokens"
    >
      <div
        v-if="Object.keys(tokens.groups).length > 0"
        class="flex flex-wrap gap-1"
      >
        <span
          v-for="(count, group) in tokens.groups"
          :key="group"
          class="inline-flex items-center gap-1 rounded-full bg-(--d-hover) px-2 py-px text-11 text-(--d-muted)"
        >{{ group }}<span class="font-mono font-semibold text-(--d-text)">{{ count }}</span></span>
      </div>
      <p
        v-if="breakpoints.length > 0"
        class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
      >
        <span class="text-(--d-faint)">{{ t('design.tools.breakpoints') }}</span>
        <span
          v-for="[name, width] in breakpoints"
          :key="name"
          class="font-mono text-11 text-(--d-text)"
        >{{ name }} <span class="text-(--d-muted)">{{ width }}</span></span>
        <span class="text-11 text-(--d-faint)">· {{ tokens.breakpoints.source }}</span>
      </p>
      <p
        v-if="tokens.fonts.length > 0"
        class="flex flex-wrap items-baseline gap-x-2"
      >
        <span class="text-(--d-faint)">{{ t('design.tools.fonts') }}</span>
        <span
          v-for="font in tokens.fonts"
          :key="font"
          class="font-mono text-11 text-(--d-text)"
        >{{ font }}</span>
      </p>
    </div>

    <p
      v-else-if="asset"
      class="flex items-center gap-2 border-t border-(--d-border) px-3 py-2 text-xs"
      data-testid="design-asset"
    >
      <span
        class="min-w-0 flex-1 truncate font-mono text-11.5 text-(--d-text)"
        dir="ltr"
      >{{ asset.asset }}</span>
      <span class="flex-none text-11 text-(--d-faint)">{{ formatBytes(asset.bytes, locale) }}</span>
    </p>

    <DesignCheckReport
      v-else-if="check"
      :summary="check"
    />

    <div
      v-else-if="screenshot"
      class="border-t border-(--d-border) px-3 py-2 text-xs"
      data-testid="design-screenshot"
      @click.stop
    >
      <p
        v-if="screenshot.outline"
        class="flex items-start gap-2 text-pretty text-(--d-muted)"
        data-testid="design-screenshot-outline"
      >
        <FileText
          class="mt-px size-3.25 flex-none text-(--d-faint)"
          aria-hidden="true"
        />
        {{ t('design.screenshot.outline') }}
      </p>
      <ToolResultImages
        v-else
        :tool="toolCall"
        :owner="SESSION_OWNER"
        :captions="screenshotCaptions"
        :sizes="screenshotSizes"
        @open="emit('openLightbox', $event)"
      />
    </div>

    <ul
      v-else-if="skills && skills.length > 0"
      class="flex flex-col gap-1 border-t border-(--d-border) px-3 py-2 text-xs"
      data-testid="design-loaded-skills"
    >
      <li
        v-for="skill in skills"
        :key="skill.name"
        class="flex min-w-0 items-baseline gap-2"
        data-testid="design-loaded-skill"
      >
        <span
          class="d-tone-design flex-none rounded-full bg-(--tone)/12 px-1.75 font-mono text-11 font-semibold"
          dir="ltr"
        >{{ skill.name }}</span>
        <span class="min-w-0 truncate text-(--d-text)">{{ skill.title }}</span>
        <span class="ms-auto flex-none text-11 text-(--d-faint)">{{ t('design.check.hints', { n: skill.hints }, skill.hints) }}</span>
      </li>
    </ul>

    <DeclareTweaksList
      v-else-if="tweaks"
      :details="tweaks"
    />

    <MapReferenceTable
      v-else-if="reference"
      :details="reference"
    />

    <ul
      v-else-if="decisions.length > 0"
      class="flex flex-col gap-1 border-t border-(--d-border) px-3 py-2 text-xs"
      data-testid="design-recorded-decisions"
    >
      <li
        v-for="decision in decisions"
        :key="decision.id"
        class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
      >
        <DesignDecisionChip :decision="decision" />
        <span class="text-11 text-(--d-faint)">
          {{ sourceText(decision.source) }}<template v-if="decision.supersedes"> · {{ t('design.decision.supersedes', { id: decision.supersedes }) }}</template>
        </span>
      </li>
    </ul>

    <ToolErrorStrip
      v-if="toolCall.status === 'failed' && toolCall.errorMessage"
      :message="toolCall.errorMessage"
    />
    <ToolBlockedReason
      v-else-if="toolCall.status === 'blocked' && toolCall.feedback"
      :reason="toolCall.feedback"
      data-testid="tool-card-blocked-reason"
    />
    <div
      v-if="toolCall.status === 'running'"
      class="d-sweep-bar h-0.5 bg-(--d-hover) text-(--d-design)"
      aria-hidden="true"
    />
  </ToolCardFrame>
</template>
