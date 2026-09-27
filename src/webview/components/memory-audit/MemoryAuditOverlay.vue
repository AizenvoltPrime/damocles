<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import type { AcceptableValue } from 'reka-ui';
import { ListChecks, TriangleAlert, Info, RefreshCw } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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
    :title="t('memoryAudit.title')"
    :subtitle="t('memoryAudit.subtitle')"
    :icon="ListChecks"
    icon-class="text-primary"
    @close="emit('close')"
  >
    <div class="@container p-4 space-y-4">
      <div
        v-if="error"
        role="alert"
        class="flex items-start gap-2 rounded-md border border-destructive/50 p-3 text-xs text-destructive"
        data-audit-error
      >
        <TriangleAlert :size="14" class="shrink-0 mt-0.5" />
        <span class="break-words">{{ t(`memoryAudit.error.${error}`) }}</span>
      </div>

      <p v-if="resultText" role="status" class="text-xs text-muted-foreground" data-audit-result>{{ resultText }}</p>
      <p v-if="cancelResult === 'held-elsewhere'" role="status" class="text-xs text-warning" data-audit-cancel-held>
        {{ t('memoryAudit.cancelHeldElsewhere') }}
      </p>

      <div
        v-if="heldElsewhere"
        class="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs"
        data-audit-held
      >
        <Info :size="14" class="shrink-0 text-warning" />
        <span class="flex-1">{{ t('memoryAudit.heldElsewhere') }}</span>
        <Button variant="outline" size="sm" class="h-6 text-xs shrink-0" data-audit-refresh @click="store.requestState()">
          <RefreshCw :size="12" class="mr-1" />{{ t('memoryAudit.refresh') }}
        </Button>
      </div>

      <div
        v-if="state === null && !error"
        class="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground"
        data-audit-loading
      >
        <LoadingSpinner :size="16" />{{ t('memoryAudit.loading') }}
      </div>

      <template v-else-if="state">
        <section
          v-if="liveRun"
          class="space-y-2 rounded-md border border-border/50 bg-card p-3"
          data-audit-progress
        >
          <h3 class="text-xs font-medium">{{ t('memoryAudit.progress.title') }}</h3>
          <Progress :model-value="progressPercent" class="h-2" />
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <span data-audit-progress-count>{{ t('memoryAudit.progress.count', { graded: count(liveRun.graded), total: count(liveRun.total) }) }}</span>
            <span v-if="liveRun.failedBatches > 0" class="text-warning" data-audit-progress-failed>
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
          class="space-y-3 rounded-md border border-border/50 bg-card p-3"
          data-audit-estimate
        >
          <h3 class="text-xs font-medium">{{ t('memoryAudit.estimate.title') }}</h3>
          <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt class="text-muted-foreground">{{ t('memoryAudit.estimate.memories') }}</dt>
            <dd data-estimate="memories">{{ count(estimate.memoryCount) }}</dd>
            <dt class="text-muted-foreground">{{ t('memoryAudit.estimate.profiles') }}</dt>
            <dd data-estimate="profiles">{{ count(estimate.profileCount) }}</dd>
            <dt class="text-muted-foreground">{{ t('memoryAudit.estimate.inputTokens') }}</dt>
            <dd data-estimate="input-tokens">{{ tokens(estimate.inputTokens) }}</dd>
            <dt class="text-muted-foreground">{{ t('memoryAudit.estimate.outputTokens') }}</dt>
            <dd data-estimate="output-tokens">{{ tokens(estimate.outputTokens) }}</dd>
            <dt class="text-muted-foreground">{{ t('memoryAudit.estimate.model') }}</dt>
            <dd class="truncate" data-estimate="model">
              {{ estimate.model ? `${estimate.model.provider}/${estimate.model.id}` : t('memoryAudit.estimate.noModelShort') }}
            </dd>
            <template v-if="estimate.model && (estimate.unpriced || estimate.costUsd !== null)">
              <dt class="text-muted-foreground" data-estimate="cost-label">
                {{ estimate.model.dollarBilled ? t('memoryAudit.estimate.cost') : t('memoryAudit.estimate.costApiEquivalent') }}
              </dt>
              <dd v-if="estimate.unpriced" data-estimate="cost" :title="t('common.unpricedTooltip')">{{ t('common.unpriced') }}</dd>
              <dd v-else-if="estimate.costUsd !== null" data-estimate="cost" :title="costTitle(estimate.model.dollarBilled)">
                {{ costLabel(estimate.costUsd, estimate.model.dollarBilled) }}
              </dd>
            </template>
          </dl>
          <p v-if="estimate.model === null" class="text-xs text-warning" data-audit-no-model>
            {{ t('memoryAudit.estimate.noModel') }}
          </p>
          <p v-else-if="estimate.memoryCount + estimate.profileCount === 0" class="text-xs text-muted-foreground">
            {{ t('memoryAudit.estimate.nothing') }}
          </p>
          <p class="text-xs text-muted-foreground">{{ t('memoryAudit.estimate.note') }}</p>
          <div
            v-if="confirmingStart"
            role="alert"
            class="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs"
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

        <p v-if="run && !liveRun" class="text-xs text-muted-foreground" data-audit-run-summary>
          {{ t('memoryAudit.runSummary', { status: t(`memoryAudit.runStatus.${run.status}`), graded: count(run.graded), total: count(run.total) }) }}
          <span v-if="run.failedBatches > 0" class="text-warning">
            {{ t('memoryAudit.progress.failed', { n: run.failedBatches }, run.failedBatches) }}
          </span>
        </p>

        <p
          v-if="run && !liveRun && run.status !== 'running' && proposals.length === 0"
          class="text-xs text-muted-foreground"
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
              <span v-if="groupDecision(group.pendingIds) === 'mixed'" class="text-xs text-muted-foreground" data-audit-group-mixed>
                {{ t('memoryAudit.decision.mixed') }}
              </span>
            </template>
          </div>

          <div
            v-for="p in group.items"
            :key="p.id"
            class="space-y-1 rounded-md border border-border/50 bg-card p-2"
            :data-audit-proposal="p.id"
            :data-status="p.status"
          >
            <div class="flex items-center gap-1.5 flex-wrap">
              <Badge v-if="p.kind" variant="secondary" class="h-4 px-1.5 text-xs">{{ kindLabel(p.kind) }}</Badge>
              <span class="text-xs font-medium break-words">{{ rowLabel(p) }}</span>
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
            <p v-if="p.title && p.contentPreview" class="text-xs text-muted-foreground line-clamp-3 break-words">
              {{ p.contentPreview }}
            </p>
            <p class="text-xs text-violet-400/80 italic break-words" data-audit-reason>
              {{ t('memoryAudit.review.reason', { reason: p.reason }) }}
            </p>
            <p v-if="p.action !== 'profile_rewrite'" class="text-xs text-muted-foreground" data-audit-change>
              <span :title="p.currentWorkspace ?? undefined">{{ scopeLabel(p.currentScope, p.currentWorkspace) }}</span>
              <span aria-hidden="true"> → </span>
              <span class="sr-only">{{ t('memoryAudit.review.becomes') }}</span>
              <span class="text-foreground" :title="p.targetWorkspace ?? undefined">{{ proposedLabel(p) }}</span>
            </p>
            <p v-if="p.status === 'stale'" class="text-xs text-warning">{{ t('memoryAudit.review.staleHint') }}</p>
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
                <p class="text-xs font-medium text-muted-foreground">{{ t(`memoryAudit.profile.${section}`) }}</p>
                <div class="grid grid-cols-1 @md:grid-cols-2 gap-2">
                  <div class="rounded border border-border/40 p-1.5">
                    <p class="text-xs text-muted-foreground/70 mb-0.5">{{ t('memoryAudit.profile.before') }}</p>
                    <p class="text-xs whitespace-pre-wrap break-words" :data-profile-before="section">
                      {{ p.profileBefore[section] || t('memoryAudit.profile.empty') }}
                    </p>
                  </div>
                  <div class="rounded border border-primary/30 p-1.5">
                    <p class="text-xs text-muted-foreground/70 mb-0.5">{{ t('memoryAudit.profile.after') }}</p>
                    <p class="text-xs whitespace-pre-wrap break-words" :data-profile-after="section">
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
        class="flex flex-wrap items-center gap-2 border-t border-border/30 px-4 py-3 shrink-0"
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
          <span v-if="pending.length > 0" class="flex-1 text-xs text-muted-foreground" data-audit-apply-summary>
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
