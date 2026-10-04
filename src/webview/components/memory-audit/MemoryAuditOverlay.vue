<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import type { AcceptableValue } from 'reka-ui';
import { ShieldCheck, TriangleAlert, Info, RefreshCw } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import OverlayShell from '../OverlayShell.vue';
import LoadingSpinner from '../LoadingSpinner.vue';
import { memoryLabel } from '../context-injection/memory-display';
import { auditResultText } from './audit-result-text';
import { useMemoryAuditStore } from '@/stores/useMemoryAuditStore';
import { useCostLabel } from '@/composables/useCostLabel';
import { formatTokenCount } from '@/composables/useTeamFormatting';
import { folderName } from '@/lib/folder-name';
import type { MemoryAuditAction, MemoryAuditProposalStatus, MemoryAuditProposalView } from '@shared/types/memory-audit';

const emit = defineEmits<{ (e: 'close'): void }>();

const { t, te, locale } = useI18n();
const store = useMemoryAuditStore();
const { state, run, proposals, liveRun, heldElsewhere, error, pendingAction, lastResult, cancelResult } = storeToRefs(store);
const { costLabel, costTitle } = useCostLabel();

const ACTION_ORDER: readonly MemoryAuditAction[] = ['forget', 'rescope_global', 'rescope_workspace', 'to_episode', 'profile_rewrite'];
const PROFILE_SECTIONS = ['static', 'dynamic'] as const;

type Decision = 'accept' | 'reject' | 'undecided';
const DECISIONS: readonly Decision[] = ['accept', 'undecided', 'reject'];

/** Explicit decisions only; a pending proposal missing here is undecided and stays pending on apply. */
const decisions = ref(new Map<string, 'accept' | 'reject'>());
const confirmingRevert = ref(false);
const confirmingStart = ref(false);

watch(state, () => {
  confirmingRevert.value = false;
  confirmingStart.value = false;
});

const estimate = computed(() => state.value?.estimate ?? null);
const pending = computed(() => proposals.value.filter((p) => p.status === 'pending'));
const acceptIds = computed(() => pending.value.filter((p) => decisions.value.get(p.id) === 'accept').map((p) => p.id));
const rejectIds = computed(() => pending.value.filter((p) => decisions.value.get(p.id) === 'reject').map((p) => p.id));
const undecidedCount = computed(() => pending.value.length - acceptIds.value.length - rejectIds.value.length);
const appliedCount = computed(() => proposals.value.filter((p) => p.status === 'applied').length);
const resultText = computed(() => (lastResult.value ? auditResultText(lastResult.value) : null));

const groups = computed(() =>
  ACTION_ORDER
    .map((action) => {
      const items = proposals.value.filter((p) => p.action === action);
      const pendingIds = items.filter((p) => p.status === 'pending').map((p) => p.id);
      return { action, items, pendingIds };
    })
    .filter((g) => g.items.length > 0),
);

const canStart = computed(() => {
  const e = estimate.value;
  if (!e || e.model === null || e.memoryCount + e.profileCount === 0) return false;
  return pendingAction.value === null && !(run.value?.leaseActive ?? false);
});

const progressPercent = computed(() => {
  const r = liveRun.value;
  return r && r.total > 0 ? Math.round((r.graded / r.total) * 100) : 0;
});

const integerFormat = computed(() => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 0 }));

function count(n: number): string {
  return integerFormat.value.format(n);
}

function tokens(n: number): string {
  return formatTokenCount(n, locale.value);
}

function scopeLabel(scope: string | null, workspace: string | null): string {
  const key = `memory.scope.${scope ?? 'unknown'}`;
  const label = te(key) ? t(key) : (scope ?? t('memory.scope.unknown'));
  return workspace ? `${label} · ${folderName(workspace)}` : label;
}

function kindLabel(kind: string): string {
  const key = `memory.kind.${kind}`;
  return te(key) ? t(key) : kind;
}

function proposedLabel(p: MemoryAuditProposalView): string {
  switch (p.action) {
    case 'forget': return t('memoryAudit.proposedValue.forget');
    case 'rescope_global': return scopeLabel('global', null);
    case 'rescope_workspace': return scopeLabel('project', p.targetWorkspace);
    case 'to_episode': return t('memoryAudit.proposedValue.episode');
    case 'profile_rewrite': return '';
  }
}

function profileLabel(p: MemoryAuditProposalView): string {
  return p.profileScope === 'project'
    ? t('memoryAudit.profile.project', { workspace: p.profileWorkspace ? folderName(p.profileWorkspace) : '' })
    : t('memoryAudit.profile.global');
}

function rowLabel(p: MemoryAuditProposalView): string {
  return p.action === 'profile_rewrite' ? profileLabel(p) : (p.title ?? p.contentPreview ?? p.memoryId ?? p.id);
}

function accessibleLabel(p: MemoryAuditProposalView): string {
  return p.action === 'profile_rewrite' ? profileLabel(p) : memoryLabel(p.title, p.contentPreview ?? p.memoryId ?? p.id);
}

function statusClass(status: MemoryAuditProposalStatus): string {
  switch (status) {
    case 'applied': return 'text-success border-success/40';
    case 'stale': return 'text-warning border-warning/40';
    case 'rejected':
    case 'reverted':
    case 'pending': return 'text-muted-foreground';
  }
}

function decisionOf(id: string): Decision {
  return decisions.value.get(id) ?? 'undecided';
}

function isDecision(value: AcceptableValue): value is Decision {
  return value === 'accept' || value === 'reject' || value === 'undecided';
}

/** A toggle group reports a click on its pressed item as no value; the decision then stays. */
function setDecisions(ids: readonly string[], value: AcceptableValue): void {
  if (!isDecision(value)) return;
  const next = new Map(decisions.value);
  for (const id of ids) {
    if (value === 'undecided') next.delete(id);
    else next.set(id, value);
  }
  decisions.value = next;
}

function groupDecision(ids: readonly string[]): Decision | 'mixed' {
  const first = ids[0];
  if (first === undefined) return 'undecided';
  const decision = decisionOf(first);
  return ids.every((id) => decisionOf(id) === decision) ? decision : 'mixed';
}

function requestStart(): void {
  if (state.value?.startEndsLatestRun) confirmingStart.value = true;
  else store.start();
}

function confirmStart(): void {
  confirmingStart.value = false;
  store.start();
}

function applyDecisions(): void {
  const r = run.value;
  if (!r) return;
  store.apply(r.id, acceptIds.value, rejectIds.value);
}

function confirmRevert(): void {
  const r = run.value;
  if (!r) return;
  confirmingRevert.value = false;
  store.revert(r.id);
}
</script>

<template>
  <OverlayShell
    data-testid="memory-audit-overlay"
    :title="t('memoryAudit.title')"
    :subtitle="t('memoryAudit.subtitle')"
    :icon="ShieldCheck"
    @close="emit('close')"
  >
    <div class="@container flex flex-col gap-3 px-4.5 pt-4 pb-5">
      <div
        v-if="error"
        role="alert"
        class="flex items-start gap-2 rounded-md border border-[color-mix(in_srgb,var(--d-danger)_50%,transparent)] p-3 text-xs text-(--d-danger)"
        data-audit-error
      >
        <TriangleAlert class="size-3.5 shrink-0 mt-0.5" />
        <span class="wrap-break-word">{{ t(`memoryAudit.error.${error}`) }}</span>
      </div>

      <p v-if="resultText" role="status" class="text-xs text-(--d-muted)" data-audit-result>{{ resultText }}</p>
      <p v-if="cancelResult === 'held-elsewhere'" role="status" class="text-xs text-(--d-warning)" data-audit-cancel-held>
        {{ t('memoryAudit.cancelHeldElsewhere') }}
      </p>

      <div
        v-if="heldElsewhere"
        class="flex items-center gap-2 rounded-md border border-[color-mix(in_srgb,var(--d-warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--d-warning)_10%,transparent)] p-3 text-xs"
        data-audit-held
      >
        <Info class="size-3.5 shrink-0 text-(--d-warning)" />
        <span class="flex-1">{{ t('memoryAudit.heldElsewhere') }}</span>
        <Button variant="outline" size="sm" class="h-6 text-xs shrink-0" data-audit-refresh @click="store.requestState()">
          <RefreshCw class="size-3 mr-1" />{{ t('memoryAudit.refresh') }}
        </Button>
      </div>

      <div
        v-if="state === null && !error"
        class="flex items-center justify-center gap-2 py-12 text-xs text-(--d-muted)"
        data-audit-loading
      >
        <LoadingSpinner class="size-4" />{{ t('memoryAudit.loading') }}
      </div>

      <template v-else-if="state">
        <section
          v-if="liveRun"
          class="space-y-2 rounded-10 border border-(--d-border) bg-(--d-card) px-3 py-2.5"
          data-audit-progress
        >
          <h3 class="text-11 font-semibold tracking-[.07em] text-(--d-faint) uppercase">{{ t('memoryAudit.progress.title') }}</h3>
          <div
            class="h-1.5 overflow-hidden rounded-full bg-(--d-hover)"
            role="progressbar"
            :aria-label="t('memoryAudit.progress.title')"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="progressPercent"
          >
            <div
              class="h-full origin-left rounded-full bg-(--d-accent) transition-transform duration-300 ease-out rtl:origin-right"
              :style="{ transform: `scaleX(${progressPercent / 100})` }"
            />
          </div>
          <div class="flex items-center gap-2 text-xs text-(--d-muted)">
            <span data-audit-progress-count>{{ t('memoryAudit.progress.count', { graded: count(liveRun.graded), total: count(liveRun.total) }) }}</span>
            <span v-if="liveRun.failedBatches > 0" class="text-(--d-warning)" data-audit-progress-failed>
              {{ t('memoryAudit.progress.failed', { n: liveRun.failedBatches }, liveRun.failedBatches) }}
            </span>
            <Button
              variant="outline"
              size="sm"
              class="ml-auto h-6 text-xs"
              :disabled="pendingAction === 'cancel'"
              data-audit-cancel
              @click="store.cancel()"
            >
              {{ pendingAction === 'cancel' ? t('memoryAudit.progress.cancelling') : t('memoryAudit.progress.cancel') }}
            </Button>
          </div>
        </section>

        <section
          v-else-if="estimate"
          class="flex flex-col gap-3"
          data-audit-estimate
        >
          <h3 class="text-11 font-semibold tracking-[.07em] text-(--d-faint) uppercase">{{ t('memoryAudit.estimate.title') }}</h3>
          <dl class="flex flex-wrap gap-px overflow-hidden rounded-lg border border-(--d-border) bg-(--d-border)">
            <div class="flex min-w-0 flex-[1_1_8rem] flex-col bg-(--d-bg) px-2.75 pt-2.25 pb-2">
              <dt class="truncate text-11 text-(--d-muted)">{{ t('memoryAudit.estimate.memories') }}</dt>
              <dd class="mt-0.5 font-mono text-[1.0625rem] font-semibold tabular-nums" data-estimate="memories">{{ count(estimate.memoryCount) }}</dd>
            </div>
            <div class="flex min-w-0 flex-[1_1_8rem] flex-col bg-(--d-bg) px-2.75 pt-2.25 pb-2">
              <dt class="truncate text-11 text-(--d-muted)">{{ t('memoryAudit.estimate.profiles') }}</dt>
              <dd class="mt-0.5 font-mono text-[1.0625rem] font-semibold tabular-nums" data-estimate="profiles">{{ count(estimate.profileCount) }}</dd>
            </div>
            <div class="flex min-w-0 flex-[1_1_8rem] flex-col bg-(--d-bg) px-2.75 pt-2.25 pb-2">
              <dt class="truncate text-11 text-(--d-muted)">{{ t('memoryAudit.estimate.inputTokens') }}</dt>
              <dd class="mt-0.5 font-mono text-[1.0625rem] font-semibold tabular-nums" data-estimate="input-tokens">{{ tokens(estimate.inputTokens) }}</dd>
            </div>
            <div class="flex min-w-0 flex-[1_1_8rem] flex-col bg-(--d-bg) px-2.75 pt-2.25 pb-2">
              <dt class="truncate text-11 text-(--d-muted)">{{ t('memoryAudit.estimate.outputTokens') }}</dt>
              <dd class="mt-0.5 font-mono text-[1.0625rem] font-semibold tabular-nums" data-estimate="output-tokens">{{ tokens(estimate.outputTokens) }}</dd>
            </div>
            <div
              v-if="estimate.model && (estimate.unpriced || estimate.costUsd !== null)"
              class="flex min-w-0 flex-[1_1_8rem] flex-col bg-(--d-bg) px-2.75 pt-2.25 pb-2"
            >
              <dt class="truncate text-11 text-(--d-muted)" data-estimate="cost-label">
                {{ estimate.model.dollarBilled ? t('memoryAudit.estimate.cost') : t('memoryAudit.estimate.costApiEquivalent') }}
              </dt>
              <dd v-if="estimate.unpriced" class="mt-0.5 font-mono text-[1.0625rem] font-semibold" data-estimate="cost" :title="t('common.unpricedTooltip')">{{ t('common.unpriced') }}</dd>
              <dd v-else-if="estimate.costUsd !== null" class="mt-0.5 font-mono text-[1.0625rem] font-semibold tabular-nums" data-estimate="cost" :title="costTitle(estimate.model.dollarBilled)">
                {{ costLabel(estimate.costUsd, estimate.model.dollarBilled) }}
              </dd>
            </div>
          </dl>
          <div class="flex min-w-0 items-center gap-2 text-xs">
            <span class="text-(--d-faint)">{{ t('memoryAudit.estimate.model') }}</span>
            <span class="min-w-0 truncate rounded-5 bg-(--d-hover) px-1.5 font-mono text-11.5 text-(--d-muted)" data-estimate="model">
              {{ estimate.model ? `${estimate.model.provider}/${estimate.model.id}` : t('memoryAudit.estimate.noModelShort') }}
            </span>
          </div>
          <p v-if="estimate.model === null" class="text-xs text-(--d-warning)" data-audit-no-model>
            {{ t('memoryAudit.estimate.noModel') }}
          </p>
          <p v-else-if="estimate.memoryCount + estimate.profileCount === 0" class="text-xs text-(--d-muted)">
            {{ t('memoryAudit.estimate.nothing') }}
          </p>
          <p class="text-xs text-(--d-muted)">{{ t('memoryAudit.estimate.note') }}</p>
          <div
            v-if="confirmingStart"
            role="alert"
            class="space-y-2 rounded-md border border-[color-mix(in_srgb,var(--d-warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--d-warning)_10%,transparent)] p-2 text-xs"
            data-audit-start-prompt
          >
            <p>{{ t('memoryAudit.estimate.confirmNew') }}</p>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" size="sm" class="h-7 text-xs" data-audit-start-cancel @click="confirmingStart = false">
                {{ t('memoryAudit.estimate.confirmCancel') }}
              </Button>
              <Button size="sm" class="h-7 text-xs" :disabled="!canStart" data-audit-start-confirm @click="confirmStart">
                {{ t('memoryAudit.estimate.confirmStart') }}
              </Button>
            </div>
          </div>
          <Button v-else size="sm" class="h-7 text-xs" :disabled="!canStart" data-audit-start @click="requestStart">
            {{ pendingAction === 'start' ? t('memoryAudit.starting') : (run ? t('memoryAudit.runAgain') : t('memoryAudit.start')) }}
          </Button>
        </section>

        <p v-if="run && !liveRun" class="text-xs text-(--d-muted)" data-audit-run-summary>
          {{ t('memoryAudit.runSummary', { status: t(`memoryAudit.runStatus.${run.status}`), graded: count(run.graded), total: count(run.total) }) }}
          <span v-if="run.failedBatches > 0" class="text-(--d-warning)">
            {{ t('memoryAudit.progress.failed', { n: run.failedBatches }, run.failedBatches) }}
          </span>
        </p>

        <p
          v-if="run && !liveRun && run.status !== 'running' && proposals.length === 0"
          class="text-xs text-(--d-muted)"
          data-audit-no-proposals
        >
          {{ t('memoryAudit.review.empty') }}
        </p>

        <section
          v-for="group in groups"
          :key="group.action"
          class="space-y-2"
          :data-audit-group="group.action"
        >
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-xs font-medium">{{ t(`memoryAudit.action.${group.action}`) }}</h3>
            <Badge variant="secondary" class="h-4 px-1.5 text-xs">{{ count(group.items.length) }}</Badge>
            <template v-if="!liveRun && group.pendingIds.length > 0">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                class="ml-auto justify-start"
                :model-value="groupDecision(group.pendingIds)"
                :aria-label="t('memoryAudit.decision.groupLabel', { group: t(`memoryAudit.action.${group.action}`) })"
                data-audit-group-decision
                :data-decision="groupDecision(group.pendingIds)"
                @update:model-value="(v: AcceptableValue) => setDecisions(group.pendingIds, v)"
              >
                <ToggleGroupItem
                  v-for="d in DECISIONS"
                  :key="d"
                  :value="d"
                  class="h-6 px-2 text-xs"
                  :data-audit-decision-option="d"
                >
                  {{ t(`memoryAudit.decision.${d}`) }}
                </ToggleGroupItem>
              </ToggleGroup>
              <span v-if="groupDecision(group.pendingIds) === 'mixed'" class="text-xs text-(--d-muted)" data-audit-group-mixed>
                {{ t('memoryAudit.decision.mixed') }}
              </span>
            </template>
          </div>

          <div
            v-for="p in group.items"
            :key="p.id"
            class="space-y-1 rounded-md border border-(--d-border) bg-(--d-card) p-2"
            :data-audit-proposal="p.id"
            :data-status="p.status"
          >
            <div class="flex items-center gap-1.5 flex-wrap">
              <Badge v-if="p.kind" variant="secondary" class="h-4 px-1.5 text-xs">{{ kindLabel(p.kind) }}</Badge>
              <span class="text-xs font-medium wrap-break-word">{{ rowLabel(p) }}</span>
              <Badge
                v-if="p.status !== 'pending'"
                variant="outline"
                class="ml-auto h-4 px-1.5 text-xs"
                :class="statusClass(p.status)"
                data-audit-status
              >
                {{ t(`memoryAudit.status.${p.status}`) }}
              </Badge>
            </div>
            <p v-if="p.title && p.contentPreview" class="text-xs text-(--d-muted) line-clamp-3 wrap-break-word">
              {{ p.contentPreview }}
            </p>
            <p
              class="text-xs text-(--d-info) italic wrap-break-word"
              data-audit-reason
            >
              {{ t('memoryAudit.review.reason', { reason: p.reason }) }}
            </p>
            <p v-if="p.action !== 'profile_rewrite'" class="text-xs text-(--d-muted)" data-audit-change>
              <span :title="p.currentWorkspace ?? undefined">{{ scopeLabel(p.currentScope, p.currentWorkspace) }}</span>
              <span aria-hidden="true"> → </span>
              <span class="sr-only">{{ t('memoryAudit.review.becomes') }}</span>
              <span class="text-(--d-text)" :title="p.targetWorkspace ?? undefined">{{ proposedLabel(p) }}</span>
            </p>
            <p v-if="p.status === 'stale'" class="text-xs text-(--d-warning)">{{ t('memoryAudit.review.staleHint') }}</p>
            <div
              v-if="p.action === 'profile_rewrite' && p.profileBefore && p.profileAfter"
              class="space-y-2"
              data-audit-profile-diff
            >
              <div
                v-for="section in PROFILE_SECTIONS"
                :key="section"
                class="space-y-1"
              >
                <p class="text-xs font-medium text-(--d-muted)">{{ t(`memoryAudit.profile.${section}`) }}</p>
                <div class="grid grid-cols-1 @md:grid-cols-2 gap-2">
                  <div class="rounded border border-(--d-border) p-1.5">
                    <p class="text-xs text-(--d-faint) mb-0.5">{{ t('memoryAudit.profile.before') }}</p>
                    <p class="text-xs whitespace-pre-wrap wrap-break-word" :data-profile-before="section">
                      {{ p.profileBefore[section] || t('memoryAudit.profile.empty') }}
                    </p>
                  </div>
                  <div class="rounded border border-[color-mix(in_srgb,var(--d-accent)_30%,transparent)] p-1.5">
                    <p class="text-xs text-(--d-faint) mb-0.5">{{ t('memoryAudit.profile.after') }}</p>
                    <p class="text-xs whitespace-pre-wrap wrap-break-word" :data-profile-after="section">
                      {{ p.profileAfter[section] || t('memoryAudit.profile.empty') }}
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <ToggleGroup
              v-if="p.status === 'pending' && !liveRun"
              type="single"
              variant="outline"
              size="sm"
              class="justify-start pt-1"
              :model-value="decisionOf(p.id)"
              :aria-label="t('memoryAudit.decision.label', { label: accessibleLabel(p) })"
              data-audit-decision
              :data-decision="decisionOf(p.id)"
              @update:model-value="(v: AcceptableValue) => setDecisions([p.id], v)"
            >
              <ToggleGroupItem
                v-for="d in DECISIONS"
                :key="d"
                :value="d"
                class="h-6 px-2 text-xs"
                :data-audit-decision-option="d"
              >
                {{ t(`memoryAudit.decision.${d}`) }}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </section>
      </template>
    </div>

    <template #footer>
      <div
        v-if="run && !liveRun && (pending.length > 0 || appliedCount > 0)"
        class="flex flex-wrap items-center gap-2 border-t border-(--d-border) px-4 py-3 shrink-0"
      >
        <template v-if="confirmingRevert">
          <span class="flex-1 text-xs" data-audit-revert-prompt>{{ t('memoryAudit.revert.confirm', { n: appliedCount }, appliedCount) }}</span>
          <Button variant="ghost" size="sm" class="h-7 text-xs" data-audit-revert-cancel @click="confirmingRevert = false">
            {{ t('memoryAudit.revert.cancel') }}
          </Button>
          <Button variant="destructive" size="sm" class="h-7 text-xs" data-audit-revert-confirm @click="confirmRevert">
            {{ t('memoryAudit.revert.confirmButton') }}
          </Button>
        </template>
        <template v-else>
          <span v-if="pending.length > 0" class="flex-1 text-xs text-(--d-muted)" data-audit-apply-summary>
            {{ t('memoryAudit.apply.summary', { accept: count(acceptIds.length), reject: count(rejectIds.length), undecided: count(undecidedCount) }) }}
          </span>
          <span v-else class="flex-1" />
          <Button
            v-if="appliedCount > 0"
            variant="outline"
            size="sm"
            class="h-7 text-xs"
            :disabled="pendingAction !== null || heldElsewhere"
            data-audit-revert
            @click="confirmingRevert = true"
          >
            {{ pendingAction === 'revert' ? t('memoryAudit.revert.reverting') : t('memoryAudit.revert.button') }}
          </Button>
          <Button
            v-if="pending.length > 0"
            size="sm"
            class="h-7 text-xs"
            :disabled="pendingAction !== null || heldElsewhere || acceptIds.length + rejectIds.length === 0"
            data-audit-apply
            @click="applyDecisions"
          >
            {{ pendingAction === 'apply' ? t('memoryAudit.apply.applying') : t('memoryAudit.apply.button') }}
          </Button>
        </template>
      </div>
    </template>
  </OverlayShell>
</template>
