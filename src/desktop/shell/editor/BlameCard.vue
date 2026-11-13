<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowUpRight, Copy, GitCommitHorizontal, History } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import ForgeAvatar from '@/components/settings/forge/ForgeAvatar.vue';
import { commitTime } from '@/utils/clock';
import type { ScmBlameCommit } from '../../preload/scm-channels';
import type { ContainingChange } from '@shared/forge/history';
import { scanReferences, type ForgeReference } from '@shared/forge/references';
import { visibleText } from '@shared/visible-text';
import { LINK, mergedLabel } from '../forge/history-view';

// The inline blame's hover card (blame.ts getBlameInformationHover): who, when and what, with the commit's actions.
const props = defineProps<{
  commit: ScmBlameCommit;
  ago: string;
  // the author's picture over the initial once core issued a key (none with showAvatars off)
  avatarKey?: string | undefined;
  // the repository's server kind: the summary links its references and Open Commit on Server shows; absent (no registered
  // server): plain text and no server action
  forgeKind?: 'github' | 'gitlab' | undefined;
  // the merged MR/PR holding the commit, once known
  merged?: ContainingChange | null | undefined;
}>();
const emit = defineEmits<{
  openCommit: [];
  copyCommitId: [];
  openTimeline: [];
  openOnServer: [];
  openReference: [reference: ForgeReference];
  openMerged: [];
  hold: [by: 'pointer' | 'focus', inside: boolean];
  avatarFailed: [];
}>();
const { t, locale } = useI18n();

const date = computed(() => commitTime(props.commit.authorTime, locale.value).full);
const author = computed(() => visibleText(props.commit.author));
const summary = computed(() => visibleText(props.commit.summary));
const segments = computed(() => (props.forgeKind === undefined ? [{ text: summary.value }] : scanReferences(summary.value, props.forgeKind)));
const ACTION = 'd-press h-6.5 gap-1.5 rounded-md px-2 text-12 text-(--d-text) hover:bg-(--d-hover) [&_svg]:size-3.5';
</script>

<template>
  <div
    role="dialog"
    data-testid="blame-card"
    :aria-label="t('blame.cardLabel', { author })"
    class="qd-blame-card w-80 max-w-full rounded-10 border border-(--d-border2) bg-(--d-card) p-3 text-12.5 text-(--d-text) shadow-(--d-shadow)"
    @pointerenter="emit('hold', 'pointer', true)"
    @pointerleave="emit('hold', 'pointer', false)"
    @focusin="emit('hold', 'focus', true)"
    @focusout="emit('hold', 'focus', false)"
  >
    <div class="flex items-center gap-2.5">
      <ForgeAvatar
        :login="author"
        :avatar-key="avatarKey"
        size="row"
        @failed="emit('avatarFailed')"
      />
      <div class="min-w-0 flex-1">
        <div class="truncate font-medium">
          {{ author }}
        </div>
        <div class="truncate text-11.5 text-(--d-faint-text)">
          {{ visibleText(commit.authorEmail) }}
        </div>
      </div>
      <span
        class="shrink-0 text-11.5 text-(--d-muted)"
        :title="date"
      >{{ ago }}</span>
    </div>
    <p
      class="mt-2.5 line-clamp-3 wrap-break-word"
      data-testid="blame-card-summary"
    >
      <template
        v-for="(segment, index) in segments"
        :key="index"
      >
        <button
          v-if="segment.reference"
          type="button"
          role="link"
          data-testid="blame-card-ref"
          class="text-(--d-accent-text)"
          :class="LINK"
          @click="emit('openReference', segment.reference)"
          v-text="segment.text"
        />
        <span
          v-else
          v-text="segment.text"
        />
      </template>
    </p>
    <div class="mt-2 flex flex-wrap items-center gap-2 text-11.5 text-(--d-faint-text)">
      <span
        class="rounded-5 bg-(--d-hover) px-1.5 font-mono text-(--d-muted)"
        data-testid="blame-card-hash"
      >{{ commit.hash.slice(0, 7) }}</span>
      <span data-testid="blame-card-date">{{ date }}</span>
      <i18n-t
        v-if="merged"
        tag="span"
        keypath="graph.status.merged"
        scope="global"
        data-testid="blame-card-merged"
      >
        <template #ref>
          <button
            type="button"
            role="link"
            data-testid="blame-card-merged-link"
            class="text-(--d-accent-text)"
            :class="LINK"
            @click="emit('openMerged')"
            v-text="mergedLabel(merged)"
          />
        </template>
      </i18n-t>
    </div>
    <div class="mt-2.5 flex flex-wrap items-center gap-1 border-t border-(--d-border) pt-2">
      <!-- data-blame-first: Show Line Blame focuses the card's first action -->
      <Button
        size="sm"
        variant="ghost"
        data-testid="blame-open-commit"
        data-blame-first
        :class="ACTION"
        @click="emit('openCommit')"
      >
        <GitCommitHorizontal aria-hidden="true" />{{ t('blame.openCommit') }}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid="blame-copy-commit-id"
        :class="ACTION"
        @click="emit('copyCommitId')"
      >
        <Copy aria-hidden="true" />{{ t('blame.copyCommitId') }}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid="blame-open-timeline"
        :class="ACTION"
        @click="emit('openTimeline')"
      >
        <History aria-hidden="true" />{{ t('blame.openTimeline') }}
      </Button>
      <!-- main opens the commit on its Git hosting server, or says why it cannot; only with a remote on such a server -->
      <Button
        v-if="forgeKind !== undefined"
        size="sm"
        variant="ghost"
        data-testid="blame-open-on-server"
        :class="ACTION"
        @click="emit('openOnServer')"
      >
        <ArrowUpRight aria-hidden="true" />{{ t('blame.openOnServer') }}
      </Button>
    </div>
  </div>
</template>
