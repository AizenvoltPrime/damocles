<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, Cloud, GitBranch, GitMerge, Tag, Target } from 'lucide-vue-next';
import type { Component } from 'vue';
import { visibleText } from '@shared/visible-text';
import type { ScmHistoryRef } from '../../preload/scm-channels';
import type { GraphListRow } from './graph-model';
import { laneColor, laneTextColor, type LaneMetrics } from './lanes';

// One commit or incoming/outgoing row of the Graph's virtualized tree; custom markup, since no shadcn part virtualizes a tree
// row or draws SVG lanes.
const props = defineProps<{
  row: Extract<GraphListRow, { kind: 'commit' | 'changes' }>;
  id: string;
  // aria-setsize: the commit and changes rows of the history, -1 while pages remain
  setSize: number;
  // the roving tabindex position; its badges are in the tab order only then
  current: boolean;
  // CSS px, fixed so the virtual list can place the row
  height: number;
  lane: LaneMetrics;
  // the swimlane ids the hovered commit's path runs through; null while no commit is hovered
  lit: ReadonlySet<string> | null;
  // the hovered commit's row
  hovered: boolean;
  // the compact age the row shows, and the full one its tooltip and accessible name read
  time: string;
  timeTitle: string;
  // CSS px the subject needs on one line, so it reserves no more than that of its 35% share
  subjectWidth: number;
  // incoming or outgoing: the count and the upstream's short name
  count?: number | undefined;
  upstream?: string | undefined;
  // a live arrival's place in its batch; never set for a row a scroll mounted
  arrival?: number | undefined;
  // HEAD changed to this commit after the first load: its halo pulses once
  halo?: boolean | undefined;
  // Go to Current landed on this row: its background flashes once
  flash?: boolean | undefined;
}>();
const emit = defineEmits<{
  toggle: [];
  open: [];
  menu: [event: MouseEvent];
  refMenu: [ref: ScmHistoryRef, anchor: DOMRect];
  focus: [];
  hover: [on: boolean];
}>();
const { t } = useI18n();

const commit = computed(() => (props.row.kind === 'commit' ? props.row.row.commit : undefined));
const merge = computed(() => (commit.value?.parents.length ?? 0) > 1);
const head = computed(() => props.row.row.kind === 'HEAD');
const geometry = computed(() => props.row.geometry);
const node = computed(() => geometry.value.node);
// VS Code's radii (4, ring 7, merge 6 and 3) at its 11px lane, scaled with the lane
const radius = (base: number): number => (base * props.lane.width) / 11;

const lit = (id: string): boolean => props.lit === null || props.lit.has(id) || (props.hovered && props.row.row.parents.includes(id));
const nodeLit = computed(() => props.lit === null || props.lit.has(props.row.row.id));

const subject = computed(() => (commit.value ? visibleText(commit.value.subject) : t(props.row.kind === 'changes' && props.row.direction === 'incoming' ? 'graph.incoming' : 'graph.outgoing')));
const author = computed(() => (commit.value ? visibleText(commit.value.author) : ''));

interface Badge {
  readonly ref: ScmHistoryRef;
  readonly icon: Component;
  readonly tone: string;
  readonly name: string;
  readonly label: string;
}

// Tinted pills from the --d-* tokens: a local branch in the accent, HEAD's branch filled, a remote muted, a tag in the warning
// colour and the base ref in the info colour, as the prototype colours them; a hovered row deepens each tint.
const TONES = {
  branch: 'bg-(--d-accent-soft) text-(--d-accent-text) group-hover/row:bg-[color-mix(in_srgb,var(--d-accent)_22%,transparent)]',
  current: 'bg-(--d-accent) text-(--d-on-accent) font-semibold',
  remote: 'bg-(--d-hover) text-(--d-muted) group-hover/row:bg-(--d-border2)',
  tag: 'bg-[color-mix(in_srgb,var(--d-warning)_14%,transparent)] text-(--d-warning-text) group-hover/row:bg-[color-mix(in_srgb,var(--d-warning)_22%,transparent)]',
  base: 'bg-[color-mix(in_srgb,var(--d-info)_14%,transparent)] text-(--d-info-text) group-hover/row:bg-[color-mix(in_srgb,var(--d-info)_22%,transparent)]',
} as const;

const badges = computed<Badge[]>(() => props.row.row.refs.map(({ ref }) => {
  const name = visibleText(ref.name);
  const current = ref.current && (ref.kind === 'branch' || ref.kind === 'head');
  const icon = ref.kind === 'head' ? Target : ref.kind === 'remote' ? Cloud : ref.kind === 'tag' ? Tag : ref.kind === 'base' ? GitMerge : current ? Target : GitBranch;
  const tone = current ? TONES.current : ref.kind === 'head' ? TONES.current : TONES[ref.kind];
  const label = ref.kind === 'head' ? t('graph.badge.head') : t(`graph.badge.${current ? 'current' : ref.kind}`, { name });
  return { ref, icon, tone, name, label };
}));

const changes = computed(() => (props.row.kind === 'changes' ? props.row.direction : undefined));
const changesTitle = computed(() => {
  if (!changes.value || props.count === undefined) return undefined;
  return t(changes.value === 'incoming' ? 'graph.incomingTitle' : 'graph.outgoingTitle', props.count, { named: { n: props.count, upstream: visibleText(props.upstream ?? '') } });
});

const title = computed(() => {
  if (changes.value) return changesTitle.value;
  const c = commit.value!;
  return `${c.hash.slice(0, 8)}: ${subject.value}\n${author.value}, ${props.timeTitle}\n${t('graph.rowTitle')}`;
});

const ariaLabel = computed(() => {
  if (changes.value) return [subject.value, changesTitle.value].filter(Boolean).join(', ');
  return [subject.value, ...badges.value.map((badge) => badge.label), author.value, props.timeTitle, head.value ? t('graph.head') : '', merge.value ? t('graph.merge') : '']
    .filter((part) => part !== '')
    .join(', ');
});

function onBadgeKeydown(event: KeyboardEvent, ref: ScmHistoryRef): void {
  if (ref.kind === 'head') return;
  if (!(event.key === 'ContextMenu' || event.key === 'Enter' || event.key === ' ' || (event.key === 'F10' && event.shiftKey))) return;
  event.preventDefault();
  event.stopPropagation();
  emit('refMenu', ref, (event.currentTarget as HTMLElement).getBoundingClientRect());
}

// A detached HEAD's badge has no menu: its right click opens the commit's.
function onBadgeMenu(event: MouseEvent, ref: ScmHistoryRef): void {
  if (ref.kind === 'head') return;
  event.stopPropagation();
  emit('refMenu', ref, new DOMRect(event.clientX, event.clientY, 0, 0));
}

function onClick(): void {
  if (changes.value) emit('open');
  else emit('toggle');
}
</script>

<template>
  <div
    :id="id"
    role="treeitem"
    data-testid="graph-row"
    :data-row-key="row.key"
    :data-kind="row.kind === 'changes' ? row.direction : row.row.kind === 'HEAD' ? 'head' : merge ? 'merge' : 'commit'"
    :data-hash="commit?.hash"
    :aria-level="1"
    :aria-posinset="row.position"
    :aria-setsize="setSize"
    :aria-expanded="row.kind === 'commit' ? row.expanded : undefined"
    :aria-label="ariaLabel"
    :tabindex="current ? 0 : -1"
    :title="title"
    class="group/row @container/row relative isolate flex cursor-pointer items-center gap-1.5 rounded-6 pr-1.5 outline-none select-none before:absolute before:inset-0 before:-z-1 before:rounded-6 before:bg-(--d-hover) before:opacity-0 before:transition-opacity before:duration-200 hover:before:opacity-100 focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
    :class="[
      row.kind === 'commit' && row.expanded ? 'before:opacity-100' : '',
      arrival !== undefined ? 'd-arrive' : '',
      flash ? 'after:pointer-events-none after:absolute after:inset-0 after:-z-1 after:rounded-6 after:bg-(--d-accent-soft) after:animate-[d-flash_.9s_var(--ease-out)_both]' : '',
    ]"
    :style="{ height: `${height}px`, ...(arrival !== undefined ? { animationDelay: `${Math.min(arrival, 8) * 30}ms` } : {}) }"
    @click="onClick"
    @focus="emit('focus')"
    @pointerenter="emit('hover', true)"
    @pointerleave="emit('hover', false)"
    @contextmenu.prevent="row.kind === 'commit' && emit('menu', $event)"
  >
    <!-- The expanded commit's accent bar eases in by transform; a transition, so a row a scroll mounts expanded never plays it. -->
    <span
      v-if="row.kind === 'commit'"
      aria-hidden="true"
      class="absolute inset-y-1 left-0 w-0.5 origin-top rounded-full bg-(--d-accent) transition-[transform,opacity] duration-200 ease-out"
      :class="row.expanded ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0'"
    />
    <ChevronRight
      v-if="row.kind === 'commit'"
      aria-hidden="true"
      data-testid="graph-twistie"
      class="ml-0.5 size-3 shrink-0 text-(--d-faint) transition-transform duration-200 ease-out group-hover/row:text-(--d-muted)"
      :class="row.expanded ? 'rotate-90' : ''"
    />
    <span
      v-else
      aria-hidden="true"
      class="ml-0.5 w-3 shrink-0"
    />
    <!-- SVG lanes from the port's geometry; x lands on whole device pixels (LaneMetrics), the stroke centred on them. -->
    <svg
      aria-hidden="true"
      data-testid="graph-lanes"
      class="shrink-0 overflow-visible"
      :width="geometry.width"
      :height="height"
      :viewBox="`0 0 ${geometry.width} ${height}`"
    >
      <g :transform="`translate(${lane.offset} 0)`">
        <path
          v-for="(path, index) in geometry.paths"
          :key="index"
          :d="path.d"
          fill="none"
          stroke-linecap="round"
          :stroke-width="lane.stroke"
          class="transition-opacity duration-150 ease-out"
          :style="{ stroke: laneColor(path.color), opacity: lit(path.id) ? 1 : 0.3 }"
        />
        <g
          data-testid="graph-node"
          :data-node="node.kind"
          class="transition-opacity duration-150 ease-out"
          :style="{ opacity: nodeLit ? 1 : 0.3, color: laneColor(node.color) }"
        >
          <circle
            v-if="halo"
            data-testid="graph-halo"
            :cx="node.x"
            :cy="node.y"
            :r="radius(5.5)"
            fill="currentColor"
            class="pointer-events-none [--ring-scale:2.4] transform-fill origin-center animate-[d-ring_.9s_var(--ease-out)_1_both]"
          />
          <template v-if="node.kind === 'head'">
            <circle
              :cx="node.x"
              :cy="node.y"
              :r="radius(5.5)"
              fill="currentColor"
            />
            <circle
              :cx="node.x"
              :cy="node.y"
              :r="radius(2)"
              fill="var(--d-panel)"
            />
          </template>
          <template v-else-if="node.kind === 'merge'">
            <circle
              :cx="node.x"
              :cy="node.y"
              :r="radius(5.5)"
              fill="var(--d-panel)"
              stroke="currentColor"
              :stroke-width="lane.ring"
            />
            <circle
              :cx="node.x"
              :cy="node.y"
              :r="radius(2.5)"
              fill="currentColor"
            />
          </template>
          <template v-else-if="node.kind === 'incoming' || node.kind === 'outgoing'">
            <circle
              :cx="node.x"
              :cy="node.y"
              :r="radius(5)"
              fill="var(--d-panel)"
              stroke="currentColor"
              :stroke-width="lane.ring"
              :stroke-dasharray="`${radius(2.6)} ${radius(1.6)}`"
            />
            <circle
              :cx="node.x"
              :cy="node.y"
              :r="radius(1.75)"
              fill="currentColor"
            />
          </template>
          <circle
            v-else
            :cx="node.x"
            :cy="node.y"
            :r="radius(4)"
            fill="var(--d-panel)"
            stroke="currentColor"
            :stroke-width="lane.stroke"
          />
        </g>
      </g>
    </svg>
    <!-- When the row is short, the other badges' names go first, then the author, then the first badge's name down to 4ch, and
         the subject last, down to the smaller of 35% and its own width. -->
    <span
      data-testid="graph-subject"
      class="flex-[1_1_auto] truncate text-xs"
      :class="changes ? 'font-medium' : merge ? 'text-(--d-faint)' : 'text-(--d-text)'"
      :style="{ minWidth: `min(35%, ${subjectWidth}px)`, ...(changes ? { color: laneTextColor(node.color) } : {}) }"
    >{{ subject }}</span>
    <!-- The badges never shrink below the first one's name at 4 characters and its ellipsis (less for a shorter name) and the
         others' icons: a pill's own min-content is its whole name, so the floor is set here, in the pills' mono font, and
         drops to the icons below 15rem. -->
    <span
      v-if="badges.length > 0"
      class="flex min-w-[calc(var(--first-ch)*1ch+1.375rem+var(--others)*1.4375rem)] shrink items-center gap-1 overflow-hidden font-mono text-10 @max-[15rem]/row:min-w-0"
      :style="{ '--first-ch': String(Math.min(5, badges[0]!.name.length)), '--others': String(badges.length - 1) }"
    >
      <!-- A detached HEAD's badge has no menu, so it is neither a button nor in the tab order. -->
      <span
        v-for="(badge, index) in badges"
        :key="badge.ref.id"
        :role="badge.ref.kind === 'head' ? undefined : 'button'"
        data-testid="graph-badge"
        :data-ref="badge.ref.id"
        :data-kind="badge.ref.kind"
        :data-current="badge.ref.current || undefined"
        :tabindex="badge.ref.kind === 'head' ? undefined : current ? 0 : -1"
        :aria-label="badge.label"
        :aria-haspopup="badge.ref.kind === 'head' ? undefined : 'menu'"
        :title="badge.ref.kind === 'head' ? badge.name : `${badge.name}\n${t('graph.badgeTitle')}`"
        class="flex h-4 max-w-32 items-center gap-0.75 rounded-5 px-1.25 font-mono text-10 outline-none transition-colors duration-150 focus-visible:shadow-[inset_0_0_0_1px_currentColor]"
        :class="[badge.tone, index === 0 ? 'min-w-0 shrink' : 'shrink-0']"
        @click.stop
        @keydown="onBadgeKeydown($event, badge.ref)"
        @contextmenu.prevent="onBadgeMenu($event, badge.ref)"
      >
        <component
          :is="badge.icon"
          aria-hidden="true"
          class="size-2.25 shrink-0"
        />
        <!-- VS Code's _renderBadges: the first badge keeps its name, the others show their icon on a default-width row; below
             15rem every badge is its icon. The name stays in the title and label. -->
        <span
          class="min-w-0 truncate"
          :class="index === 0 ? '@max-[15rem]/row:hidden' : '@max-[26rem]/row:hidden'"
        >{{ badge.name }}</span>
      </span>
    </span>
    <!-- Styled like Source control's sync button counts. -->
    <span
      v-if="changes && count !== undefined"
      data-testid="graph-changes-count"
      class="shrink-0 font-mono text-11"
      :style="{ color: laneTextColor(node.color) }"
    >{{ count }}{{ changes === 'incoming' ? '↓' : '↑' }}</span>
    <span
      v-if="commit"
      data-testid="graph-author"
      class="max-w-20 min-w-10 shrink-8 truncate text-right text-10.5 text-(--d-faint) @max-[17.5rem]/row:hidden"
    >{{ author }}</span>
    <span
      v-if="commit"
      aria-hidden="true"
      class="-mx-0.75 shrink-0 text-10.5 text-(--d-faint) @max-[17.5rem]/row:hidden"
    >·</span>
    <span
      v-if="commit"
      data-testid="graph-time"
      class="shrink-0 text-right text-10.5 whitespace-nowrap text-(--d-faint) tabular-nums @max-[13rem]/row:hidden"
    >{{ time }}</span>
  </div>
</template>
