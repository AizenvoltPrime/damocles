<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Info, MessageSquareText, Send, Users } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import SegmentedToggle from '@/components/SegmentedToggle.vue';
import RollingNumber from '@/components/RollingNumber.vue';
import type { ChatReviewComment, ChatReviewScope, ChatReviewTab } from '../../preload/review-channels';
import { MAX_REVIEW_COMMENTS } from '../../preload/review-channels';
import type { DamoclesShellApi, ShellEditorTab, ShellPlatform } from '../../preload/shell-channels';
import { LETTER_TONE } from '@shared/scm/status-letter';
import type { ChangesSource } from './changes-source';
import ChangesTab from './ChangesTab.vue';

// The "Changes: {chat title}" tab (D60): the chat's files in Whole chat or Last turn, line comments, and the bar that sends
// them to the chat as one message. Main keeps the drafts per chat for the run; the tab sends each change of them.
const props = defineProps<{ api: DamoclesShellApi; tab: ShellEditorTab & { review: ChatReviewTab }; platform: ShellPlatform }>();
const { t } = useI18n();

const review = computed(() => props.tab.review);
const drafts = shallowRef<readonly ChatReviewComment[]>([]);
const sending = ref(false);
// error: the send itself failed (the request was refused or main threw); stale carries main's words, which its notice shows too
const sendFailure = ref<{ readonly reason: 'stale'; readonly message: string } | { readonly reason: 'unsent' | 'missing' | 'error' } | null>(null);
const failureText = computed(() => (sendFailure.value?.reason === 'stale' ? sendFailure.value.message : sendFailure.value ? t(`review.failed.${sendFailure.value.reason}`) : ''));
const sameComment = (a: ChatReviewComment, b: ChatReviewComment): boolean =>
  a.path === b.path && a.line === b.line && a.side === b.side && a.scope === b.scope && a.text === b.text && a.revision === b.revision;
const changes = ref<InstanceType<typeof ChangesTab> | null>(null);

// Main keeps the drafts per chat session; when the chat's session changes under the open tab, the tab takes that session's list.
watch(() => review.value.draftsKey, () => {
  drafts.value = review.value.comments;
  sendFailure.value = null;
}, { immediate: true });

function setDrafts(next: readonly ChatReviewComment[]): void {
  drafts.value = next;
  sendFailure.value = null;
  void props.api.review.setDrafts({ reviewId: review.value.reviewId, comments: next });
}

const source = computed<ChangesSource>(() => {
  const { reviewId, entries, scope } = review.value;
  return {
    entries: entries.map((entry) => ({
      path: entry.path,
      letter: entry.status,
      tone: LETTER_TONE[entry.status],
      status: t(`review.status.${entry.status}`),
      strike: entry.status === 'D',
      // the entry's revision is in it, so a diff whose content moved while its counts stayed is read again
      version: `${scope}:${JSON.stringify(entry)}`,
      commentable: entry.commentable,
      ...(entry.outsideEdits ? { note: t('review.outsideEdits') } : {}),
    })),
    emptyText: scope === 'turn' ? t('review.emptyTurn') : t('review.emptyChat'),
    missingText: t('review.missing'),
    fileDiff: (path) => props.api.review.fileDiff({ reviewId, path }),
    comments: {
      of: (path) => drafts.value.filter((comment) => comment.path === path && comment.scope === review.value.scope),
      add: (comment) => {
        if (drafts.value.length < MAX_REVIEW_COMMENTS) setDrafts([...drafts.value, { ...comment, scope: review.value.scope }]);
      },
      get full() {
        return drafts.value.length >= MAX_REVIEW_COMMENTS;
      },
      remove: (comment) => setDrafts(drafts.value.filter((candidate) => candidate !== comment)),
      stale: (comment) => review.value.staleComments.some((candidate) => sameComment(candidate, comment)),
      hint: t('review.hint'),
    },
  };
});

const stats = computed(() => review.value.entries.reduce((sum, entry) => ({ added: sum.added + entry.added, removed: sum.removed + entry.removed }), { added: 0, removed: 0 }));
const scopeOptions = computed(() => [
  { value: 'chat' as const, label: t('review.wholeChat'), attrs: { 'data-testid': 'review-scope-chat' } },
  { value: 'turn' as const, label: t('review.lastTurn'), attrs: { 'data-testid': 'review-scope-turn' } },
]);

function setScope(scope: ChatReviewScope): void {
  void props.api.review.setScope({ reviewId: review.value.reviewId, scope });
}

async function send(): Promise<void> {
  if (drafts.value.length === 0 || sending.value) return;
  sending.value = true;
  sendFailure.value = null;
  // main drops only the drafts it sent; a comment added meanwhile stays on both sides
  const sent = drafts.value;
  try {
    const result = await props.api.review.send({ reviewId: review.value.reviewId });
    if (result.ok || result.reason === 'empty') drafts.value = drafts.value.filter((comment) => !sent.includes(comment));
    else sendFailure.value = result.reason === 'stale' ? { reason: 'stale', message: result.message } : { reason: result.reason };
  } catch (err) {
    console.error('[review] sending the comments failed', err);
    sendFailure.value = { reason: 'error' };
  } finally {
    sending.value = false;
  }
}

function discard(): void {
  drafts.value = [];
  sendFailure.value = null;
  void props.api.review.discard({ reviewId: review.value.reviewId });
}

// Ctrl+Enter (Cmd+Enter on macOS) sends from anywhere in the tab (plan AD11: a focused field's key); a comment typed in the
// open box is added first and goes with the others.
function onKeydown(event: KeyboardEvent): void {
  const mod = props.platform === 'darwin' ? event.metaKey : event.ctrlKey;
  if (event.key !== 'Enter' || !mod || event.shiftKey || event.altKey) return;
  event.preventDefault();
  changes.value?.addComment();
  void send();
}

const sendKey = computed(() => (props.platform === 'darwin' ? '⌘ Enter' : 'Ctrl Enter'));
</script>

<template>
  <div
    data-testid="review-tab"
    class="absolute inset-0"
    @keydown="onKeydown"
  >
    <ChangesTab
      ref="changes"
      :source="source"
      :lead="t('review.lead')"
      :stats="stats"
    >
      <template #actions>
        <SegmentedToggle
          :model-value="review.scope"
          :options="scopeOptions"
          class="border border-(--d-border2) bg-(--d-input)"
          indicator-class="text-(--d-card)"
          selected-class="text-(--d-accent-text)"
          :aria-label="t('review.scopeLabel')"
          @update:model-value="setScope"
        />
      </template>
      <template
        v-if="review.shellChangesNotListed || review.sharedWith"
        #notice
      >
        <!-- A shared worktree's review lists every chat's changes in it (D60); core counts the others. -->
        <p
          v-if="review.sharedWith"
          data-testid="chat-review-shared-note"
          class="flex shrink-0 items-center gap-1.5 border-b border-(--d-border) bg-(--d-panel) px-3 py-1 text-11.5 text-(--d-muted)"
        >
          <Users
            aria-hidden="true"
            class="size-3.25 shrink-0 text-(--d-info-text)"
          />{{ t('review.sharedWorktree', { n: review.sharedWith }, review.sharedWith) }}
        </p>
        <p
          v-if="review.shellChangesNotListed"
          data-testid="review-shell-note"
          class="flex shrink-0 items-center gap-1.5 border-b border-(--d-border) bg-(--d-panel) px-3 py-1 text-11.5 text-(--d-muted)"
        >
          <Info
            aria-hidden="true"
            class="size-3.25 shrink-0 text-(--d-info-text)"
          />{{ t('review.shellNotListed') }}
        </p>
      </template>
      <template #footer>
        <Transition name="t-up">
          <div
            v-if="drafts.length > 0"
            data-testid="review-bar"
            role="region"
            :aria-label="t('review.barLabel')"
            class="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-(--d-border) bg-(--d-panel) px-3 py-1.5"
          >
            <MessageSquareText
              aria-hidden="true"
              class="size-3.75 shrink-0 text-(--d-accent-text)"
            />
            <span
              class="text-12.5 whitespace-nowrap"
              data-testid="review-bar-count"
              aria-live="polite"
            >
              <b><RollingNumber :value="drafts.length" /></b>{{ ` ${t('review.ready', drafts.length)}` }}
            </span>
            <!-- The reason takes its own row under the controls and wraps there, so a narrow tab still shows all of it. -->
            <span
              v-if="sendFailure"
              role="alert"
              data-testid="review-send-failure"
              class="order-last min-w-0 basis-full text-11.5/4 text-(--d-warning-text)"
            >{{ failureText }}</span>
            <span
              v-else
              class="min-w-0 truncate text-11.5 text-(--d-faint-text)"
            >{{ t('review.barHint') }}</span>
            <!-- One group at the end; where it cannot hold both on one row, each grows to the full row, as the comment box's do. -->
            <span class="ms-auto flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="review-discard"
                class="d-press h-7 grow rounded-7 border-(--d-border2) bg-transparent px-2.5 text-12 hover:bg-(--d-hover)"
                :disabled="sending"
                @click="discard"
              >
                {{ t('review.discard') }}
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="review-send"
                class="d-press h-7 grow gap-1.5 rounded-7 bg-(--d-accent) px-2.75 text-12 font-semibold text-(--d-on-accent) hover:bg-(--d-accent) hover:brightness-110 [&_svg]:size-3.25"
                :disabled="sending"
                :aria-keyshortcuts="platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'"
                :title="`${t('review.send')} (${sendKey})`"
                @click="send"
              >
                <Send aria-hidden="true" />{{ t('review.send') }}<kbd class="rounded-5 border border-current px-1 font-mono text-10 @max-[26rem]/changes:hidden">{{ sendKey }}</kbd>
              </Button>
            </span>
          </div>
        </Transition>
      </template>
    </ChangesTab>
  </div>
</template>
