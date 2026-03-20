<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import { IconLayers, IconChevronDown, IconX } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import OverlayShell from './OverlayShell.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import TaskNodeCard from './TaskNodeCard.vue';
import { useNodeStore } from '@/stores/useNodeStore';
import { useNodeFormatting } from '@/composables/useNodeFormatting';
import { formatDuration } from '@/utils/stringUtils';

const { t } = useI18n();
const store = useNodeStore();
const { formatAge, outcomeBadgeClass } = useNodeFormatting();

const recallAttempts = computed(() => store.selectedNodeRecallAttempts);

const graphRef = ref<HTMLElement>();
const canvasRef = ref<HTMLCanvasElement>();

const isEditingSeedPrompt = ref(false);
const seedPromptText = ref('');

watch(() => store.selectedNodeId, () => {
  isEditingSeedPrompt.value = false;
  seedPromptText.value = '';
});

function drawEdges() {
  const container = graphRef.value;
  const canvas = canvasRef.value;
  if (!container || !canvas) return;

  const cRect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cRect.width * dpr;
  canvas.height = cRect.height * dpr;
  canvas.style.width = `${cRect.width}px`;
  canvas.style.height = `${cRect.height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cRect.width, cRect.height);

  const style = getComputedStyle(document.documentElement);
  const primary = style.getPropertyValue('--primary').trim();
  ctx.strokeStyle = `hsl(${primary} / 0.3)`;
  ctx.lineWidth = 2;

  for (const activeNode of store.activeNodes) {
    const activeEl = container.querySelector<HTMLElement>(`[data-node-id="${activeNode.nodeId}"]`);
    if (!activeEl) continue;

    for (const closedId of activeNode.relatedClosedNodeIds) {
      const closedEl = container.querySelector<HTMLElement>(`[data-node-id="${closedId}"]`);
      if (!closedEl) continue;

      const aBox = activeEl.getBoundingClientRect();
      const cBox = closedEl.getBoundingClientRect();

      const sx = aBox.left - cRect.left;
      const sy = aBox.top + aBox.height / 2 - cRect.top;
      const ex = cBox.right - cRect.left;
      const ey = cBox.top + cBox.height / 2 - cRect.top;
      const offset = Math.max(Math.abs(sx - ex) * 0.4, 50);

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.bezierCurveTo(sx - offset, sy, ex + offset, ey, ex, ey);
      ctx.stroke();
    }
  }
}

const resizeObserver = new ResizeObserver(drawEdges);
watch(graphRef, (el, oldEl) => {
  if (oldEl) resizeObserver.unobserve(oldEl);
  if (el) resizeObserver.observe(el);
}, { immediate: true });
watch(() => store.nodes, () => requestAnimationFrame(drawEdges), { deep: true });
onBeforeUnmount(() => resizeObserver.disconnect());

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const isDetailView = computed(() => store.selectedNodeId !== null);
const node = computed(() => store.selectedNode);
const turns = computed(() => store.selectedNodeTurns);
const seedContext = computed(() => store.selectedNodeSeedContext);
const seedContextPrompt = computed(() => store.selectedNodeSeedContextPrompt);
const relatedNodes = computed(() => store.selectedNodeRelatedNodes);
const isDefaultNode = computed(() => node.value && node.value.nodeId === store.activeNodeId);

function toolCallSummary(tc: { name: string; input: Record<string, unknown> }): string {
  if (tc.input.file_path) return String(tc.input.file_path);
  if (tc.input.command) return String(tc.input.command).slice(0, 80);
  if (tc.input.pattern) return String(tc.input.pattern);
  if (tc.input.query) return String(tc.input.query).slice(0, 80);
  return '';
}

function handleClose(): void {
  if (isDetailView.value) {
    store.backToList();
  } else {
    emit('close');
  }
}

function openSeedPromptEditor(): void {
  seedPromptText.value = seedContextPrompt.value ?? '';
  isEditingSeedPrompt.value = true;
}

function cancelSeedPromptEditor(): void {
  isEditingSeedPrompt.value = false;
  seedPromptText.value = '';
}

function submitSeedRegeneration(): void {
  if (!node.value || !seedPromptText.value.trim()) return;
  store.regenerateSeedContext(node.value.nodeId, seedPromptText.value.trim());
  isEditingSeedPrompt.value = false;
}

const overlayTitle = computed(() => isDetailView.value && node.value ? node.value.title : t('nodeOverlay.title'));
const overlaySubtitle = computed(() => {
  if (isDetailView.value && node.value) {
    return t('nodeOverlay.subtitleNode', { turns: node.value.turnCount, age: formatAge(node.value.createdAt) });
  }
  return t('nodeOverlay.subtitleList', { active: store.activeNodes.length, closed: store.closedNodes.length });
});
</script>

<template>
  <OverlayShell
    :title="overlayTitle"
    :subtitle="overlaySubtitle"
    :icon="IconLayers"
    icon-class="text-primary"
    @close="handleClose"
  >
    <template #header-actions>
      <template v-if="isDetailView && node">
        <Badge
          v-if="isDefaultNode"
          variant="outline"
          class="text-xs border-primary/50 text-primary"
        >
          {{ t('nodeOverlay.default') }}
        </Badge>
        <Badge
          variant="outline"
          class="text-xs"
          :class="node.status === 'ACTIVE' ? 'border-emerald-500/50 text-emerald-400' : 'border-muted-foreground/30 text-muted-foreground'"
        >
          {{ node.status }}
        </Badge>
        <Badge
          v-if="node.summary"
          variant="outline"
          class="text-xs"
          :class="outcomeBadgeClass(node.summary.outcome)"
        >
          {{ node.summary.outcome }}
        </Badge>
      </template>
    </template>

    <!-- Detail View: scrollable with padding -->
    <div v-if="isDetailView && node" class="p-4 space-y-4">
      <div class="space-y-3 mb-4">
        <div v-if="node.keyEntities.length > 0" class="flex flex-wrap gap-1">
          <Badge
            v-for="tag in node.keyEntities"
            :key="tag"
            variant="secondary"
            class="text-xs px-1.5 py-0"
          >
            {{ tag }}
          </Badge>
        </div>

        <div v-if="node.summary" class="rounded-lg border border-border bg-muted/60 p-3 space-y-2">
          <p class="text-xs text-foreground/80">{{ node.summary.taskDescription }}</p>
          <div v-if="node.summary.filesChanged.length > 0" class="text-xs text-muted-foreground">
            <span class="font-medium">{{ t('nodeOverlay.files') }}</span> {{ node.summary.filesChanged.join(', ') }}
          </div>
          <div v-if="node.summary.keyDecisions.length > 0" class="space-y-0.5">
            <span class="text-xs font-medium text-muted-foreground">{{ t('nodeOverlay.keyDecisions') }}</span>
            <ul class="list-disc list-inside text-xs text-foreground/70 space-y-0.5 pl-1">
              <li v-for="(decision, i) in node.summary.keyDecisions" :key="i">{{ decision }}</li>
            </ul>
          </div>
        </div>

        <Collapsible v-if="node.filesTouched.length > 0">
          <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
            <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
            <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {{ t('nodeOverlay.filesTouchedCount', { count: node.filesTouched.length }) }}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="mt-1 flex flex-wrap gap-1">
              <span
                v-for="file in node.filesTouched"
                :key="file"
                class="text-xs font-mono text-primary/80 bg-primary/5 px-1.5 py-0.5 rounded break-all"
              >
                {{ file }}
              </span>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      <div v-if="store.isLoadingTurns" class="flex items-center justify-center py-12">
        <LoadingSpinner :size="24" />
      </div>

      <template v-else>
        <Collapsible v-if="seedContext">
          <div class="rounded-lg border border-amber-500/20 bg-amber-500/5">
            <CollapsibleTrigger class="group flex items-center gap-2 w-full px-3 py-2 cursor-pointer">
              <IconChevronDown :size="12" class="shrink-0 text-amber-400 transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
              <span class="text-xs font-medium text-amber-400 uppercase tracking-wider">{{ t('nodeOverlay.seedContext') }}</span>
              <span class="text-xs text-muted-foreground/50">{{ seedContext.length.toLocaleString() }} chars</span>
              <div class="flex-1" />
              <Button
                v-if="!store.isRegeneratingSeedContext"
                variant="ghost"
                size="sm"
                class="h-5 px-1.5 text-xs text-amber-400/60 hover:text-amber-400"
                @click.stop="openSeedPromptEditor"
              >
                {{ t('nodeOverlay.regenerateSeed') }}
              </Button>
              <div v-else class="flex items-center gap-1.5">
                <LoadingSpinner :size="12" />
                <span class="text-xs text-amber-400/60">{{ t('nodeOverlay.regenerating') }}</span>
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <!-- Seed prompt editor -->
              <div v-if="isEditingSeedPrompt" class="px-3 pt-2 pb-2 space-y-2">
                <Textarea
                  v-model="seedPromptText"
                  :placeholder="t('nodeOverlay.seedPromptPlaceholder')"
                  class="text-xs min-h-[4.5rem] resize-none"
                  rows="3"
                />
                <div class="flex items-center gap-2">
                  <Button
                    size="sm"
                    class="h-6 px-2.5 text-xs"
                    :disabled="!seedPromptText.trim()"
                    @click="submitSeedRegeneration"
                  >
                    {{ t('common.submit') }}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-6 px-2.5 text-xs"
                    @click="cancelSeedPromptEditor"
                  >
                    {{ t('common.cancel') }}
                  </Button>
                </div>
              </div>
              <!-- Custom prompt display -->
              <div v-else-if="seedContextPrompt" class="px-3 pb-1">
                <span class="text-xs text-muted-foreground/60">{{ t('nodeOverlay.seedPromptLabel') }}: {{ seedContextPrompt }}</span>
              </div>
              <div class="px-3 pb-3 text-xs text-foreground/80">
                <MarkdownRenderer :content="seedContext" />
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        <Collapsible v-if="relatedNodes.length > 0">
          <div class="rounded-lg border border-primary/20 bg-primary/5">
            <CollapsibleTrigger class="group flex items-center gap-2 w-full px-3 py-2 cursor-pointer">
              <IconChevronDown :size="12" class="shrink-0 text-primary transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
              <span class="text-xs font-medium text-primary uppercase tracking-wider">{{ t('nodeOverlay.relatedTasks') }}</span>
              <Badge variant="secondary" class="text-xs px-1.5 py-0">{{ relatedNodes.length }}</Badge>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div class="px-3 pb-3 space-y-1.5">
                <div
                  v-for="r in relatedNodes"
                  :key="r.nodeId"
                  class="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-muted/40 px-3 py-2 cursor-pointer transition-colors hover:bg-muted/80"
                  @click="store.viewNodeDetail(r.nodeId)"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="text-xs text-foreground/80 truncate">{{ r.title }}</span>
                    <Badge
                      variant="outline"
                      class="text-xs px-1 py-0 shrink-0"
                      :class="outcomeBadgeClass(r.outcome)"
                    >
                      {{ r.outcome }}
                    </Badge>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <span v-if="r.taskDescription" class="text-xs text-muted-foreground/60 max-w-[12.5rem] truncate">{{ r.taskDescription }}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="h-4 w-4 p-0 text-muted-foreground hover:text-destructive"
                      :title="t('nodeOverlay.disconnectRelation')"
                      @click.stop="node && store.disconnectNodeRelation(node.nodeId, r.nodeId)"
                    >
                      <IconX :size="10" />
                    </Button>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        <!-- Recall Attempts -->
        <Collapsible v-if="recallAttempts.length > 0">
          <div class="rounded-lg border border-cyan-500/20 bg-cyan-500/5">
            <CollapsibleTrigger class="group flex items-center gap-2 w-full px-3 py-2 cursor-pointer">
              <IconChevronDown :size="12" class="shrink-0 text-cyan-400 transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
              <span class="text-xs font-medium text-cyan-400 uppercase tracking-wider">{{ t('nodeOverlay.recallAttempts') }}</span>
              <Badge variant="secondary" class="text-xs px-1.5 py-0">{{ recallAttempts.length }}</Badge>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div class="px-3 pb-3 space-y-1.5">
                <div
                  v-for="attempt in recallAttempts"
                  :key="attempt.promptIndex"
                  class="rounded-lg border border-border/50 bg-muted/40 p-3 space-y-2"
                >
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-2 min-w-0">
                      <Badge variant="outline" class="text-xs px-1 py-0 shrink-0 border-cyan-500/30 text-cyan-400">
                        {{ t('nodeOverlay.recallAttemptPrompt', { n: attempt.promptIndex }) }}
                      </Badge>
                      <span class="text-xs text-foreground/70 truncate">{{ attempt.userPrompt }}</span>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <Badge
                        variant="outline"
                        class="text-xs px-1 py-0"
                        :class="attempt.orientation ? 'border-cyan-500/50 text-cyan-400' : 'border-emerald-500/50 text-emerald-400'"
                      >
                        {{ attempt.orientation ? t('nodeOverlay.recallAttemptOriented') : t('nodeOverlay.recallAttemptDirect') }}
                      </Badge>
                      <Badge v-if="!attempt.shortCircuited" variant="secondary" class="text-xs px-1 py-0">
                        {{ t('nodeOverlay.recallAttemptIterations', { count: attempt.iterationCount }) }}
                      </Badge>
                      <span class="text-xs text-muted-foreground tabular-nums">{{ formatDuration(attempt.totalDurationMs) }}</span>
                    </div>
                  </div>

                  <template v-if="attempt.orientation">
                    <div v-if="attempt.orientation.expandedTerms.length > 0" class="flex flex-wrap gap-1">
                      <Badge
                        v-for="term in attempt.orientation.expandedTerms"
                        :key="term"
                        variant="secondary"
                        class="text-xs px-1.5 py-0"
                      >
                        {{ term }}
                      </Badge>
                    </div>

                    <Collapsible v-if="attempt.orientation.bm25Results.length > 0" :default-open="false">
                      <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
                        <IconChevronDown :size="10" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                        <span class="text-xs text-muted-foreground">{{ t('nodeOverlay.bm25Matches', { count: attempt.orientation.bm25Results.length }) }}</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div class="space-y-0.5 mt-1">
                          <div
                            v-for="result in attempt.orientation.bm25Results.slice(0, 5)"
                            :key="result.turnIndex"
                            class="flex items-center gap-2 text-xs"
                          >
                            <span class="tabular-nums text-cyan-400 shrink-0">{{ result.score.toFixed(1) }}</span>
                            <span class="text-foreground/60 truncate">{{ result.preview }}</span>
                          </div>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>

                    <Collapsible v-if="attempt.orientation.investigationReport" :default-open="false">
                      <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
                        <IconChevronDown :size="10" class="shrink-0 text-amber-400 transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                        <span class="text-xs text-amber-400">{{ t('contextInjection.orientationInvestigation') }}</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div class="mt-1 text-xs text-foreground/70">
                          <MarkdownRenderer :content="attempt.orientation.investigationReport" />
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </template>
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        <div v-if="turns.length > 0" class="space-y-3">
          <div class="flex items-center gap-2 mb-2">
            <div class="h-px flex-1 bg-border" />
            <span class="text-xs font-medium text-muted-foreground uppercase tracking-widest">{{ t('nodeOverlay.conversation') }}</span>
            <Badge variant="secondary" class="text-xs px-1.5 py-0">{{ t('nodeOverlay.turnsBadge', { count: turns.length }) }}</Badge>
            <div class="h-px flex-1 bg-border" />
          </div>

          <div v-for="(turn, idx) in turns" :key="turn.promptIndex" class="space-y-1.5">
            <div class="border-l-2 border-blue-500 pl-3 py-2 bg-blue-500/5 rounded-r-lg">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-xs font-medium text-blue-400">{{ t('nodeOverlay.turnN', { n: idx + 1 }) }}</span>
                <span class="text-xs text-muted-foreground">{{ t('nodeOverlay.you') }}</span>
                <span class="text-xs text-muted-foreground/50">{{ formatAge(turn.timestamp) }}</span>
              </div>
              <div class="text-xs text-foreground/90">
                <MarkdownRenderer :content="turn.userMessage" />
              </div>
            </div>

            <template v-for="(block, bi) in turn.contentBlocks" :key="bi">
              <div v-if="block.type === 'text'" class="border-l-2 border-violet-500 pl-3 py-2 bg-violet-500/5 rounded-r-lg">
                <div v-if="bi === 0" class="flex items-center gap-2 mb-1">
                  <span class="text-xs font-medium text-violet-400">{{ t('nodeOverlay.turnN', { n: idx + 1 }) }}</span>
                  <span class="text-xs text-muted-foreground">{{ t('nodeOverlay.claude') }}</span>
                </div>
                <div class="text-xs text-foreground/80">
                  <MarkdownRenderer :content="block.content" />
                </div>
              </div>
              <Collapsible v-else-if="block.type === 'tool_call'">
                <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer border-l-2 border-amber-500/60 pl-3 py-1.5 bg-amber-500/5 rounded-r-lg">
                  <IconChevronDown :size="10" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                  <span class="text-xs font-mono text-amber-400">{{ block.name }}</span>
                  <span class="text-xs font-mono text-foreground/50 truncate">{{ toolCallSummary(block) }}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div v-if="block.result" class="border-l-2 border-amber-500/30 pl-3 py-1.5">
                    <pre class="text-xs font-mono text-foreground/70 whitespace-pre-wrap break-all overflow-hidden">{{ block.result }}</pre>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </template>

            <template v-if="turn.contentBlocks.length === 0">
              <div class="border-l-2 border-violet-500 pl-3 py-2 bg-violet-500/5 rounded-r-lg">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-xs font-medium text-violet-400">{{ t('nodeOverlay.turnN', { n: idx + 1 }) }}</span>
                  <span class="text-xs text-muted-foreground">{{ t('nodeOverlay.claude') }}</span>
                </div>
                <div class="text-xs text-foreground/80">
                  <MarkdownRenderer :content="turn.assistantResponse" />
                </div>
              </div>
              <Collapsible v-for="(tc, i) in turn.toolCalls" :key="'tc-' + i">
                <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer border-l-2 border-amber-500/60 pl-3 py-1.5 bg-amber-500/5 rounded-r-lg">
                  <IconChevronDown :size="10" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                  <span class="text-xs font-mono text-amber-400">{{ tc.name }}</span>
                  <span class="text-xs font-mono text-foreground/50 truncate">{{ toolCallSummary(tc) }}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div v-if="tc.result" class="border-l-2 border-amber-500/30 pl-3 py-1.5">
                    <pre class="text-xs font-mono text-foreground/70 whitespace-pre-wrap break-all overflow-hidden">{{ tc.result }}</pre>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </template>

            <Collapsible v-if="turn.filesTouched.length > 0">
              <CollapsibleTrigger class="group flex items-center gap-1.5 cursor-pointer">
                <IconChevronDown :size="10" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                <span class="text-xs font-medium text-primary/60">{{ t('nodePicker.filesTouched') }}</span>
                <span class="text-xs font-mono text-muted-foreground">({{ turn.filesTouched.length }})</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div class="flex flex-col gap-0.5 pl-4 pt-1">
                  <span
                    v-for="file in turn.filesTouched"
                    :key="file"
                    class="text-xs font-mono text-primary/60 bg-primary/5 px-1 py-0.5 rounded break-all"
                  >
                    {{ file }}
                  </span>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>

        <div v-else-if="!seedContext && relatedNodes.length === 0" class="flex flex-col items-center justify-center text-center gap-3 py-12">
          <IconLayers :size="32" class="text-muted-foreground/40" />
          <p class="text-sm text-muted-foreground">{{ t('nodeOverlay.noTurns') }}</p>
        </div>
      </template>
    </div>

    <!-- Empty state -->
    <div v-else-if="store.nodes.length === 0" class="h-full flex flex-col items-center justify-center text-center gap-3 p-4">
      <IconLayers :size="32" class="text-muted-foreground/40" />
      <div>
        <p class="text-sm text-muted-foreground">{{ t('nodeOverlay.noNodes') }}</p>
        <p class="text-xs text-muted-foreground/60 mt-1">{{ t('nodeOverlay.noNodesHint') }}</p>
      </div>
    </div>

    <!-- Node graph: closed left, active right, SVG edges -->
    <div v-else ref="graphRef" class="relative py-6">
      <div class="flex justify-around items-start relative z-10">
        <div v-if="store.closedNodes.length > 0" class="flex flex-col items-center gap-4">
          <span class="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-1">{{ t('nodeOverlay.closed') }}</span>
          <TaskNodeCard
            v-for="n in store.closedNodes"
            :key="n.nodeId"

            :node="n"
            :is-closing="store.closingNodeIds.has(n.nodeId)"
          />
        </div>

        <div v-if="store.activeNodes.length > 0" class="flex flex-col items-center gap-4">
          <span class="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-1">{{ t('nodeOverlay.active') }}</span>
          <TaskNodeCard
            v-for="n in store.activeNodes"
            :key="n.nodeId"

            :node="n"
            :is-closing="store.closingNodeIds.has(n.nodeId)"
            :is-default="n.nodeId === store.activeNodeId"
          />
        </div>
      </div>

      <canvas ref="canvasRef" class="absolute inset-0 pointer-events-none" style="z-index: 1;" />
    </div>
  </OverlayShell>
</template>
