import { effectScope, h, nextTick, render, watch, type AppContext } from 'vue';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import { applyLineChanges, selectedLineChanges, type LineChange, type LineRange } from '@shared/scm/apply-line-changes';
import type { Monaco } from '@/components/editor/useMonaco';
import type { DamoclesShellApi, ShellEditorTab } from '../../preload/shell-channels';
import type { ScmBlameCommit, ScmRangeAction, ScmRangeRefusal, ScmResource } from '../../preload/scm-channels';
import type { ScmStore } from '../scm/scm-store';
import { fromNow } from '../scm/scm-list';
import { attachBlame, type BlameCardHost, type BlameController } from './blame';
import BlameCard from './BlameCard.vue';
import { lineEdits } from './format-edits';
import { attachGutter, gutterMarks, type Gutter, type GutterMark } from './quick-diff/gutter';
import { attachPeek, type Peek, type PeekTarget } from './quick-diff/peek';
import { createQuickDiffModel, type QuickDiffModel, type QuickDiffState, type QuickDiffStatus } from './quick-diff/quick-diff-model';
import { changeKind, changesKeptByRevert, nextChangeIndex, previousChangeIndex, sameChange, selectionLineRanges, stagedChangesFor } from './quick-diff/quick-diff-compute';
import QuickDiffPeekHeader from './quick-diff/QuickDiffPeekHeader.vue';

// A code tab's git: the quick diff gutter and peek (B25, B26), Stage, Unstage and Revert Selected Ranges (B27), Next and
// Previous Change, and inline blame (B31). It runs only for a tab main gave a git resource, which an untrusted project never has.

export type EditorGitCommand = 'nextChange' | 'previousChange' | 'stageSelectedRanges' | 'unstageSelectedRanges' | 'revertSelectedRanges' | 'showLineBlame';

const RANGE_ACTIONS = { stageSelectedRanges: 'stage', unstageSelectedRanges: 'unstage', revertSelectedRanges: 'revert' } as const satisfies Record<string, ScmRangeAction>;

// ms of .qd-blame-card-out (d-pop-out's length in style.css); the card's widget is removed when it ends
const BLAME_CARD_EXIT_MS = 120;

export interface EditorGitDeps {
  readonly api: DamoclesShellApi;
  readonly scm: ScmStore;
  readonly t: (key: string, named?: Record<string, unknown>) => string;
  readonly locale: () => string;
  readonly appContext: AppContext | null;
  // sends the document's pending edit to main, so main stages the text that was diffed
  readonly flush: (documentId: string) => void;
  readonly shortcuts: () => { readonly next: string; readonly previous: string };
  // the marks drawn and whether more may come, for the editor element's data-quick-diff and data-quick-diff-state (e2e and
  // screenshots wait on them); none for a tab without git
  readonly onQuickDiff: (marks: readonly GutterMark[], status: QuickDiffStatus) => void;
  // whether inline blame is on, for the editor element's data-inline-blame
  readonly onBlameEnabled: (enabled: boolean) => void;
}

export interface EditorGit extends IDisposable {
  /** The tab now shown, with its model; a tab without git turns everything off. */
  bind(tab: ShellEditorTab | null, model: MonacoEditor.ITextModel | null): void;
  run(command: EditorGitCommand): Promise<void>;
  // the quick diff of the bound tab, for tests and screenshots
  readonly state: () => QuickDiffState | null;
}

export function attachEditorGit(editor: MonacoEditor.IStandaloneCodeEditor, monaco: Monaco, deps: EditorGitDeps): EditorGit {
  const { t } = deps;
  let tab: ShellEditorTab | null = null;
  let target: ScmResource | null = null;
  let model: MonacoEditor.ITextModel | null = null;
  let quick: QuickDiffModel | null = null;
  let scope = effectScope();
  let busy = false;
  // the mark the peek shows: its index among the marks and the mark itself
  let peeked: { mark: GutterMark } | null = null;

  const marks = (): GutterMark[] => {
    const state = quick?.state.value;
    return state ? gutterMarks(state.primary, state.secondary) : [];
  };

  const gutter: Gutter = attachGutter(editor, monaco, {
    added: t('quickDiff.added'),
    modified: t('quickDiff.modified'),
    deleted: t('quickDiff.deleted'),
    staged: (kind) => t('quickDiff.stagedMark', { kind }),
  }, (mark) => openPeek(mark));

  const peek: Peek = attachPeek(editor, monaco, {
    render(node, shown) {
      if (shown === null) {
        render(null, node);
        return;
      }
      const all = marks();
      const index = all.findIndex((mark) => mark.change === shown.change);
      const vnode = h(QuickDiffPeekHeader, {
        name: tab?.title ?? '',
        index: Math.max(0, index),
        count: all.length,
        staged: shown.staged,
        kind: changeKind(shown.change),
        busy,
        shortcuts: deps.shortcuts(),
        onStage: () => void stageMark(shown),
        onUnstage: () => void unstageMark(shown),
        onRevert: () => void revertMark(shown),
        onNext: () => void move(1),
        onPrevious: () => void move(-1),
        onClose: () => {
          peek.close();
          editor.focus();
        },
      });
      vnode.appContext = deps.appContext;
      render(vnode, node);
    },
  }, () => t('quickDiff.peekLabel', { name: tab?.title ?? '' }), () => {
    peeked = null;
  }, t('quickDiff.close'));

  const targetOf = (mark: GutterMark, state: QuickDiffState): PeekTarget => ({ change: mark.change, original: mark.staged ? state.headText ?? '' : state.indexText, staged: mark.staged });

  function openPeek(mark: GutterMark): void {
    const state = quick?.state.value;
    if (!state) return;
    peeked = { mark };
    peek.open(targetOf(mark, state));
  }

  // After the marks change, the peek follows its change: the same lines (now staged or unstaged after Stage or Unstage Hunk),
  // else the next change below, else it closes. The same change in the same state stays in its zone, so a keystroke or a
  // status neither rebuilds the inline diff nor loses its scroll.
  function followPeek(): void {
    const state = quick?.state.value;
    if (!peeked) return;
    const all = marks();
    const was = peeked.mark;
    const start = was.change.modifiedStartLineNumber;
    const next = all.find((mark) => mark.staged === was.staged && mark.change.modifiedStartLineNumber === start)
      ?? all.find((mark) => mark.change.modifiedStartLineNumber === start)
      ?? all.find((mark) => mark.change.modifiedStartLineNumber > start);
    if (!next || !state) peek.close();
    else if (peek.follow(targetOf(next, state))) peeked = { mark: next };
    else openPeek(next);
  }

  // The card holds while the pointer or focus is in it, and plays its exit (BLAME_CARD_EXIT_MS) before its widget goes; once
  // neither is in it, it hides after the delay the blame text gives the pointer to come back.
  let cardPointer = false;
  let cardFocus = false;
  const cardHeld = (): boolean => cardPointer || cardFocus;
  let cardWidget: MonacoEditor.IOverlayWidget | null = null;
  let cardAnchor: HTMLElement | null = null;
  let cardAt: MonacoEditor.IOverlayWidgetPosition = { preference: { top: 0, left: 0 } };
  let cardLeaving: ReturnType<typeof setTimeout> | undefined;
  const cardNode = document.createElement('div');
  cardNode.className = 'qd-blame-card-host';
  // Escape in the card closes it and gives the editor its focus back
  cardNode.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    removeCard();
    editor.focus();
  });

  function removeCard(): void {
    clearTimeout(cardLeaving);
    cardLeaving = undefined;
    if (!cardWidget) return;
    editor.removeOverlayWidget(cardWidget);
    cardWidget = null;
    cardAnchor = null;
    cardPointer = false;
    cardFocus = false;
    render(null, cardNode);
  }

  // Under the blame text, or above it when the space below is short, moved left until it fits beside the scrollbar.
  function placeCard(): void {
    const root = editor.getDomNode();
    if (!cardWidget || !cardAnchor || !root) return;
    const layout = editor.getLayoutInfo();
    cardNode.style.maxWidth = `${layout.width - layout.verticalScrollbarWidth}px`;
    const box = root.getBoundingClientRect();
    const text = cardAnchor.getBoundingClientRect();
    // rects are scaled while the focus overlay zooms; the widget's coordinates are the editor's layout pixels
    const scale = box.width / root.offsetWidth || 1;
    const textLeft = (text.left - box.left) / scale;
    const textTop = (text.top - box.top) / scale;
    const textBottom = (text.bottom - box.top) / scale;
    const fitsBelow = textBottom + cardNode.offsetHeight <= layout.height - layout.horizontalScrollbarHeight;
    const top = fitsBelow || textTop < cardNode.offsetHeight ? textBottom : textTop - cardNode.offsetHeight;
    const left = Math.max(0, Math.min(textLeft, layout.width - layout.verticalScrollbarWidth - cardNode.offsetWidth));
    cardAt = { preference: { top, left } };
    editor.layoutOverlayWidget(cardWidget);
  }

  const card: BlameCardHost = {
    show(anchor, commit) {
      clearTimeout(cardLeaving);
      cardLeaving = undefined;
      cardNode.querySelector('.qd-blame-card')?.classList.remove('qd-blame-card-out');
      const vnode = h(BlameCard, {
        commit,
        ago: fromNow(commit.authorTime, Date.now(), deps.locale()),
        onOpenCommit: () => void runBlameAction('openCommit', commit),
        onCopyCommitId: () => void runBlameAction('copyCommitId', commit),
        onOpenTimeline: () => void runBlameAction('openTimeline', commit),
        onHold: (by: 'pointer' | 'focus', inside: boolean) => {
          if (by === 'pointer') cardPointer = inside;
          else cardFocus = inside;
          if (!cardHeld()) blame.cardLeft();
        },
      });
      vnode.appContext = deps.appContext;
      render(vnode, cardNode);
      cardAnchor = anchor.element;
      if (!cardWidget) {
        // an overlay widget in the editor's own coordinates: it draws over the minimap, and a fixed overflow widget's
        // viewport coordinates would land off its anchor inside the focus overlay's transformed pane
        cardWidget = { getId: () => 'damocles.blameCard', getDomNode: () => cardNode, getPosition: () => cardAt };
        editor.addOverlayWidget(cardWidget);
      }
      placeCard();
      // Monaco moves an overlay widget only on its next frame; until then the card would keep the place it last had, which
      // can lie over the text the pointer is on, taking its clicks and its hover
      editor.render();
    },
    hide() {
      if (!cardWidget || cardLeaving !== undefined) return;
      if (prefersReducedMotion()) {
        removeCard();
        return;
      }
      cardNode.querySelector('.qd-blame-card')?.classList.add('qd-blame-card-out');
      cardLeaving = setTimeout(removeCard, BLAME_CARD_EXIT_MS);
    },
    held: cardHeld,
  };

  async function runBlameAction(action: 'openCommit' | 'copyCommitId' | 'openTimeline', commit: ScmBlameCommit): Promise<void> {
    if (!target) return;
    card.hide();
    if (action === 'openCommit') await deps.api.scm.run({ op: 'openCommit', repoId: target.repoId, commit: commit.hash });
    else if (action === 'copyCommitId') await deps.api.scm.copy({ repoId: target.repoId, kind: 'commitId', value: commit.hash });
    else await deps.api.scm.run({ op: 'openTimeline', repoId: target.repoId, path: target.path });
  }

  const blame: BlameController = attachBlame(editor, monaco, {
    uncommitted: t('blame.uncommitted'),
    staged: t('blame.staged'),
    line: (commit, ago) => t('blame.line', { author: commit.author, ago, subject: commit.summary }),
    ago: (time) => fromNow(time, Date.now(), deps.locale()),
  }, card);

  function unbind(): void {
    scope.stop();
    scope = effectScope();
    quick?.dispose();
    quick = null;
    peek.close();
    peeked = null;
    gutter.update([]);
    deps.onQuickDiff([], 'none');
    deps.onBlameEnabled(false);
    blame.bind(null);
  }

  function bind(nextTab: ShellEditorTab | null, nextModel: MonacoEditor.ITextModel | null): void {
    const git = nextTab?.git;
    const same = git && target && nextModel === model && git.repoId === target.repoId && git.path === target.path;
    tab = nextTab;
    if (same) return;
    unbind();
    model = nextModel;
    target = git && nextModel ? { repoId: git.repoId, path: git.path } : null;
    if (!target || !nextModel) return;
    const resource = target;
    const created = createQuickDiffModel(deps.api.scm, nextModel, resource, (listener) => {
      const stop = watch(() => deps.scm.snapshots.value.get(resource.repoId)?.revision, listener);
      return stop;
    });
    quick = created;
    deps.onQuickDiff([], created.status.value);
    scope.run(() => {
      watch(created.state, () => {
        gutter.update(marks());
        followPeek();
        blame.refreshLine();
      });
      watch([created.state, created.status], () => deps.onQuickDiff(marks(), created.status.value));
      watch(() => deps.scm.snapshots.value.get(resource.repoId)?.commit?.hash, () => blame.invalidate());
      watch(() => deps.scm.settings.value.blameEditorDecoration, (enabled) => {
        blame.setEnabled(enabled);
        deps.onBlameEnabled(enabled);
      }, { immediate: true });
    });
    blame.bind({ read: () => deps.api.scm.blame(resource), quick: () => created.state.value });
  }

  async function withBusy(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    peek.refresh();
    try {
      await work();
    } finally {
      busy = false;
      peek.refresh();
    }
  }

  // main owns notices, so an action with nothing to apply is told there
  async function refuse(resource: ScmResource, action: ScmRangeAction, reason: ScmRangeRefusal = 'noChanges'): Promise<void> {
    await deps.api.scm.run({ op: 'refuseRanges', repoId: resource.repoId, action, reason });
  }

  async function stage(changes: readonly LineChange[], state: QuickDiffState): Promise<void> {
    if (!target || !tab?.documentId) return;
    if (changes.length === 0) return refuse(target, 'stage');
    deps.flush(tab.documentId);
    const result = await deps.api.scm.run({ op: 'stageRanges', repoId: target.repoId, path: target.path, documentId: tab.documentId, ranges: changes, indexOid: state.indexOid });
    if (result.ok) await quick?.refresh();
  }

  async function unstage(changes: readonly LineChange[], state: QuickDiffState): Promise<void> {
    if (!target || !tab?.documentId) return;
    if (changes.length === 0) return refuse(target, 'unstage');
    const result = await deps.api.scm.run({ op: 'unstageRanges', repoId: target.repoId, path: target.path, documentId: tab.documentId, ranges: changes, indexOid: state.indexOid, headOid: state.headOid });
    if (result.ok) await quick?.refresh();
  }

  // Revert edits the buffer alone (B27): the kept changes applied to the index give the new text, written as one undoable edit.
  async function revert(kept: readonly LineChange[], state: QuickDiffState): Promise<void> {
    if (!model || !target || tab?.readOnly) return;
    const current = model.getValue();
    const next = applyLineChanges(state.indexText, current, kept);
    const edits = lineEdits(current, next);
    if (edits.length === 0) return refuse(target, 'revert');
    const selections = editor.getSelections();
    model.pushStackElement();
    model.pushEditOperations(selections ?? [], edits.map((edit) => ({ range: edit.range, text: edit.text })), () => selections);
    model.pushStackElement();
  }

  const stageMark = (shown: PeekTarget): Promise<void> => withBusy(async () => {
    const state = await quick?.current();
    const change = state?.primary.find((candidate) => sameChange(candidate, shown.change));
    if (state && change) await stage([change], state);
  });
  const unstageMark = (shown: PeekTarget): Promise<void> => withBusy(async () => {
    const state = await quick?.current();
    if (state) await unstage(stagedChangesFor(shown.change, state.primary, state.staged), state);
  });
  const revertMark = (shown: PeekTarget): Promise<void> => withBusy(async () => {
    const state = await quick?.current();
    if (state) await revert(state.primary.filter((change) => !sameChange(change, shown.change)), state);
  });

  function selectedRanges(): LineRange[] {
    return selectionLineRanges(editor.getSelections() ?? []);
  }

  async function move(step: 1 | -1): Promise<void> {
    const all = marks();
    if (all.length === 0) return;
    const line = editor.getPosition()?.lineNumber ?? 1;
    const changes = all.map((mark) => mark.change);
    const index = peeked
      ? (all.findIndex((mark) => mark.change === peeked!.mark.change) + step + all.length) % all.length
      : step === 1 ? nextChangeIndex(changes, line, false) : previousChangeIndex(changes, line, false);
    const mark = all[index]!;
    const at = Math.max(1, mark.change.modifiedStartLineNumber);
    editor.setPosition({ lineNumber: at, column: 1 });
    editor.revealLineInCenterIfOutsideViewport(at);
    if (peeked) openPeek(mark);
  }

  async function run(command: EditorGitCommand): Promise<void> {
    if (command === 'showLineBlame') {
      // the keyboard's way to the card: it opens on the cursor line's commit and takes focus
      const shown = blame.shown();
      const element = editor.getDomNode()?.querySelector<HTMLElement>('.qd-blame');
      if (shown?.blame.kind !== 'commit' || !element) return;
      card.show({ line: shown.line, element }, shown.blame.commit);
      void nextTick(() => cardNode.querySelector<HTMLElement>('button')?.focus());
      return;
    }
    if (command === 'nextChange' || command === 'previousChange') {
      await quick?.current();
      await move(command === 'nextChange' ? 1 : -1);
      return;
    }
    await withBusy(async () => {
      const state = await quick?.current();
      if (!model || !target) return;
      // no state: the file has no quick diff, else the buffer changed while the base was read
      if (!state) return refuse(target, RANGE_ACTIONS[command], quick?.status.value === 'none' ? 'noQuickDiff' : 'outOfRange');
      const ranges = selectedRanges();
      const lineCount = model.getLineCount();
      if (command === 'stageSelectedRanges') await stage(selectedLineChanges(state.primary, ranges, lineCount), state);
      else if (command === 'revertSelectedRanges') await revert(changesKeptByRevert(state.primary, ranges, lineCount), state);
      else {
        const secondary = selectedLineChanges(state.secondary, ranges, lineCount);
        const staged = secondary.flatMap((change) => stagedChangesFor(change, state.primary, state.staged));
        await unstage([...new Set(staged)], state);
      }
    });
  }

  // the card is placed once from its text's rect, so it leaves when the text moves under it
  const cardFollows = [
    editor.onDidScrollChange((event) => {
      if (event.scrollTopChanged || event.scrollLeftChanged) card.hide();
    }),
    editor.onDidLayoutChange(() => card.hide()),
  ];

  return {
    bind,
    run,
    state: () => quick?.state.value ?? null,
    dispose() {
      unbind();
      scope.stop();
      gutter.dispose();
      peek.dispose();
      blame.dispose();
      for (const listener of cardFollows) listener.dispose();
      removeCard();
    },
  };
}
