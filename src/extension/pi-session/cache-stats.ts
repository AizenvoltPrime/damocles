// Ported from pi-coding-agent core/cache-stats.ts @0.80.10 — not exported upstream; keep in sync on pi
// upgrades. Damocles ports ONLY the live-notice detection path (detectCacheMiss + its helpers).
// pi's collectCacheMisses/computeCacheWaste (resume re-derivation, cumulative-waste totals) are
// deliberately NOT ported: Damocles cache-miss notices are ephemeral (live-run only), so there is no
// resume rebuild or /waste consumer to serve. Re-port them from pi if that changes.
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { CACHE_TTL_MS } from '../../shared/types/constants';

// Prompt-cache TTL lives in shared constants (single source of truth with the webview notice).
// Re-exported here so this module's existing consumers/tests keep importing it from cache-stats.
export { CACHE_TTL_MS };

/** Per-turn misses at or below this are cache breakpoint granularity noise. */
export const NOISE_FLOOR_TOKENS: number = 1024;

/**
 * Display gate mirroring pi's TUI (`addCacheMissNotice`): a detected miss is worth surfacing only when
 * it is materially large. pi suppresses a miss that is under BOTH 20k tokens AND $0.10, so a notice
 * shows when EITHER threshold is met. This keeps notices rare and meaningful rather than firing on
 * every miss above the 1024-token detection floor.
 */
const DISPLAY_MIN_TOKENS = 20_000;
const DISPLAY_MIN_COST = 0.1;

/** Whether a detected miss clears pi's display threshold and is worth showing as a transcript notice. */
export function isCacheMissSignificant(miss: CacheMiss): boolean {
	return miss.missedTokens >= DISPLAY_MIN_TOKENS || miss.missedCost >= DISPLAY_MIN_COST;
}

/** A counted cache miss on a single assistant message. */
export interface CacheMiss {
	/** Prompt tokens that were in the previous turn's prompt but not read from cache. */
	missedTokens: number;
	/** Extra dollars paid vs. a full cache hit; 0 when pricing is unknown. */
	missedCost: number;
	/** Milliseconds since the previous request (which last refreshed the cache). */
	idleMs: number;
	/** True when the model changed relative to the previous request. */
	modelChanged: boolean;
}

/** Minimal pricing lookup, satisfied by ModelRuntime. Cost is $/million tokens. */
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

interface PreviousRequest {
	promptTokens: number;
	modelKey: string;
	timestamp: number;
	/** Sticky: some earlier request in this scan segment reported cache activity. */
	reportedCache: boolean;
}

/**
 * Compute the cache miss for one assistant message relative to the previous
 * request. Returns undefined when nothing is counted: first turn, after a
 * reset, no cache activity ever reported (provider without cache support), or
 * miss below the noise floor.
 */
function detectMiss(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// A zero-cache turn only counts when cache activity was reported before:
	// on cache-read-only providers that is a total miss, while on providers
	// that never report caching it means nothing.
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
		return undefined;
	}
	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;
	// Extra cost = missed tokens billed at the actual paid rate (input/cacheWrite,
	// incl. write premium) instead of the cache-read rate. Missed tokens can only
	// land in the input or cacheWrite buckets, so the paid rate comes straight
	// from this message's own cost breakdown.
	const paidTokens = usage.input + usage.cacheWrite;
	const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	const readPerToken =
		usage.cacheRead > 0
			? usage.cost.cacheRead / usage.cacheRead
			: (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;
	return {
		missedTokens,
		missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
		idleMs: Math.max(0, message.timestamp - prev.timestamp),
		modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
	};
}

function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return {
		promptTokens,
		modelKey: `${message.provider}/${message.model}`,
		timestamp: message.timestamp,
		reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
	};
}

/**
 * Walk the session entries to find the LAST request state before the just-completed message — the
 * baseline the next turn's prompt should have been cached against. Baseline resets on
 * compaction/branch_summary (the following prompt is new content, not re-billed content); a model
 * switch is NOT exempt (it re-bills the full prompt and should be counted).
 */
function lastRequestBefore(entries: SessionEntry[]): PreviousRequest | undefined {
	let prev: PreviousRequest | undefined;
	for (const entry of entries) {
		if (entry.type === 'compaction' || entry.type === 'branch_summary') {
			prev = undefined;
			continue;
		}
		if (entry.type === 'message' && entry.message.role === 'assistant') {
			prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
		}
	}
	return prev;
}

/**
 * Detect a cache miss on a just-completed assistant message.
 * `entries` must not yet contain `message` (message_end fires before persistence).
 */
export function detectCacheMiss(
	entries: SessionEntry[],
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	return detectMiss(lastRequestBefore(entries), message, models);
}
