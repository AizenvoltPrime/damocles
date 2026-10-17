<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, reactive, ref, shallowRef, toRaw, triggerRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDevicePixelRatio, useElementSize, useVirtualList } from '@vueuse/core';
import { ArrowDownToLine, ArrowUpFromLine, CloudDownload, CloudUpload, Crosshair, GitBranch, GitCommitHorizontal, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import { ARRIVAL_MS } from '@/composables/useLiveArrivals';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import { visibleLines, visibleText } from '@shared/visible-text';
import type { OverlayRefPickerRef } from '../../preload/overlay-channels';
import { MAX_REF_PICKER_REFS } from '../../preload/overlay-channels';
import type { ScmArtifactsResult, ScmCommitDetailsResult, ScmHistoryCommit, ScmHistoryLoad, ScmHistoryRef, ScmHistoryResult, ScmRunRequest } from '../../preload/scm-channels';
import type { DamoclesShellApi, GraphRefChoice } from '../../preload/shell-channels';
import SidebarSection from '../components/SidebarSection.vue';
import ScmStateCard from '../scm/ScmStateCard.vue';
import type { ScmStateCard as StateCard } from '../scm/scm-state';
import { SCM_STORE } from '../scm/scm-store';
import { fromNow } from '../scm/scm-list';
import { actionOf, graphCommitCall, graphCommitMenu, graphRefCall, graphRefMenu, isGraphCommitAction, isGraphRefAction, toOverlayMenu, type ScmMenuNode, type ScmRowCall } from '../scm/scm-menus';
import GraphRow from './GraphRow.vue';
import CommitDetails from './CommitDetails.vue';
import {
  chipText,
  composeListRows,
  headInChoice,
  isDetailRow,
  keptChoice,
  laneListRows,
  lanePath,
  pickerRefs,
  refChangeAction,
  MESSAGE_LINE_REM,
  ROW_REM,
  rowRem,
  sameChoice,
  shortFromNow,
  type DetailsState,
  type GraphListRow,
} from './graph-model';
import { laneMetrics } from './lanes';

// The Graph section (plan slice 13, A.4; VS Code's SCM Graph view, scmHistoryViewPane.ts): the history of the repository Source
// control shows (D58, D31), with the ref picker, paging, Go to Current, the Outdated rule and the commit and ref menus. Every
// action calls the damocles:scm:* operation Source control's menus call for it.
const props = defineProps<{
  api: DamoclesShellApi;
  // the shown folder's root key (D31)
  projectKey: string | undefined;
  // the ref choice per repository root, as the layout keeps it (AD8)
  choices: { readonly [root: string]: GraphRefChoice };
  collapsed: boolean;
  bodySize?: number | undefined;
}>();
const emit = defineEmits<{ toggle: []; choice: [root: string, choice: GraphRefChoice] }>();
const { t, locale } = useI18n();
const store = inject(SCM_STORE)!;

// ms between refreshes of the rows' relative times
const AGE_TICK_MS = 60_000;
// rows from the end of the loaded list at which the next page is read (VS Code's pageOnScroll)
const PAGE_AHEAD_ROWS = 10;
// ms the list keeps its leave and move transitions armed after a user's expand or collapse
const ARMED_MS = 600;
// skeleton rows while the first page loads
const SKELETON_ROWS = 6;

const section = ref<InstanceType<typeof SidebarSection> | null>(null);
const treeId = useId();
const helpId = useId();

const view = computed(() => (props.projectKey === undefined ? undefined : store.views.value.get(props.projectKey)));
const untrusted = computed(() => view.value?.state === 'untrusted');
// D58: the repository Source control's picker and the Repositories section select; a closed one is in no view.
const repo = computed(() => {
  const current = view.value;
  if (current?.state !== 'ready' || current.selectedRepoId === null) return undefined;
  return current.repos.find((entry) => entry.repoId === current.selectedRepoId);
});
const repoId = computed(() => repo.value?.repoId);
const snapshot = computed(() => (repoId.value === undefined ? undefined : store.snapshots.value.get(repoId.value)));
const choice = computed<GraphRefChoice>(() => (repo.value ? props.choices[repo.value.root] ?? 'auto' : 'auto'));
const choiceKey = computed(() => JSON.stringify(choice.value));

type Status = 'idle' | 'loading' | 'ready' | 'empty' | 'failed' | 'untrusted';
const status = ref<Status>('idle');
const commits = shallowRef<readonly ScmHistoryCommit[]>([]);
const load = shallowRef<ScmHistoryLoad | undefined>(undefined);
const cursor = ref<string | undefined>(undefined);
const loading = ref(false);
const loadingMore = ref(false);
// the last page read failed: the list ends in a row to try again, and scrolling reads no page until it is used
const moreFailed = ref(false);
const outdated = ref(false);
const expanded = shallowRef(new Set<string>());
const details = shallowRef(new Map<string, DetailsState>());
// the hovered commit (its lane lights) and the row holding the roving tabindex
const hovered = ref<string | null>(null);
const focusedKey = ref<string | null>(null);
// a load asked while one runs is run once that one ends
let again = false;
let generation = 0;
// what the list showed before, for live arrivals: hashes already seen for this repository and choice
let seen = new Set<string>();
let seenFor = '';
let headRevision: { repoId: string; revision: string } | undefined;
// the repository and choice (as choiceKey writes it) the rows show once a load landed; a choice that becomes it loads nothing
let shownFor: string | undefined;
// the list must load when the section opens again
let stale = false;

const run = (request: ScmRunRequest): Promise<unknown> => store.api.run(request);
async function call(entry: ScmRowCall): Promise<void> {
  await ('run' in entry ? run(entry.run) : store.api.copy(entry.copy));
}

// Lanes on whole device pixels at the current font and scale (plan slice 13's 26px rows).
const { pixelRatio } = useDevicePixelRatio();
const rowHeight = computed(() => Math.round(remPx(ROW_REM)));
const lane = computed(() => laneMetrics(remPx(1), pixelRatio.value));

// The message block's lines as they wrap in the card (CommitDetails.vue's 12.5px text beside the commit's lanes), so a long
// one-line message gets the lines it needs before the block scrolls.
const tree = ref<HTMLElement | null>(null);
const { width: treeWidth } = useElementSize(tree);
// rem around the message text in a detail row beside the tree's content box: the twistie column and its margin, two gaps, the
// card's padding and the row's end padding (CommitDetails.vue)
const MESSAGE_CHROME_REM = 0.875 + 0.75 + 1.25 + 0.375;
// A hidden copy of the message block (CommitDetails.vue's text, line height, wrapping and scrollbar gutter) at the card's
// width, rendered beside the tree rather than inside the virtual list's own children: its height in lines is what the block
// needs.
const probe = ref<HTMLElement | null>(null);
function messageLines(text: string, lanes: number): number {
  const element = probe.value;
  // the card's two 1px borders
  const width = treeWidth.value - remPx(MESSAGE_CHROME_REM) - lane.value.width * (Math.max(lanes, 1) + 1) - 2;
  if (!element || width <= 0) return text.split('\n').length;
  element.style.width = `${width}px`;
  element.textContent = visibleLines(text);
  return Math.max(1, Math.round(element.scrollHeight / remPx(MESSAGE_LINE_REM)));
}

// The px a subject takes on one line at the row's 12px text, measured with the tree's font, so its minimum share is no wider.
let measurer: CanvasRenderingContext2D | null | undefined;
// the canvas font, read from the tree's style once per root font size rather than once per subject
let measurerFont: string | undefined;
const subjectWidths = new Map<string, number>();
function subjectWidth(text: string): number {
  let width = subjectWidths.get(text);
  if (width !== undefined) return width;
  measurer ??= document.createElement('canvas').getContext('2d');
  if (!measurer) return 0;
  if (measurerFont === undefined) {
    const font = `${remPx(0.75)}px ${getComputedStyle(tree.value ?? document.body).fontFamily}`;
    measurer.font = font;
    // kept only once read from the tree itself, which mounts after the first rows render
    if (tree.value) measurerFont = font;
  }
  width = Math.ceil(measurer.measureText(visibleText(text)).width);
  subjectWidths.set(text, width);
  return width;
}
// the root font changes every width
watch(() => remPx(1), () => {
  subjectWidths.clear();
  measurerFont = undefined;
});

// The lanes and their geometry depend on the commits and the lane metrics alone, so expanding, collapsing, a details answer,
// a page read starting or the tree's width changing composes rows on top of them without running the port again.
const laneRows = computed(() => laneListRows(commits.value, load.value, { rowHeight: rowHeight.value, laneWidth: lane.value.width }));
const rows = computed<GraphListRow[]>(() => composeListRows(laneRows.value, {
  expanded: expanded.value,
  details: details.value,
  more: loadingMore.value ? 'loading' : moreFailed.value ? 'failed' : undefined,
  messageLines,
}));
// aria-setsize of the commit rows: their count once the history ended, else unknown (-1) while pages remain
const laneCount = computed(() => (cursor.value === undefined ? laneRows.value.length : -1));
// The message block rounds up, so its last line never sits half a pixel under a scrollbar.
const heightOf = (row: GraphListRow | undefined): number => {
  if (!row) return rowHeight.value;
  return row.kind === 'message' ? Math.ceil(remPx(rowRem(row))) + (row.last ? 1 : 0) : Math.round(remPx(rowRem(row)));
};
const { list: visibleRows, containerProps, wrapperProps } = useVirtualList(rows, { itemHeight: (index) => heightOf(rows.value[index]), overscan: 10 });
watch(() => containerProps.ref.value, (element) => {
  tree.value = element;
}, { immediate: true });

const now = ref(Date.now());
const ageTimer = setInterval(() => {
  now.value = Date.now();
}, AGE_TICK_MS);
const timeOf = (date: number): string => fromNow(date, now.value, locale.value);
const shortTimeOf = (date: number): string => shortFromNow(date, now.value, locale.value);

// Live arrivals (useLiveArrivals.ts's rule): commits new to a reload of the same repository and choice enter once; a first load,
// a page read on scroll and a row a scroll mounts never do.
const arrivals = reactive(new Map<string, number>());
const arrivalTimers = new Set<ReturnType<typeof setTimeout>>();
function markArrivals(hashes: readonly string[]): void {
  hashes.forEach((hash, index) => arrivals.set(hash, index));
  const timer = setTimeout(() => {
    arrivalTimers.delete(timer);
    for (const hash of hashes) arrivals.delete(hash);
  }, ARRIVAL_MS);
  arrivalTimers.add(timer);
}

// HEAD moved to another commit since the last load of the repository: its node's halo pulses once. Go to Current landed on a
// commit: its row flashes once. Each mark outlives its animation by a little and no more, so a row a later scroll mounts never
// replays it.
const ONE_SHOT_MS = 1000;
const halo = ref<string | null>(null);
const flash = ref<string | null>(null);
let haloTimer: ReturnType<typeof setTimeout> | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
function pulseHalo(hash: string): void {
  halo.value = hash;
  clearTimeout(haloTimer);
  haloTimer = setTimeout(() => {
    halo.value = null;
  }, ONE_SHOT_MS);
}
function flashRow(key: string): void {
  flash.value = key;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash.value = null;
  }, ONE_SHOT_MS);
}

function reset(): void {
  generation++;
  commits.value = [];
  load.value = undefined;
  cursor.value = undefined;
  loading.value = false;
  loadingMore.value = false;
  moreFailed.value = false;
  outdated.value = false;
  expanded.value = new Set();
  details.value = new Map();
  again = false;
  shownFor = undefined;
  halo.value = null;
  flash.value = null;
  focusedKey.value = null;
  hovered.value = null;
  status.value = 'idle';
}

/** Reads the first page for the repository and its choice, dropping what is loaded; one asked meanwhile runs after it. */
async function reload(): Promise<void> {
  const id = repoId.value;
  const root = repo.value?.root;
  if (id === undefined || root === undefined || untrusted.value) return;
  if (props.collapsed) {
    stale = true;
    return;
  }
  if (loading.value) {
    again = true;
    return;
  }
  stale = false;
  const asked = choice.value;
  // a page read under way belongs to the load this one replaces: its answer is dropped, so its row goes now
  const read = ++generation;
  loadingMore.value = false;
  moreFailed.value = false;
  loading.value = true;
  if (commits.value.length === 0) status.value = 'loading';
  // A refused invoke shows the failure note too, rather than a list that never stops loading.
  const result = await store.api.history({ repoId: id, refs: typeof asked === 'string' ? asked : [...asked] }).catch((): ScmHistoryResult => ({ ok: false, reason: 'failed' }));
  if (read !== generation) return;
  loading.value = false;
  // the choice changed while this load ran: its answer, and the pruned choice it would keep, belong to the old one
  if (!sameChoice(asked, choice.value)) {
    again = false;
    await reload();
    return;
  }
  if (!result.ok || !result.page.load) {
    commits.value = [];
    load.value = undefined;
    cursor.value = undefined;
    shownFor = undefined;
    status.value = result.ok ? 'failed' : result.reason === 'untrusted' ? 'untrusted' : result.reason === 'empty' ? 'empty' : result.reason === 'noRepository' ? 'idle' : 'failed';
  } else {
    const page = result.page;
    const next = page.load!;
    const key = `${id}\0${JSON.stringify(asked)}`;
    if (seenFor === key && status.value === 'ready') markArrivals(page.commits.filter((commit) => !seen.has(commit.hash)).map((commit) => commit.hash));
    else seen = new Set();
    seenFor = key;
    for (const commit of page.commits) seen.add(commit.hash);
    const revision = next.headRefs.head.revision;
    if (headRevision?.repoId === id && headRevision.revision !== revision) pulseHalo(revision);
    headRevision = { repoId: id, revision };
    commits.value = page.commits;
    load.value = next;
    cursor.value = page.cursor;
    status.value = 'ready';
    outdated.value = false;
    const present = new Set(page.commits.map((commit) => commit.hash));
    if ([...expanded.value].some((hash) => !present.has(hash))) expanded.value = new Set([...expanded.value].filter((hash) => present.has(hash)));
    // VS Code's refresh shows the top again.
    containerProps.ref.value?.scrollTo({ top: 0 });
    const kept = keptChoice(asked, next.resolvedRefs);
    shownFor = `${id}\0${JSON.stringify(kept)}`;
    if (!sameChoice(kept, asked)) emit('choice', root, kept);
  }
  if (again) {
    again = false;
    await reload();
  }
}

/** Reads the next page of the current load, which reads the snapshot the first page resolved. */
async function loadMore(): Promise<boolean> {
  const id = repoId.value;
  const from = cursor.value;
  if (id === undefined || from === undefined || loading.value || loadingMore.value) return false;
  const read = generation;
  moreFailed.value = false;
  loadingMore.value = true;
  const asked = choice.value;
  const result = await store.api.history({ repoId: id, refs: typeof asked === 'string' ? asked : [...asked], cursor: from }).catch((): ScmHistoryResult => ({ ok: false, reason: 'failed' }));
  if (read !== generation) return false;
  loadingMore.value = false;
  // the cursor stays, so the row's Try again reads this page again
  if (!result.ok) {
    moreFailed.value = true;
    return false;
  }
  const known = new Set(commits.value.map((commit) => commit.hash));
  const added = result.page.commits.filter((commit) => !known.has(commit.hash));
  for (const commit of added) seen.add(commit.hash);
  commits.value = [...commits.value, ...added];
  cursor.value = result.page.cursor;
  return true;
}

watch([repoId, choiceKey, untrusted], ([id, key], [previousId]) => {
  if (id !== previousId) {
    reset();
    seen = new Set();
    seenFor = '';
  }
  if (untrusted.value) {
    reset();
    status.value = 'untrusted';
    return;
  }
  // the choice a load pruned and emitted itself: the rows already show it
  if (!loading.value && shownFor === `${id}\0${key}`) return;
  void reload();
}, { immediate: true });

function retryMore(): void {
  if (moreFailed.value) void loadMore();
}

watch(() => props.collapsed, (collapsed) => {
  if (!collapsed && stale) void reload();
});

// HEAD's ref changed (a checkout): the Graph reloads, as VS Code's historyItemRef id change does. A change of repository
// changes the snapshot's HEAD too, and its own watcher above loads it.
const headKey = computed(() => {
  const head = snapshot.value?.head;
  if (!head) return undefined;
  return head.type === 'detached' ? `detached:${head.commit}` : `${head.type}:${head.name}`;
});
watch([repoId, headKey], ([id, next], [previousId, previous]) => {
  if (id === previousId && next !== undefined && previous !== undefined && next !== previous) void reload();
});

const atTop = (): boolean => (containerProps.ref.value?.scrollTop ?? 0) <= 0;

// A ref change: one the engine made reloads; one made in the background reloads at the top, else marks the graph Outdated.
const stopArtifacts = store.onArtifactsChanged((changed) => {
  if (changed.repoId !== repoId.value || changed.refs === undefined) return;
  if (props.collapsed) {
    stale = true;
    return;
  }
  if (refChangeAction(changed.refs === 'background', atTop()) === 'reload') void reload();
  else outdated.value = true;
});

function onScroll(): void {
  const container = containerProps.ref.value;
  if (!container) return;
  if (outdated.value && container.scrollTop <= 0) {
    void reload();
    return;
  }
  const end = visibleRows.value.at(-1)?.index ?? 0;
  if (cursor.value !== undefined && !moreFailed.value && end >= rows.value.length - PAGE_AHEAD_ROWS) void loadMore();
}
// A first page shorter than the list's height leaves nothing to scroll: the next page loads as the rows end in view.
watch(visibleRows, () => {
  const end = visibleRows.value.at(-1)?.index ?? 0;
  if (status.value === 'ready' && cursor.value !== undefined && !moreFailed.value && end >= rows.value.length - PAGE_AHEAD_ROWS) void loadMore();
});

// The header chip (A.4) and the title actions.
const chip = computed(() => chipText(choice.value, { auto: t('graph.auto'), all: t('graph.all'), refs: (n) => t('graph.refsCount', n, { named: { n } }) }));
const ready = computed(() => status.value === 'ready');
const canGoToCurrent = computed(() => ready.value && load.value !== undefined && headInChoice(choice.value, load.value));
const hasRemotes = computed(() => (snapshot.value?.remotes.length ?? 0) > 0);
const onBranch = computed(() => snapshot.value?.head?.type === 'branch' && snapshot.value.commit !== null);
const upstream = computed(() => snapshot.value?.upstream ?? null);
const upstreamName = computed(() => load.value?.headRefs.upstream?.name ?? (upstream.value ? `${upstream.value.remote}/${upstream.value.branch}` : ''));

// The refresh icon spins while a load runs and then coasts to its next full turn rather than snapping upright.
const spinner = ref<HTMLElement | null>(null);
const settle = ref<{ from: number; time: number } | null>(null);
watch(loading, (on, was) => {
  const element = spinner.value;
  if (on || !was || !element) {
    settle.value = null;
    return;
  }
  // Read before the patch drops .d-spinning; reduced motion and a spin never painted leave no angle to settle from.
  const matrix = /^matrix\(([^,]+),\s*([^,]+)/.exec(getComputedStyle(element).transform);
  if (!matrix) return;
  const angle = (Math.atan2(Number(matrix[2]), Number(matrix[1])) * 180 / Math.PI + 360) % 360;
  if (angle === 0) return;
  settle.value = { from: angle, time: Math.round(Math.max(0.3, ((360 - angle) / 360) * 1.2) * 100) / 100 };
});

// A chip text on its way out is presentation only: it leaves without its test id and hidden from assistive technology.
function retire(element: Element): void {
  element.removeAttribute('data-testid');
  element.setAttribute('aria-hidden', 'true');
}

function refresh(): void {
  outdated.value = false;
  void reload();
}

async function goToCurrent(): Promise<void> {
  if (!canGoToCurrent.value) return;
  for (;;) {
    const index = rows.value.findIndex((row) => row.kind === 'commit' && row.row.kind === 'HEAD');
    if (index >= 0) {
      const row = rows.value[index]!;
      const container = containerProps.ref.value;
      if (container) {
        const top = rows.value.slice(0, index).reduce((sum, each) => sum + heightOf(each), 0);
        // The CSS reduced-motion rule does not reach a script's smooth scroll.
        container.scrollTo({ top: Math.max(0, top - (container.clientHeight - heightOf(row)) / 2), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      }
      focusedKey.value = row.key;
      flashRow(row.key);
      return;
    }
    if (cursor.value === undefined || !(await loadMore())) return;
  }
}

// The ref picker (A.4), in the overlay: the repository's branches, remote branches and tags, read through the artifacts list.
const pickerOpen = ref(false);
async function openPicker(event: MouseEvent): Promise<void> {
  const id = repoId.value;
  const root = repo.value?.root;
  if (id === undefined || root === undefined || pickerOpen.value) return;
  const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
  pickerOpen.value = true;
  const ask = async (): Promise<void> => {
    const groups = await Promise.all((['branches', 'remoteBranches', 'tags'] as const).map((group) =>
      store.api.artifacts({ repoId: id, group }).catch((): ScmArtifactsResult => ({ ok: false, reason: 'failed' }))));
    const listed = groups.flatMap((result): OverlayRefPickerRef[] => {
      if (!result.ok) return [];
      const { artifacts } = result;
      return artifacts.group === 'branches' || artifacts.group === 'remoteBranches' || artifacts.group === 'tags' ? artifacts.rows.map((row) => ({ id: row.ref, name: row.name })) : [];
    });
    const current = choice.value;
    const { refs, omitted } = pickerRefs(listed, current, MAX_REF_PICKER_REFS);
    const offered = new Set(refs.map((ref) => ref.id));
    const selected: GraphRefChoice = typeof current === 'string' ? current : current.filter((ref) => offered.has(ref));
    const answer = await props.api.requestOverlay({
      kind: 'refPicker',
      anchor: { x: Math.max(0, anchor.left), y: Math.max(0, anchor.top), width: anchor.width, height: anchor.height },
      refs,
      selected: typeof selected === 'string' ? selected : selected.length === 0 ? 'auto' : [...selected],
      failed: groups.some((result) => !result.ok),
      omitted,
    });
    if (answer.kind === 'refPicker' && !sameChoice(answer.choice, choice.value)) emit('choice', root, answer.choice);
  };
  try {
    await (section.value ? section.value.holdActions(ask()) : ask());
  } finally {
    pickerOpen.value = false;
  }
}

// Expanding a commit (the plan's flattened detail rows), its details read once.
async function readDetails(hash: string): Promise<void> {
  const id = repoId.value;
  if (id === undefined) return;
  const read = generation;
  details.value.set(hash, { state: 'loading' });
  triggerRef(details);
  const result = await store.api.commitDetails({ repoId: id, hash }).catch((): ScmCommitDetailsResult => ({ ok: false, reason: 'failed' }));
  if (read !== generation) return;
  details.value.set(hash, result.ok ? { state: 'ready', details: result.details } : { state: 'failed' });
  triggerRef(details);
}

// Motion: detail rows tuck in one after another on a user's expand, and leave by the armed list's transition on collapse; a
// scroll never plays either.
const armed = ref(false);
let armTimer: ReturnType<typeof setTimeout> | undefined;
const revealing = reactive(new Map<string, number>());
let revealFor: { hash: string; until: number } | undefined;

function arm(): void {
  armed.value = true;
  clearTimeout(armTimer);
  armTimer = setTimeout(() => {
    armed.value = false;
    revealing.clear();
  }, ARMED_MS);
}

function setExpanded(hash: string, open: boolean): void {
  if (expanded.value.has(hash) === open) return;
  arm();
  const next = new Set(expanded.value);
  if (open) {
    next.add(hash);
    revealFor = { hash, until: Date.now() + ARMED_MS };
    const state = details.value.get(hash);
    if (!state || state.state === 'failed') void readDetails(hash);
  } else {
    next.delete(hash);
  }
  expanded.value = next;
}

watch(rows, (list, previous) => {
  const pending = revealFor && revealFor.until > Date.now() ? revealFor : undefined;
  if (!pending) return;
  const before = new Set((previous ?? []).map((row) => row.key));
  let index = revealing.size;
  for (const row of list) if (isDetailRow(row) && row.hash === pending.hash && !before.has(row.key)) revealing.set(row.key, index++);
  arm();
});

// The hovered commit's lane path stays lit while the other lanes fade.
const lit = computed(() => (hovered.value === null ? null : lanePath(rows.value, hovered.value)));

function onHover(row: GraphListRow, on: boolean): void {
  if (on) hovered.value = row.kind === 'commit' ? row.key : null;
  else if (hovered.value === row.key) hovered.value = null;
}

// The keyboard: a tree with a roving tabindex over the flattened rows.
const focusedIndex = computed(() => Math.max(0, rows.value.findIndex((row) => row.key === focusedKey.value)));
const rowElement = (key: string): HTMLElement | null =>
  [...(containerProps.ref.value?.querySelectorAll<HTMLElement>('[data-row-key]') ?? [])].find((element) => element.dataset['rowKey'] === key) ?? null;

function revealIndex(index: number): void {
  const container = containerProps.ref.value;
  if (!container || index < 0) return;
  const top = rows.value.slice(0, index).reduce((sum, row) => sum + heightOf(row), 0);
  const height = heightOf(rows.value[index]);
  if (top < container.scrollTop) container.scrollTop = top;
  else if (top + height > container.scrollTop + container.clientHeight) container.scrollTop = top + height - container.clientHeight;
}

async function focusRow(index: number): Promise<void> {
  const clamped = Math.min(Math.max(index, 0), rows.value.length - 1);
  const row = rows.value[clamped];
  if (!row || (row.kind === 'more' && row.state === 'loading')) return;
  focusedKey.value = row.key;
  revealIndex(clamped);
  await nextTick();
  rowElement(row.key)?.focus({ preventScroll: true });
}

// A focused row the list scrolls out of view unmounts; the tree keeps focus so the keys still reach it.
watch(visibleRows, (list) => {
  const container = containerProps.ref.value;
  const key = focusedKey.value;
  if (!container || key === null || !container.contains(document.activeElement) || document.activeElement === container) return;
  if (!list.some(({ data }) => data.key === key)) container.focus({ preventScroll: true });
});

const commitOf = (row: GraphListRow): string | undefined => (row.kind === 'commit' ? row.key : isDetailRow(row) ? row.hash : undefined);

type Anchor = { left: number; top: number; width: number; height: number };
// One menu at a time: the context-menu key's keydown opens it, and the contextmenu event Windows sends on the key's release
// must not open a second.
let menuOpen = false;
async function showMenu(nodes: readonly ScmMenuNode[], label: string, anchor: Anchor, caption?: string): Promise<string | undefined> {
  const items = toOverlayMenu(nodes, (key) => t(`scm.${key}`));
  if (items.length === 0 || menuOpen) return undefined;
  menuOpen = true;
  try {
    const answer = await props.api.requestOverlay({
      kind: 'menu',
      label,
      anchor: { x: Math.max(0, anchor.left), y: Math.max(0, anchor.top), width: anchor.width, height: anchor.height },
      items,
      ...(caption !== undefined ? { caption } : {}),
    });
    return answer.kind === 'menu' ? answer.itemId : undefined;
  } finally {
    menuOpen = false;
  }
}

async function openCommitMenu(hash: string, anchor: Anchor): Promise<void> {
  const id = repoId.value;
  if (id === undefined) return;
  const commit = commits.value.find((each) => each.hash === hash);
  const nodes = graphCommitMenu({ hasUpstream: load.value?.headRefs.upstream !== undefined, hasBase: load.value?.headRefs.base !== undefined, operation: snapshot.value?.operation ?? null });
  const itemId = await showMenu(nodes, t('graph.rowMenu', { hash: hash.slice(0, 8) }), anchor, commit ? `${hash.slice(0, 8)} ${visibleText(commit.subject)}` : undefined);
  if (itemId === undefined) return;
  const action = actionOf(itemId);
  if (isGraphCommitAction(action)) await call(graphCommitCall(action, id, hash));
}

async function openRefMenu(ref: ScmHistoryRef, rect: DOMRect): Promise<void> {
  const id = repoId.value;
  if (id === undefined) return;
  const nodes = graphRefMenu(ref, load.value?.headRefs.upstream?.id);
  const itemId = await showMenu(nodes, t('graph.refMenu', { name: visibleText(ref.name) }), rect);
  if (itemId === undefined) return;
  const action = actionOf(itemId);
  if (isGraphRefAction(action)) await call(graphRefCall(action, id, ref.id));
}

function openChanges(direction: 'incoming' | 'outgoing'): void {
  const id = repoId.value;
  if (id !== undefined) void run({ op: 'openGraphChanges', repoId: id, direction });
}

function activate(row: GraphListRow): void {
  const id = repoId.value;
  if (id === undefined) return;
  if (row.kind === 'commit') setExpanded(row.key, !row.expanded);
  else if (row.kind === 'changes') openChanges(row.direction);
  else if (row.kind === 'meta') void call(graphCommitCall('openCommit', id, row.hash));
  else if (row.kind === 'file') void run({ op: 'openCommit', repoId: id, commit: row.hash, path: row.file.path });
  else if (row.kind === 'more') retryMore();
}

function parentIndex(index: number): number {
  for (let candidate = index - 1; candidate >= 0; candidate--) if (rows.value[candidate]!.kind === 'commit') return candidate;
  return index;
}

function onKeydown(event: KeyboardEvent): void {
  const index = focusedIndex.value;
  const row = rows.value[index];
  if (!row || event.ctrlKey || event.metaKey || event.altKey) return;
  const page = Math.max(1, Math.floor((containerProps.ref.value?.clientHeight ?? 0) / rowHeight.value) - 1);
  switch (event.key) {
    case 'ArrowDown': void focusRow(index + 1); break;
    case 'ArrowUp': void focusRow(index - 1); break;
    case 'PageDown': void focusRow(index + page); break;
    case 'PageUp': void focusRow(index - page); break;
    case 'Home': void focusRow(0); break;
    case 'End': void focusRow(rows.value.length - 1); break;
    case 'ArrowRight':
      if (row.kind !== 'commit') return;
      if (!row.expanded) setExpanded(row.key, true);
      else void focusRow(index + 1);
      break;
    case 'ArrowLeft':
      if (row.kind === 'commit' && row.expanded) setExpanded(row.key, false);
      else if (isDetailRow(row)) void focusRow(parentIndex(index));
      else return;
      break;
    case 'Enter':
    case ' ':
      activate(row);
      break;
    case 'ContextMenu':
    case 'F10': {
      if (event.key === 'F10' && !event.shiftKey) return;
      const hash = commitOf(row);
      if (hash !== undefined) void openCommitMenu(hash, rowElement(row.key)?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 });
      break;
    }
    default:
      return;
  }
  event.preventDefault();
}

const pointAnchor = (event: MouseEvent): Anchor => ({ left: event.clientX, top: event.clientY, width: 0, height: 0 });

// States (A.4): an untrusted project runs no git and says so with Source control's trust card; a repository with no commit says
// "No commits yet."; outside git the section shows nothing.
const trustCard = computed<StateCard | undefined>(() => {
  const key = props.projectKey;
  if (status.value !== 'untrusted' || key === undefined) return undefined;
  return { id: 'untrusted', icon: ShieldAlert, tone: 'warning', text: t('graph.state.untrusted'), primary: { label: t('scm.state.untrusted.trust'), run: () => props.api.grantTrust(key) } };
});

onBeforeUnmount(() => {
  stopArtifacts();
  clearInterval(ageTimer);
  clearTimeout(armTimer);
  clearTimeout(haloTimer);
  clearTimeout(flashTimer);
  for (const timer of arrivalTimers) clearTimeout(timer);
});

const toolbarButton = 'size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25 disabled:opacity-40';
// Pull and Push give way first in a narrow header (Source control's sync does both), so the title beside them reads whole.
const SYNC_ACTION = '@max-[15.5rem]/header:hidden';
const raw = <T,>(value: T): T => toRaw(value);
</script>

<template>
  <SidebarSection
    ref="section"
    section="graph"
    :collapsed="collapsed"
    :body-size="bodySize"
    data-testid="graph-section"
    :has-chip="!!repo && !untrusted"
    @toggle="emit('toggle')"
  >
    <template
      v-if="repo && !untrusted"
      #badge
    >
      <Transition name="t-badge">
        <span
          v-if="outdated"
          data-testid="graph-outdated"
          :title="t('graph.outdatedTitle')"
          class="ml-1 flex h-4 shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--d-warning)_14%,transparent)] px-1.5 text-10 font-medium tracking-normal text-(--d-warning-text) normal-case"
        >
          <span
            aria-hidden="true"
            class="size-1.5 rounded-full bg-(--d-warning)"
          />{{ t('graph.outdated') }}
        </span>
      </Transition>
    </template>
    <template
      v-if="repo && !untrusted"
      #chip
    >
      <button
        type="button"
        data-testid="graph-ref-chip"
        :aria-label="t('graph.refChipAria', { choice: chip })"
        :title="t('graph.refChip')"
        aria-haspopup="dialog"
        :aria-expanded="pickerOpen"
        class="flex h-5 max-w-full min-w-0 items-center gap-1 rounded-5 px-1.5 font-mono text-10.5 text-(--d-faint) hover:bg-(--d-border2) hover:text-(--d-text) focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)] focus-visible:outline-none"
        :class="pickerOpen ? 'bg-(--d-border2) text-(--d-text)' : ''"
        @click.stop="openPicker"
      >
        <GitBranch
          aria-hidden="true"
          class="size-2.5 shrink-0"
        />
        <span class="inline-grid min-w-0">
          <Transition
            name="t-morph"
            @before-leave="retire"
          >
            <span
              :key="chip"
              data-testid="graph-ref-chip-text"
              class="truncate [grid-area:1/1]"
            >{{ chip }}</span>
          </Transition>
        </span>
      </button>
    </template>
    <template
      v-if="repo && !untrusted"
      #actions
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="graph-go-to-current"
        :disabled="!canGoToCurrent"
        :class="toolbarButton"
        :aria-label="t('graph.goToCurrent')"
        :title="t('graph.goToCurrent')"
        @click="goToCurrent"
      >
        <Crosshair aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="graph-refresh"
        :aria-busy="loading || undefined"
        :class="toolbarButton"
        :aria-label="t('graph.refresh')"
        :title="t('graph.refresh')"
        @click="refresh"
      >
        <span
          ref="spinner"
          aria-hidden="true"
          class="inline-flex"
          :class="loading ? 'd-spinning' : settle ? 'd-settle' : ''"
          :style="settle ? { '--settle-from': `${settle.from}deg`, '--settle-time': `${settle.time}s` } : undefined"
          @animationend.self="settle = null"
        ><RefreshCw /></span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="graph-fetch"
        :disabled="!hasRemotes"
        :class="toolbarButton"
        :aria-label="t('graph.fetchAll')"
        :title="t('graph.fetchAll')"
        @click="repoId && run({ op: 'fetch', repoId, scope: 'all' })"
      >
        <CloudDownload aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="graph-pull"
        :disabled="!upstream"
        :class="[toolbarButton, SYNC_ACTION]"
        :aria-label="t('graph.pull')"
        :title="t('graph.pull')"
        @click="repoId && run({ op: 'pull', repoId, rebase: false })"
      >
        <ArrowDownToLine aria-hidden="true" />
      </Button>
      <Button
        v-if="upstream"
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="graph-push"
        :class="[toolbarButton, SYNC_ACTION]"
        :aria-label="t('graph.push')"
        :title="t('graph.push')"
        @click="repoId && run({ op: 'push', repoId, to: false, force: false, followTags: false })"
      >
        <ArrowUpFromLine aria-hidden="true" />
      </Button>
      <Button
        v-else
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="graph-publish"
        :disabled="!onBranch || !hasRemotes"
        :class="[toolbarButton, SYNC_ACTION]"
        :aria-label="t('graph.publish')"
        :title="t('graph.publish')"
        @click="repoId && run({ op: 'publish', repoId })"
      >
        <CloudUpload aria-hidden="true" />
      </Button>
    </template>

    <Transition
      name="t-fade"
      mode="out-in"
    >
      <ScmStateCard
        v-if="trustCard"
        key="untrusted"
        :card="trustCard"
      />
      <div
        v-else-if="repo && (status === 'empty' || status === 'failed')"
        :key="status"
        data-testid="graph-state"
        :data-state="status"
        class="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pt-3.5 pb-4"
      >
        <component
          :is="status === 'empty' ? GitCommitHorizontal : TriangleAlert"
          aria-hidden="true"
          class="d-state-icon size-6.5"
          :class="status === 'empty' ? 'text-(--d-faint)' : 'text-(--d-warning)'"
        />
        <p class="text-12.5 text-pretty text-(--d-muted)">
          {{ t(status === 'empty' ? 'graph.state.empty' : 'graph.state.failed') }}
        </p>
      </div>
      <!-- The skeleton fades in only when the first page takes a moment, so a fast load never flashes it; its sweep moves by transform. -->
      <div
        v-else-if="repo && status === 'loading'"
        key="skeleton"
        data-testid="graph-skeleton"
        role="status"
        :aria-label="t('graph.loading')"
        class="flex animate-[o-fade_.2s_var(--ease-out)_.12s_both] flex-col px-1.5"
      >
        <div
          v-for="index in SKELETON_ROWS"
          :key="index"
          aria-hidden="true"
          class="flex items-center gap-1.5 pr-1.5"
          :style="{ height: `${rowHeight}px` }"
        >
          <span class="ml-0.5 w-3 shrink-0" />
          <svg
            class="shrink-0"
            :width="lane.width * 2"
            :height="rowHeight"
          >
            <g :transform="`translate(${lane.offset} 0)`">
              <path
                :d="`M ${lane.width} ${index === 1 ? rowHeight / 2 : 0} V ${index === SKELETON_ROWS ? rowHeight / 2 : rowHeight}`"
                fill="none"
                :stroke-width="lane.stroke"
                stroke="var(--d-border2)"
              />
              <circle
                :cx="lane.width"
                :cy="rowHeight / 2"
                :r="(lane.width * 4) / 11"
                fill="var(--d-panel)"
                stroke="var(--d-border2)"
                :stroke-width="lane.stroke"
              />
            </g>
          </svg>
          <!-- The sweep runs down the rows as a wave, each row --row steps after the one above. -->
          <span
            class="relative h-2 overflow-hidden rounded-5 bg-(--d-hover) after:absolute after:inset-y-0 after:left-0 after:w-2/5 after:-translate-x-full after:animate-[o-sweep_1.3s_ease-in-out_infinite] after:bg-linear-to-r after:from-transparent after:via-[color-mix(in_srgb,var(--d-text)_7%,transparent)] after:to-transparent after:[animation-delay:calc(var(--row)*90ms)]"
            :style="{ width: `${[62, 48, 70, 40, 56, 44][index - 1]}%`, '--row': String(index - 1) }"
          />
          <span class="flex-1" />
          <span
            class="relative h-2 w-8 overflow-hidden rounded-5 bg-(--d-hover) after:absolute after:inset-y-0 after:left-0 after:w-2/5 after:-translate-x-full after:animate-[o-sweep_1.3s_ease-in-out_infinite] after:bg-linear-to-r after:from-transparent after:via-[color-mix(in_srgb,var(--d-text)_7%,transparent)] after:to-transparent after:[animation-delay:calc(var(--row)*90ms)]"
            :style="{ '--row': String(index - 1) }"
          />
        </div>
      </div>
      <div
        v-else-if="repo && status === 'ready'"
        key="tree"
        class="relative flex min-h-0 flex-1 flex-col"
      >
        <div
          ref="probe"
          aria-hidden="true"
          class="pointer-events-none invisible absolute top-0 left-0 h-0 overflow-y-auto [scrollbar-gutter:stable] text-12.5/4.5 wrap-break-word whitespace-pre-wrap"
        />
        <!-- A virtualized tree (commits with their flattened details, roving tabindex); no shadcn part virtualizes a tree. -->
        <div
          v-bind="containerProps"
          :id="treeId"
          role="tree"
          tabindex="-1"
          data-testid="graph-tree"
          :aria-label="t('graph.treeLabel')"
          :aria-describedby="helpId"
          :aria-busy="loading || loadingMore || undefined"
          class="relative min-h-0 flex-1 overflow-x-hidden px-1.5 pb-2 outline-none"
          @keydown="onKeydown"
          @scroll.passive="onScroll"
          @pointerleave="hovered = null"
        >
          <div v-bind="wrapperProps">
            <!-- css off unless armed: a CSS-mode leave keeps a row a scroll unmounted in the DOM. -->
            <TransitionGroup
              :name="armed ? 't-row' : 't-row-off'"
              :css="armed"
              tag="div"
              class="relative"
            >
              <div
                v-for="{ data: row, index } in visibleRows"
                :key="row.key"
                role="none"
              >
                <GraphRow
                  v-if="row.kind === 'commit' || row.kind === 'changes'"
                  :id="`${treeId}-${index}`"
                  :row="row"
                  :set-size="laneCount"
                  :current="index === focusedIndex"
                  :height="heightOf(row)"
                  :lane="lane"
                  :lit="lit"
                  :hovered="hovered === row.key"
                  :time="row.kind === 'commit' ? shortTimeOf(row.row.commit!.authorDate) : ''"
                  :time-title="row.kind === 'commit' ? timeOf(row.row.commit!.authorDate) : ''"
                  :subject-width="row.kind === 'commit' ? subjectWidth(row.row.commit!.subject) : 0"
                  :count="row.kind === 'changes' ? (row.direction === 'incoming' ? load?.behind : load?.ahead) : undefined"
                  :upstream="upstreamName"
                  :arrival="arrivals.get(row.key)"
                  :halo="halo === row.key"
                  :flash="flash === row.key"
                  @toggle="focusedKey = row.key; row.kind === 'commit' && setExpanded(row.key, !row.expanded)"
                  @open="row.kind === 'changes' && openChanges(row.direction)"
                  @menu="openCommitMenu(row.key, pointAnchor($event))"
                  @ref-menu="(ref, rect) => openRefMenu(raw(ref), rect)"
                  @focus="focusedKey = row.key"
                  @hover="(on) => onHover(row, on)"
                />
                <CommitDetails
                  v-else-if="row.kind !== 'more'"
                  :id="`${treeId}-${index}`"
                  :row="row"
                  :current="index === focusedIndex"
                  :height="heightOf(row)"
                  :lane="lane"
                  :lit="lit"
                  :reveal="revealing.get(row.key)"
                  @copy-id="repoId && call(graphCommitCall('copyCommitId', repoId, row.hash))"
                  @open-changes="repoId && call(graphCommitCall('openCommit', repoId, row.hash))"
                  @open-file="(path) => repoId && run({ op: 'openCommit', repoId, commit: row.hash, path })"
                  @focus="focusedKey = row.key"
                  @menu="openCommitMenu(row.hash, pointAnchor($event))"
                />
                <div
                  v-else-if="row.state === 'loading'"
                  role="none"
                  data-testid="graph-more"
                  data-state="loading"
                  class="flex items-center gap-1.5 px-6 text-11 text-(--d-faint)"
                  :style="{ height: `${heightOf(row)}px` }"
                >
                  <RefreshCw
                    aria-hidden="true"
                    class="d-spinning size-3"
                  />{{ t('graph.loadingMore') }}
                </div>
                <!-- A tree row like the commits, so the keyboard reaches it; Enter or Space reads the page again. -->
                <div
                  v-else
                  :id="`${treeId}-${index}`"
                  role="treeitem"
                  aria-level="1"
                  data-testid="graph-more"
                  data-state="failed"
                  :data-row-key="row.key"
                  :tabindex="index === focusedIndex ? 0 : -1"
                  class="flex items-center gap-1.5 rounded-6 pr-1.5 pl-6 text-11 text-(--d-warning-text) outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
                  :style="{ height: `${heightOf(row)}px` }"
                  @focus="focusedKey = row.key"
                >
                  <TriangleAlert
                    aria-hidden="true"
                    class="size-3 shrink-0"
                  />
                  <span class="min-w-0 flex-1 truncate">{{ t('graph.loadMoreFailed') }}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    tabindex="-1"
                    data-testid="graph-more-retry"
                    class="d-press h-5 shrink-0 rounded-5 px-1.5 text-11 font-normal text-(--d-accent-text) hover:bg-(--d-accent-soft) hover:text-(--d-accent-text)"
                    @click.stop="focusedKey = row.key; retryMore()"
                  >
                    {{ t('graph.retry') }}
                  </Button>
                </div>
              </div>
            </TransitionGroup>
          </div>
        </div>
        <p
          :id="helpId"
          class="sr-only"
        >
          {{ t('graph.keyboardHelp') }}
        </p>
      </div>
    </Transition>
  </SidebarSection>
</template>
