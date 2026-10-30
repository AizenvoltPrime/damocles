<script setup lang="ts">
import { computed, getCurrentInstance, h, inject, nextTick, onBeforeUnmount, onMounted, ref, render, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { editor as MonacoEditor, IDisposable, IRange } from 'monaco-editor/editor/editor.api';
import { ArrowDownToLine, Check, ChevronDown, ChevronUp, Ellipsis, FileCheck, LoaderCircle, Target } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import type { OverlayMenuItem } from '../../../preload/overlay-channels';
import type { ScmMergeInputsResult, ScmMergeLabel } from '../../../preload/scm-channels';
import type { DamoclesShellApi, ShellEditorTab } from '../../../preload/shell-channels';
import { visibleText } from '@shared/visible-text';
import { EDITOR_STORE, type EditorTargetCommand } from '../editor-store';
import { lineEdits } from '../format-edits';
import { attachConflictLens, type ConflictLens } from './code-lens';
import { containsConflict, parseConflicts, type ConflictChoice } from './conflict-parser';
import { markerNames, matchRegions, mergeProgress, type ConflictRegion } from './merge-model';
import { createMergeWorker } from './merge-worker';
import MergeRegionActions from './MergeRegionActions.vue';
import LoadFailedNotice from '../LoadFailedNotice.vue';
import RollingNumber from '@/components/RollingNumber.vue';

// The 3-way merge editor (B28): Incoming and Current read-only above, the file's own document as the Result below, VS Code's
// mergeEditor.ts layout and commands.ts title actions. During a rebase Current is the branch rebased onto and shows first, as
// VS Code's openMergeEditor swaps its inputs. The Result's conflicts are its marker blocks, so accepting a side, an
// edit by hand, Reset Result or Compute Conflicts With Git all count the same way. An upload merge (an offline save that met
// a changed target) has no repository: its inputs and Complete Merge are main's document service's, and git computes nothing.
const props = defineProps<{ api: DamoclesShellApi; tab: ShellEditorTab & { merge: NonNullable<ShellEditorTab['merge']> } }>();
const { t } = useI18n();
const store = inject(EDITOR_STORE)!;
const appContext = getCurrentInstance()?.appContext ?? null;

// ms a region that just resolved shows its arrival wash (o-fade-out's length in style.css), then takes its static class
const RESOLVE_ARRIVE_MS = 450;
// rem of the action row above each conflict in the input panes
const ACTIONS_REM = 1.625;

// the input panes' editor hosts, set by the panes in whichever order they render
const inputHosts: Record<'incoming' | 'current', HTMLElement | null> = { incoming: null, current: null };
const resultHost = ref<HTMLElement | null>(null);
const inputs = shallowRef<Extract<ScmMergeInputsResult, { ok: true }> | null>(null);
const failure = ref<Extract<ScmMergeInputsResult, { ok: false }>['reason'] | null>(null);
const resultText = ref('');
const total = ref(0);
const focus = ref(0);
const busy = ref<'complete' | 'compute' | null>(null);
const regions = shallowRef<ConflictRegion[]>([]);

let result: MonacoEditor.IStandaloneCodeEditor | null = null;
let incoming: MonacoEditor.IStandaloneCodeEditor | null = null;
let current: MonacoEditor.IStandaloneCodeEditor | null = null;
let lens: ConflictLens | null = null;
const models: MonacoEditor.ITextModel[] = [];
const disposables: IDisposable[] = [];
let stopCommands: (() => void) | undefined;
let unmounted = false;
// node-diff3's alignment and Reset Result run here, so a large conflict never stalls the shell
const mergeWorker = createMergeWorker();

const progress = computed(() => mergeProgress(resultText.value, total.value));
const matched = computed(() => matchRegions(resultText.value, parseConflicts(resultText.value), regions.value));
const name = computed(() => props.tab.merge.path.slice(props.tab.merge.path.lastIndexOf('/') + 1));
const git = computed(() => ('repoId' in props.tab.merge ? props.tab.merge : null));
const paneOrder = computed(() => (inputs.value?.operation === 'rebase' ? (['current', 'incoming'] as const) : (['incoming', 'current'] as const)));
// the Result's document could not load; a remount of the tab asks main again
const resultFailed = computed(() => store.loadFailed(props.tab.merge.documentId));

let inputDecorations: { incoming: MonacoEditor.IEditorDecorationsCollection; current: MonacoEditor.IEditorDecorationsCollection } | null = null;
let resultDecorations: MonacoEditor.IEditorDecorationsCollection | null = null;
// The Result's resolved bars, which follow later edits: those still playing their arrival, and those settled. Collections of
// the Result editor, so no other editor of the file's model draws them.
let arrivingBars: MonacoEditor.IEditorDecorationsCollection | null = null;
let settledBars: MonacoEditor.IEditorDecorationsCollection | null = null;
const arriving = new Set<ConflictRegion>();
let arriveTimer: ReturnType<typeof setTimeout> | undefined;
// the input panes' action rows, one per region and pane, created once and patched in place so their swap animates
const zones: Array<{ side: 'incoming' | 'current'; region: number; node: HTMLElement }> = [];

function regionDecorations(side: 'incoming' | 'current'): MonacoEditor.IModelDeltaDecoration[] {
  const open = new Set(matched.value.filter((region): region is ConflictRegion => region !== null));
  return regions.value.flatMap((region, index) => {
    const span = region[side];
    if (span.lines === 0) return [];
    const state = open.has(region) ? 'open' : 'resolved';
    const arrive = arriving.has(region) ? ' qd-merge-arrive' : '';
    const focused = index === focusedRegion() ? ' qd-merge-focus' : '';
    return [{
      range: { startLineNumber: span.start, startColumn: 1, endLineNumber: span.start + span.lines - 1, endColumn: 1 },
      options: { description: 'merge-region', isWholeLine: true, className: `qd-merge-${side} qd-merge-${state}${arrive}${focused}`, linesDecorationsClassName: `qd-merge-bar qd-merge-${side}-bar` },
    }];
  });
}

// The region of the focused Result conflict, for the ring in the input panes.
function focusedRegion(): number {
  const region = matched.value[focus.value];
  return region ? regions.value.indexOf(region) : -1;
}

function decorate(): void {
  inputDecorations?.incoming.set(regionDecorations('incoming'));
  inputDecorations?.current.set(regionDecorations('current'));
  const conflicts = parseConflicts(resultText.value);
  resultDecorations?.set(conflicts.map((conflict, index) => ({
    range: { startLineNumber: conflict.startLine, startColumn: 1, endLineNumber: conflict.endLine, endColumn: 1 },
    options: { description: 'merge-result', isWholeLine: true, className: `qd-merge-result-open${index === focus.value ? ' qd-merge-focus' : ''}`, linesDecorationsClassName: 'qd-merge-bar qd-merge-open-bar' },
  })));
  renderZones();
}

// The input panes' action rows: one view zone above each region, holding its Accept buttons.
// A view zone draws under the lines' layer, which takes every click, so the row is an overlay widget kept at the top of an
// empty zone, as VS Code's ZoneWidget places its content.
function createZones(): void {
  for (const [side, editor] of [['incoming', incoming], ['current', current]] as const) {
    if (!editor) continue;
    const place = (node: HTMLElement): void => {
      const layout = editor.getLayoutInfo();
      node.style.left = `${layout.contentLeft}px`;
      node.style.width = `${layout.contentWidth - layout.verticalScrollbarWidth}px`;
    };
    editor.changeViewZones((accessor) => {
      regions.value.forEach((region, index) => {
        const node = document.createElement('div');
        node.className = 'qd-merge-actions';
        node.style.height = `${remPx(ACTIONS_REM)}px`;
        node.style.top = '-1000px';
        place(node);
        const id = `damocles.mergeActions.${side}.${index}`;
        editor.addOverlayWidget({ getId: () => id, getDomNode: () => node, getPosition: () => null });
        zones.push({ side, region: index, node });
        accessor.addZone({
          afterLineNumber: region[side].start - 1,
          heightInPx: remPx(ACTIONS_REM),
          domNode: document.createElement('div'),
          onDomNodeTop: (top) => {
            node.style.top = `${top}px`;
          },
        });
      });
    });
    disposables.push(editor.onDidLayoutChange(() => {
      for (const zone of zones) if (zone.side === side) place(zone.node);
    }));
  }
}

function renderZones(): void {
  const focused = focusedRegion();
  for (const zone of zones) {
    const region = regions.value[zone.region]!;
    const conflictIndex = matched.value.indexOf(region);
    const vnode = h(MergeRegionActions, {
      side: zone.side,
      resolved: conflictIndex < 0,
      focused: zone.region === focused,
      onAccept: (choice: ConflictChoice) => void accept(conflictIndex, choice),
    });
    vnode.appContext = appContext;
    render(vnode, zone.node);
  }
}

function resultModel(): MonacoEditor.ITextModel | null {
  return result?.getModel() ?? null;
}

// set while Reset Result or Compute Conflicts rebuilds the Result, whose new markers resolve nothing
let rebuilding = false;

/** Rebuilds the Result as one undoable edit, touching only the lines that change, and drops the resolved bars. */
function replaceResult(next: string): void {
  const model = resultModel();
  if (!model) return;
  const edits = lineEdits(model.getValue(), next);
  arrivingBars?.clear();
  settledBars?.clear();
  if (edits.length === 0) return;
  rebuilding = true;
  try {
    model.pushStackElement();
    model.pushEditOperations(result?.getSelections() ?? [], edits.map((edit) => ({ range: edit.range, text: edit.text })), () => null);
    model.pushStackElement();
  } finally {
    rebuilding = false;
  }
}

function markResolved(before: readonly (ConflictRegion | null)[]): void {
  const now = new Set(matched.value);
  for (const region of before) if (region && !now.has(region)) arriving.add(region);
  if (arriving.size === 0 || prefersReducedMotion()) {
    arriving.clear();
    return;
  }
  clearTimeout(arriveTimer);
  arriveTimer = setTimeout(() => {
    arriving.clear();
    decorate();
  }, RESOLVE_ARRIVE_MS);
}

function accept(index: number, choice: ConflictChoice): void {
  const model = resultModel();
  const conflict = parseConflicts(model?.getValue() ?? '')[index];
  if (!model || !conflict) return;
  result?.setPosition(model.getPositionAt(conflict.start));
  lens?.run(choice === 'current' ? 'acceptCurrent' : choice === 'incoming' ? 'acceptIncoming' : 'acceptBoth');
}

// Where the Result's text replaced a whole conflict (a lens, an accept, by hand), its lines get the resolved bar; a range
// is in the old text's lines, so later edits of one event shift by what earlier ones added.
function trackResolved(event: MonacoEditor.IModelContentChangedEvent, before: string): void {
  const model = resultModel();
  const old = parseConflicts(before);
  if (!model || rebuilding || old.length === 0) return;
  const ranges: Array<{ start: number; end: number }> = [];
  let shift = 0;
  for (const change of [...event.changes].sort((a, b) => a.rangeOffset - b.rangeOffset)) {
    const lines = change.text.split(/\r\n|\r|\n/).length - 1;
    const start = change.range.startLineNumber + shift;
    shift += lines - (change.range.endLineNumber - change.range.startLineNumber);
    const resolves = old.some((conflict) => conflict.start >= change.rangeOffset && conflict.end <= change.rangeOffset + change.rangeLength);
    if (resolves) ranges.push({ start, end: Math.max(start, start + lines - 1) });
  }
  if (ranges.length === 0 || !arrivingBars || !settledBars) return;
  const arriving = arrivingBars;
  const settled = settledBars;
  const bar = (range: IRange, className: string): MonacoEditor.IModelDeltaDecoration => ({ range, options: { isWholeLine: true, linesDecorationsClassName: className, stickiness: 1 } });
  const added = ranges.map(({ start, end }) => ({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 }));
  if (prefersReducedMotion()) {
    settled.set([...settled.getRanges(), ...added].map((range) => bar(range, SETTLED_BAR)));
    return;
  }
  arriving.set([...arriving.getRanges(), ...added].map((range) => bar(range, `${SETTLED_BAR} qd-merge-arrive`)));
  setTimeout(() => {
    if (unmounted || model.isDisposed()) return;
    settled.set([...settled.getRanges(), ...arriving.getRanges()].map((range) => bar(range, SETTLED_BAR)));
    arriving.clear();
  }, RESOLVE_ARRIVE_MS);
}

function goTo(step: 1 | -1): void {
  const count = progress.value.left;
  if (count === 0) return;
  focus.value = (focus.value + step + count) % count;
  reveal();
}

function reveal(): void {
  const conflict = parseConflicts(resultText.value)[focus.value];
  if (conflict) {
    result?.setPosition({ lineNumber: conflict.startLine, column: 1 });
    result?.revealLineInCenterIfOutsideViewport(conflict.startLine);
  }
  const region = matched.value[focus.value];
  if (region) {
    incoming?.revealLineInCenterIfOutsideViewport(region.incoming.start);
    current?.revealLineInCenterIfOutsideViewport(region.current.start);
  }
  decorate();
}

async function computeWithGit(diff3: boolean): Promise<void> {
  const repo = git.value;
  if (!repo) return;
  busy.value = 'compute';
  try {
    const answer = await props.api.scm.mergeFile({ repoId: repo.repoId, path: repo.path, diff3 });
    if (!answer.ok || unmounted) return;
    replaceResult(answer.text);
    total.value = parseConflicts(answer.text).length;
    focus.value = 0;
    reveal();
  } finally {
    busy.value = null;
  }
}

// Rebuilt from the inputs in the worker, its markers named by each label's marker, the names core gives git's merge-file; past
// the alignment's line cap, or with no worker, git's own merge rebuilds it.
async function resetResult(): Promise<void> {
  const merged = inputs.value;
  const model = resultModel();
  if (!merged || !model) return;
  busy.value = 'compute';
  const text = await mergeWorker.markers(merged.base, merged.current, merged.incoming, markerNames(merged.labels), model.getEOL()).catch(() => null);
  busy.value = null;
  if (unmounted) return;
  if (text === null) {
    await computeWithGit(false);
    return;
  }
  replaceResult(text);
  total.value = parseConflicts(text).length;
  focus.value = 0;
  reveal();
}

async function complete(): Promise<void> {
  // marker text the parser cannot pair (lengths that differ) still counts as one conflict left
  const left = Math.max(progress.value.left, containsConflict(resultText.value) ? 1 : 0);
  if (left > 0) {
    const answer = await props.api.requestOverlay({
      kind: 'confirm',
      title: t('merge.completeTitle', { name: name.value }),
      message: t('merge.unhandled', left, { named: { count: left } }),
      confirmLabel: t('merge.completeWithConflicts'),
      cancelLabel: t('merge.cancel'),
      danger: false,
    });
    if (answer.kind !== 'confirm' || !answer.confirmed) return;
  }
  busy.value = 'complete';
  try {
    store.flush(props.tab.merge.documentId);
    // main saves, stages (a repository's conflict only) and closes this tab
    const repo = git.value;
    if (repo) await props.api.scm.run({ op: 'completeMerge', repoId: repo.repoId, path: repo.path, documentId: repo.documentId });
    else await props.api.completeUploadMerge(props.tab.id);
  } finally {
    if (!unmounted) busy.value = null;
  }
}

async function openMore(event: MouseEvent): Promise<void> {
  const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const item = (id: string, label: string, icon: Extract<OverlayMenuItem, { kind: 'item' }>['icon']): OverlayMenuItem => ({ kind: 'item', id, label, ...(icon ? { icon } : {}) });
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: t('merge.moreActions'),
    anchor: { x: anchor.left, y: anchor.top, width: anchor.width, height: anchor.height },
    items: [
      ...(git.value ? [item('compute', t('merge.computeWithGit'), 'refresh-cw'), item('computeDiff3', t('merge.computeWithGitDiff3'), 'refresh-cw'), { kind: 'separator' } as const] : []),
      item('acceptAllIncoming', t('merge.acceptAllIncoming'), 'arrow-down-to-line'),
      item('acceptAllCurrent', t('merge.acceptAllCurrent'), 'circle-dot'),
      { kind: 'separator' },
      item('reset', t('merge.resetResult'), 'undo-2'),
      item('openFile', t('merge.openFile'), 'file'),
    ],
  });
  if (answer.kind !== 'menu') return;
  await runAction(answer.itemId);
}

async function runAction(id: string): Promise<void> {
  if (id === 'compute' || id === 'computeDiff3') await computeWithGit(id === 'computeDiff3');
  else if (id === 'acceptAllIncoming' || id === 'acceptAllCurrent') acceptAll(id === 'acceptAllIncoming' ? 'incoming' : 'current');
  else if (id === 'reset') await resetResult();
  else if (id === 'openFile') {
    const repo = git.value;
    if (repo) await props.api.scm.run({ op: 'openFile', repoId: repo.repoId, path: repo.path });
    else await props.api.editorTab({ action: 'openFile', tabId: props.tab.id });
  }
}

function acceptAll(choice: 'incoming' | 'current'): void {
  const model = resultModel();
  if (!model) return;
  lens?.run(choice === 'incoming' ? 'acceptAllIncoming' : 'acceptAllCurrent');
}

async function runCommand(command: EditorTargetCommand): Promise<void> {
  if (command === 'nextConflict' || command === 'nextChange') goTo(1);
  else if (command === 'previousConflict' || command === 'previousChange') goTo(-1);
  else if (command === 'acceptAllCurrent') acceptAll('current');
  else if (command === 'acceptAllIncoming') acceptAll('incoming');
  else if (command === 'acceptCurrent' || command === 'acceptIncoming' || command === 'acceptBoth') {
    accept(focus.value, command === 'acceptCurrent' ? 'current' : command === 'acceptIncoming' ? 'incoming' : 'both');
  }
}

// The inputs and Monaco load before the panes fill; a bar shows only past this many ms, so a fast load never flickers it.
const LOADING_BAR_DELAY_MS = 150;
const loadingBar = ref(false);
const barTimer = setTimeout(() => {
  loadingBar.value = true;
}, LOADING_BAR_DELAY_MS);

// A request main threw on reads as the failed read it is, so the bar stops and the tab says so.
async function mergeInputs(): Promise<ScmMergeInputsResult> {
  const repo = git.value;
  try {
    return await (repo ? props.api.scm.mergeInputs({ repoId: repo.repoId, path: repo.path }) : props.api.uploadMergeInputs(props.tab.id));
  } catch (err) {
    console.error('[merge] reading the merge inputs failed', err);
    return { ok: false, reason: 'failed' };
  }
}

onMounted(async () => {
  const [module, content, answer] = await Promise.all([store.monaco(), store.loadShown(props.tab.merge.documentId), mergeInputs()]);
  clearTimeout(barTimer);
  loadingBar.value = false;
  if (unmounted || content?.kind !== 'text') return;
  if (!answer.ok) {
    failure.value = answer.reason;
    return;
  }
  const model = await store.model(props.tab.merge.documentId);
  if (unmounted) return;
  inputs.value = answer;
  // the panes render in the operation's order before their editors mount
  await nextTick();
  if (unmounted) return;
  const monaco = module.useMonaco();
  const settings = store.settings.value;
  const base = { ...module.baseEditorOptions(), ...(settings ? { fontSize: settings.fontSize, wordWrap: settings.wordWrap } : {}), scrollBeyondLastLine: false, contextmenu: false, lineDecorationsWidth: remPx(0.75), minimap: { enabled: false } };
  const language = model.getLanguageId();
  const incomingModel = monaco.editor.createModel(answer.incoming, language);
  const currentModel = monaco.editor.createModel(answer.current, language);
  models.push(incomingModel, currentModel);
  if (!inputHosts.incoming || !inputHosts.current || !resultHost.value) return;
  incoming = monaco.editor.create(inputHosts.incoming, { ...base, readOnly: true, model: incomingModel });
  current = monaco.editor.create(inputHosts.current, { ...base, readOnly: true, model: currentModel });
  result = monaco.editor.create(resultHost.value, { ...base, readOnly: props.tab.readOnly, model });
  inputDecorations = { incoming: incoming.createDecorationsCollection(), current: current.createDecorationsCollection() };
  resultDecorations = result.createDecorationsCollection();
  arrivingBars = result.createDecorationsCollection();
  settledBars = result.createDecorationsCollection();
  lens = attachConflictLens(result, monaco, { t: (key, named) => (named ? t(key, named) : t(key)), appContext, sideTints: false });
  lens.setEnabled(!props.tab.readOnly);
  resultText.value = model.getValue();
  total.value = parseConflicts(resultText.value).length;
  disposables.push(incoming, current, result, lens, model.onDidChangeContent((event) => {
    const before = matched.value;
    trackResolved(event, resultText.value);
    resultText.value = model.getValue();
    focus.value = Math.min(focus.value, Math.max(0, progress.value.left - 1));
    markResolved(before);
    decorate();
  }));
  stopCommands = store.setCommandTarget(props.tab.id, runCommand);
  decorate();
  reveal();
  if (store.takeFocus(props.tab.id)) result.focus();
  // The Result works from its markers alone; the input panes' regions and action rows follow once aligned, and not at all
  // past the line cap or when the worker fails.
  const aligned = await mergeWorker.align(answer.base, answer.current, answer.incoming).catch(() => null);
  if (unmounted || !aligned) return;
  regions.value = aligned;
  createZones();
  decorate();
  reveal();
});

watch(() => store.settings.value, (settings) => {
  if (!settings) return;
  for (const editor of [incoming, current, result]) editor?.updateOptions({ fontSize: settings.fontSize, wordWrap: settings.wordWrap });
}, { deep: true });

onBeforeUnmount(() => {
  unmounted = true;
  clearTimeout(arriveTimer);
  clearTimeout(barTimer);
  stopCommands?.();
  mergeWorker.dispose();
  for (const zone of zones.splice(0)) render(null, zone.node);
  for (const disposable of disposables) disposable.dispose();
  for (const model of models) model.dispose();
});

// A side's branch or tag names, else its short hash; and the two together for the pane header and the tooltip.
const labelName = (label: ScmMergeLabel): string | undefined => label.detail || label.description;
const labelTip = (label: ScmMergeLabel): string => [label.description, label.detail].filter((part) => part !== undefined && part !== '').join(' · ');
const ICON_BUTTON = 'd-press size-6 rounded-6 text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.5';
const SETTLED_BAR = 'qd-merge-bar qd-merge-done-bar';
// Each input's look: its icon, its words and its tone, the header chip's included.
const PANES = {
  incoming: { icon: ArrowDownToLine, title: 'merge.incoming', pane: 'merge.incomingPane', tone: 'text-(--d-info-text)', chip: 'bg-[color-mix(in_srgb,var(--d-info)_16%,transparent)] text-(--d-info-text)' },
  current: { icon: Target, title: 'merge.current', pane: 'merge.currentPane', tone: 'text-(--d-accent-text)', chip: 'bg-(--d-accent-soft) text-(--d-accent-text)' },
} as const;
function setInputHost(side: 'incoming' | 'current', element: unknown): void {
  inputHosts[side] = element instanceof HTMLElement ? element : null;
}
</script>

<template>
  <div
    data-testid="merge-editor"
    :data-conflicts-left="progress.left"
    class="absolute inset-0 flex min-h-0 flex-col"
  >
    <div class="flex h-10 shrink-0 items-center gap-2.5 border-b border-(--d-border) bg-(--d-bg) px-3 text-11.5 whitespace-nowrap">
      <template v-if="inputs">
        <span
          v-for="side in paneOrder"
          :key="side"
          :data-testid="`merge-${side}-label`"
          class="inline-flex h-5.5 min-w-0 items-center gap-1.25 rounded-full px-2"
          :class="PANES[side].chip"
          :title="labelTip(inputs.labels[side])"
        >
          <component
            :is="PANES[side].icon"
            aria-hidden="true"
            class="size-2.75 shrink-0"
          />{{ visibleText(inputs.labels[side].title) }}<span
            v-if="labelName(inputs.labels[side])"
            class="truncate font-mono"
          >{{ visibleText(labelName(inputs.labels[side])!) }}</span>
        </span>
      </template>
      <span class="flex-1" />
      <!-- The count rolls; the sentence swaps only as the last conflict goes or one comes back. Both share one grid cell. -->
      <span
        v-if="inputs"
        data-testid="merge-status"
        role="status"
        class="inline-grid justify-items-end text-12"
      >
        <Transition :name="progress.left === 0 ? 't-swap-down' : 't-swap'">
          <span
            v-if="progress.left === 0"
            key="done"
            class="inline-flex items-center gap-1 text-(--d-success-text) [grid-area:1/1]"
          ><Check
            aria-hidden="true"
            class="size-3.25"
          />{{ t('merge.allResolved') }}</span>
          <i18n-t
            v-else
            key="left"
            keypath="merge.left"
            tag="span"
            class="whitespace-nowrap text-(--d-warning-text) [grid-area:1/1]"
          >
            <template #left>
              <RollingNumber :value="progress.left" />
            </template>
            <template #total>
              {{ progress.total }}
            </template>
          </i18n-t>
        </Transition>
      </span>
      <Button
        size="icon"
        variant="ghost"
        data-testid="merge-previous"
        :class="ICON_BUTTON"
        :disabled="progress.left === 0"
        :aria-label="t('merge.previousConflict')"
        :title="t('merge.previousConflict')"
        @click="goTo(-1)"
      >
        <ChevronUp aria-hidden="true" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        data-testid="merge-next"
        :class="ICON_BUTTON"
        :disabled="progress.left === 0"
        :aria-label="t('merge.nextConflict')"
        :title="t('merge.nextConflict')"
        @click="goTo(1)"
      >
        <ChevronDown aria-hidden="true" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        data-testid="merge-more"
        :class="ICON_BUTTON"
        :disabled="!inputs || busy !== null"
        :aria-label="t('merge.moreActions')"
        :title="t('merge.moreActions')"
        aria-haspopup="menu"
        @click="openMore"
      >
        <LoaderCircle
          v-if="busy === 'compute'"
          aria-hidden="true"
          class="d-spinning"
        />
        <Ellipsis
          v-else
          aria-hidden="true"
        />
      </Button>
      <Button
        size="sm"
        data-testid="merge-complete"
        class="d-press h-7 gap-1.5 rounded-7 bg-(--d-accent) px-2.75 text-12 font-semibold text-(--d-on-accent) hover:bg-(--d-accent) hover:brightness-110 [&_svg]:size-3.25"
        :disabled="!inputs || busy !== null || tab.readOnly"
        @click="complete"
      >
        <LoaderCircle
          v-if="busy === 'complete'"
          aria-hidden="true"
          class="d-spinning"
        />
        <Check
          v-else
          aria-hidden="true"
        />{{ t('merge.complete') }}
      </Button>
    </div>

    <div
      v-if="loadingBar"
      role="progressbar"
      :aria-label="t('merge.loading')"
      class="d-sweep-bar h-0.5 shrink-0 text-(--d-accent)"
    />
    <LoadFailedNotice
      v-if="resultFailed"
      :tab="tab"
      class="min-h-0 flex-1"
    />
    <div
      v-else-if="failure"
      role="alert"
      data-testid="merge-failure"
      class="pane-empty d-fade-in flex flex-1 items-center justify-center p-6 text-center text-12.5 text-(--d-muted)"
    >
      {{ t(`merge.failure.${failure}`) }}
    </div>
    <div
      v-show="!failure && !resultFailed"
      class="grid min-h-0 flex-1 grid-rows-[minmax(9rem,46%)_minmax(0,1fr)]"
    >
      <div class="grid min-h-0 grid-cols-2 border-b border-(--d-border)">
        <section
          v-for="(side, index) in paneOrder"
          :key="side"
          class="flex min-h-0 min-w-0 flex-col"
          :class="index === 0 ? 'border-r border-(--d-border)' : ''"
          :aria-label="t(PANES[side].pane)"
        >
          <div
            class="flex h-6.5 shrink-0 items-center gap-1.5 border-b border-(--d-border) px-3 text-11"
            :class="PANES[side].tone"
          >
            <component
              :is="PANES[side].icon"
              aria-hidden="true"
              class="size-2.75"
            />{{ t(PANES[side].title) }}<span
              v-if="inputs && labelTip(inputs.labels[side])"
              class="truncate font-mono text-(--d-faint-text)"
            >{{ visibleText(labelTip(inputs.labels[side])) }}</span>
          </div>
          <div
            :ref="(element) => setInputHost(side, element)"
            :data-testid="`merge-${side}`"
            class="relative min-h-0 flex-1"
          />
        </section>
      </div>
      <section
        class="flex min-h-0 flex-col"
        :aria-label="t('merge.resultPane')"
      >
        <div class="flex h-6.5 shrink-0 items-center gap-1.5 border-b border-(--d-border) bg-(--d-panel) px-3 text-11 text-(--d-muted)">
          <FileCheck
            aria-hidden="true"
            class="size-2.75"
          />{{ t('merge.result') }}<span class="truncate font-mono text-(--d-faint-text)">{{ visibleText(tab.merge.path) }}</span>
        </div>
        <div
          ref="resultHost"
          data-testid="merge-result"
          class="relative min-h-0 flex-1"
        />
      </section>
    </div>
  </div>
</template>
