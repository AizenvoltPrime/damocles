import { log } from "../logger";
import type { ContentInput, StreamingInputController } from "./types";
import { loadSdkStartup } from "../shared/sdk-loader";

export type SdkUserMessage = {
  type: "user";
  message: { role: "user"; content: ContentInput };
  parent_tool_use_id: null;
};

export type WarmQuery = Awaited<ReturnType<NonNullable<ReturnType<typeof loadSdkStartup>>>>;

export interface WarmupStreamState {
  inputStream: AsyncGenerator<SdkUserMessage, void, unknown>;
  controller: StreamingInputController;
}

export interface WarmupInputs {
  model: string;
  configuredModel: string;
  ephemeral: boolean;
  fastMode: boolean;
  ultracode: boolean;
  resumeSessionId: string | null;
  resumeSessionAt: string | null;
  mcpServerNamesHash: string;
  providerEnvHash: string;
  chromeEnabled: boolean;
  maxTurns: number;
  thinkingSignature: string;
  sandboxSignature: string;
  debugSignature: string;
  pluginsSignature: string;
  enableFileCheckpointing: boolean;
  agentProgressSummaries: boolean;
  /**
   * Backend signature: `"anthropic"`, or `openai:<authMode>:<bridgeUrl>:<bridgeBearer>` for
   * OpenAI-backed models. Including the URL + bearer guarantees that a bridge port-rotation
   * (after `dispose()`) or auth-mode flip (Prefer API key toggle) invalidates the warmed
   * subprocess — its env was sealed against the previous endpoint and would 401 on first use.
   */
  backendSignature: string;
}

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${entries.join(',')}}`;
}

export function diffWarmupInputs(a: WarmupInputs, b: WarmupInputs): string[] {
  const keys: Array<keyof WarmupInputs> = [
    'model', 'configuredModel', 'ephemeral', 'fastMode', 'ultracode',
    'resumeSessionId', 'resumeSessionAt',
    'mcpServerNamesHash', 'providerEnvHash', 'chromeEnabled',
    'maxTurns', 'thinkingSignature', 'sandboxSignature', 'debugSignature',
    'pluginsSignature', 'enableFileCheckpointing', 'agentProgressSummaries',
    'backendSignature',
  ];
  const diffs: string[] = [];
  for (const k of keys) {
    if (a[k] !== b[k]) {
      diffs.push(`${k}: warm=${JSON.stringify(a[k])} now=${JSON.stringify(b[k])}`);
    }
  }
  return diffs;
}

export function createStreamingInput(): WarmupStreamState {
  let resolveNext: ((content: ContentInput | null) => void) | null = null;

  async function* inputStream(): AsyncGenerator<SdkUserMessage, void, unknown> {
    while (true) {
      const content = await new Promise<ContentInput | null>((resolve) => {
        resolveNext = resolve;
      });
      if (content === null) break;
      yield {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
      };
    }
  }

  const controller: StreamingInputController = {
    sendMessage: (content: ContentInput) => {
      if (resolveNext) resolveNext(content);
    },
    close: () => {
      if (resolveNext) resolveNext(null);
    },
  };

  return { inputStream: inputStream(), controller };
}

type BuiltOptions = {
  queryOptions: Record<string, unknown>;
  inputs: WarmupInputs;
  model: string;
  configuredModel: string;
};

/**
 * Pre-spawned warm warmQuery consumed by the first user send. Holds the subprocess
 * handle, its AbortController, and the input stream bound to the warmup options.
 * On consumption, ownership of the AbortController + stream transfers to the caller
 * and `consume()` clears all internal state. Unused warms are released via
 * `dispose()`, which closes the SDK warmQuery and aborts its controller.
 */
export class QueryWarmupManager {
  private _warm: WarmQuery | null = null;
  private _inputs: WarmupInputs | null = null;
  private _abortController: AbortController | null = null;
  private _stream: WarmupStreamState | null = null;
  private _inFlight: Promise<void> | null = null;
  private _readyAt: number | null = null;
  private _generation = 0;

  get inFlight(): Promise<void> | null {
    return this._inFlight;
  }

  get hasWarm(): boolean {
    return this._warm !== null;
  }

  /**
   * Start a background warmup. Returns a promise that resolves when the SDK subprocess
   * is ready (or has failed — failures are logged and cleared internally).
   *
   * Concurrency: rapid `start()` calls (e.g., model + betas change in quick succession)
   * each increment the generation counter; in-flight IIFEs that lose the race never write
   * to shared state and close their locally-owned resources. This guarantees the newest
   * attempt's state is never clobbered by a superseded attempt's completion or catch path.
   */
  start(
    build: (abortController: AbortController) => BuiltOptions | null,
    onBuilt: (model: string, configuredModel: string) => void,
  ): Promise<void> {
    const startupFn = loadSdkStartup();
    if (!startupFn) {
      log('[Warmup] SKIP — SDK startup() unavailable; first prompt will cold-start');
      return Promise.resolve();
    }

    this.dispose('replaced-by-new-start');

    const myGeneration = ++this._generation;
    const startedAt = Date.now();
    const abortController = new AbortController();
    const stream = createStreamingInput();

    this._abortController = abortController;
    this._stream = stream;

    const self = this;
    const isCurrent = () => self._generation === myGeneration;
    const holder: { promise: Promise<void> | null } = { promise: null };
    holder.promise = (async function runWarmup() {
      let localWarm: WarmQuery | null = null;
      try {
        const built = build(abortController);
        if (!built) {
          if (isCurrent()) log('[Warmup] ABORT — build returned null');
          return;
        }
        if (!isCurrent()) return;

        self._inputs = built.inputs;
        onBuilt(built.model, built.configuredModel);

        log('[Warmup] ACTIVE — spawning Claude Code subprocess (model=%s)', built.model);
        const typedOptions = built.queryOptions as Parameters<typeof startupFn>[0] extends { options?: infer O } ? O : never;
        localWarm = await startupFn({ options: typedOptions, initializeTimeoutMs: 15000 });

        if (!isCurrent()) {
          try { localWarm.close(); } catch { /* benign */ }
          return;
        }

        self._warm = localWarm;
        self._readyAt = Date.now();
        const elapsed = self._readyAt - startedAt;
        log('[Warmup] READY in %dms — first prompt will skip cold-start', elapsed);
      } catch (err) {
        if (isCurrent()) {
          log('[Warmup] FAILED — first prompt will cold-start: %O', err);
        }
      } finally {
        if (self._inFlight === holder.promise) {
          self._inFlight = null;
        }
      }
    })();

    this._inFlight = holder.promise;
    holder.promise.catch(() => { /* errors handled inside IIFE */ });
    return holder.promise;
  }

  /**
   * Attempt to consume the warm. Returns the transferred resources when `currentInputs`
   * match the warmup's recorded inputs and a warm is available; otherwise returns null.
   * On success, the manager clears its state — the caller owns the returned handles.
   */
  consume(currentInputs: WarmupInputs): {
    warm: WarmQuery;
    abortController: AbortController;
    stream: WarmupStreamState;
  } | null {
    if (!this._warm || !this._inputs || !this._abortController || !this._stream) return null;
    const diffs = diffWarmupInputs(this._inputs, currentInputs);
    if (diffs.length > 0) {
      log('[Warmup] fingerprint diff — %s', diffs.join('; '));
      return null;
    }

    const handle = {
      warm: this._warm,
      abortController: this._abortController,
      stream: this._stream,
    };
    this._warm = null;
    this._inputs = null;
    this._abortController = null;
    this._stream = null;
    this._inFlight = null;
    const warmAge = this._readyAt ? (Date.now() - this._readyAt) : 0;
    this._readyAt = null;
    log('[Warmup] HIT — first prompt consumed warm subprocess (idle %dms)', warmAge);
    return handle;
  }

  /**
   * Tear down any pending or completed warm. Idempotent. Bumping the generation
   * invalidates any in-flight IIFE that is still awaiting subprocess spawn, so late
   * completions cannot revive stale state.
   */
  dispose(reason?: string): void {
    const had = !!this._warm || !!this._inputs || !!this._abortController || !!this._stream || !!this._inFlight;
    this._generation++;
    if (this._warm) {
      try { this._warm.close(); } catch (err) { log('[Warmup] close error:', err); }
    }
    if (this._abortController) {
      try { this._abortController.abort(); } catch { /* benign */ }
    }
    if (this._stream) {
      try { this._stream.controller.close(); } catch { /* benign */ }
    }
    this._warm = null;
    this._inputs = null;
    this._abortController = null;
    this._stream = null;
    this._inFlight = null;
    this._readyAt = null;
    if (had) log('[Warmup] DISPOSED — warm subprocess released (reason=%s)', reason ?? 'unspecified');
  }
}
