<script setup lang="ts">
import { computed, ref, useId, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Eye, Folder, FolderInput, FolderTree, GitMerge, Play, Sparkles, Trash2 } from 'lucide-vue-next';
import { visibleText } from '@shared/visible-text';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { MAX_WORKTREE_COMMIT_MESSAGE_CHARS, type DamoclesOverlayApi, type OverlayAnswer, type WorktreeDialogAnswer, type WorktreeDialogRequest } from '../../../preload/overlay-channels';
import { answerOf } from '../popup-answer';
import OverlayDialog, { type DialogButton, type DialogSeverity } from './OverlayDialog.vue';
import WorktreeFileList from './WorktreeFileList.vue';

/**
 * The questions of worktree chats (D32, D33, D61, R15) as D41 dialogs. Branch names, paths and commit subjects come from git
 * and render as text with their hidden characters shown.
 */
const props = defineProps<{ api: DamoclesOverlayApi; request: WorktreeDialogRequest }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const shown = (text: string): string => visibleText(text);

// Delete: the branch goes too unless unticked; a locked box cannot change.
const deleteBranch = ref(props.request.dialog === 'delete' ? props.request.deleteBranchDefault : false);
const checkboxId = useId();
const lockedId = useId();

// Merge: the commit message the worktree's uncommitted files are committed with.
const message = ref('');
const generating = ref(false);
const generateFailed = ref(false);
async function generate(): Promise<void> {
  generating.value = true;
  generateFailed.value = false;
  try {
    const result = await answerOf(props.api.generateWorktreeMessage());
    // undefined: the dialog closed meanwhile; null: main told the user why no message came
    if (result) message.value = result.message.slice(0, MAX_WORKTREE_COMMIT_MESSAGE_CHARS);
  } catch (error) {
    console.error('[worktreeDialog] generate failed', error);
    generateFailed.value = true;
  } finally {
    generating.value = false;
  }
}

interface Shape {
  readonly severity: DialogSeverity;
  readonly icon?: Component;
  readonly title: string;
  readonly message?: string;
  readonly buttons: readonly DialogButton[];
  // the answer each button gives, by index; Escape and the scrim give cancelIndex's
  readonly answers: readonly (() => WorktreeDialogAnswer)[];
  readonly initialFocus: number;
  readonly cancelIndex: number;
}

const cancelButton = (label = t('worktree.dialog.cancel')): DialogButton => ({ label, variant: 'plain', testId: 'worktree-dialog-cancel' });

function shapeOf(request: WorktreeDialogRequest): Shape {
  switch (request.dialog) {
    case 'setupReview':
      // Running repository commands is consent like trust, so Skip takes focus first.
      return {
        severity: 'warning',
        title: t('worktree.dialog.setupTitle'),
        message: t('worktree.dialog.setupMessage', { project: request.projectName }),
        buttons: [cancelButton(t('worktree.dialog.skip')), { label: t('worktree.dialog.run'), variant: 'fill', icon: Play, testId: 'worktree-dialog-run' }],
        answers: [() => ({ dialog: 'setupReview', choice: 'skip' }), () => ({ dialog: 'setupReview', choice: 'run' })],
        initialFocus: 0,
        cancelIndex: 0,
      };
    case 'delete':
      return {
        severity: 'danger',
        title: t('worktree.dialog.deleteTitle'),
        buttons: [cancelButton(), { label: t('worktree.dialog.deleteConfirm'), variant: 'fill', icon: Trash2, testId: 'worktree-dialog-delete' }],
        answers: [
          () => ({ dialog: 'delete', choice: 'cancel', deleteBranch: deleteBranch.value }),
          () => ({ dialog: 'delete', choice: 'delete', deleteBranch: deleteBranch.value }),
        ],
        initialFocus: 0,
        cancelIndex: 0,
      };
    case 'mergeMessage':
      return {
        severity: 'accent',
        icon: GitMerge,
        title: t('worktree.dialog.mergeTitle', { branch: shown(request.branch), target: shown(request.target) }),
        message: t('worktree.dialog.mergeMessage', { n: request.files.length, target: shown(request.target) }, request.files.length),
        buttons: [cancelButton(), { label: t('worktree.dialog.mergeConfirm'), variant: 'fill', icon: GitMerge, testId: 'worktree-dialog-commit', disabled: message.value.trim() === '' }],
        answers: [
          () => ({ dialog: 'mergeMessage', choice: 'cancel', message: '' }),
          () => ({ dialog: 'mergeMessage', choice: 'commit', message: message.value }),
        ],
        initialFocus: 0,
        cancelIndex: 0,
      };
    case 'rewritten':
      return {
        severity: 'warning',
        title: t('worktree.dialog.rewrittenTitle', { branch: shown(request.branch) }),
        message: t('worktree.dialog.rewrittenMessage'),
        buttons: [
          cancelButton(),
          { label: t('worktree.dialog.applyInstead'), variant: 'plain', icon: FolderInput, testId: 'worktree-dialog-apply' },
          { label: t('worktree.dialog.rebase', { branch: shown(request.branch) }), variant: 'fill', icon: GitMerge, testId: 'worktree-dialog-rebase' },
        ],
        answers: [
          () => ({ dialog: 'rewritten', choice: 'cancel' }),
          () => ({ dialog: 'rewritten', choice: 'apply' }),
          () => ({ dialog: 'rewritten', choice: 'rebase' }),
        ],
        initialFocus: 2,
        cancelIndex: 0,
      };
    case 'refusal':
      return {
        severity: 'warning',
        title: t(request.action === 'apply' ? 'worktree.dialog.applyRefusedTitle' : 'worktree.dialog.handOffRefusedTitle'),
        message: t('worktree.dialog.refusedMessage'),
        buttons: [{ label: t('worktree.dialog.ok'), variant: 'fill', testId: 'worktree-dialog-ok' }],
        answers: [() => ({ dialog: 'refusal', choice: 'ok' })],
        initialFocus: 0,
        cancelIndex: 0,
      };
    case 'handOffConfirm': {
      const toWorktree = request.direction === 'toWorktree';
      return {
        severity: 'accent',
        icon: toWorktree ? FolderTree : Folder,
        title: t(toWorktree ? 'worktree.dialog.toWorktreeTitle' : 'worktree.dialog.toProjectTitle'),
        message: t(toWorktree ? 'worktree.dialog.toWorktreeMessage' : 'worktree.dialog.toProjectMessage'),
        buttons: [
          cancelButton(),
          { label: t(toWorktree ? 'worktree.dialog.moveToWorktree' : 'worktree.dialog.moveToProject'), variant: 'fill', icon: toWorktree ? FolderTree : Folder, testId: 'worktree-dialog-move' },
        ],
        answers: [() => ({ dialog: 'handOffConfirm', choice: 'cancel' }), () => ({ dialog: 'handOffConfirm', choice: 'move' })],
        initialFocus: 1,
        cancelIndex: 0,
      };
    }
    case 'leftovers':
      return {
        severity: 'warning',
        title: t('worktree.dialog.leftoversTitle'),
        message: t('worktree.dialog.leftoversMessage'),
        buttons: [{ label: t('worktree.dialog.close'), variant: 'plain', testId: 'worktree-dialog-close' }],
        answers: [() => ({ dialog: 'leftovers', choice: 'close' })],
        initialFocus: 0,
        cancelIndex: 0,
      };
  }
}
const shape = computed(() => shapeOf(props.request));
// A typed or generated merge message is unsent text, which a click beside the dialog must not discard.
const hasDraft = computed(() => props.request.dialog === 'mergeMessage' && message.value.trim() !== '');

// Commit needs a message; the button stays but answers nothing while the box is blank.
function choose(index: number): void {
  if (props.request.dialog === 'mergeMessage' && index === 1 && message.value.trim() === '') return;
  const answer = shape.value.answers[index] ?? shape.value.answers[shape.value.cancelIndex];
  if (answer) emit('answer', { kind: 'worktreeDialog', ...answer() });
}

function leftover(choice: 'prune' | 'reveal' | 'delete' | 'keep', path: string): void {
  emit('answer', { kind: 'worktreeDialog', dialog: 'leftovers', choice, path });
}

// A leftover reads by its folder's name, with the folder it sits in under it.
function splitPath(path: string): { readonly name: string; readonly parent: string } {
  const shownPath = shown(path);
  const cut = Math.max(shownPath.lastIndexOf('/'), shownPath.lastIndexOf('\\')) + 1;
  return { name: shownPath.slice(cut) || shownPath, parent: shownPath.slice(0, cut) };
}
const leftovers = computed(() => (props.request.dialog === 'leftovers' ? props.request.items.map((item) => ({ ...item, shown: shown(item.path), ...splitPath(item.path) })) : []));

// The Delete dialog's three lists stagger as one sequence, each starting where the one above it ended.
const deleteOffsets = computed(() => {
  const request = props.request;
  if (request.dialog !== 'delete') return { submodules: 0, commits: 0 };
  const submodules = request.uncommitted.length;
  return { submodules, commits: submodules + request.submoduleChanges.length };
});

const DIALOG_BUTTON = 'd-press h-6.5 shrink-0 gap-1 rounded-7 border-(--d-border2) bg-transparent px-2 text-11.5 font-normal text-(--d-text) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-3';
// Prune and Delete remove what cannot be brought back; danger text on a danger tint within D48's 22%.
const DANGER_BUTTON = `${DIALOG_BUTTON} border-(--d-danger)/40 text-(--d-danger-text) hover:border-(--d-danger) hover:bg-(--d-danger)/12 hover:text-(--d-danger-text)`;
</script>

<template>
  <OverlayDialog
    :severity="shape.severity"
    :icon="shape.icon"
    :title="shape.title"
    :message="shape.message"
    :buttons="shape.buttons"
    :initial-focus="shape.initialFocus"
    :cancel-index="shape.cancelIndex"
    :has-draft="hasDraft"
    :data-dialog="request.dialog"
    test-id="worktree-dialog"
    @choose="choose"
  >
    <template v-if="request.dialog === 'setupReview'">
      <ol
        :aria-label="t('worktree.dialog.setupTitle')"
        data-testid="worktree-dialog-commands"
        class="max-h-40 overflow-auto rounded-7 border border-(--d-border) bg-(--d-code) px-2.5 py-2 font-mono text-11.5/relaxed text-(--d-text)"
      >
        <!-- Verbatim, one line each; a long command scrolls sideways and never breaks mid-identifier. -->
        <li
          v-for="(command, index) in request.commands"
          :key="index"
          class="d-row-reveal flex w-max min-w-full gap-2 whitespace-pre"
          :style="{ '--reveal-index': index }"
        >
          <span
            aria-hidden="true"
            class="shrink-0 text-(--d-faint)"
          >$</span>
          <span dir="ltr">{{ shown(command) }}</span>
        </li>
      </ol>
    </template>

    <template v-else-if="request.dialog === 'delete'">
      <p
        class="truncate font-mono text-11 text-(--d-faint-text)"
        dir="ltr"
        :title="shown(request.path)"
        data-testid="worktree-dialog-path"
      >
        {{ shown(request.path) }}
      </p>
      <p class="text-12.5 text-(--d-muted)">
        {{ request.uncommitted.length > 0 ? t('worktree.dialog.deleteUncommitted', { n: request.uncommitted.length }, request.uncommitted.length) : t('worktree.dialog.deleteClean') }}
      </p>
      <WorktreeFileList
        v-if="request.uncommitted.length > 0"
        :label="t('worktree.dialog.fileList')"
        :files="request.uncommitted"
      />
      <template v-if="request.submoduleChanges.length > 0">
        <p class="text-12.5 text-(--d-muted)">
          {{ t('worktree.dialog.deleteSubmodules') }}
        </p>
        <WorktreeFileList
          :label="t('worktree.dialog.deleteSubmodules')"
          :files="request.submoduleChanges"
          :index-offset="deleteOffsets.submodules"
          test-id="worktree-dialog-submodules"
        />
      </template>
      <template v-if="request.unmergedCommits.length > 0">
        <p class="text-12.5 text-(--d-muted)">
          {{ t('worktree.dialog.deleteUnmerged', { n: request.unmergedCommits.length, branch: shown(request.branch) }, request.unmergedCommits.length) }}
        </p>
        <ul
          :aria-label="t('worktree.dialog.deleteUnmerged', { n: request.unmergedCommits.length, branch: shown(request.branch) }, request.unmergedCommits.length)"
          data-testid="worktree-dialog-commits"
          class="max-h-32 overflow-y-auto rounded-9 border border-(--d-border) bg-(--d-panel) p-1"
        >
          <li
            v-for="(commit, index) in request.unmergedCommits"
            :key="commit.hash"
            class="d-row-reveal flex h-6.5 min-w-0 items-center gap-2 px-1.75 text-12"
            :style="{ '--reveal-index': deleteOffsets.commits + index }"
            :title="shown(commit.subject)"
          >
            <span class="shrink-0 font-mono text-11 text-(--d-accent-text)">{{ commit.hash.slice(0, 7) }}</span>
            <span class="min-w-0 truncate">{{ shown(commit.subject) }}</span>
          </li>
        </ul>
      </template>
      <p class="text-11 text-pretty text-(--d-faint-text)">
        {{ t('worktree.dialog.deleteDetail') }}
      </p>
      <div class="flex items-start gap-2">
        <Checkbox
          :id="checkboxId"
          :checked="deleteBranch"
          :disabled="request.deleteBranchLocked"
          :aria-describedby="request.deleteBranchLocked ? lockedId : undefined"
          data-testid="worktree-dialog-delete-branch"
          class="mt-0.5 size-3.75 shrink-0 rounded-xs border-(--d-border2) data-[state=checked]:border-(--d-accent) data-[state=checked]:bg-(--d-accent) data-[state=checked]:text-(--d-on-accent) [&_svg]:size-2.75"
          @update:checked="deleteBranch = $event"
        />
        <label
          :for="checkboxId"
          class="text-12.5"
          :class="request.deleteBranchLocked ? 'text-(--d-faint-text)' : 'cursor-pointer'"
        >
          <i18n-t
            keypath="worktree.dialog.alsoDeleteBranch"
            scope="global"
          >
            <template #branch>
              <span
                class="font-mono"
                dir="ltr"
              >{{ shown(request.branch) }}</span>
            </template>
          </i18n-t>
        </label>
      </div>
      <p
        v-if="request.deleteBranchLocked"
        :id="lockedId"
        class="-mt-2 ps-5.75 text-11 text-pretty text-(--d-faint-text)"
        data-testid="worktree-dialog-branch-locked"
      >
        {{ t('worktree.dialog.branchLocked') }}
      </p>
    </template>

    <template v-else-if="request.dialog === 'mergeMessage'">
      <WorktreeFileList
        :label="t('worktree.dialog.fileList')"
        :files="request.files"
      />
      <div class="relative">
        <Textarea
          :model-value="message"
          data-overlay-initial-focus
          data-testid="worktree-dialog-message"
          rows="3"
          spellcheck="true"
          :maxlength="MAX_WORKTREE_COMMIT_MESSAGE_CHARS"
          :aria-label="t('worktree.dialog.commitMessage')"
          :placeholder="t('worktree.dialog.commitMessage')"
          :aria-busy="generating || undefined"
          :readonly="generating"
          class="block min-h-0 w-full resize-none rounded-8 border-(--d-border2) bg-(--d-input) px-2.5 py-2 text-12.5 text-(--d-text) placeholder:text-(--d-faint) focus-visible:border-(--d-accent) focus-visible:ring-0 focus-visible:ring-offset-0"
          @update:model-value="message = String($event)"
          @keydown.ctrl.enter.prevent="choose(1)"
          @keydown.meta.enter.prevent="choose(1)"
        />
        <span
          v-if="generating"
          class="d-sheen text-(--d-accent)"
          aria-hidden="true"
        />
      </div>
      <div class="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          data-testid="worktree-dialog-generate"
          :class="[DIALOG_BUTTON, 'h-7 gap-1.5 px-2.5 text-12 disabled:opacity-60 [&_svg]:size-3.25']"
          :disabled="generating"
          @click="generate"
        >
          <Sparkles
            aria-hidden="true"
            :class="generating ? 'd-pulsing text-(--d-accent)' : ''"
          />
          {{ generating ? t('worktree.dialog.generating') : t('worktree.dialog.generate') }}
        </Button>
        <span
          v-if="generateFailed"
          role="alert"
          class="text-11 text-(--d-danger-text)"
        >{{ t('worktree.dialog.generateFailed') }}</span>
      </div>
    </template>

    <template v-else-if="request.dialog === 'refusal'">
      <WorktreeFileList
        :label="t('worktree.dialog.fileList')"
        :files="request.files"
      />
    </template>

    <template v-else-if="request.dialog === 'handOffConfirm'">
      <p class="text-12 font-medium text-(--d-muted)">
        {{ request.files.length > 0 ? t('worktree.dialog.filesMove', { n: request.files.length }, request.files.length) : t('worktree.dialog.noFiles') }}
      </p>
      <WorktreeFileList
        v-if="request.files.length > 0"
        :label="t('worktree.dialog.filesMove', { n: request.files.length }, request.files.length)"
        :files="request.files.map((file) => ({ path: file.path, letter: file.letter, mark: file.alsoUserEdits ? t('worktree.dialog.alsoUserEdits') : undefined }))"
      />
    </template>

    <template v-else-if="request.dialog === 'leftovers'">
      <ul
        :aria-label="t('worktree.dialog.leftoversTitle')"
        data-testid="worktree-dialog-leftovers"
        class="max-h-64 overflow-y-auto rounded-9 border border-(--d-border) bg-(--d-panel) p-1"
      >
        <li
          v-for="(item, index) in leftovers"
          :key="item.path"
          class="d-row-reveal grid min-w-0 grid-cols-[1fr_auto] items-center gap-x-2 rounded-md px-1.75 py-1"
          :style="{ '--reveal-index': index }"
          :title="item.shown"
          data-testid="worktree-dialog-leftover"
        >
          <span class="flex min-w-0 flex-col">
            <span
              class="truncate font-mono text-11.5 font-medium"
              dir="ltr"
              data-testid="worktree-dialog-leftover-name"
            >{{ item.name }}</span>
            <span
              v-if="item.parent"
              class="truncate text-10.5 text-(--d-faint-text)"
              dir="ltr"
            >{{ item.parent }}</span>
            <span class="text-11 text-(--d-faint-text)">{{ t(`worktree.dialog.${item.reason}`) }}</span>
          </span>
          <span class="flex items-center gap-1.5">
            <!-- Only an unregistered folder is still on disk to reveal. -->
            <Button
              v-if="item.reason === 'unregistered'"
              type="button"
              variant="outline"
              :class="DIALOG_BUTTON"
              data-testid="worktree-dialog-reveal"
              @click="leftover('reveal', item.path)"
            >
              <Eye aria-hidden="true" />{{ t('worktree.dialog.reveal') }}
            </Button>
            <Button
              v-if="item.reason === 'gitRecordOnly'"
              type="button"
              variant="outline"
              :class="DANGER_BUTTON"
              :title="t('worktree.dialog.pruneTitle')"
              data-testid="worktree-dialog-prune"
              @click="leftover('prune', item.path)"
            >
              <Trash2 aria-hidden="true" />{{ t('worktree.dialog.prune') }}
            </Button>
            <Button
              v-if="item.reason === 'noChat'"
              type="button"
              variant="outline"
              :class="DANGER_BUTTON"
              data-testid="worktree-dialog-delete-leftover"
              @click="leftover('delete', item.path)"
            >
              <Trash2 aria-hidden="true" />{{ t('worktree.dialog.deleteLeftover') }}
            </Button>
            <Button
              v-if="item.reason === 'noChat'"
              type="button"
              variant="outline"
              :class="DIALOG_BUTTON"
              data-testid="worktree-dialog-keep-leftover"
              @click="leftover('keep', item.path)"
            >
              <Check aria-hidden="true" />{{ t('worktree.dialog.keepLeftover') }}
            </Button>
          </span>
        </li>
      </ul>
    </template>
  </OverlayDialog>
</template>
