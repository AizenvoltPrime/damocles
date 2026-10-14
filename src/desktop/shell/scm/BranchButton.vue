<script setup lang="ts">
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronsUpDown, CircleDot, GitBranch } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { ScmHead, ScmRepoSnapshot } from '../../preload/scm-channels';
import { SCM_STORE } from './scm-store';
import { visibleText } from '@shared/visible-text';

// The prototype's branch button (VS Code's checkout status bar item): the branch, or a detached HEAD's short hash, with the
// "local" marker while the branch has no upstream; a click runs Checkout to...
const props = defineProps<{ snapshot: ScmRepoSnapshot; head: ScmHead }>();
const { t } = useI18n();
const store = inject(SCM_STORE)!;

const detached = computed(() => props.head.type === 'detached');
const label = computed(() => {
  const head = props.head;
  return visibleText(head.type === 'detached' ? head.commit.slice(0, 8) : head.name);
});
const unpublished = computed(() => props.head.type === 'branch' && props.snapshot.upstream === null);
const state = computed(() => {
  const upstream = props.snapshot.upstream;
  if (upstream) return t('scm.branch.tracking', { upstream: visibleText(`${upstream.remote}/${upstream.branch}`) });
  return unpublished.value ? t('scm.branch.unpublished') : undefined;
});
const title = computed(() => (state.value === undefined ? t('scm.action.checkout') : t('scm.branch.title', { action: t('scm.action.checkout'), state: state.value })));
const ariaLabel = computed(() => {
  const named = { action: t('scm.action.checkout'), branch: label.value };
  return state.value === undefined ? t('scm.branch.aria', named) : t('scm.branch.ariaState', { ...named, state: state.value });
});

// A copy on its way out is presentation only: it leaves without its test id and hidden from assistive technology.
function retire(element: Element): void {
  element.removeAttribute('data-testid');
  element.setAttribute('aria-hidden', 'true');
}

function checkout(): void {
  void store.api.run({ op: 'checkout', repoId: props.snapshot.repoId, detached: false });
}
</script>

<template>
  <Button
    type="button"
    variant="ghost"
    data-testid="scm-branch"
    :data-detached="detached || undefined"
    :title="title"
    :aria-label="ariaLabel"
    class="d-press h-7 min-w-0 flex-1 justify-start gap-1.5 rounded-7 border border-(--d-border2) bg-(--d-card) px-2.25 py-0 font-mono text-11.5 font-normal text-(--d-text) transition-colors duration-150 hover:border-(--d-accent) hover:bg-(--d-card) hover:text-(--d-text) focus-visible:border-(--d-accent) focus-visible:ring-0 focus-visible:ring-offset-0 [&_svg]:size-3.25"
    @click="checkout"
  >
    <span
      aria-hidden="true"
      class="inline-flex size-3.25 shrink-0 items-center justify-center text-(--d-accent-text)"
    >
      <Transition name="t-icon">
        <CircleDot
          v-if="detached"
          key="detached"
        />
        <GitBranch
          v-else
          key="branch"
        />
      </Transition>
    </span>
    <!-- Both copies share one grid cell while the label swaps, so the button never grows by a line. -->
    <span class="grid min-w-0 flex-1 overflow-hidden text-left">
      <Transition
        name="t-swap-down"
        @before-leave="retire"
      >
        <span
          :key="label"
          data-testid="scm-branch-label"
          class="min-w-0 truncate [grid-area:1/1]"
        >{{ label }}</span>
      </Transition>
    </span>
    <Transition name="t-badge">
      <span
        v-if="unpublished"
        data-testid="scm-branch-local"
        class="shrink-0 font-sans text-10 text-(--d-warning-text)"
      >{{ t('scm.branch.local') }}</span>
    </Transition>
    <ChevronsUpDown
      aria-hidden="true"
      class="size-3! shrink-0 text-(--d-faint)"
    />
  </Button>
</template>
