import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeManager } from '../node-manager';
import type { TaskNode, NodeSummary, NodeState, StructuredTurn } from '../types';

vi.mock('../haiku-query', () => ({
  haikuStructuredQuery: vi.fn(),
}));

import { haikuStructuredQuery } from '../haiku-query';
const mockHaikuQuery = vi.mocked(haikuStructuredQuery);

function makePersistence() {
  return {
    persistNodeCreatedQueued: vi.fn(),
    persistNodeClosedQueued: vi.fn(),
    persistNodeReopenedQueued: vi.fn(),
    persistNodeStateQueued: vi.fn(),
    persistNodeSeedContextQueued: vi.fn(),
  } as unknown as import('../turn-persistence').TurnPersistence;
}

function makeTurn(index: number, nodeId: string | null = null, userMessage = `prompt ${index}`): StructuredTurn {
  return {
    promptIndex: index,
    timestamp: new Date().toISOString(),
    userMessage,
    assistantResponse: `response ${index}`,
    toolCalls: [],
    contentBlocks: [],
    thinkingBlocks: [],
    filesTouched: [],
    nodeId,
    summary: null,
    keywords: null,
  };
}

function makeSummary(overrides: Partial<NodeSummary> = {}): NodeSummary {
  return {
    title: 'Test Task',
    taskDescription: 'A test task',
    outcome: 'resolved',
    filesChanged: [],
    keyDecisions: [],
    keyEntities: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Node creation
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeManager: createNode', () => {
  let manager: NodeManager;
  let persistence: ReturnType<typeof makePersistence>;

  beforeEach(() => {
    vi.clearAllMocks();
    persistence = makePersistence();
    manager = new NodeManager(persistence, '/test');
  });

  it('creates a node with Haiku-generated title and entities', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Fix Auth Bug', keyEntities: ['auth', 'login', 'JWT'] });
    const node = await manager.createNode('Fix the auth bug in login.ts');

    expect(node.title).toBe('Fix Auth Bug');
    expect(node.keyEntities).toEqual(['auth', 'login', 'JWT']);
    expect(node.status).toBe('ACTIVE');
    expect(node.turnIndices).toEqual([]);
    expect(node.closedAt).toBeNull();
    expect(node.summary).toBeNull();
    expect(node.nodeId).toBeTruthy();
    expect(node.createdAt).toBeTruthy();
  });

  it('falls back to "New Task" when Haiku returns null', async () => {
    mockHaikuQuery.mockResolvedValueOnce(null);
    const node = await manager.createNode('some prompt');

    expect(node.title).toBe('New Task');
    expect(node.keyEntities).toEqual([]);
  });

  it('sets the new node as active', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task A', keyEntities: [] });
    const node = await manager.createNode('task a');

    expect(manager.getNodeState().activeNodeId).toBe(node.nodeId);
  });

  it('persists node creation and state', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: ['x'] });
    const node = await manager.createNode('test');

    expect(persistence.persistNodeCreatedQueued).toHaveBeenCalledWith(node.nodeId, 'Task', ['x']);
    expect(persistence.persistNodeStateQueued).toHaveBeenCalledWith(manager.getNodeState());
  });

  it('truncates entities at MAX_ENTITIES_PER_NODE (30)', async () => {
    const entities = Array.from({ length: 50 }, (_, i) => `entity${i}`);
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: entities });
    const node = await manager.createNode('test');

    expect(node.keyEntities).toHaveLength(30);
  });

  it('passes entities from Haiku directly without filtering', async () => {
    mockHaikuQuery.mockResolvedValueOnce({
      title: 'Sun Research',
      keyEntities: ['sun', 'moon', 'solar energy'],
      relatedClosedNodeIds: [],
    });
    const node = await manager.createNode('tell me about the sun');

    expect(node.keyEntities).toEqual(['sun', 'moon', 'solar energy']);
  });

  it('uses relatedClosedNodeIds from Haiku directly', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Old Auth', keyEntities: ['auth', 'login', 'JWT'], relatedClosedNodeIds: [] });
    const oldNode = await manager.createNode('old auth work');
    manager.closeNode(oldNode.nodeId, makeSummary({ keyEntities: ['auth', 'login', 'JWT'] }));

    mockHaikuQuery.mockResolvedValueOnce({
      title: 'New Auth',
      keyEntities: ['auth', 'login', 'session'],
      relatedClosedNodeIds: [oldNode.nodeId],
    });
    const newNode = await manager.createNode('new auth work');

    expect(newNode.relatedClosedNodeIds).toContain(oldNode.nodeId);
  });

  it('filters out invalid relatedClosedNodeIds from Haiku', async () => {
    mockHaikuQuery.mockResolvedValueOnce({
      title: 'Task',
      keyEntities: ['auth'],
      relatedClosedNodeIds: ['nonexistent-id', 'another-fake'],
    });
    const node = await manager.createNode('test');

    expect(node.relatedClosedNodeIds).toEqual([]);
  });

  it('generates unique nodeIds', async () => {
    mockHaikuQuery.mockResolvedValue({ title: 'Task', keyEntities: [] });
    const node1 = await manager.createNode('a');
    const node2 = await manager.createNode('b');

    expect(node1.nodeId).not.toBe(node2.nodeId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Node closing
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeManager: closeNode', () => {
  let manager: NodeManager;
  let persistence: ReturnType<typeof makePersistence>;

  beforeEach(() => {
    vi.clearAllMocks();
    persistence = makePersistence();
    manager = new NodeManager(persistence, '/test');
  });

  it('sets status to CLOSED and assigns closedAt', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    const summary = makeSummary();
    manager.closeNode(node.nodeId, summary);

    const closed = manager.getNodeById(node.nodeId)!;
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).toBeTruthy();
    expect(closed.summary).toBe(summary);
  });

  it('clears activeNodeId when closing the active node', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    expect(manager.getNodeState().activeNodeId).toBe(node.nodeId);

    manager.closeNode(node.nodeId, makeSummary());
    expect(manager.getNodeState().activeNodeId).toBeNull();
  });

  it('does not clear activeNodeId when closing a non-active node', async () => {
    mockHaikuQuery.mockResolvedValue({ title: 'Task', keyEntities: [] });
    const node1 = await manager.createNode('a');
    const node2 = await manager.createNode('b');

    expect(manager.getNodeState().activeNodeId).toBe(node2.nodeId);
    manager.closeNode(node1.nodeId, makeSummary());
    expect(manager.getNodeState().activeNodeId).toBe(node2.nodeId);
  });

  it('is a no-op for non-existent nodeId', () => {
    manager.closeNode('nonexistent', makeSummary());
    expect(persistence.persistNodeClosedQueued).not.toHaveBeenCalled();
  });

  it('persists close and state', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    const summary = makeSummary();
    manager.closeNode(node.nodeId, summary);

    expect(persistence.persistNodeClosedQueued).toHaveBeenCalledWith(node.nodeId, summary);
    expect(persistence.persistNodeStateQueued).toHaveBeenCalled();
  });

  it('recomputes related closed nodes for remaining active nodes', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Auth Fix', keyEntities: ['auth', 'JWT', 'login'] });
    const a = await manager.createNode('auth fix');

    mockHaikuQuery.mockResolvedValueOnce({ title: 'Auth Refactor', keyEntities: ['auth', 'JWT', 'middleware'] });
    const b = await manager.createNode('auth refactor');

    manager.closeNode(a.nodeId, makeSummary({ keyEntities: ['auth', 'JWT', 'login'] }));

    const bNode = manager.getNodeById(b.nodeId)!;
    expect(bNode.relatedClosedNodeIds).toContain(a.nodeId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Node reopening
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeManager: reopenNode', () => {
  let manager: NodeManager;
  let persistence: ReturnType<typeof makePersistence>;

  beforeEach(() => {
    vi.clearAllMocks();
    persistence = makePersistence();
    manager = new NodeManager(persistence, '/test');
  });

  it('reopens a closed node and sets it as active', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    manager.closeNode(node.nodeId, makeSummary());

    const result = manager.reopenNode(node.nodeId);
    expect(result).toBe(true);

    const reopened = manager.getNodeById(node.nodeId)!;
    expect(reopened.status).toBe('ACTIVE');
    expect(reopened.closedAt).toBeNull();
    expect(manager.getNodeState().activeNodeId).toBe(node.nodeId);
  });

  it('returns false when at MAX_ACTIVE_NODES limit', async () => {
    mockHaikuQuery.mockResolvedValue({ title: 'Task', keyEntities: [] });

    const nodes: TaskNode[] = [];
    for (let i = 0; i < 5; i++) nodes.push(await manager.createNode(`task ${i}`));
    expect(manager.getActiveNodes()).toHaveLength(5);

    manager.closeNode(nodes[0]!.nodeId, makeSummary());
    manager.closeNode(nodes[1]!.nodeId, makeSummary());
    expect(manager.getActiveNodes()).toHaveLength(3);

    manager.reopenNode(nodes[0]!.nodeId);
    expect(manager.getActiveNodes()).toHaveLength(4);

    manager.reopenNode(nodes[1]!.nodeId);
    expect(manager.getActiveNodes()).toHaveLength(5);

    manager.closeNode(nodes[2]!.nodeId, makeSummary());
    expect(manager.getActiveNodes()).toHaveLength(4);
    manager.reopenNode(nodes[2]!.nodeId);
    expect(manager.getActiveNodes()).toHaveLength(5);

    manager.closeNode(nodes[3]!.nodeId, makeSummary());
    const result = manager.reopenNode(nodes[3]!.nodeId);
    expect(result).toBe(true);
    expect(manager.getActiveNodes()).toHaveLength(5);

    manager.closeNode(nodes[4]!.nodeId, makeSummary());
    await manager.createNode('fill');
    expect(manager.getActiveNodes()).toHaveLength(5);

    const blocked = manager.reopenNode(nodes[4]!.nodeId);
    expect(blocked).toBe(false);
  });

  it('returns false for non-existent nodeId', () => {
    expect(manager.reopenNode('nonexistent')).toBe(false);
  });

  it('returns false for an already-active node', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');

    expect(manager.reopenNode(node.nodeId)).toBe(false);
  });

  it('persists reopen and state', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    manager.closeNode(node.nodeId, makeSummary());
    vi.clearAllMocks();

    manager.reopenNode(node.nodeId);
    expect(persistence.persistNodeReopenedQueued).toHaveBeenCalledWith(node.nodeId);
    expect(persistence.persistNodeStateQueued).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Turn assignment and entity extraction
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeManager: assignTurnToNode', () => {
  let manager: NodeManager;
  let persistence: ReturnType<typeof makePersistence>;

  beforeEach(() => {
    vi.clearAllMocks();
    persistence = makePersistence();
    manager = new NodeManager(persistence, '/test');
  });

  it('adds promptIndex to node turnIndices', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    manager.assignTurnToNode(0, node.nodeId, 'fix the bug');

    expect(node.turnIndices).toContain(0);
  });

  it('deduplicates promptIndex', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    manager.assignTurnToNode(0, node.nodeId, 'fix the bug');
    manager.assignTurnToNode(0, node.nodeId, 'fix the bug');

    expect(node.turnIndices.filter(i => i === 0)).toHaveLength(1);
  });

  it('extracts entities from user message (file paths)', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    manager.assignTurnToNode(0, node.nodeId, 'Fix the bug in src/auth/login.ts');

    expect(node.keyEntities.some(e => e.includes('login.ts') || e.includes('src/auth/login.ts'))).toBe(true);
  });

  it('extracts entities from user message (extension pattern)', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    manager.assignTurnToNode(0, node.nodeId, 'Update the component.vue and styles.css files');

    const entities = node.keyEntities.map(e => e.toLowerCase());
    expect(entities.some(e => e.includes('component.vue'))).toBe(true);
    expect(entities.some(e => e.includes('styles.css'))).toBe(true);
  });

  it('filters stop words from generic word extraction', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    manager.assignTurnToNode(0, node.nodeId, 'the quick brown fox jumps over the lazy dog');

    const lowerEntities = node.keyEntities.map(e => e.toLowerCase());
    expect(lowerEntities).not.toContain('the');
    expect(lowerEntities).not.toContain('over');
    expect(lowerEntities).toContain('quick');
    expect(lowerEntities).toContain('brown');
    expect(lowerEntities).toContain('fox');
  });

  it('deduplicates entities case-insensitively', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: ['Auth'] });
    const node = await manager.createNode('test');
    manager.assignTurnToNode(0, node.nodeId, 'Fix the Auth module in auth service');

    const authCount = node.keyEntities.filter(e => e.toLowerCase() === 'auth').length;
    expect(authCount).toBe(1);
  });

  it('caps entities at MAX_ENTITIES_PER_NODE (30)', async () => {
    const initialEntities = Array.from({ length: 28 }, (_, i) => `entity${i}`);
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: initialEntities });
    const node = await manager.createNode('test');

    manager.assignTurnToNode(0, node.nodeId,
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa');

    expect(node.keyEntities.length).toBeLessThanOrEqual(30);
  });

  it('is a no-op for null nodeId', async () => {
    manager.assignTurnToNode(0, null, 'test');
    expect(manager.getNodeState().nodes).toHaveLength(0);
  });

  it('is a no-op for non-existent nodeId', async () => {
    manager.assignTurnToNode(0, 'nonexistent', 'test');
    expect(manager.getNodeState().nodes).toHaveLength(0);
  });

  it('recomputes related closed nodes after entity update', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Old', keyEntities: ['database', 'migration', 'schema'] });
    const old = await manager.createNode('old');
    manager.closeNode(old.nodeId, makeSummary({ keyEntities: ['database', 'migration', 'schema'] }));

    mockHaikuQuery.mockResolvedValueOnce({ title: 'New', keyEntities: [] });
    const fresh = await manager.createNode('new');
    expect(fresh.relatedClosedNodeIds).toHaveLength(0);

    manager.assignTurnToNode(0, fresh.nodeId, 'Update database migration and schema changes');
    expect(fresh.relatedClosedNodeIds).toContain(old.nodeId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan turn assignment
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeManager: assignOrphanTurnsToNode', () => {
  let manager: NodeManager;
  let persistence: ReturnType<typeof makePersistence>;

  beforeEach(() => {
    vi.clearAllMocks();
    persistence = makePersistence();
    manager = new NodeManager(persistence, '/test');
  });

  it('assigns orphan turns when total chars < threshold', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    const history = [makeTurn(0, null, 'short'), makeTurn(1, null, 'also short')];

    manager.assignOrphanTurnsToNode(node.nodeId, history);

    expect(history[0]!.nodeId).toBe(node.nodeId);
    expect(history[1]!.nodeId).toBe(node.nodeId);
    expect(node.turnIndices).toContain(0);
    expect(node.turnIndices).toContain(1);
  });

  it('does NOT assign orphans when total chars >= threshold (4000)', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    const longMsg = 'x'.repeat(2100);
    const history = [makeTurn(0, null, longMsg), makeTurn(1, null, longMsg)];

    manager.assignOrphanTurnsToNode(node.nodeId, history);

    expect(history[0]!.nodeId).toBeNull();
    expect(history[1]!.nodeId).toBeNull();
  });

  it('ignores turns that already have a nodeId', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    const history = [
      makeTurn(0, 'other-node', 'assigned'),
      makeTurn(1, null, 'orphan'),
    ];

    manager.assignOrphanTurnsToNode(node.nodeId, history);

    expect(history[0]!.nodeId).toBe('other-node');
    expect(history[1]!.nodeId).toBe(node.nodeId);
  });

  it('is a no-op when no orphans exist', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    const history = [makeTurn(0, 'some-node'), makeTurn(1, 'some-node')];

    manager.assignOrphanTurnsToNode(node.nodeId, history);
    expect(node.turnIndices).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Entity overlap and related node computation
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeManager: entity overlap', () => {
  let manager: NodeManager;
  let persistence: ReturnType<typeof makePersistence>;

  beforeEach(() => {
    vi.clearAllMocks();
    persistence = makePersistence();
    manager = new NodeManager(persistence, '/test');
  });

  it('incremental: connects nodes with any entity overlap', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Old', keyEntities: ['auth', 'login', 'JWT', 'session', 'token'], relatedClosedNodeIds: [] });
    const old = await manager.createNode('old');
    manager.closeNode(old.nodeId, makeSummary({ keyEntities: ['auth', 'login', 'JWT', 'session', 'token'] }));

    mockHaikuQuery.mockResolvedValueOnce({ title: 'New', keyEntities: [], relatedClosedNodeIds: [] });
    const fresh = await manager.createNode('new');
    manager.assignTurnToNode(0, fresh.nodeId, 'Fix the database auth query');

    expect(fresh.relatedClosedNodeIds).toContain(old.nodeId);
  });

  it('incremental: even a single shared entity connects nodes', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Old', keyEntities: ['database', 'migration', 'schema', 'index', 'query'], relatedClosedNodeIds: [] });
    const old = await manager.createNode('old');
    manager.closeNode(old.nodeId, makeSummary({ keyEntities: ['database', 'migration', 'schema', 'index', 'query'] }));

    mockHaikuQuery.mockResolvedValueOnce({ title: 'New', keyEntities: [], relatedClosedNodeIds: [] });
    const fresh = await manager.createNode('new');
    manager.assignTurnToNode(0, fresh.nodeId, 'Fix the database connection');

    expect(fresh.relatedClosedNodeIds).toContain(old.nodeId);
  });

  it('returns empty when no closed nodes exist', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: ['auth'] });
    const node = await manager.createNode('test');
    expect(node.relatedClosedNodeIds).toEqual([]);
  });

  it('incremental: uses summary keyEntities for overlap on closed nodes', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Old', keyEntities: ['react', 'component'], relatedClosedNodeIds: [] });
    const old = await manager.createNode('old');
    manager.closeNode(old.nodeId, makeSummary({ keyEntities: ['vue', 'component', 'pinia', 'store'] }));

    mockHaikuQuery.mockResolvedValueOnce({ title: 'New', keyEntities: [], relatedClosedNodeIds: [] });
    const fresh = await manager.createNode('new');
    manager.assignTurnToNode(0, fresh.nodeId, 'Update the vue component');

    expect(fresh.relatedClosedNodeIds).toContain(old.nodeId);
  });

  it('Haiku receives closed node summaries in prompt', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Old', keyEntities: ['sun', 'solar'], relatedClosedNodeIds: [] });
    const old = await manager.createNode('sun facts');
    manager.closeNode(old.nodeId, makeSummary({
      keyEntities: ['sun', 'solar'],
      taskDescription: 'Researched solar facts',
    }));

    mockHaikuQuery.mockResolvedValueOnce({
      title: 'Moon Sun Compare',
      keyEntities: ['sun', 'moon'],
      relatedClosedNodeIds: [old.nodeId],
    });
    const fresh = await manager.createNode('compare moon and sun');

    expect(fresh.relatedClosedNodeIds).toContain(old.nodeId);
    const haikuCallArgs = mockHaikuQuery.mock.calls[1]![0]!;
    expect(haikuCallArgs.userMessage).toContain(old.nodeId);
    expect(haikuCallArgs.userMessage).toContain('Previously completed tasks');
  });

  it('handles empty entity lists gracefully', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Old', keyEntities: [] });
    const old = await manager.createNode('old');
    manager.closeNode(old.nodeId, makeSummary({ keyEntities: [] }));

    mockHaikuQuery.mockResolvedValueOnce({ title: 'New', keyEntities: [] });
    const fresh = await manager.createNode('new');

    expect(fresh.relatedClosedNodeIds).toEqual([]);
  });

  it('findRelatedClosedNodes returns actual TaskNode objects', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Old', keyEntities: ['auth', 'login'], relatedClosedNodeIds: [] });
    const old = await manager.createNode('old');
    manager.closeNode(old.nodeId, makeSummary({ keyEntities: ['auth', 'login'] }));

    mockHaikuQuery.mockResolvedValueOnce({ title: 'New', keyEntities: ['auth', 'login'], relatedClosedNodeIds: [old.nodeId] });
    const fresh = await manager.createNode('new');

    const related = manager.findRelatedClosedNodes(fresh);
    expect(related).toHaveLength(1);
    expect(related[0]!.nodeId).toBe(old.nodeId);
    expect(related[0]!.status).toBe('CLOSED');
  });

  it('findRelatedClosedNodes excludes reopened nodes', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Old', keyEntities: ['auth', 'login'], relatedClosedNodeIds: [] });
    const old = await manager.createNode('old');
    manager.closeNode(old.nodeId, makeSummary({ keyEntities: ['auth', 'login'] }));

    mockHaikuQuery.mockResolvedValueOnce({ title: 'New', keyEntities: ['auth', 'login'], relatedClosedNodeIds: [old.nodeId] });
    const fresh = await manager.createNode('new');

    manager.reopenNode(old.nodeId);
    const related = manager.findRelatedClosedNodes(fresh);
    expect(related).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Query methods
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeManager: queries', () => {
  let manager: NodeManager;
  let persistence: ReturnType<typeof makePersistence>;

  beforeEach(() => {
    vi.clearAllMocks();
    persistence = makePersistence();
    manager = new NodeManager(persistence, '/test');
  });

  it('getActiveNodes returns only ACTIVE nodes', async () => {
    mockHaikuQuery.mockResolvedValue({ title: 'Task', keyEntities: [] });
    const a = await manager.createNode('a');
    const b = await manager.createNode('b');
    manager.closeNode(a.nodeId, makeSummary());

    const active = manager.getActiveNodes();
    expect(active).toHaveLength(1);
    expect(active[0]!.nodeId).toBe(b.nodeId);
  });

  it('getClosedNodes returns only CLOSED nodes', async () => {
    mockHaikuQuery.mockResolvedValue({ title: 'Task', keyEntities: [] });
    const a = await manager.createNode('a');
    await manager.createNode('b');
    manager.closeNode(a.nodeId, makeSummary());

    const closed = manager.getClosedNodes();
    expect(closed).toHaveLength(1);
    expect(closed[0]!.nodeId).toBe(a.nodeId);
  });

  it('getNodeById returns undefined for unknown id', () => {
    expect(manager.getNodeById('unknown')).toBeUndefined();
  });

  it('getNodeTurns filters history by nodeId', async () => {
    mockHaikuQuery.mockResolvedValue({ title: 'Task', keyEntities: [] });
    const node = await manager.createNode('test');
    const history = [
      makeTurn(0, node.nodeId),
      makeTurn(1, 'other'),
      makeTurn(2, node.nodeId),
      makeTurn(3, null),
    ];

    const turns = manager.getNodeTurns(node.nodeId, history);
    expect(turns).toHaveLength(2);
    expect(turns.map(t => t.promptIndex)).toEqual([0, 2]);
  });

  it('canCreateNode returns false at MAX_ACTIVE_NODES', async () => {
    mockHaikuQuery.mockResolvedValue({ title: 'Task', keyEntities: [] });
    for (let i = 0; i < 5; i++) await manager.createNode(`task ${i}`);

    expect(manager.canCreateNode()).toBe(false);
  });

  it('canCreateNode returns true below limit', async () => {
    mockHaikuQuery.mockResolvedValue({ title: 'Task', keyEntities: [] });
    for (let i = 0; i < 4; i++) await manager.createNode(`task ${i}`);

    expect(manager.canCreateNode()).toBe(true);
  });

  it('hasNodes returns false initially and true after creation', async () => {
    expect(manager.hasNodes()).toBe(false);

    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    await manager.createNode('test');
    expect(manager.hasNodes()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// State management
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeManager: state management', () => {
  let manager: NodeManager;
  let persistence: ReturnType<typeof makePersistence>;

  beforeEach(() => {
    vi.clearAllMocks();
    persistence = makePersistence();
    manager = new NodeManager(persistence, '/test');
  });

  it('loadState replaces all internal state', () => {
    const state: NodeState = {
      nodes: [{
        nodeId: 'test-id',
        title: 'Loaded Task',
        status: 'ACTIVE',
        keyEntities: ['x'],
        turnIndices: [0, 1],
        createdAt: new Date().toISOString(),
        closedAt: null,
        summary: null,
        relatedClosedNodeIds: [],
        manuallyDisconnectedNodeIds: [],
        seedContext: null,
        seedContextPrompt: null,
      }],
      activeNodeId: 'test-id',
    };

    manager.loadState(state);

    expect(manager.hasNodes()).toBe(true);
    expect(manager.getNodeById('test-id')?.title).toBe('Loaded Task');
    expect(manager.getNodeState().activeNodeId).toBe('test-id');
  });

  it('loadState with empty state resets everything', () => {
    manager.loadState({ nodes: [], activeNodeId: null });
    expect(manager.hasNodes()).toBe(false);
    expect(manager.getNodeState().activeNodeId).toBeNull();
  });

  it('setActiveNodeId changes the active node', async () => {
    mockHaikuQuery.mockResolvedValue({ title: 'Task', keyEntities: [] });
    const a = await manager.createNode('a');
    const b = await manager.createNode('b');

    expect(manager.getNodeState().activeNodeId).toBe(b.nodeId);
    manager.setActiveNodeId(a.nodeId);
    expect(manager.getNodeState().activeNodeId).toBe(a.nodeId);
  });

  it('setActiveNodeId accepts null', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    await manager.createNode('test');

    manager.setActiveNodeId(null);
    expect(manager.getNodeState().activeNodeId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Node picker data
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeManager: getNodePickerData', () => {
  let manager: NodeManager;
  let persistence: ReturnType<typeof makePersistence>;

  beforeEach(() => {
    vi.clearAllMocks();
    persistence = makePersistence();
    manager = new NodeManager(persistence, '/test');
  });

  it('returns empty active nodes initially', () => {
    const data = manager.getNodePickerData();
    expect(data.activeNodes).toHaveLength(0);
    expect(data.canCreateNew).toBe(true);
  });

  it('returns formatted active node data', async () => {
    mockHaikuQuery.mockResolvedValueOnce({
      title: 'Fix Auth Bug',
      keyEntities: ['auth', 'login', 'JWT', 'session', 'middleware', 'handler'],
    });
    const node = await manager.createNode('test');
    manager.assignTurnToNode(0, node.nodeId, 'first');
    manager.assignTurnToNode(1, node.nodeId, 'second');

    const data = manager.getNodePickerData();
    expect(data.activeNodes).toHaveLength(1);
    expect(data.activeNodes[0]!.title).toBe('Fix Auth Bug');
    expect(data.activeNodes[0]!.turnCount).toBe(2);
    expect(data.activeNodes[0]!.entityTags).toHaveLength(5);
  });

  it('canCreateNew is false at 5 active nodes', async () => {
    mockHaikuQuery.mockResolvedValue({ title: 'Task', keyEntities: [] });
    for (let i = 0; i < 5; i++) await manager.createNode(`task ${i}`);

    const data = manager.getNodePickerData();
    expect(data.canCreateNew).toBe(false);
  });

  it('excludes closed nodes from picker', async () => {
    mockHaikuQuery.mockResolvedValue({ title: 'Task', keyEntities: [] });
    const a = await manager.createNode('a');
    await manager.createNode('b');
    manager.closeNode(a.nodeId, makeSummary());

    const data = manager.getNodePickerData();
    expect(data.activeNodes).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatAge (tested indirectly through getNodePickerData)
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeManager: age formatting', () => {
  let manager: NodeManager;
  let persistence: ReturnType<typeof makePersistence>;

  beforeEach(() => {
    vi.clearAllMocks();
    persistence = makePersistence();
    manager = new NodeManager(persistence, '/test');
  });

  it('shows "just now" for recent nodes', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Task', keyEntities: [] });
    await manager.createNode('test');

    const data = manager.getNodePickerData();
    expect(data.activeNodes[0]!.lastActivityAge).toBe('just now');
  });

  it('shows minutes for older nodes', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    manager.loadState({
      nodes: [{
        nodeId: 'old',
        title: 'Old Task',
        status: 'ACTIVE' as const,
        keyEntities: [],
        turnIndices: [],
        createdAt: tenMinutesAgo,
        closedAt: null,
        summary: null,
        relatedClosedNodeIds: [],
        manuallyDisconnectedNodeIds: [],
        seedContext: null,
        seedContextPrompt: null,
      }],
      activeNodeId: 'old',
    });

    const data = manager.getNodePickerData();
    expect(data.activeNodes[0]!.lastActivityAge).toBe('10m ago');
  });

  it('shows hours for older nodes', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    manager.loadState({
      nodes: [{
        nodeId: 'old',
        title: 'Old Task',
        status: 'ACTIVE' as const,
        keyEntities: [],
        turnIndices: [],
        createdAt: twoHoursAgo,
        closedAt: null,
        summary: null,
        relatedClosedNodeIds: [],
        manuallyDisconnectedNodeIds: [],
        seedContext: null,
        seedContextPrompt: null,
      }],
      activeNodeId: 'old',
    });

    const data = manager.getNodePickerData();
    expect(data.activeNodes[0]!.lastActivityAge).toBe('2h ago');
  });

  it('shows days for very old nodes', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    manager.loadState({
      nodes: [{
        nodeId: 'old',
        title: 'Old Task',
        status: 'ACTIVE' as const,
        keyEntities: [],
        turnIndices: [],
        createdAt: threeDaysAgo,
        closedAt: null,
        summary: null,
        relatedClosedNodeIds: [],
        manuallyDisconnectedNodeIds: [],
        seedContext: null,
        seedContextPrompt: null,
      }],
      activeNodeId: 'old',
    });

    const data = manager.getNodePickerData();
    expect(data.activeNodes[0]!.lastActivityAge).toBe('3d ago');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Manual disconnect
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeManager: disconnectNode', () => {
  let manager: NodeManager;
  let persistence: ReturnType<typeof makePersistence>;

  beforeEach(() => {
    vi.clearAllMocks();
    persistence = makePersistence();
    manager = new NodeManager(persistence, '/test');
  });

  it('removes a related closed node and persists', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Old', keyEntities: ['auth', 'login'], relatedClosedNodeIds: [] });
    const old = await manager.createNode('old');
    manager.closeNode(old.nodeId, makeSummary({ keyEntities: ['auth', 'login'] }));

    mockHaikuQuery.mockResolvedValueOnce({ title: 'New', keyEntities: ['auth', 'login'], relatedClosedNodeIds: [old.nodeId] });
    const fresh = await manager.createNode('new');
    expect(fresh.relatedClosedNodeIds).toContain(old.nodeId);

    manager.disconnectNode(fresh.nodeId, old.nodeId);
    expect(fresh.relatedClosedNodeIds).not.toContain(old.nodeId);
    expect(fresh.manuallyDisconnectedNodeIds).toContain(old.nodeId);
    expect(persistence.persistNodeStateQueued).toHaveBeenCalled();
  });

  it('prevents recomputation from re-adding disconnected nodes', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Old', keyEntities: ['auth', 'login'], relatedClosedNodeIds: [] });
    const old = await manager.createNode('old');
    manager.closeNode(old.nodeId, makeSummary({ keyEntities: ['auth', 'login'] }));

    mockHaikuQuery.mockResolvedValueOnce({ title: 'New', keyEntities: ['auth', 'login'], relatedClosedNodeIds: [old.nodeId] });
    const fresh = await manager.createNode('new');

    manager.disconnectNode(fresh.nodeId, old.nodeId);
    expect(fresh.relatedClosedNodeIds).not.toContain(old.nodeId);

    manager.assignTurnToNode(0, fresh.nodeId, 'Work on auth login system');
    expect(fresh.relatedClosedNodeIds).not.toContain(old.nodeId);
  });

  it('is a no-op for non-existent nodeId', () => {
    manager.disconnectNode('nonexistent', 'some-id');
    expect(persistence.persistNodeStateQueued).not.toHaveBeenCalled();
  });

  it('does not duplicate entries in manuallyDisconnectedNodeIds', async () => {
    mockHaikuQuery.mockResolvedValueOnce({ title: 'Old', keyEntities: ['auth'], relatedClosedNodeIds: [] });
    const old = await manager.createNode('old');
    manager.closeNode(old.nodeId, makeSummary({ keyEntities: ['auth'] }));

    mockHaikuQuery.mockResolvedValueOnce({ title: 'New', keyEntities: ['auth'], relatedClosedNodeIds: [old.nodeId] });
    const fresh = await manager.createNode('new');

    manager.disconnectNode(fresh.nodeId, old.nodeId);
    manager.disconnectNode(fresh.nodeId, old.nodeId);
    expect(fresh.manuallyDisconnectedNodeIds.filter(id => id === old.nodeId)).toHaveLength(1);
  });

  it('loadState backfills manuallyDisconnectedNodeIds for old sessions', () => {
    const oldState = {
      nodes: [{
        nodeId: 'test-id',
        title: 'Old Session Task',
        status: 'ACTIVE' as const,
        keyEntities: ['x'],
        turnIndices: [],
        createdAt: new Date().toISOString(),
        closedAt: null,
        summary: null,
        relatedClosedNodeIds: [],
        seedContext: null,
        seedContextPrompt: null,
      }],
      activeNodeId: 'test-id',
    } as unknown as NodeState;

    manager.loadState(oldState);
    const loaded = manager.getNodeById('test-id')!;
    expect(loaded.manuallyDisconnectedNodeIds).toEqual([]);
  });
});
