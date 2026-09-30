/**
 * Stale browser screenshots leave model context as append-only `context_edit` entries, planned here
 * and established at two seams: once per agent run, and at every turn boundary. The invariant those
 * two keep is that a session's context edits are always current, so nothing is recomputed per request
 * and the model-visible bytes cannot drift from the persisted record.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ContextEditableContent, ContextEditEntryDraft, SessionManager } from '@earendil-works/pi-coding-agent';
import { log } from '../logger';

/**
 * Damocles' own cost policy for retained tool-result screenshots, not a provider limit. Retained
 * images sit inside the cached prefix, so the recurring cost is the cache-read rate and the binding
 * constraint is context-window occupancy: a 1950px screenshot is roughly 2k input tokens after
 * Anthropic's 1568px long-edge normalization, so twelve is about a tenth of a 200k window.
 */
const COST_KEEP = 12;

/**
 * The estimate is directionally right, not exact, so leave headroom under the published byte cap: it
 * excludes provider JSON framing, counts only image and text blocks (toolCall arguments, thinking and
 * document blocks count as nothing) and skips a message whose content is a string rather than an
 * array, which includes the compaction summary.
 */
const BYTE_CEILING_FRACTION = 0.9;

// Constant placeholder — MUST be byte-identical for every pruned image. Together with batching, that
// holds the projected history byte-stable between prune events, so Anthropic's prompt-cache prefix
// survives instead of being invalidated on every turn.
const PLACEHOLDER =
  '[Image removed: an older screenshot was pruned to keep the request within provider size limits. Capture a fresh screenshot (BrowserScreenshot) or re-read the file if this content is still needed.]';

/** The part of `ProjectedSessionEntry` the planner reads. */
export interface ProjectedEntryView {
  sourceEntry: { id: string };
  messages: readonly AgentMessage[];
}

/** The part of a pi `Model` the planner reads. */
export interface ImageLimitSource {
  inputLimits?: {
    maxRequestBytes?: number;
    images?: { maxPerRequest?: number; maxPerMessage?: number };
  };
}

/** One tool-result entry that must lose images, with the content its context edit will carry. */
export interface ImagePruneEdit {
  targetId: string;
  content: ContextEditableContent;
}

/** How many tool-result images may stay, and how many leave per prune event. */
export interface ImageBudget {
  keep: number;
  batch: number;
  maxRequestBytes?: number;
}

/**
 * Resolve the retention budget from the active model's published limits.
 *
 * `maxPerMessage` participates because Bedrock publishes no request-level cap, so its per-message
 * number is the only published ceiling. Halving `keep` for the batch is what scales the batching rule
 * when a provider cap binds: at `keep` 6 it reproduces the batch of 3 Damocles shipped before the
 * limits were published.
 */
export function resolveImageBudget(model: ImageLimitSource | undefined, costKeep: number = COST_KEEP): ImageBudget {
  const images = model?.inputLimits?.images;
  const keep = Math.max(1, Math.min(costKeep, images?.maxPerRequest ?? Infinity, images?.maxPerMessage ?? Infinity));
  const maxRequestBytes = model?.inputLimits?.maxRequestBytes;
  return { keep, batch: Math.max(1, Math.floor(keep / 2)), ...(maxRequestBytes ? { maxRequestBytes } : {}) };
}

/** One image block that a context edit could replace, in oldest-first order. */
interface ImageSite {
  entryIndex: number;
  blockIndex: number;
  bytes: number;
  targetId: string;
  toolResult: ToolResult;
}

function blockBytes(block: { type: string; text?: string; data?: string }): number {
  if (block.type === 'image') return block.data?.length ?? 0;
  if (block.type === 'text') return block.text?.length ?? 0;
  return 0;
}

type ToolResult = Extract<AgentMessage, { role: 'toolResult' }>;

/**
 * The single tool-result message an entry projects to, or undefined when the entry is not one this
 * planner may edit. A context edit replaces an entry's whole content, so an entry projecting to
 * several messages cannot express a per-message replacement.
 */
function editableToolResult(entry: ProjectedEntryView): ToolResult | undefined {
  if (entry.messages.length !== 1) return undefined;
  const message = entry.messages[0];
  if (!message || message.role !== 'toolResult' || !Array.isArray(message.content)) return undefined;
  return message;
}

/**
 * Decide which tool-result screenshots must leave model context, and return one replacement content
 * per entry that loses images.
 *
 * Counts the PROJECTED entries, where an already-edited entry shows the placeholder rather than its
 * image, so each run plans only what is newly over budget. Edits are append-only and never revised,
 * which makes pruning monotonic: a pruned image is never restored.
 *
 * User-attached images are deliberately exempt — they are intentional content the model may still
 * need — so they count toward the byte estimate but are never replaced.
 *
 * A pruned image also stays pruned across compaction: an edit is appended after its target, and
 * compaction retains a suffix, so a retained target keeps its edit.
 */
export function planImagePruning(
  entries: readonly ProjectedEntryView[],
  model?: ImageLimitSource,
  costKeep: number = COST_KEEP,
): ImagePruneEdit[] {
  const { keep, batch, maxRequestBytes } = resolveImageBudget(model, costKeep);

  const sites: ImageSite[] = [];
  let totalBytes = 0;
  entries.forEach((entry, entryIndex) => {
    for (const message of entry.messages) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) totalBytes += blockBytes(block as { type: string; text?: string; data?: string });
    }
    const toolResult = editableToolResult(entry);
    if (!toolResult) return;
    toolResult.content.forEach((block, blockIndex) => {
      if (block.type === 'image')
        sites.push({ entryIndex, blockIndex, bytes: block.data?.length ?? 0, targetId: entry.sourceEntry.id, toolResult });
    });
  });

  let boundary = Math.max(0, Math.ceil((sites.length - keep) / batch) * batch);
  if (maxRequestBytes) {
    const ceiling = maxRequestBytes * BYTE_CEILING_FRACTION;
    let freed = sites.slice(0, boundary).reduce((sum, site) => sum + site.bytes - PLACEHOLDER.length, 0);
    while (totalBytes - freed > ceiling && boundary < sites.length) {
      const next = Math.min(sites.length, boundary + batch);
      const gain = sites.slice(boundary, next).reduce((sum, site) => sum + site.bytes - PLACEHOLDER.length, 0);
      // Images shorter than the placeholder grow the payload, so escalating further cannot help.
      // Reachable only through a user-defined maxRequestBytes (`dist/core/model-config.js:130` allows 1).
      if (gain <= 0) break;
      freed += gain;
      boundary = next;
    }
  }
  if (boundary === 0) return [];

  interface PrunedEntry {
    targetId: string;
    toolResult: ToolResult;
    blocks: Set<number>;
  }
  const prunedEntries = new Map<number, PrunedEntry>();
  for (const site of sites.slice(0, boundary)) {
    const pruned = prunedEntries.get(site.entryIndex);
    if (pruned) pruned.blocks.add(site.blockIndex);
    else
      prunedEntries.set(site.entryIndex, {
        targetId: site.targetId,
        toolResult: site.toolResult,
        blocks: new Set([site.blockIndex]),
      });
  }

  return [...prunedEntries.values()].map(({ targetId, toolResult, blocks }) => ({
    targetId,
    // Block order is preserved: a placeholder sits where its image sat, or the cached prefix shifts.
    content: toolResult.content.map((block, blockIndex) =>
      blocks.has(blockIndex) ? { type: 'text' as const, text: PLACEHOLDER } : block,
    ),
  }));
}

function toDraft(edit: ImagePruneEdit): ContextEditEntryDraft {
  return { type: 'context_edit', targetId: edit.targetId, replacement: { content: edit.content } };
}

/**
 * Prune stale screenshots at every turn boundary, as append-only `context_edit` drafts.
 *
 * `turn_end` fires after every tool batch and before the next assistant request, so every point at
 * which a screenshot enters history is followed by this boundary before those bytes can be sent.
 *
 * Registered from every factory and routed by nothing: subagent, team and btw sessions have no panel
 * entry, and a panel-routed registration would leave them unpruned.
 */
export function registerTurnEndImagePruning(pi: ExtensionAPI): void {
  pi.on('turn_end', (event, ctx) => {
    try {
      const edits = planImagePruning(event.context.contextEntries, ctx.model);
      if (edits.length === 0) return undefined;
      log('[ContextPrune] pruning stale screenshots from %d tool results at turn end', edits.length);
      // Spread: pi replaces the draft accumulator with whatever this returns, so a bare list would
      // discard every earlier handler's drafts. Never sets `continue`, which would force a request.
      return { entries: [...event.entries, ...edits.map(toDraft)] };
    } catch (err) {
      log('[ContextPrune] turn_end pruning failed, proceeding unpruned: %O', err);
      return undefined;
    }
  });
}

/** The append seam pi types off `ExtensionContext` but hands over at runtime. */
type ContextEditAppender = Pick<SessionManager, 'appendContextEdit'>;

/**
 * Bring a session's context edits up to date once per agent run, covering resume, fork, branch
 * navigation and sessions recorded before pruning existed. Without it such a session sends one
 * oversized request before its first `turn_end` can correct it.
 *
 * Idempotent by construction: the planner reads the projection, where an already-edited entry shows
 * no image, so a run over unchanged history plans nothing and appends nothing.
 *
 * Separate from the panel-routed `before_agent_start` handler in `damocles-extension.ts`, which
 * returns early when no panel is registered.
 */
export function registerAgentStartImageReconcile(pi: ExtensionAPI): void {
  pi.on('before_agent_start', (_event, ctx) => {
    try {
      // `ExtensionContext` types this as a ReadonlySessionManager, but the runtime object is the full
      // SessionManager, and pi publishes no other way to append an edit outside a boundary. Every
      // provider request reads its messages from the session projection (pi's `prepareRequest`
      // override), so an edit appended here is visible to this run's first request.
      const appender = ctx.sessionManager as Partial<ContextEditAppender>;
      if (typeof appender.appendContextEdit !== 'function') return undefined;
      const edits = planImagePruning(ctx.sessionManager.buildSessionProjection().entries, ctx.model);
      let appended = 0;
      for (const edit of edits) {
        // Per edit: appends already committed cannot be undone, so one rejected target must not
        // abandon the rest and report the whole run as unpruned.
        try {
          appender.appendContextEdit(edit.targetId, { content: edit.content });
          appended++;
        } catch (err) {
          log('[ContextPrune] skipping context edit for %s: %O', edit.targetId, err);
        }
      }
      if (appended > 0) log('[ContextPrune] reconciled %d tool results at agent start', appended);
    } catch (err) {
      log('[ContextPrune] agent-start reconcile failed, proceeding unpruned: %O', err);
    }
    return undefined;
  });
}
