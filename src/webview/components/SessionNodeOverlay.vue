<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { IconLayers, IconChevronDown, IconX } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import OverlayShell from './OverlayShell.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { useNodeStore } from '@/stores/useNodeStore';

const { t } = useI18n();
const store = useNodeStore();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const isDetailView = computed(() => store.selectedNodeId !== null);
const node = computed(() => store.selectedNode);
const turns = computed(() => store.selectedNodeTurns);
const seedContext = computed(() => store.selectedNodeSeedContext);
const relatedNodes = computed(() => store.selectedNodeRelatedNodes);

function getRelatedNodes(relatedIds: string[] | undefined) {
  if (!relatedIds?.length) return [];
  return relatedIds
    .map(id => store.nodes.find(n => n.nodeId === id))
    .filter((n): n is NonNullable<typeof n> => !!n);
}

function outcomeBadgeClass(outcome: string): string {
  switch (outcome) {
    case 'resolved': return 'border-emerald-500/50 text-emerald-400';
    case 'partial': return 'border-amber-500/50 text-amber-400';
    case 'abandoned': return 'border-red-500/50 text-red-400';
    default: return 'border-muted-foreground/30 text-muted-foreground';
  }
}

function formatAge(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (diffMs < 60_000) return t('time.justNow');
  if (diffMs < 3_600_000) return t('time.minutesAgo', { n: Math.floor(diffMs / 60_000) });
  if (diffMs < 86_400_000) return t('time.hoursAgo', { n: Math.floor(diffMs / 3_600_000) });
  return t('time.daysAgo', { n: Math.floor(diffMs / 86_400_000) });
}

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
          variant="outline"
          class="text-[10px]"
          :class="node.status === 'ACTIVE' ? 'border-emerald-500/50 text-emerald-400' : 'border-muted-foreground/30 text-muted-foreground'"
        >
          {{ node.status }}
        </Badge>
        <Badge
          v-if="node.summary"
          variant="outline"
          class="text-[10px]"
          :class="outcomeBadgeClass(node.summary.outcome)"
        >
          {{ node.summary.outcome }}
        </Badge>
      </template>
    </template>

    <div class="p-4 space-y-4">
      <!-- Detail View: Full conversation for selected node -->
      <template v-if="isDetailView && node">
        <!-- Node metadata header -->
        <div class="space-y-3 mb-4">
          <!-- Key entities -->
          <div v-if="node.keyEntities.length > 0" class="flex flex-wrap gap-1">
            <Badge
              v-for="tag in node.keyEntities"
              :key="tag"
              variant="secondary"
              class="text-[9px] px-1.5 py-0"
            >
              {{ tag }}
            </Badge>
          </div>

          <!-- Summary card (closed nodes) -->
          <div v-if="node.summary" class="rounded-lg border border-border bg-muted/60 p-3 space-y-2">
            <p class="text-[11px] text-foreground/80">{{ node.summary.taskDescription }}</p>
            <div v-if="node.summary.filesChanged.length > 0" class="text-[10px] text-muted-foreground">
              <span class="font-medium">{{ t('nodeOverlay.files') }}</span> {{ node.summary.filesChanged.join(', ') }}
            </div>
            <div v-if="node.summary.keyDecisions.length > 0" class="space-y-0.5">
              <span class="text-[10px] font-medium text-muted-foreground">{{ t('nodeOverlay.keyDecisions') }}</span>
              <ul class="list-disc list-inside text-[10px] text-foreground/70 space-y-0.5 pl-1">
                <li v-for="(decision, i) in node.summary.keyDecisions" :key="i">{{ decision }}</li>
              </ul>
            </div>
          </div>

          <!-- Files touched -->
          <Collapsible v-if="node.filesTouched.length > 0">
            <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
              <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
              <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                {{ t('nodeOverlay.filesTouchedCount', { count: node.filesTouched.length }) }}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div class="mt-1 flex flex-wrap gap-1">
                <span
                  v-for="file in node.filesTouched"
                  :key="file"
                  class="text-[10px] font-mono text-primary/80 bg-primary/5 px-1.5 py-0.5 rounded"
                >
                  {{ file }}
                </span>
              </div>
            </CollapsibleContent>
          </Collapsible>

        </div>

        <!-- Loading turns -->
        <div v-if="store.isLoadingTurns" class="flex items-center justify-center py-12">
          <LoadingSpinner :size="24" />
        </div>

        <template v-else>
          <!-- Seed context -->
          <Collapsible v-if="seedContext">
            <div class="rounded-lg border border-amber-500/20 bg-amber-500/5">
              <CollapsibleTrigger class="group flex items-center gap-2 w-full px-3 py-2 cursor-pointer">
                <IconChevronDown :size="12" class="shrink-0 text-amber-400 transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                <span class="text-[10px] font-medium text-amber-400 uppercase tracking-wider">{{ t('nodeOverlay.seedContext') }}</span>
                <span class="text-[9px] text-muted-foreground/50">{{ seedContext.length.toLocaleString() }} chars</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div class="px-3 pb-3 text-[12px] text-foreground/80">
                  <MarkdownRenderer :content="seedContext" />
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>

          <!-- Related tasks (detail view) -->
          <Collapsible v-if="relatedNodes.length > 0">
            <div class="rounded-lg border border-primary/20 bg-primary/5">
              <CollapsibleTrigger class="group flex items-center gap-2 w-full px-3 py-2 cursor-pointer">
                <IconChevronDown :size="12" class="shrink-0 text-primary transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                <span class="text-[10px] font-medium text-primary uppercase tracking-wider">{{ t('nodeOverlay.relatedTasks') }}</span>
                <Badge variant="secondary" class="text-[9px] px-1.5 py-0">{{ relatedNodes.length }}</Badge>
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
                      <span class="text-[10px] text-foreground/80 truncate">{{ r.title }}</span>
                      <Badge
                        variant="outline"
                        class="text-[8px] px-1 py-0 shrink-0"
                        :class="outcomeBadgeClass(r.outcome)"
                      >
                        {{ r.outcome }}
                      </Badge>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <span v-if="r.taskDescription" class="text-[9px] text-muted-foreground/60 max-w-[200px] truncate">{{ r.taskDescription }}</span>
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

          <!-- Conversation turns -->
          <div v-if="turns.length > 0" class="space-y-3">
          <div class="flex items-center gap-2 mb-2">
            <div class="h-px flex-1 bg-border" />
            <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">{{ t('nodeOverlay.conversation') }}</span>
            <Badge variant="secondary" class="text-[9px] px-1.5 py-0">{{ t('nodeOverlay.turnsBadge', { count: turns.length }) }}</Badge>
            <div class="h-px flex-1 bg-border" />
          </div>

          <div v-for="(turn, idx) in turns" :key="turn.promptIndex" class="space-y-1.5">
            <!-- User message -->
            <div class="border-l-2 border-blue-500 pl-3 py-2 bg-blue-500/5 rounded-r-lg">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-[10px] font-medium text-blue-400">{{ t('nodeOverlay.turnN', { n: idx + 1 }) }}</span>
                <span class="text-[10px] text-muted-foreground">{{ t('nodeOverlay.you') }}</span>
                <span class="text-[9px] text-muted-foreground/50">{{ formatAge(turn.timestamp) }}</span>
              </div>
              <div class="text-[12px] text-foreground/90">
                <MarkdownRenderer :content="turn.userMessage" />
              </div>
            </div>

            <!-- Interleaved content blocks (text + tool calls in conversation order) -->
            <template v-for="(block, bi) in turn.contentBlocks" :key="bi">
              <div v-if="block.type === 'text'" class="border-l-2 border-violet-500 pl-3 py-2 bg-violet-500/5 rounded-r-lg">
                <div v-if="bi === 0" class="flex items-center gap-2 mb-1">
                  <span class="text-[10px] font-medium text-violet-400">{{ t('nodeOverlay.turnN', { n: idx + 1 }) }}</span>
                  <span class="text-[10px] text-muted-foreground">{{ t('nodeOverlay.claude') }}</span>
                </div>
                <div class="text-[12px] text-foreground/80">
                  <MarkdownRenderer :content="block.content" />
                </div>
              </div>
              <Collapsible v-else-if="block.type === 'tool_call'">
                <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer border-l-2 border-amber-500/60 pl-3 py-1.5 bg-amber-500/5 rounded-r-lg">
                  <IconChevronDown :size="10" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                  <span class="text-[10px] font-mono text-amber-400">{{ block.name }}</span>
                  <span class="text-[10px] font-mono text-foreground/50 truncate">{{ toolCallSummary(block) }}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div v-if="block.result" class="border-l-2 border-amber-500/30 pl-3 py-1.5">
                    <pre class="text-[10px] font-mono text-foreground/70 whitespace-pre-wrap break-all overflow-hidden">{{ block.result }}</pre>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </template>

            <!-- Fallback: if no contentBlocks, show flat response + tool calls -->
            <template v-if="turn.contentBlocks.length === 0">
              <div class="border-l-2 border-violet-500 pl-3 py-2 bg-violet-500/5 rounded-r-lg">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-[10px] font-medium text-violet-400">{{ t('nodeOverlay.turnN', { n: idx + 1 }) }}</span>
                  <span class="text-[10px] text-muted-foreground">{{ t('nodeOverlay.claude') }}</span>
                </div>
                <div class="text-[12px] text-foreground/80">
                  <MarkdownRenderer :content="turn.assistantResponse" />
                </div>
              </div>
              <Collapsible v-for="(tc, i) in turn.toolCalls" :key="'tc-' + i">
                <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer border-l-2 border-amber-500/60 pl-3 py-1.5 bg-amber-500/5 rounded-r-lg">
                  <IconChevronDown :size="10" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                  <span class="text-[10px] font-mono text-amber-400">{{ tc.name }}</span>
                  <span class="text-[10px] font-mono text-foreground/50 truncate">{{ toolCallSummary(tc) }}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div v-if="tc.result" class="border-l-2 border-amber-500/30 pl-3 py-1.5">
                    <pre class="text-[10px] font-mono text-foreground/70 whitespace-pre-wrap break-all overflow-hidden">{{ tc.result }}</pre>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </template>

            <!-- Files touched -->
            <Collapsible v-if="turn.filesTouched.length > 0">
              <CollapsibleTrigger class="group flex items-center gap-1.5 cursor-pointer">
                <IconChevronDown :size="10" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                <span class="text-[9px] font-medium text-primary/60">{{ t('nodePicker.filesTouched') }}</span>
                <span class="text-[9px] font-mono text-muted-foreground">({{ turn.filesTouched.length }})</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div class="flex flex-col gap-0.5 pl-4 pt-1">
                  <span
                    v-for="file in turn.filesTouched"
                    :key="file"
                    class="text-[9px] font-mono text-primary/60 bg-primary/5 px-1 py-0.5 rounded w-fit"
                  >
                    {{ file }}
                  </span>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>

          <!-- Empty turns -->
          <div v-else-if="!seedContext && relatedNodes.length === 0" class="flex flex-col items-center justify-center text-center gap-3 py-12">
            <IconLayers :size="32" class="text-muted-foreground/40" />
            <p class="text-sm text-muted-foreground">{{ t('nodeOverlay.noTurns') }}</p>
          </div>
        </template>
      </template>

      <!-- List View: All nodes -->
      <template v-else>
        <div v-if="store.nodes.length === 0" class="flex flex-col items-center justify-center text-center gap-3 py-12">
          <IconLayers :size="32" class="text-muted-foreground/40" />
          <div>
            <p class="text-sm text-muted-foreground">{{ t('nodeOverlay.noNodes') }}</p>
            <p class="text-xs text-muted-foreground/60 mt-1">{{ t('nodeOverlay.noNodesHint') }}</p>
          </div>
        </div>

        <!-- Active Tasks -->
        <div v-if="store.activeNodes.length > 0" class="space-y-2">
          <div class="flex items-center gap-2">
            <div class="h-px flex-1 bg-border" />
            <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">{{ t('nodeOverlay.activeTasks') }}</span>
            <Badge variant="secondary" class="text-[9px] px-1.5 py-0">{{ store.activeNodes.length }}</Badge>
            <div class="h-px flex-1 bg-border" />
          </div>

          <div
            v-for="n in store.activeNodes"
            :key="n.nodeId"
            class="rounded-xl border p-3 space-y-2 cursor-pointer transition-colors hover:bg-muted/60"
            :class="n.nodeId === store.activeNodeId ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/80'"
            @click="store.viewNodeDetail(n.nodeId)"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <div
                  v-if="n.nodeId === store.activeNodeId"
                  class="w-2 h-2 rounded-full bg-primary shrink-0"
                  :title="t('nodeOverlay.currentTask')"
                />
                <span class="text-[11px] font-medium text-foreground truncate">{{ n.title }}</span>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <span class="text-[10px] text-muted-foreground tabular-nums">{{ t('nodeOverlay.turnsBadge', { count: n.turnCount }) }}</span>
                <span class="text-[10px] text-muted-foreground">{{ formatAge(n.lastActivity ?? n.createdAt) }}</span>
              </div>
            </div>

            <!-- First prompt -->
            <Collapsible v-if="n.firstPrompt">
              <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer" @click.stop>
                <IconChevronDown :size="10" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                <span class="text-[9px] text-muted-foreground uppercase tracking-wider">{{ t('nodeOverlay.firstPrompt') }}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div class="mt-1 text-[11px] text-foreground/70 bg-background rounded-lg p-2">
                  <MarkdownRenderer :content="n.firstPrompt" />
                </div>
              </CollapsibleContent>
            </Collapsible>

            <!-- Key entities -->
            <div v-if="n.keyEntities.length > 0" class="flex flex-wrap gap-1">
              <Badge
                v-for="tag in n.keyEntities"
                :key="tag"
                variant="secondary"
                class="text-[9px] px-1.5 py-0"
              >
                {{ tag }}
              </Badge>
            </div>

            <!-- Files touched -->
            <div v-if="n.filesTouched.length > 0" class="flex flex-wrap gap-1">
              <span
                v-for="file in n.filesTouched.slice(0, 5)"
                :key="file"
                class="text-[9px] font-mono text-primary/60 bg-primary/5 px-1 py-0.5 rounded"
              >
                {{ file }}
              </span>
              <span v-if="n.filesTouched.length > 5" class="text-[9px] text-muted-foreground">
                {{ t('nodeOverlay.moreFiles', { count: n.filesTouched.length - 5 }) }}
              </span>
            </div>

            <!-- Related closed tasks -->
            <template v-for="(related, _idx) in [getRelatedNodes(n.relatedClosedNodeIds)]" :key="_idx">
            <div v-if="related.length > 0" class="space-y-1" @click.stop>
              <span class="text-[9px] font-medium text-muted-foreground uppercase tracking-wider">{{ t('nodeOverlay.related') }}</span>
              <div
                v-for="r in related"
                :key="r.nodeId"
                class="flex items-center justify-between gap-2 rounded border border-border/50 bg-muted/40 px-2 py-1"
              >
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="text-[9px] text-foreground/70 truncate">{{ r.title }}</span>
                  <Badge
                    v-if="r.summary"
                    variant="outline"
                    class="text-[8px] px-1 py-0 shrink-0"
                    :class="outcomeBadgeClass(r.summary.outcome)"
                  >
                    {{ r.summary.outcome }}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-4 w-4 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                  :title="t('nodeOverlay.disconnectRelation')"
                  @click="store.disconnectNodeRelation(n.nodeId, r.nodeId)"
                >
                  <IconX :size="10" />
                </Button>
              </div>
            </div>
            </template>

            <div class="flex justify-end" @click.stop>
              <Button
                variant="ghost"
                size="sm"
                class="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                @click="store.closeNodeFromDashboard(n.nodeId)"
              >
                {{ t('nodeOverlay.closeAction') }}
              </Button>
            </div>
          </div>
        </div>

        <!-- Closed Tasks -->
        <div v-if="store.closedNodes.length > 0" class="space-y-2">
          <div class="flex items-center gap-2">
            <div class="h-px flex-1 bg-border" />
            <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">{{ t('nodeOverlay.completedTasks') }}</span>
            <Badge variant="secondary" class="text-[9px] px-1.5 py-0">{{ store.closedNodes.length }}</Badge>
            <div class="h-px flex-1 bg-border" />
          </div>

          <div
            v-for="n in store.closedNodes"
            :key="n.nodeId"
            class="rounded-xl border border-border bg-muted/40 p-3 space-y-2 cursor-pointer transition-colors hover:bg-muted/60"
            @click="store.viewNodeDetail(n.nodeId)"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-[11px] font-medium text-foreground truncate">{{ n.title }}</span>
              <div class="flex items-center gap-1.5 shrink-0">
                <Badge
                  v-if="n.summary"
                  variant="outline"
                  class="text-[9px] px-1.5 py-0"
                  :class="outcomeBadgeClass(n.summary.outcome)"
                >
                  {{ n.summary.outcome }}
                </Badge>
                <span class="text-[10px] text-muted-foreground tabular-nums">{{ t('nodeOverlay.turnsBadge', { count: n.turnCount }) }}</span>
              </div>
            </div>

            <!-- Summary -->
            <p v-if="n.summary" class="text-[11px] text-foreground/70">{{ n.summary.taskDescription }}</p>

            <!-- First prompt -->
            <Collapsible v-if="n.firstPrompt">
              <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer" @click.stop>
                <IconChevronDown :size="10" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                <span class="text-[9px] text-muted-foreground uppercase tracking-wider">{{ t('nodeOverlay.firstPrompt') }}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div class="mt-1 text-[11px] text-foreground/70 bg-background rounded-lg p-2">
                  <MarkdownRenderer :content="n.firstPrompt" />
                </div>
              </CollapsibleContent>
            </Collapsible>

            <!-- Key entities -->
            <div v-if="n.keyEntities.length > 0" class="flex flex-wrap gap-1">
              <Badge
                v-for="tag in n.keyEntities"
                :key="tag"
                variant="secondary"
                class="text-[9px] px-1.5 py-0"
              >
                {{ tag }}
              </Badge>
            </div>

            <!-- Files touched -->
            <div v-if="n.filesTouched.length > 0" class="flex flex-wrap gap-1">
              <span
                v-for="file in n.filesTouched.slice(0, 5)"
                :key="file"
                class="text-[9px] font-mono text-primary/60 bg-primary/5 px-1 py-0.5 rounded"
              >
                {{ file }}
              </span>
              <span v-if="n.filesTouched.length > 5" class="text-[9px] text-muted-foreground">
                {{ t('nodeOverlay.moreFiles', { count: n.filesTouched.length - 5 }) }}
              </span>
            </div>

            <div class="flex justify-end" @click.stop>
              <Button
                variant="ghost"
                size="sm"
                class="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                @click="store.reopenNode(n.nodeId)"
              >
                {{ t('nodeOverlay.reopen') }}
              </Button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </OverlayShell>
</template>
