# Compaction and prompt caching

This page covers manual and automatic context compaction, per-model compaction budgets, how compactions are reported, and prompt cache warming.

## Manual compaction (`/compact`)

Summarize the conversation on demand to reclaim context, optionally focusing the summary with an instruction (`/compact <instructions>`). It is gated to idle: finish or stop the current turn first. The compaction boundary and restored context surface inline in the chat.

## Auto-compact

Automatic context compaction is optional (`damocles.autoCompact`; opt-in, disabled by default). It triggers a compaction once context usage crosses `triggerPercent` of the window to prevent overflow. It applies uniformly to every provider: GPT sessions compact only when you enable it, the same as Anthropic.

## Per-model compaction budgets

`damocles.autoCompact.modelOverrides` gives one model its own budget, keyed by the model value the picker uses (for example `claude-opus-5-5`) and applied only while that model is active. An entry may set `triggerPercent` (50-95), `keepRecentPercent` (1-50), or both; omitted values fall back to `damocles.autoCompact.triggerPercent` and to pi's own default respectively. Out-of-range and non-numeric values are clamped rather than passed through.

## Compaction transparency

The transcript says what a compaction did. A boundary card names the trigger (manual, threshold, or overflow) and, with `damocles.showCacheMissNotices` on, what the compaction itself billed. A compaction that aborted or failed leaves a card saying so and whether a retry is coming, instead of clearing its banner in silence.

To recover the context a compaction summarized, see [Rewind to before compaction](checkpoints.md#rewind-to-before-compaction).

## Prompt cache warming

Shortly before the provider drops the cached prompt, Damocles re-sends the last request with a one-token output budget, so the next real request is a cache read instead of a full rebuild. It only fires when the expected saving clears pi's threshold, which small contexts and cheap models often miss.

A warm request bills as a cache read of the full context plus one output token, never enters the conversation, adds no turn to the turn count, and counts in the conversation's total cost and in `/stats` under Cache warming.

`damocles.cacheWarming` picks the mode:

- `streaming` (the default) warms only while a run is in flight.
- `idle` also warms for up to 30 minutes after the last request.
- `off` lets the cache expire.

Warming stops when the panel closes or the session's budget cap fires, because it bills against that same cap. The setting is application-scoped, so it lives in user settings and a repository cannot turn it on from `.vscode/settings.json`.
