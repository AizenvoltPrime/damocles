import * as crypto from 'crypto';
import { log } from '../logger';
import type { TurnPersistence } from './turn-persistence';
import type { TaskNode, NodeSummary, NodeState, StructuredTurn } from './types';
import { haikuStructuredQuery } from './haiku-query';

const MAX_ACTIVE_NODES = 5;
const MAX_ENTITIES_PER_NODE = 30;
const ORPHAN_BULK_ASSIGN_THRESHOLD = 4_000;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'through', 'after', 'before', 'above', 'below', 'up', 'down', 'out',
  'off', 'over', 'under', 'again', 'then', 'once', 'here', 'there',
  'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 'just', 'because',
  'but', 'and', 'or', 'if', 'while', 'that', 'this', 'what', 'which',
  'who', 'whom', 'these', 'those', 'am', 'it', 'its', 'my', 'your',
  'his', 'her', 'our', 'their', 'me', 'him', 'us', 'them',
  'yes', 'ok', 'okay', 'yep', 'yeah', 'sure', 'right', 'well',
  'please', 'thanks', 'thank', 'now', 'also', 'still', 'already',
  'let', 'make', 'get', 'put', 'say', 'go', 'know', 'take', 'see',
  'come', 'think', 'look', 'want', 'give', 'use', 'find', 'tell',
  'try', 'need', 'feel', 'become', 'leave', 'call', 'keep',
  'add', 'fix', 'update', 'remove', 'change', 'move', 'set', 'run',
  'check', 'test', 'write', 'read', 'show', 'hide', 'send', 'load',
  'create', 'delete', 'open', 'close', 'start', 'stop', 'build', 'new',
  'implement', 'refactor', 'rename', 'replace', 'handle', 'return',
  'function', 'method', 'class', 'type', 'interface', 'module', 'export',
  'import', 'const', 'variable', 'parameter', 'argument', 'value', 'string',
  'number', 'boolean', 'array', 'object', 'null', 'undefined', 'void',
  'file', 'folder', 'directory', 'path', 'name', 'data', 'list', 'item',
  'code', 'line', 'block', 'comment', 'error', 'warning', 'message', 'log',
  'component', 'element', 'property', 'attribute', 'option', 'config',
  'default', 'current', 'existing', 'following', 'using', 'like', 'way',
  'thing', 'something', 'anything', 'everything', 'nothing',
]);

const TITLE_GENERATION_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Concise 3-5 word task title' },
    keyEntities: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    relatedClosedNodeIds: { type: 'array', items: { type: 'string' }, description: 'IDs of semantically related completed tasks' },
  },
  required: ['title', 'keyEntities', 'relatedClosedNodeIds'],
  additionalProperties: false,
};

const TITLE_SYSTEM_PROMPT = `Generate a concise task title, extract key entities, and identify related completed tasks from a user prompt.
The title should be 3-5 words summarizing the task.
Entities must be domain-specific nouns: technical terms, file names, component names, libraries, APIs, algorithms, or topic-level concepts (e.g. "authentication", "solar energy", "database migration").
Do NOT include conversational framing words like "question", "clarification", "previous conversation", "example", "issue", "problem", "help", "request", "task", "update", or "change".
If previously completed tasks are listed, return their IDs in relatedClosedNodeIds only if they discuss the same technical domain, files, or concepts as the new task. Return an empty array if none are related or none are listed.`;

export class NodeManager {
  private nodeState: NodeState = { nodes: [], activeNodeId: null };
  private persistence: TurnPersistence;
  private cwd: string;

  constructor(persistence: TurnPersistence, cwd: string) {
    this.persistence = persistence;
    this.cwd = cwd;
  }

  async createNode(userPrompt: string, abortSignal?: AbortSignal): Promise<TaskNode> {
    if (!this.canCreateNode()) {
      throw new Error(`Cannot create node: ${MAX_ACTIVE_NODES} active nodes limit reached`);
    }

    const closedNodes = this.getClosedNodes().filter(n => n.summary?.outcome !== 'abandoned');
    const userMessage = buildCreateNodePrompt(userPrompt, closedNodes);

    const generated = await haikuStructuredQuery<{ title: string; keyEntities: string[]; relatedClosedNodeIds: string[] }>({
      systemPrompt: TITLE_SYSTEM_PROMPT,
      userMessage,
      schema: TITLE_GENERATION_SCHEMA,
      cwd: this.cwd,
      abortSignal,
    });

    const title = generated?.title ?? 'New Task';
    const keyEntities = generated?.keyEntities ?? [];

    const validClosedIds = new Set(closedNodes.map(n => n.nodeId));
    const relatedClosedNodeIds = (generated?.relatedClosedNodeIds ?? [])
      .filter(id => validClosedIds.has(id));

    const node: TaskNode = {
      nodeId: crypto.randomUUID(),
      title,
      status: 'ACTIVE',
      keyEntities: keyEntities.slice(0, MAX_ENTITIES_PER_NODE),
      turnIndices: [],
      createdAt: new Date().toISOString(),
      closedAt: null,
      summary: null,
      relatedClosedNodeIds,
      manuallyDisconnectedNodeIds: [],
      seedContext: null,
    };

    this.nodeState.nodes.push(node);
    this.nodeState.activeNodeId = node.nodeId;

    this.persistence.persistNodeCreatedQueued(node.nodeId, node.title, node.keyEntities);
    this.persistence.persistNodeStateQueued(this.nodeState);

    log('[NodeManager] Created node %s "%s" with %d entities, %d related', node.nodeId.slice(0, 8), title, keyEntities.length, relatedClosedNodeIds.length);
    return node;
  }

  closeNode(nodeId: string, summary: NodeSummary): void {
    const node = this.getNodeById(nodeId);
    if (!node) return;

    node.status = 'CLOSED';
    node.closedAt = new Date().toISOString();
    node.summary = summary;

    if (this.nodeState.activeNodeId === nodeId) {
      this.nodeState.activeNodeId = null;
    }

    this.persistence.persistNodeClosedQueued(nodeId, summary);
    this.recomputeAllRelatedClosed();
    this.persistence.persistNodeStateQueued(this.nodeState);

    log('[NodeManager] Closed node %s "%s" outcome=%s', nodeId.slice(0, 8), node.title, summary.outcome);
  }

  reopenNode(nodeId: string): boolean {
    if (this.getActiveNodes().length >= MAX_ACTIVE_NODES) return false;

    const node = this.getNodeById(nodeId);
    if (!node || node.status !== 'CLOSED') return false;

    node.status = 'ACTIVE';
    node.closedAt = null;
    node.summary = null;
    this.nodeState.activeNodeId = nodeId;

    this.persistence.persistNodeReopenedQueued(nodeId);
    this.recomputeAllRelatedClosed();
    this.persistence.persistNodeStateQueued(this.nodeState);

    log('[NodeManager] Reopened node %s "%s"', nodeId.slice(0, 8), node.title);
    return true;
  }

  assignTurnToNode(promptIndex: number, nodeId: string | null, userMessage: string): void {
    if (!nodeId) return;
    const node = this.getNodeById(nodeId);
    if (!node) return;

    if (!node.turnIndices.includes(promptIndex)) {
      node.turnIndices.push(promptIndex);
    }

    const newEntities = extractDeterministicEntities(userMessage);
    const existing = new Set(node.keyEntities.map(e => e.toLowerCase()));
    for (const entity of newEntities) {
      if (!existing.has(entity.toLowerCase()) && node.keyEntities.length < MAX_ENTITIES_PER_NODE) {
        node.keyEntities.push(entity);
        existing.add(entity.toLowerCase());
      }
    }

    node.relatedClosedNodeIds = this.computeRelatedClosed(
      node.keyEntities,
      node.manuallyDisconnectedNodeIds,
    );

    this.persistence.persistNodeStateQueued(this.nodeState);
  }

  assignOrphanTurnsToNode(nodeId: string, history: StructuredTurn[]): void {
    const orphans = history.filter(t => t.nodeId === null);
    if (orphans.length === 0) return;

    const totalChars = orphans.reduce((s, t) => s + t.userMessage.length + t.assistantResponse.length, 0);

    if (totalChars < ORPHAN_BULK_ASSIGN_THRESHOLD) {
      const node = this.getNodeById(nodeId);
      if (!node) return;

      const existing = new Set(node.keyEntities.map(e => e.toLowerCase()));
      for (const turn of orphans) {
        turn.nodeId = nodeId;
        if (!node.turnIndices.includes(turn.promptIndex)) {
          node.turnIndices.push(turn.promptIndex);
        }
        for (const entity of extractDeterministicEntities(turn.userMessage)) {
          if (!existing.has(entity.toLowerCase()) && node.keyEntities.length < MAX_ENTITIES_PER_NODE) {
            node.keyEntities.push(entity);
            existing.add(entity.toLowerCase());
          }
        }
      }

      node.relatedClosedNodeIds = this.computeRelatedClosed(
        node.keyEntities,
        node.manuallyDisconnectedNodeIds,
      );
      this.persistence.persistNodeStateQueued(this.nodeState);

      log('[NodeManager] Bulk-assigned %d orphan turns to node %s', orphans.length, nodeId.slice(0, 8));
    } else {
      log('[NodeManager] Skipped orphan bulk-assign: %d chars exceeds threshold', totalChars);
    }
  }

  setActiveNodeId(nodeId: string | null): void {
    this.nodeState.activeNodeId = nodeId;
    this.persistence.persistNodeStateQueued(this.nodeState);
  }

  getActiveNodes(): TaskNode[] {
    return this.nodeState.nodes.filter(n => n.status === 'ACTIVE');
  }

  getClosedNodes(): TaskNode[] {
    return this.nodeState.nodes.filter(n => n.status === 'CLOSED');
  }

  getNodeById(nodeId: string): TaskNode | undefined {
    return this.nodeState.nodes.find(n => n.nodeId === nodeId);
  }

  getNodeTurns(nodeId: string, history: StructuredTurn[]): StructuredTurn[] {
    return history.filter(t => t.nodeId === nodeId);
  }

  findRelatedClosedNodes(activeNode: TaskNode): TaskNode[] {
    return activeNode.relatedClosedNodeIds
      .map(id => this.getNodeById(id))
      .filter((n): n is TaskNode => n !== undefined && n.status === 'CLOSED');
  }

  setSeedContext(nodeId: string, context: string): void {
    const node = this.getNodeById(nodeId);
    if (!node) return;
    node.seedContext = context;
    this.persistence.persistNodeSeedContextQueued(nodeId, context);
    log('[NodeManager] Set seed context for node %s (%d chars)', nodeId.slice(0, 8), context.length);
  }

  getOrphanTurns(history: StructuredTurn[]): StructuredTurn[] {
    return history.filter(t => t.nodeId === null);
  }

  canCreateNode(): boolean {
    return this.getActiveNodes().length < MAX_ACTIVE_NODES;
  }

  hasNodes(): boolean {
    return this.nodeState.nodes.length > 0;
  }

  getNodeState(): NodeState {
    return this.nodeState;
  }

  loadState(state: NodeState): void {
    for (const node of state.nodes) {
      if (!node.manuallyDisconnectedNodeIds) {
        node.manuallyDisconnectedNodeIds = [];
      }
    }
    this.nodeState = state;
    log('[NodeManager] Loaded state: %d nodes, activeNodeId=%s',
      state.nodes.length, state.activeNodeId?.slice(0, 8) ?? 'none');
  }

  getNodePickerData(history?: StructuredTurn[]): {
    activeNodes: Array<{
      nodeId: string;
      title: string;
      turnCount: number;
      entityTags: string[];
      lastActivityAge: string;
    }>;
    canCreateNew: boolean;
  } {
    const now = Date.now();
    const activeNodes = this.getActiveNodes().map(node => {
      let lastTimestamp = node.createdAt;
      if (history) {
        const nodeTurns = this.getNodeTurns(node.nodeId, history);
        if (nodeTurns.length > 0) {
          lastTimestamp = nodeTurns[nodeTurns.length - 1]!.timestamp;
        }
      }
      return {
        nodeId: node.nodeId,
        title: node.title,
        turnCount: node.turnIndices.length,
        entityTags: node.keyEntities.slice(0, 5),
        lastActivityAge: formatAge(now, lastTimestamp),
      };
    });

    return {
      activeNodes,
      canCreateNew: this.canCreateNode(),
    };
  }

  disconnectNode(nodeId: string, relatedNodeId: string): void {
    const node = this.getNodeById(nodeId);
    if (!node) return;

    node.relatedClosedNodeIds = node.relatedClosedNodeIds.filter(id => id !== relatedNodeId);
    if (!node.manuallyDisconnectedNodeIds.includes(relatedNodeId)) {
      node.manuallyDisconnectedNodeIds.push(relatedNodeId);
    }

    this.persistence.persistNodeStateQueued(this.nodeState);
    log('[NodeManager] Disconnected node %s from %s', nodeId.slice(0, 8), relatedNodeId.slice(0, 8));
  }

  private computeRelatedClosed(keyEntities: string[], excludeIds: string[] = []): string[] {
    const activeSet = new Set(keyEntities.map(e => e.toLowerCase()));
    if (activeSet.size === 0) return [];

    const excluded = new Set(excludeIds);
    const related: string[] = [];
    for (const node of this.getClosedNodes()) {
      if (excluded.has(node.nodeId)) continue;
      if (node.summary?.outcome === 'abandoned') continue;
      const closedEntities = node.summary?.keyEntities ?? node.keyEntities;
      const hasOverlap = closedEntities.some(e => activeSet.has(e.toLowerCase()));
      if (hasOverlap) {
        related.push(node.nodeId);
      }
    }
    return related;
  }

  private recomputeAllRelatedClosed(): void {
    for (const node of this.getActiveNodes()) {
      node.relatedClosedNodeIds = this.computeRelatedClosed(
        node.keyEntities,
        node.manuallyDisconnectedNodeIds,
      );
    }
  }
}

function buildCreateNodePrompt(userPrompt: string, closedNodes: TaskNode[]): string {
  if (closedNodes.length === 0) return userPrompt;

  const recentClosed = closedNodes.slice(-20);
  let prompt = userPrompt + '\n\nPreviously completed tasks (select related ones by ID):';
  for (const n of recentClosed) {
    const entities = (n.summary?.keyEntities ?? n.keyEntities).join(', ');
    const desc = n.summary?.taskDescription ?? '';
    prompt += `\n[${n.nodeId}] "${n.title}"`;
    if (desc) prompt += ` — ${desc}`;
    if (entities) prompt += ` | Entities: ${entities}`;
  }
  return prompt;
}

function extractDeterministicEntities(text: string): string[] {
  const entities: string[] = [];
  const seen = new Set<string>();

  const filePathRegex = /(?:[\w.-]+[/\\])+[\w.-]+\.\w{1,5}/g;
  const fileMatches = text.match(filePathRegex);
  if (fileMatches) {
    for (const match of fileMatches) {
      const lower = match.toLowerCase();
      if (!seen.has(lower)) {
        entities.push(match);
        seen.add(lower);
      }
    }
  }

  const extRegex = /\b[\w-]+\.(?:ts|js|tsx|jsx|vue|py|rs|go|css|html|json|yaml|yml|toml|sql|md)\b/g;
  const extMatches = text.match(extRegex);
  if (extMatches) {
    for (const match of extMatches) {
      const lower = match.toLowerCase();
      if (!seen.has(lower)) {
        entities.push(match);
        seen.add(lower);
      }
    }
  }

  const words = text.replace(/[^\w\s/-]/g, ' ').split(/\s+/).filter(Boolean);
  for (const word of words) {
    if (word.length < 3) continue;
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    entities.push(word);
    seen.add(lower);
  }

  return entities.slice(0, 100);
}

function formatAge(nowMs: number, createdAt: string): string {
  const createdMs = new Date(createdAt).getTime();
  if (isNaN(createdMs)) return 'unknown';
  const diffMs = nowMs - createdMs;

  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}
