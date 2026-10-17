<script setup lang="ts">
import { computed, inject, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { CloudUpload, RefreshCw } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { ScmRepoSnapshot } from '../../preload/scm-channels';
import { SCM_STORE } from './scm-store';
import { visibleText } from '@shared/visible-text';

// The sync button beside the branch button (prototype; VS Code's SyncStatusBar): Publish for a branch without an upstream,
// "N↓ M↑" (behind, then ahead) for one with an upstream; the arrows spin while a remote operation runs on the repository.
const props = defineProps<{ snapshot: ScmRepoSnapshot; committing: boolean }>();
const { t } = useI18n();
const store = inject(SCM_STORE)!;

const spinning = computed(() => props.snapshot.running !== null);
// VS Code: a branch with a commit syncs or publishes; a detached HEAD or an unborn branch shows the icon without a command.
const mode = computed<'publish' | 'counts' | 'none'>(() => {
  const head = props.snapshot.head;
  if (head?.type !== 'branch' || props.snapshot.commit === null) return 'none';
  return props.snapshot.upstream === null ? 'publish' : 'counts';
});
const behind = computed(() => props.snapshot.upstream?.behind ?? 0);
const ahead = computed(() => props.snapshot.upstream?.ahead ?? 0);
const enabled = computed(() => mode.value !== 'none' && !spinning.value && !props.committing);

// VS Code's statusbar tooltips (SyncStatusBar.command, Repository.syncTooltip); with no command, where VS Code's tooltip is
// empty, the reason, since a disabled control still needs a name.
const tooltip = computed(() => {
  if (spinning.value) return t('scm.sync.running');
  if (props.committing) return t('scm.sync.committing');
  if (mode.value === 'none') return props.snapshot.head?.type === 'detached' ? t('scm.sync.detached') : t('scm.sync.unborn');
  const upstream = props.snapshot.upstream;
  if (mode.value === 'publish') return t('scm.sync.publish');
  if (!upstream || (upstream.ahead === 0 && upstream.behind === 0)) return t('scm.sync.sync');
  const named = { remote: visibleText(upstream.remote), branch: visibleText(upstream.branch), behind: upstream.behind, ahead: upstream.ahead };
  if (upstream.ahead === 0) return t('scm.sync.pull', upstream.behind, { named });
  if (upstream.behind === 0) return t('scm.sync.push', upstream.ahead, { named });
  // one noun after both counts, singular only when both are one
  return t('scm.sync.pullPush', Math.max(upstream.behind, upstream.ahead), { named });
});

function run(): void {
  if (!enabled.value) return;
  const repoId = props.snapshot.repoId;
  void store.api.run(mode.value === 'publish' ? { op: 'publish', repoId } : { op: 'sync', repoId, rebase: false });
}

// A count that rose rolls up and one that fell rolls down, another repository's too; an arrow whose count rose in the same
// repository bumps and lights up once, the glow leaving once it has faded.
const roll = reactive({ behind: 't-swap', ahead: 't-swap' });
const pulses = reactive({ behind: 0, ahead: 0 });
const glowing = reactive({ behind: false, ahead: false });
watch([() => props.snapshot.repoId, behind, ahead], ([repoId, nextBehind, nextAhead], [previousRepo, previousBehind, previousAhead]) => {
  if (nextBehind !== previousBehind) roll.behind = nextBehind > previousBehind ? 't-swap' : 't-swap-down';
  if (nextAhead !== previousAhead) roll.ahead = nextAhead > previousAhead ? 't-swap' : 't-swap-down';
  if (repoId !== previousRepo) return;
  if (nextBehind > previousBehind) {
    pulses.behind++;
    glowing.behind = true;
  }
  if (nextAhead > previousAhead) {
    pulses.ahead++;
    glowing.ahead = true;
  }
});

// A copy on its way out is presentation only: it leaves without its test id and hidden from assistive technology.
function retire(element: Element): void {
  element.removeAttribute('data-testid');
  element.setAttribute('aria-hidden', 'true');
}

// The spin ends by coasting to its next full turn rather than snapping back upright.
const spinner = ref<HTMLElement | null>(null);
const settle = ref<{ from: number; time: number } | null>(null);
watch(spinning, (on, was) => {
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
  // Swapped for .d-spinning in the same patch, so no frame shows the icon upright.
  settle.value = { from: angle, time: Math.round(Math.max(0.3, ((360 - angle) / 360) * 1.2) * 100) / 100 };
});
</script>

<template>
  <Button
    type="button"
    variant="ghost"
    data-testid="scm-sync"
    :data-mode="mode"
    :data-running="snapshot.running ?? undefined"
    :aria-label="tooltip"
    :title="tooltip"
    :aria-disabled="!enabled || undefined"
    :aria-busy="spinning || undefined"
    class="h-7 shrink-0 gap-1.25 rounded-7 py-0 border border-(--d-border2) bg-(--d-card) px-2.25 font-mono text-11 font-normal text-(--d-muted) transition-colors duration-150 hover:bg-(--d-card) focus-visible:border-(--d-accent) focus-visible:ring-0 focus-visible:ring-offset-0 [&_svg]:size-3"
    :class="[enabled ? 'd-press hover:border-(--d-accent) hover:text-(--d-text)' : 'cursor-default hover:text-(--d-muted)', mode === 'none' && !spinning && !committing ? 'opacity-50' : '']"
    @click="run"
  >
    <span
      ref="spinner"
      aria-hidden="true"
      class="inline-flex size-3 items-center justify-center"
      :class="spinning ? 'd-spinning' : settle ? 'd-settle' : ''"
      :style="settle ? { '--settle-from': `${settle.from}deg`, '--settle-time': `${settle.time}s` } : undefined"
      @animationend.self="settle = null"
    >
      <Transition name="t-icon">
        <CloudUpload
          v-if="mode === 'publish' && !spinning"
          key="publish"
        />
        <RefreshCw
          v-else
          key="sync"
        />
      </Transition>
    </span>
    <span
      v-if="mode !== 'none'"
      aria-hidden="true"
      class="inline-grid"
    >
      <Transition
        name="t-morph"
        @before-leave="retire"
      >
        <span
          v-if="mode === 'publish'"
          key="publish"
          data-testid="scm-sync-label"
          class="[grid-area:1/1]"
        >{{ t('scm.sync.publishLabel') }}</span>
        <span
          v-else
          key="counts"
          data-testid="scm-sync-label"
          class="inline-flex items-center gap-1.25 [grid-area:1/1]"
        >
          <span class="inline-flex items-center">
            <span class="inline-grid">
              <Transition
                :name="roll.behind"
                @before-leave="retire"
              >
                <span
                  :key="behind"
                  data-testid="scm-sync-behind"
                  class="[grid-area:1/1]"
                >{{ behind }}</span>
              </Transition>
            </span>
            <span
              :key="`behind-${pulses.behind}`"
              class="relative inline-block [--bump:0.0625rem]"
              :class="pulses.behind > 0 ? 'd-count-bump' : ''"
            >↓<span
              v-if="glowing.behind"
              data-testid="scm-sync-pulse"
              class="d-count-glow absolute inset-0 text-(--d-accent-text)"
              @animationend="glowing.behind = false"
            >↓</span></span>
          </span>
          <span class="inline-flex items-center">
            <span class="inline-grid">
              <Transition
                :name="roll.ahead"
                @before-leave="retire"
              >
                <span
                  :key="ahead"
                  data-testid="scm-sync-ahead"
                  class="[grid-area:1/1]"
                >{{ ahead }}</span>
              </Transition>
            </span>
            <span
              :key="`ahead-${pulses.ahead}`"
              class="relative inline-block [--bump:-0.0625rem]"
              :class="pulses.ahead > 0 ? 'd-count-bump' : ''"
            >↑<span
              v-if="glowing.ahead"
              data-testid="scm-sync-pulse"
              class="d-count-glow absolute inset-0 text-(--d-accent-text)"
              @animationend="glowing.ahead = false"
            >↑</span></span>
          </span>
        </span>
      </Transition>
    </span>
  </Button>
</template>
