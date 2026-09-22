import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  planImagePruning,
  resolveImageBudget,
  registerTurnEndImagePruning,
  registerAgentStartImageReconcile,
  type ImageLimitSource,
  type ProjectedEntryView,
} from '../context-image-pruning';

/** The placeholder is spelled out here, not imported: a change to it invalidates the prompt cache. */
const PLACEHOLDER =
  '[Image removed: an older screenshot was pruned to keep the request within provider size limits. Capture a fresh screenshot (BrowserScreenshot) or re-read the file if this content is still needed.]';

type Block = { type: string; text?: string; data?: string; mimeType?: string };

function screenshotResult(id: string, imageCount = 1, text = `result ${id}`): AgentMessage {
  const images = Array.from({ length: imageCount }, (_, i) => ({
    type: 'image' as const,
    data: `${id}-img-${i}`,
    mimeType: 'image/jpeg',
  }));
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'BrowserScreenshot',
    content: [...images, { type: 'text' as const, text }],
    isError: false,
    timestamp: 0,
  };
}

/** One projected entry per tool result, oldest first, ids `t0..tN`. */
function projectedResults(count: number, imagesEach = 1): ProjectedEntryView[] {
  return Array.from({ length: count }, (_, i) => ({
    sourceEntry: { id: `t${i}` },
    messages: [screenshotResult(`t${i}`, imagesEach)],
  }));
}

/** Like `projectedResults`, but each image carries `bytes` base64 characters so byte rules can bind. */
function sizedResults(count: number, bytes: number): ProjectedEntryView[] {
  return Array.from({ length: count }, (_, i) => ({
    sourceEntry: { id: `t${i}` },
    messages: [
      {
        role: 'toolResult',
        toolCallId: `t${i}`,
        toolName: 'BrowserScreenshot',
        content: [{ type: 'image', data: 'x'.repeat(bytes), mimeType: 'image/jpeg' }],
        isError: false,
        timestamp: 0,
      } as AgentMessage,
    ],
  }));
}

/** Apply a plan to the projection the way a committed context edit does. */
function applyEdits(entries: ProjectedEntryView[], edits: ReturnType<typeof planImagePruning>): ProjectedEntryView[] {
  const byId = new Map(edits.map((edit) => [edit.targetId, edit.content]));
  return entries.map((entry) => {
    const content = byId.get(entry.sourceEntry.id);
    if (!content) return entry;
    return { sourceEntry: entry.sourceEntry, messages: entry.messages.map((m) => ({ ...m, content }) as AgentMessage) };
  });
}

function imageCount(entries: ProjectedEntryView[]): number {
  let n = 0;
  for (const entry of entries)
    for (const message of entry.messages)
      for (const block of (message as { content: Block[] }).content) if (block.type === 'image') n++;
  return n;
}

/** How many images a plan over `entries` replaces. */
function prunedImages(entries: ProjectedEntryView[], model?: ImageLimitSource, costKeep?: number): number {
  const edits = costKeep === undefined ? planImagePruning(entries, model) : planImagePruning(entries, model, costKeep);
  return imageCount(entries) - imageCount(applyEdits(entries, edits));
}

const noLimits = undefined;
const anthropic: ImageLimitSource = { inputLimits: { maxRequestBytes: 32 * 1024 * 1024, images: { maxPerRequest: 100 } } };
const bedrock: ImageLimitSource = { inputLimits: { images: { maxPerMessage: 20 } } };
const tinyRequest: ImageLimitSource = { inputLimits: { images: { maxPerRequest: 2 } } };

describe('resolveImageBudget', () => {
  it('falls back to the cost policy when the model publishes no limits', () => {
    expect(resolveImageBudget(noLimits)).toEqual({ keep: 12, batch: 6 });
  });

  it('keeps the cost policy under the published Anthropic and Bedrock caps', () => {
    expect(resolveImageBudget(anthropic)).toEqual({ keep: 12, batch: 6, maxRequestBytes: 32 * 1024 * 1024 });
    // Bedrock publishes no request-level cap, so its per-message number is the only published ceiling.
    expect(resolveImageBudget(bedrock)).toEqual({ keep: 12, batch: 6 });
  });

  it('follows a published cap below the cost policy, halving it for the batch', () => {
    expect(resolveImageBudget(tinyRequest)).toEqual({ keep: 2, batch: 1 });
    expect(resolveImageBudget({ inputLimits: { images: { maxPerMessage: 4 } } })).toEqual({ keep: 4, batch: 2 });
  });
});

describe('planImagePruning boundaries', () => {
  it('with no model limits, prunes at 13 and in batches of 6', () => {
    for (const total of [1, 6, 12]) expect(planImagePruning(projectedResults(total), noLimits)).toEqual([]);
    expect(prunedImages(projectedResults(13))).toBe(6);
    expect(prunedImages(projectedResults(18))).toBe(6);
    expect(prunedImages(projectedResults(19))).toBe(12);
    expect(prunedImages(projectedResults(24))).toBe(12);
  });

  /**
   * The raised retention window is a policy change, not a formula change. Pinned at the old constant,
   * the planner must reproduce the boundaries 0.86.1 shipped (keep 6, batch 3), or a broken planner
   * would look like a working one that simply prunes less.
   */
  it('pinned at COST_KEEP 6, reproduces the 0.86.1 boundaries', () => {
    for (const total of [1, 6]) expect(planImagePruning(projectedResults(total), undefined, 6)).toEqual([]);
    expect(prunedImages(projectedResults(7), undefined, 6)).toBe(3);
    expect(prunedImages(projectedResults(9), undefined, 6)).toBe(3);
    expect(prunedImages(projectedResults(10), undefined, 6)).toBe(6);
    expect(prunedImages(projectedResults(64), undefined, 6)).toBe(60);
  });

  it('retains at most two and prunes one at a time under images.maxPerRequest 2', () => {
    expect(planImagePruning(projectedResults(2), tinyRequest)).toEqual([]);
    const at3 = projectedResults(3);
    expect(prunedImages(at3, tinyRequest)).toBe(1);
    const at4 = projectedResults(4);
    expect(imageCount(applyEdits(at4, planImagePruning(at4, tinyRequest)))).toBe(2);
  });

  it('prunes the oldest images, leaving the newest intact by value', () => {
    const entries = projectedResults(13);
    const edits = planImagePruning(entries, noLimits);
    expect(edits.map((edit) => edit.targetId)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
    const projected = applyEdits(entries, edits);
    expect((projected[0]!.messages[0] as { content: Block[] }).content[0]).toEqual({ type: 'text', text: PLACEHOLDER });
    expect(projected[6]!.messages[0]).toBe(entries[6]!.messages[0]);
  });

  it('keeps block order and the other blocks of an edited tool result', () => {
    const entries: ProjectedEntryView[] = [
      { sourceEntry: { id: 'multi' }, messages: [screenshotResult('multi', 13, 'keep me')] },
    ];
    const [edit] = planImagePruning(entries, noLimits);
    const content = edit!.content as Block[];
    expect(content.slice(0, 6).every((b) => b.type === 'text' && b.text === PLACEHOLDER)).toBe(true);
    expect(content.slice(6, 13).every((b) => b.type === 'image')).toBe(true);
    expect(content[13]).toEqual({ type: 'text', text: 'keep me' });
  });

  it('never prunes a user attachment, and never counts one toward the image budget', () => {
    const user: ProjectedEntryView = {
      sourceEntry: { id: 'u1' },
      messages: [{ role: 'user', content: [{ type: 'image', data: 'pasted', mimeType: 'image/png' }], timestamp: 0 }],
    };
    const entries = [user, ...projectedResults(12)];
    expect(planImagePruning(entries, noLimits)).toEqual([]);
    const overBudget = [user, ...projectedResults(13)];
    const edits = planImagePruning(overBudget, noLimits);
    expect(edits.some((edit) => edit.targetId === 'u1')).toBe(false);
  });

  it('skips an entry that projects to more than one message, which no single edit can express', () => {
    const pair: ProjectedEntryView = {
      sourceEntry: { id: 'pair' },
      messages: [screenshotResult('a'), screenshotResult('b')],
    };
    expect(planImagePruning([pair, ...projectedResults(12)], noLimits)).toEqual([]);
  });

  it('prunes further batches while the estimated payload exceeds 90% of maxRequestBytes', () => {
    // Each image is 8 base64 characters, so 12 of them plus their text sit far under 32 MiB.
    expect(planImagePruning(projectedResults(12), anthropic)).toEqual([]);
    // 60 KB of images against a 1 KiB cap: no batch count gets under it, and a hard provider limit
    // outranks the cost-policy floor, so every image goes.
    const squeezed = planImagePruning(sizedResults(12, 5_000), {
      inputLimits: { maxRequestBytes: 1024, images: { maxPerRequest: 100 } },
    });
    expect(squeezed).toHaveLength(12);
  });

  it('escalates past the count boundary only as far as the ceiling needs', () => {
    const entries = sizedResults(12, 5_000);
    // 12 images is inside the cost-policy floor, so the count rule alone plans nothing.
    expect(planImagePruning(entries, noLimits)).toEqual([]);
    // 60 KB against a 40 KB cap (36 KB ceiling): one batch of 6 frees ~28.8 KB, which is enough.
    const edits = planImagePruning(entries, { inputLimits: { maxRequestBytes: 40_000, images: { maxPerRequest: 100 } } });
    expect(edits.map((edit) => edit.targetId)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
  });

  it('prunes nothing when a batch would not shrink the payload, rather than escalating to the end', () => {
    // Images shorter than the placeholder: replacing one ADDS bytes, so no escalation can reach the
    // ceiling and pruning the whole session would only make the request bigger.
    const entries = sizedResults(12, 50);
    expect(planImagePruning(entries, { inputLimits: { maxRequestBytes: 100, images: { maxPerRequest: 100 } } })).toEqual([]);
    expect(imageCount(entries)).toBe(12);
  });
});

describe('pruning is monotonic', () => {
  it('re-planning over an already-edited projection restores nothing and plans nothing', () => {
    const entries = projectedResults(13);
    const first = applyEdits(entries, planImagePruning(entries, noLimits));
    expect(imageCount(first)).toBe(7);

    const second = planImagePruning(first, noLimits);
    expect(second).toEqual([]);
    expect(imageCount(applyEdits(first, second))).toBe(7);
  });

  it('a later prune of a partially edited tool result keeps the earlier placeholders', () => {
    const entries: ProjectedEntryView[] = [
      { sourceEntry: { id: 'multi' }, messages: [screenshotResult('multi', 13, 'tail')] },
    ];
    const once = applyEdits(entries, planImagePruning(entries, noLimits));
    // Seven images remain in that one entry; a cap of two forces another pass over the same target.
    const twice = applyEdits(once, planImagePruning(once, tinyRequest));
    const content = (twice[0]!.messages[0] as { content: Block[] }).content;
    expect(content.filter((b) => b.text === PLACEHOLDER)).toHaveLength(11);
    expect(content.filter((b) => b.type === 'image')).toHaveLength(2);
    expect(content[13]).toEqual({ type: 'text', text: 'tail' });
  });
});

/** Record handlers per event, as `fakePi` does elsewhere in this suite. */
function fakePi(): { pi: unknown; handlers: Map<string, (e: unknown, c: unknown) => unknown> } {
  const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
  return { pi: { on: (event: string, handler: (e: unknown, c: unknown) => unknown) => handlers.set(event, handler) }, handlers };
}

function turnEndEvent(entries: unknown[], contextEntries: ProjectedEntryView[]): unknown {
  return {
    type: 'turn_end',
    entries,
    continue: false,
    context: { contextEntries, contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
    outcome: 'completed',
    turnIndex: 0,
    toolResults: [],
    messageEntryId: 'a1',
    toolResultEntryIds: [],
  };
}

describe('the turn_end registration', () => {
  const checkpointDraft = { type: 'custom', customType: 'damocles-checkpoint', data: { turn: 1 } };

  it('appends its drafts after the drafts earlier handlers produced', async () => {
    const { pi, handlers } = fakePi();
    registerTurnEndImagePruning(pi as never);

    const result = (await handlers.get('turn_end')!(turnEndEvent([checkpointDraft], projectedResults(13)), {})) as {
      entries: Array<{ type: string; targetId?: string }>;
      continue?: boolean;
    };

    expect(result.entries[0]).toBe(checkpointDraft);
    expect(result.entries.slice(1).map((e) => e.type)).toEqual(Array(6).fill('context_edit'));
    expect(result.entries.slice(1).map((e) => e.targetId)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
    // Setting `continue` would force an extra provider request out of a boundary that only edits history.
    expect(result.continue).toBeUndefined();
  });

  it('drafts carry the constant placeholder as content, never a null replacement', async () => {
    const { pi, handlers } = fakePi();
    registerTurnEndImagePruning(pi as never);

    const result = (await handlers.get('turn_end')!(turnEndEvent([], projectedResults(13)), {})) as {
      entries: Array<{ replacement: { content: Block[] } | null }>;
    };

    for (const draft of result.entries) {
      expect(draft.replacement).not.toBeNull();
      expect(draft.replacement!.content[0]).toEqual({ type: 'text', text: PLACEHOLDER });
    }
  });

  it('returns undefined when nothing is over budget, leaving the accumulator alone', async () => {
    const { pi, handlers } = fakePi();
    registerTurnEndImagePruning(pi as never);
    expect(await handlers.get('turn_end')!(turnEndEvent([checkpointDraft], projectedResults(12)), {})).toBeUndefined();
  });

  it('prunes a turn that made many parallel screenshot calls', async () => {
    const { pi, handlers } = fakePi();
    registerTurnEndImagePruning(pi as never);

    // One assistant turn, thirty parallel browser calls, all thirty results in this boundary.
    const result = (await handlers.get('turn_end')!(turnEndEvent([], projectedResults(30)), {})) as {
      entries: Array<{ targetId: string }>;
    };

    expect(result.entries).toHaveLength(18);
    expect(imageCount(applyEdits(projectedResults(30), planImagePruning(projectedResults(30), noLimits)))).toBe(12);
  });

  it('reads the model limits off the event context', async () => {
    const { pi, handlers } = fakePi();
    registerTurnEndImagePruning(pi as never);

    const result = (await handlers.get('turn_end')!(turnEndEvent([], projectedResults(3)), { model: tinyRequest })) as {
      entries: Array<{ targetId: string }>;
    };

    expect(result.entries.map((e) => e.targetId)).toEqual(['t0']);
  });

  it('fails soft on a planner throw and leaves the other handlers\u2019 drafts committed', async () => {
    const { pi, handlers } = fakePi();
    registerTurnEndImagePruning(pi as never);

    // A projected entry with no `messages` array is what a planner bug looks like from here.
    const broken = [{ sourceEntry: { id: 'x' } }] as unknown as ProjectedEntryView[];
    let entries: unknown[] = [checkpointDraft];
    const handlerResult = (await handlers.get('turn_end')!(turnEndEvent(entries, broken), {})) as
      | { entries: unknown[] }
      | undefined;
    // pi keeps its accumulator when a handler returns undefined (runner.ts emitBoundary).
    if (handlerResult?.entries !== undefined) entries = handlerResult.entries;

    expect(handlerResult).toBeUndefined();
    expect(entries).toEqual([checkpointDraft]);
  });
});

describe('the before_agent_start reconcile', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A session file holding `count` screenshot tool results and no context edits. */
  function legacySession(count: number): SessionManager {
    const dir = mkdtempSync(join(tmpdir(), 'damocles-prune-'));
    tmpDirs.push(dir);
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'browse' }], timestamp: 0 } as never);
    // pi holds the file back until an assistant message lands, so the session file needs a real one.
    manager.appendMessage({
      role: 'assistant',
      content: Array.from({ length: count }, (_, i) => ({ type: 'toolCall', id: `call-${i}`, name: 'BrowserScreenshot', arguments: {} })),
      api: 'anthropic',
      provider: 'anthropic',
      model: 'claude-fable-5-1',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      stopReason: 'toolUse',
      timestamp: 0,
    } as never);
    for (let i = 0; i < count; i++) manager.appendMessage(screenshotResult(`call-${i}`) as never);
    return manager;
  }

  function ctxFor(manager: SessionManager, model?: ImageLimitSource): unknown {
    return { sessionManager: manager, model };
  }

  function contextEdits(manager: SessionManager): SessionEntry[] {
    return manager.getEntries().filter((entry) => entry.type === 'context_edit');
  }

  it('appends the missing edits for a session recorded before pruning existed', () => {
    const manager = legacySession(20);
    const { pi, handlers } = fakePi();
    registerAgentStartImageReconcile(pi as never);

    handlers.get('before_agent_start')!({ type: 'before_agent_start', prompt: 'go' }, ctxFor(manager));

    expect(contextEdits(manager)).toHaveLength(12);
    const projected = manager.buildSessionProjection().messages;
    const images = projected.flatMap((m) => ((m as { content?: Block[] }).content ?? []).filter((b) => b.type === 'image'));
    expect(images).toHaveLength(8);
  });

  it('appends nothing on a second run over unchanged history', () => {
    const manager = legacySession(20);
    const { pi, handlers } = fakePi();
    registerAgentStartImageReconcile(pi as never);
    const run = (): void => {
      handlers.get('before_agent_start')!({ type: 'before_agent_start', prompt: 'go' }, ctxFor(manager));
    };

    run();
    const afterFirst = contextEdits(manager).length;
    run();

    expect(contextEdits(manager)).toHaveLength(afterFirst);
  });

  it('persists the placeholder to the session file and keeps the tool result addressable', () => {
    const manager = legacySession(13);
    const { pi, handlers } = fakePi();
    registerAgentStartImageReconcile(pi as never);

    handlers.get('before_agent_start')!({ type: 'before_agent_start', prompt: 'go' }, ctxFor(manager));

    const lines = readFileSync(manager.getSessionFile()!, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const edits = lines.filter((entry: { type: string }) => entry.type === 'context_edit');
    expect(edits).toHaveLength(6);
    expect(edits[0].replacement.content[0]).toEqual({ type: 'text', text: PLACEHOLDER });

    // The edit replaces content only: an unpaired tool result is rejected by the provider.
    const projected = manager.buildSessionProjection().messages;
    const pruned = projected.find((m) => (m as { toolCallId?: string }).toolCallId === 'call-0') as {
      role: string;
      toolCallId: string;
      content: Block[];
    };
    expect(pruned.role).toBe('toolResult');
    expect(pruned.toolCallId).toBe('call-0');
    expect(pruned.content[0]).toEqual({ type: 'text', text: PLACEHOLDER });
  });

  it('two runs with no new screenshots project byte-identical context', () => {
    const manager = legacySession(20);
    const { pi, handlers } = fakePi();
    registerAgentStartImageReconcile(pi as never);
    const run = (): void => {
      handlers.get('before_agent_start')!({ type: 'before_agent_start', prompt: 'go' }, ctxFor(manager));
    };

    run();
    const first = JSON.stringify(manager.buildSessionProjection().messages);
    run();
    const second = JSON.stringify(manager.buildSessionProjection().messages);

    expect(second).toBe(first);
  });

  it('fails soft when the session manager exposes no append seam', () => {
    const { pi, handlers } = fakePi();
    registerAgentStartImageReconcile(pi as never);
    const readOnly = { buildSessionProjection: vi.fn() };

    expect(handlers.get('before_agent_start')!({ type: 'before_agent_start', prompt: 'go' }, { sessionManager: readOnly })).toBeUndefined();
    expect(readOnly.buildSessionProjection).not.toHaveBeenCalled();
  });

  it('fails soft on a throw, leaving the run unpruned', () => {
    const { pi, handlers } = fakePi();
    registerAgentStartImageReconcile(pi as never);
    const broken = {
      appendContextEdit: vi.fn(),
      buildSessionProjection: () => {
        throw new Error('projection unavailable');
      },
    };

    expect(handlers.get('before_agent_start')!({ type: 'before_agent_start', prompt: 'go' }, { sessionManager: broken })).toBeUndefined();
    expect(broken.appendContextEdit).not.toHaveBeenCalled();
  });
});
