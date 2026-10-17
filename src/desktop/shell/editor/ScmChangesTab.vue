<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArchiveRestore, ArrowUpFromLine, Check, Trash2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { ScmChangesTab } from '../../preload/scm-channels';
import type { ShellEditorTab } from '../../preload/shell-channels';
import { SCM_STORE } from '../scm/scm-store';
import type { ChangesSource } from './changes-source';
import ChangesTab from './ChangesTab.vue';

// Source control's multi-file diff tab: a group's changes, View Stash (with its title actions) or a Compare of two refs.
const props = defineProps<{ tab: ShellEditorTab & { changes: ScmChangesTab } }>();
const { t } = useI18n();
const store = inject(SCM_STORE)!;

const source = computed<ChangesSource>(() => {
  const { repoId, source: diffSource, entries } = props.tab.changes;
  return {
    entries: entries.map((entry) => ({
      path: entry.path,
      letter: entry.letter,
      tone: entry.tone,
      status: t(`scm.status.${entry.status}`),
      strike: entry.strike,
      version: JSON.stringify(entry),
    })),
    emptyText: t('changesTab.noFiles'),
    fileDiff: (path) => store.api.fileDiff({ repoId, source: diffSource, path }),
    openFile: (path) => void store.api.run({ op: 'openFile', repoId, path }),
  };
});

// View Stash's title actions (VS Code's git.stashApplyEditor, git.stashPopEditor and git.stashDropEditor). The tab lives as long
// as its stash: Apply keeps it, and main closes it once a pop or a confirmed drop removes the stash.
const stash = computed(() => {
  const source = props.tab.changes.source;
  return source.kind === 'stash' ? { index: source.index, hash: source.hash } : undefined;
});
const stashBusy = ref(false);
// counts each applied stash, so the check plays again on the next apply
const applied = ref(0);
let appliedTimer: ReturnType<typeof setTimeout> | undefined;
// ms the applied check stays before the archive icon returns
const APPLIED_MS = 1400;

async function runStash(action: 'apply' | 'pop' | 'drop'): Promise<void> {
  const target = stash.value;
  if (!target || stashBusy.value) return;
  stashBusy.value = true;
  try {
    const repoId = props.tab.changes.repoId;
    const result = await store.api.run(action === 'drop' ? { op: 'stashDrop', repoId, target } : { op: 'stashApply', repoId, pop: action === 'pop', target });
    if (action === 'apply' && result.ok) {
      applied.value++;
      clearTimeout(appliedTimer);
      appliedTimer = setTimeout(() => {
        applied.value = 0;
      }, APPLIED_MS);
    }
  } finally {
    stashBusy.value = false;
  }
}
onBeforeUnmount(() => clearTimeout(appliedTimer));
</script>

<template>
  <ChangesTab
    :data-source="tab.changes.source.kind"
    :source="source"
    :lead="tab.title"
  >
    <template
      v-if="stash"
      #actions
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="changes-stash-apply"
        :data-applied="applied > 0 || undefined"
        class="d-press size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
        :disabled="stashBusy"
        :aria-label="t('scm.action.applyStash')"
        :title="t('scm.action.applyStash')"
        @click="runStash('apply')"
      >
        <!-- A successful apply turns the icon into a check for a moment. -->
        <span class="inline-flex size-3.25 items-center justify-center">
          <Transition name="t-icon">
            <Check
              v-if="applied > 0"
              :key="`applied-${applied}`"
              aria-hidden="true"
              class="text-(--d-success-text)"
            />
            <ArchiveRestore
              v-else
              key="apply"
              aria-hidden="true"
            />
          </Transition>
        </span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="changes-stash-pop"
        class="d-press size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
        :disabled="stashBusy"
        :aria-label="t('scm.action.popStash')"
        :title="t('scm.action.popStash')"
        @click="runStash('pop')"
      >
        <ArrowUpFromLine aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="changes-stash-drop"
        class="d-press size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-danger-text) [&_svg]:size-3.25"
        :disabled="stashBusy"
        :aria-label="t('scm.action.dropStash')"
        :title="t('scm.action.dropStash')"
        @click="runStash('drop')"
      >
        <Trash2 aria-hidden="true" />
      </Button>
      <span
        class="sr-only"
        aria-live="polite"
      >{{ applied > 0 ? t('changesTab.stashApplied') : '' }}</span>
    </template>
  </ChangesTab>
</template>
