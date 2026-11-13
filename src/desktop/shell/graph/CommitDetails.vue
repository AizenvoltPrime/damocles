<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { GitCompare, GitMerge, LoaderCircle, TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import ForgeAvatar from '@/components/settings/forge/ForgeAvatar.vue';
import { commitTime } from '@/utils/clock';
import { scanReferences, type ForgeReference } from '@shared/forge/references';
import { visibleLines, visibleText } from '@shared/visible-text';
import FileIcon from '../components/FileIcon.vue';
import StatusLetter from '../scm/StatusLetter.vue';
import { MAX_SCM_COMMIT_FILES } from '../../preload/scm-channels';
import type { DetailRow } from './graph-model';
import { laneColor, type LaneMetrics } from './lanes';
import { ciLook, ciPipelineName, ciStateWord } from '../forge/ci-view';
import { LINK, mergedLabel } from '../forge/history-view';

// One row of an expanded commit, flattened so the Graph's list keeps fixed-height rows: the meta row, the message block, the
// stat or a file. Custom markup, since no shadcn part is a virtualized tree row; the lanes of the commit pass down beside it.
const props = defineProps<{
  row: DetailRow;
  id: string;
  current: boolean;
  // CSS px, fixed so the virtual list can place the row
  height: number;
  lane: LaneMetrics;
  // the swimlane ids the hovered commit's path runs through; null while none is hovered
  lit: ReadonlySet<string> | null;
  // the row's place in a user's expansion, for its staggered entrance; never set for a row a scroll mounted
  reveal?: number | undefined;
  // the repository's server kind: the message links its references; absent (no registered server): plain text
  forgeKind?: 'github' | 'gitlab' | undefined;
  // the meta row's author avatar (showAvatars on and a registered server), its image once core issued a key
  showAvatar?: boolean | undefined;
  avatarKey?: string | undefined;
}>();
const emit = defineEmits<{
  copyId: [];
  openChanges: [];
  openFile: [path: string];
  openPipeline: [];
  openMerged: [];
  openReference: [reference: ForgeReference];
  retryStatus: [];
  focus: [];
  menu: [event: MouseEvent];
  avatarFailed: [];
}>();
const { t, locale } = useI18n();

const lanesWidth = computed(() => props.lane.width * (Math.max(props.row.lanes.length, 1) + 1));
const x = (index: number): number => props.lane.width * (index + 1);
const lit = (id: string): boolean => props.lit === null || props.lit.has(id);

const file = computed(() => (props.row.kind === 'file' ? props.row.file : undefined));
const fileParts = computed(() => {
  const path = file.value?.path ?? '';
  const slash = path.lastIndexOf('/');
  return { name: visibleText(path.slice(slash + 1)), dir: visibleText(path.slice(0, Math.max(0, slash))) };
});

const date = computed(() => (props.row.kind === 'meta' ? commitTime(props.row.commit.authorDate, locale.value) : { full: '', day: '', clock: '', otherYear: false }));
// A narrowing card sheds the author, then the clock time, then the day, each whole, never cut mid-value; the widths are the
// card's content box that fits each beside the hash and Open Changes, wider for a day that names its year.
const DATE_FITS = {
  thisYear: { author: '@max-[14rem]/card:hidden', clock: '@max-[11.5rem]/card:hidden', day: '@max-[9rem]/card:hidden' },
  otherYear: { author: '@max-[16.5rem]/card:hidden', clock: '@max-[13.75rem]/card:hidden', day: '@max-[11.5rem]/card:hidden' },
} as const;
const fits = computed(() => DATE_FITS[date.value.otherYear ? 'otherYear' : 'thisYear']);

const noteText = computed(() => {
  if (props.row.kind !== 'note') return '';
  if (props.row.state === 'filesTruncated') return t('graph.details.filesTruncated', { n: MAX_SCM_COMMIT_FILES.toLocaleString(locale.value) });
  return t(props.row.state === 'failed' ? 'graph.details.failed' : 'graph.details.loading');
});

// the status row: "Pipeline #4312 passed" with its state's icon and "Merged in !45", or the check still running, or why it
// failed; with no pipeline the merged MR/PR shows alone.
const ciStatus = computed(() => {
  if (props.row.kind !== 'status') return undefined;
  const { status, merged } = props.row;
  if (status?.status === 'loading') return { kind: 'loading' as const, text: t('graph.status.loading') };
  if (status?.status === 'error') return { kind: 'error' as const, text: status.message };
  const pipeline = status === null ? undefined : { text: t('graph.status.pipeline', { name: ciPipelineName(status.pipeline, (key, values) => (values ? t(key, values) : t(key))), state: ciStateWord(status.pipeline.state, t) }), look: ciLook(status.pipeline.state) };
  const label = merged === null ? undefined : mergedLabel(merged);
  const mergedText = label === undefined ? undefined : t('graph.status.merged', { ref: label });
  const text = new Intl.ListFormat(locale.value, { type: 'unit' }).format([pipeline?.text, mergedText].filter((part) => part !== undefined));
  return { kind: 'ready' as const, text, pipeline, merged: label };
});

const messageText = computed(() => (props.row.kind === 'message' ? visibleLines(props.row.text) : ''));
// #123, !45 and owner/repo#12 as links on the repository's server, scanned in the escaped text the block shows
const messageSegments = computed(() => (props.row.kind === 'message' && props.forgeKind !== undefined ? scanReferences(messageText.value, props.forgeKind) : [{ text: messageText.value }]));

// git's shortstat: the file count, then insertions and deletions, each left out when it is zero; `short` is the narrow card's
// "3 files · +3 · -3", which the full text's title keeps.
const stat = computed(() => {
  if (props.row.kind !== 'stat') return undefined;
  const { files, insertions, deletions } = props.row.stat;
  return [
    { text: t('graph.details.files', files, { named: { n: files } }), short: t('graph.details.filesShort', files, { named: { n: files } }), tone: '' },
    ...(insertions > 0 ? [{ text: t('graph.details.insertions', insertions, { named: { n: insertions } }), short: `+${insertions}`, tone: 'text-(--d-success-text)' }] : []),
    ...(deletions > 0 ? [{ text: t('graph.details.deletions', deletions, { named: { n: deletions } }), short: `-${deletions}`, tone: 'text-(--d-danger-text)' }] : []),
  ];
});
const statText = computed(() => (stat.value ?? []).map((part) => part.text).join(', '));

const ariaLabel = computed(() => {
  const row = props.row;
  switch (row.kind) {
    case 'meta': return [row.commit.hash.slice(0, 8), visibleText(row.commit.author), date.value.full].join(', ');
    // the whole message, so a screen reader reads what the block shows and what it scrolls to
    case 'message': return t('graph.details.messageAria', { message: messageText.value });
    case 'stat': return statText.value;
    case 'file': {
      const status = t(`graph.details.status.${row.file.status}`);
      const renamed = row.file.oldPath === undefined ? '' : `, ${t('graph.details.renamed', { path: visibleText(row.file.oldPath) })}`;
      return `${t('graph.details.fileAria', { path: visibleText(row.file.path), status })}${renamed}`;
    }
    case 'note': return noteText.value;
    case 'status': return ciStatus.value?.text ?? '';
    default: return '';
  }
});

function onClick(): void {
  if (props.row.kind === 'file') emit('openFile', props.row.file.path);
  else if (ciStatus.value?.kind === 'ready' && ciStatus.value.pipeline) emit('openPipeline');
  else if (ciStatus.value?.kind === 'ready') emit('openMerged');
}

// the card width under which "Merged in" goes beside a pipeline; the short link shows from the same width down
const MERGED_FITS = '@max-[18rem]/card:hidden';
</script>

<template>
  <div
    :id="id"
    role="treeitem"
    data-testid="graph-detail"
    :data-row-key="row.key"
    :data-kind="row.kind"
    :data-path="file?.path"
    :aria-level="2"
    :aria-posinset="row.position"
    :aria-setsize="row.size"
    :aria-label="ariaLabel"
    :aria-busy="(row.kind === 'note' && row.state === 'loading') || ciStatus?.kind === 'loading' ? true : undefined"
    :tabindex="current ? 0 : -1"
    class="group/detail relative flex items-stretch gap-1.5 pr-1.5 outline-none focus-visible:[&>.graph-card]:shadow-[inset_0_0_0_1px_var(--d-accent)]"
    :class="row.kind === 'file' || ciStatus?.kind === 'ready' ? 'cursor-pointer' : 'cursor-default'"
    :style="{ height: `${height}px` }"
    @click="onClick"
    @focus="emit('focus')"
    @contextmenu.prevent="emit('menu', $event)"
  >
    <span
      aria-hidden="true"
      class="ml-0.5 w-3 shrink-0"
    />
    <!-- The commit's lanes passing down beside its details, as VS Code's graph placeholder draws them. -->
    <svg
      aria-hidden="true"
      class="shrink-0"
      :width="lanesWidth"
      :height="height"
      :viewBox="`0 0 ${lanesWidth} ${height}`"
    >
      <g :transform="`translate(${lane.offset} 0)`">
        <path
          v-for="(each, index) in row.lanes"
          :key="index"
          :d="`M ${x(index)} 0 V ${height}`"
          fill="none"
          :stroke-width="lane.stroke"
          class="transition-opacity duration-150 ease-out"
          :style="{ stroke: laneColor(each.color), opacity: lit(each.id) ? 1 : 0.3 }"
        />
      </g>
    </svg>
    <!-- One card split across the rows: the meta row holds its top edge, the last row its bottom. -->
    <div
      class="graph-card @container/card flex min-w-0 flex-1 items-center gap-1.5 border-x border-(--d-border) bg-(--d-card) px-2.5"
      :class="[row.kind === 'meta' ? 'mt-0.5 rounded-t-8 border-t' : '', row.last ? 'mb-1 rounded-b-8 border-b' : '', row.kind === 'file' ? 'group-hover/detail:bg-(--d-hover)' : '', reveal !== undefined ? 'd-row-reveal' : '']"
      :style="reveal !== undefined ? { '--reveal-index': String(reveal) } : undefined"
    >
      <template v-if="row.kind === 'meta'">
        <Button
          type="button"
          variant="ghost"
          data-testid="graph-copy-id"
          tabindex="-1"
          class="d-press h-4.5 rounded-5 px-1 font-mono text-11 font-normal text-(--d-accent-text) hover:bg-(--d-accent-soft) hover:text-(--d-accent-text)"
          :title="t('graph.details.copyCommitId')"
          :aria-label="t('graph.details.copyCommitId')"
          @click.stop="emit('copyId')"
        >
          {{ row.commit.hash.slice(0, 8) }}
        </Button>
        <!-- What a narrow card sheds stays in the row's accessible name and the date's title. -->
        <span
          aria-hidden="true"
          class="text-11 text-(--d-faint)"
          :class="fits.author"
        >·</span>
        <span
          class="flex min-w-0 items-center gap-1.25"
          :class="fits.author"
        >
          <ForgeAvatar
            v-if="showAvatar"
            :login="visibleText(row.commit.author)"
            :avatar-key="avatarKey"
            size="chip"
            @failed="emit('avatarFailed')"
          />
          <span
            data-testid="graph-detail-author"
            class="min-w-0 truncate text-11 text-(--d-muted)"
            :title="visibleText(row.commit.email)"
          >{{ visibleText(row.commit.author) }}</span>
        </span>
        <span
          aria-hidden="true"
          class="text-11 text-(--d-faint)"
          :class="fits.day"
        >·</span>
        <span
          data-testid="graph-detail-date"
          class="shrink-0 font-mono text-10.5 whitespace-nowrap text-(--d-faint) tabular-nums"
          :class="fits.day"
          :title="date.full"
        >{{ date.day }} <span
          data-testid="graph-detail-clock"
          :class="fits.clock"
        >{{ date.clock }}</span></span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          tabindex="-1"
          data-testid="graph-open-changes"
          class="d-press ms-auto size-5 shrink-0 rounded-5 text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3"
          :title="t('graph.details.openChanges')"
          :aria-label="t('graph.details.openChanges')"
          @click.stop="emit('openChanges')"
        >
          <GitCompare aria-hidden="true" />
        </Button>
      </template>
      <div
        v-else-if="row.kind === 'message'"
        data-testid="graph-message"
        class="h-full min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] py-1 text-12.5/4.5 wrap-break-word whitespace-pre-wrap text-(--d-text) select-text"
        :title="row.truncated ? t('graph.details.truncated') : undefined"
      >
        <!-- inline elements only, so pre-wrap keeps the message's whitespace -->
        <template
          v-for="(segment, index) in messageSegments"
          :key="index"
        >
          <!-- A link inside a tree row: tabbable while its row holds the roving tabindex, as the Graph row's badges are; its
               Enter and Space stop at the link, so the tree does not also activate the row. -->
          <button
            v-if="segment.reference"
            type="button"
            role="link"
            data-testid="graph-message-ref"
            :tabindex="current ? 0 : -1"
            class="text-(--d-accent-text)"
            :class="LINK"
            @click.stop="emit('openReference', segment.reference)"
            @keydown.enter.stop
            @keydown.space.stop
            v-text="segment.text"
          />
          <span
            v-else
            v-text="segment.text"
          />
        </template>
      </div>
      <span
        v-else-if="row.kind === 'stat' && stat"
        data-testid="graph-stat"
        class="min-w-0 truncate text-10.5 text-(--d-faint)"
        :title="statText"
      ><span class="@max-[17rem]/card:hidden"><template
        v-for="(part, index) in stat"
        :key="index"
      >{{ index > 0 ? ', ' : '' }}<span :class="part.tone">{{ part.text }}</span></template></span><span
        data-testid="graph-stat-short"
        class="@min-[17rem]/card:hidden"
      ><template
        v-for="(part, index) in stat"
        :key="index"
      >{{ index > 0 ? ' · ' : '' }}<span :class="part.tone">{{ part.short }}</span></template></span></span>
      <template v-else-if="row.kind === 'file' && file">
        <FileIcon
          :path="file.path"
          class="size-3 shrink-0"
        />
        <span
          data-testid="graph-file-name"
          class="min-w-0 truncate text-11.5 text-(--d-text)"
          :title="visibleText(file.path)"
        >{{ fileParts.name }}</span>
        <span class="min-w-0 flex-1 truncate text-10.5 text-(--d-faint)">{{ fileParts.dir }}</span>
        <StatusLetter
          data-testid="graph-file-status"
          :letter="file.status"
        />
      </template>
      <span
        v-else-if="ciStatus?.kind === 'ready'"
        data-testid="graph-ci-status"
        data-state="ready"
        class="flex min-w-0 items-center gap-2.5 text-11 text-(--d-muted)"
      >
        <span
          v-if="ciStatus.pipeline"
          class="flex min-w-0 items-center gap-1.25"
        >
          <component
            :is="ciStatus.pipeline.look.icon"
            aria-hidden="true"
            class="size-3 shrink-0"
            :class="ciStatus.pipeline.look.tone"
          />
          <!-- Links by role: each opens on the repository's server as a user click, through main. -->
          <button
            type="button"
            role="link"
            :tabindex="current ? 0 : -1"
            data-testid="graph-ci-link"
            class="min-w-0 truncate hover:text-(--d-text)"
            :class="LINK"
            @click.stop="emit('openPipeline')"
            @keydown.enter.stop
            @keydown.space.stop
          >{{ ciStatus.pipeline.text }}</button>
        </span>
        <span
          v-if="ciStatus.merged !== undefined"
          data-testid="graph-merged"
          class="flex shrink-0 items-center gap-1.25 whitespace-nowrap"
        >
          <GitMerge
            aria-hidden="true"
            class="size-3 shrink-0"
          />
          <!-- a card too narrow for both sheds "Merged in" and keeps the icon and the link; the row's name keeps the words -->
          <i18n-t
            tag="span"
            keypath="graph.status.merged"
            scope="global"
            data-testid="graph-merged-text"
            :class="ciStatus.pipeline ? MERGED_FITS : ''"
          >
            <template #ref>
              <button
                type="button"
                role="link"
                :tabindex="current ? 0 : -1"
                data-testid="graph-merged-link"
                class="text-(--d-accent-text)"
                :class="LINK"
                @click.stop="emit('openMerged')"
                @keydown.enter.stop
                @keydown.space.stop
                v-text="ciStatus.merged"
              />
            </template>
          </i18n-t>
          <button
            v-if="ciStatus.pipeline"
            type="button"
            role="link"
            :tabindex="current ? 0 : -1"
            data-testid="graph-merged-short"
            class="text-(--d-accent-text) @min-[18rem]/card:hidden"
            :class="LINK"
            @click.stop="emit('openMerged')"
            @keydown.enter.stop
            @keydown.space.stop
            v-text="ciStatus.merged"
          />
        </span>
      </span>
      <span
        v-else-if="ciStatus?.kind === 'loading'"
        data-testid="graph-ci-status"
        data-state="loading"
        class="flex min-w-0 items-center gap-1.25 truncate text-11 text-(--d-faint)"
      >
        <LoaderCircle
          aria-hidden="true"
          class="d-spinning size-3 shrink-0"
        />{{ ciStatus.text }}
      </span>
      <span
        v-else-if="ciStatus?.kind === 'error'"
        data-testid="graph-ci-status"
        data-state="error"
        class="flex min-w-0 flex-1 items-center gap-1.25 text-11 text-(--d-muted)"
      >
        <TriangleAlert
          aria-hidden="true"
          class="size-3 shrink-0 text-(--d-warning-text)"
        />
        <span
          class="min-w-0 truncate"
          :title="ciStatus.text"
        >{{ ciStatus.text }}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          tabindex="-1"
          data-testid="graph-ci-retry"
          class="d-press h-5 shrink-0 rounded-5 px-1.5 text-11 font-normal text-(--d-accent-text) hover:bg-(--d-accent-soft) hover:text-(--d-accent-text)"
          @click.stop="emit('retryStatus')"
        >
          {{ t('forge.ci.tryAgain') }}
        </Button>
      </span>
      <span
        v-else-if="row.kind === 'note'"
        class="flex min-w-0 items-center gap-1.5 truncate text-11 text-(--d-faint)"
      >
        <LoaderCircle
          v-if="row.state === 'loading'"
          aria-hidden="true"
          class="d-spinning size-3 shrink-0"
        />{{ noteText }}
      </span>
    </div>
  </div>
</template>
