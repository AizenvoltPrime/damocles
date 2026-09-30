import { randomBytes } from 'node:crypto';

/**
 * A fresh, unattributable name per launch, used for the binding, for the DOM channel the two worlds
 * talk over, and for the once-guard registry key. Held only as a local in `installContextObservers` —
 * nothing stores, logs or persists it, so a page that enumerates its own globals or listeners finds a
 * name that says nothing about us (the previous fixed `__damocles*` names were a uniquely attributable
 * automation fingerprint).
 *
 * EACH USE GETS ITS OWN INDEPENDENT VALUE. Deriving one name from another means anything the page can
 * recover leaks the rest: the once-guard markers were `<channel>_console` / `_title` / `_cursor`, so
 * reading them handed the page the channel AND named our three observers. Independent values make
 * every name a dead end.
 */
export function createBindingName(): string {
  return `__${randomBytes(8).toString('hex')}`;
}

/**
 * WHY THESE SCRIPTS SPAN TWO WORLDS — the constraint that dictates the whole design.
 *
 * Playwright's `exposeBinding` function is only ever present in its ISOLATED world. Verified against
 * patchright-core 1.61.1 in real Chrome: the main world holds the binding names only on the initial
 * about:blank, and `[]` on every document after the first navigation, while the isolated world holds
 * them at every point and across navigations.
 *
 * The cause is structural, not a bug we can wait out. `FrameSession._initBinding`
 * (`coreBundle.js:39070`) evaluates the binding wrapper only into contexts in `_contextIdToContext`,
 * and that map is filled exclusively by `_onExecutionContextCreated` (`:38653`) — driven by
 * `Runtime.executionContextCreated`, which Chromium only emits under `Runtime.enable`. Patchright
 * removes `Runtime.enable` (that is its entire point), so for the main world the map stays empty and
 * the wrapper is never installed. `addPageBinding` (`:20207`) has zero call sites in the bundle.
 *
 * Two alternatives were measured and rejected:
 *  - a raw `Runtime.addBinding` on our own session still yields no main-world global, for the same
 *    reason (no execution-context reporting to re-arm it per document);
 *  - the tagged `console.debug` channel Playwright ships for WebKit WebView (`:50852`) needs
 *    `Runtime.consoleAPICalled`, which is likewise never delivered without `Runtime.enable`.
 *
 * So the observers must run where the page is (main world) and the binding call must happen where the
 * binding is (isolated world). They are bridged over the one thing both worlds genuinely share: the
 * DOM. The main world dispatches a `CustomEvent` on `document`; an isolated-world listener forwards
 * its detail to the binding. This is the same split browser extensions use between a page script and
 * a content script, and it needs no new CDP method — `Runtime.enable` is still never sent.
 */

/**
 * Wrap a main-world init script so it runs AT MOST ONCE per document.
 *
 * PATCHRIGHT EXECUTES EVERY `context.addInitScript` TWICE PER DOCUMENT. Measured, not inferred: a
 * single init script incrementing a counter reports `2` on the first document, on every subsequent
 * navigation, and on pages created after registration. The cause is two independent registration
 * paths that both fire for the same script — `CRBrowserContext.doAddInitScript`
 * (`coreBundle.js:39655`) hands the script to `CRPage.addInitScript`, which registers it AND pushes
 * it onto `page.initScripts` (`:38219`); `FrameSession._initSession` then iterates BOTH
 * `browserContext.initScripts` and `page.initScripts` (`:38498-38499`), registering it a second time.
 *
 * Without this guard each script installs twice, giving two console wrappers with SEPARATE closure
 * state — so every entry was reported twice, and the re-entrancy guard protected only one instance.
 *
 * THE MARKER IS A `Symbol`, NOT A NAMED GLOBAL. A string key on `globalThis` is discoverable through
 * `Object.getOwnPropertyNames` no matter how it is defined — `enumerable: false` hides it from
 * `Object.keys` and nothing else. A page that reads the marker names recovers the per-launch channel
 * (they were derived from it) and can then dispatch forged events straight at the bridge and pre-set
 * the names to suppress our observers entirely. A `Symbol` is reachable only via
 * `Object.getOwnPropertySymbols`, and its `description` carries no channel material, so the recovery
 * path is closed on both counts. The uniqueness `onceGuard` needs is identity, which a `Symbol` in a
 * per-document registry gives directly.
 *
 * The registry is keyed on a `Symbol.for` global-symbol key, which is per-DOCUMENT (a new document
 * gets a fresh realm and therefore a fresh registry) and per-launch random, so a page cannot pre-seed
 * it to make our scripts think they already ran.
 */
function onceGuard(guardKey: string, scriptId: string, body: string): string {
  // Per-SCRIPT, not per-guard-key: all three observers share one registry, so a single shared marker
  // would let whichever script ran first suppress the other two entirely.
  const registryKey = JSON.stringify(guardKey);
  const slot = JSON.stringify(scriptId);
  return `(() => {
  const registrySymbol = Symbol.for(${registryKey});
  const registry = globalThis[registrySymbol] || {};
  if (registry[${slot}]) return;
  registry[${slot}] = true;
  Object.defineProperty(globalThis, registrySymbol, { value: registry, configurable: true });
${body}
})();`;
}

/**
 * MAIN-WORLD half of the bridge. Emits `payload` on the shared DOM channel, replaying recent payloads
 * whenever a listener announces itself so nothing logged at document_start is lost.
 *
 * EVERY MAIN↔ISOLATED SIGNAL IS PAGE-FORGEABLE, SO FORGERY IS MADE HARMLESS RATHER THAN IMPOSSIBLE.
 * The two worlds share only the DOM, and any DOM signal is something the page can dispatch itself.
 * The previous design gated emission on a one-shot `_ready` handshake: a page that fired
 * `<channel>_ready` at document_start flipped the gate and drained the queue into an event no listener
 * had yet subscribed to, permanently and silently killing the console bridge with no host-side signal.
 *
 * So there is no gate. Payloads dispatch immediately AND are retained in a bounded replay buffer that
 * is re-dispatched on every `_ready`. A forged `_ready` now costs one redundant replay; the real one
 * (the isolated installer announces on every document and every navigation) recovers everything from
 * document_start. Duplicates are resolved HOST-side: each payload carries a per-document id and a
 * monotonic sequence, and the host ignores any it has already seen.
 *
 * `CustomEvent` detail is a string, never a live object: passing an object across the world boundary
 * would hand the isolated world a reference the page can mutate mid-read.
 */
function channelEmitter(channel: string): string {
  const ch = JSON.stringify(channel);
  return `const REPLAY_MAX = 50;
  const docId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let seq = 0;
  const replay = [];
  const dispatch = (payload) => {
    document.dispatchEvent(new CustomEvent(${ch}, { detail: payload }));
  };
  const emit = (message) => {
    const payload = JSON.stringify({ doc: docId, seq: seq++, kind: message.kind, value: message.value });
    replay.push(payload);
    if (replay.length > REPLAY_MAX) replay.shift();
    dispatch(payload);
  };
  document.addEventListener(${ch} + '_ready', () => {
    for (const payload of replay.slice()) dispatch(payload);
  });`;
}

/**
 * ISOLATED-WORLD half of the bridge, evaluated per document via `page.evaluate` (which targets the
 * isolated world) after every main-frame navigation.
 *
 * Returned as a function body for `page.evaluate`, not a string for `addInitScript`: init scripts run
 * in the main world, which is precisely where the binding does not exist.
 *
 * The binding is resolved PER EVENT rather than captured once, because Playwright reinstalls its
 * wrapper over the raw binding and a captured reference can go stale. Installation is idempotent via a
 * marker on the isolated world's own global, so a redundant install after a same-document navigation
 * cannot double-register the listener and duplicate every message.
 */
export function isolatedBridgeInstaller(): (args: { channel: string; binding: string; guardKey: string }) => void {
  // The extension host has no DOM lib (`tsconfig` targets ES2022 only), but this body is serialized and
  // executed in the browser. The DOM surface it needs is declared locally rather than widening the
  // project's `lib`, which would let DOM globals leak into genuine host code by mistake.
  type BridgeDoc = {
    addEventListener(type: string, handler: (event: { detail?: unknown }) => void): void;
    dispatchEvent(event: unknown): void;
  };
  return ({ channel, binding, guardKey }: { channel: string; binding: string; guardKey: string }) => {
    const scope = globalThis as unknown as Record<string, unknown> & {
      document: BridgeDoc;
      CustomEvent: new (type: string, init?: { detail?: unknown }) => unknown;
    };
    // Keyed on the independent guard key rather than the channel. This world is isolated from the page,
    // but keeping the naming rule uniform means no future reader has to reason about which globals are
    // page-visible and which are not.
    const marker = `${guardKey}_installed`;
    const announce = (): void => {
      scope.document.dispatchEvent(new scope.CustomEvent(`${channel}_ready`));
    };
    if (scope[marker]) {
      // Already listening; re-announce so a NEW document's main-world queue still drains.
      announce();
      return;
    }
    scope[marker] = true;
    scope.document.addEventListener(channel, (event) => {
      // Resolved per event, never captured: Playwright reinstalls its wrapper over the raw binding, so
      // a reference taken at install time can go stale.
      const fn = scope[binding] as ((payload: string) => void) | undefined;
      if (typeof fn !== 'function') return;
      if (typeof event.detail !== 'string') return;
      fn(event.detail);
    });
    announce();
  };
}

/**
 * Injected via context.addInitScript (main world). Chromium does not emit a title-change event, so the
 * live tab title is pushed from the renderer: a MutationObserver on <head> reports document.title
 * through the channel whenever it changes.
 *
 * The payload is tagged by kind because all three observers share ONE channel and one binding: a
 * single DOM listener and a single exposeBinding endpoint are a smaller surface for a page to notice
 * than three of each.
 */
export function buildTitleObserverScript(channel: string, guardKey: string): string {
  return onceGuard(guardKey, 'title', `
  ${channelEmitter(channel)}
  let lastTitle = null;
  const report = () => {
    const t = document.title;
    if (t === lastTitle) return;
    lastTitle = t;
    emit({ kind: 'title', value: t });
  };
  const start = () => {
    report();
    const target = document.head || document.documentElement;
    if (!target) return;
    new MutationObserver(report).observe(target, { subtree: true, childList: true, characterData: true });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
`);
}

/**
 * Injected via context.addInitScript (main world). Push-based cursor: reports the hovered element's
 * cursor once per change, so hover feedback costs zero per-move CDP round trips and survives
 * navigations.
 */
export function buildCursorObserverScript(channel: string, guardKey: string): string {
  return onceGuard(guardKey, 'cursor', `
  ${channelEmitter(channel)}
  let last = null;
  let pending = false;
  let latest = null;
  const compute = (el) => {
    if (!el || !(el instanceof Element)) return 'default';
    const cs = getComputedStyle(el).cursor;
    if (cs && cs !== 'auto') return cs;
    if (el.tagName === 'A' || el.closest('a') || el.closest('[role=button]')) return 'pointer';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return 'text';
    return 'default';
  };
  const flush = () => {
    pending = false;
    const target = latest;
    // Released before anything else can return early: holding the last hovered node keeps it (and its
    // whole detached subtree) alive for the document's life once the page removes it from the DOM.
    latest = null;
    const cursor = compute(target);
    if (cursor === last) return;
    last = cursor;
    emit({ kind: 'cursor', value: cursor });
  };
  document.addEventListener('mousemove', (e) => {
    latest = e.target;
    if (pending) return;
    pending = true;
    requestAnimationFrame(flush);
  }, { passive: true });
`);
}

/**
 * Injected via context.addInitScript at document_start (main world). Captures the page's own console
 * output, uncaught errors and unhandled rejections, because Patchright disables `Console.enable` and
 * Playwright's `page.on('console')` never fires.
 *
 * Each level is wrapped in a `Proxy` over the ORIGINAL native function rather than replaced by a plain
 * function: that is what keeps `Function.prototype.toString.call(console.log)` reporting
 * `[native code]` and preserves `.name`/`.length`, with no patch to `Function.prototype.toString`
 * (a global toString patch is itself a classic detection tell).
 *
 * Entries are queued and emitted as ONE channel message per 100ms window; the queue is capped and
 * overflow is reported explicitly rather than dropped silently. Timestamps are added host-side.
 */
export function buildConsoleBridgeScript(channel: string, guardKey: string): string {
  return onceGuard(guardKey, 'console', `
  ${channelEmitter(channel)}
  const MAX_TEXT = 2000;
  const MAX_QUEUE = 50;
  const MAX_DEPTH = 3;
  const FLUSH_MS = 100;

  let pendingEntries = [];
  let dropped = 0;
  let timer = null;
  let reporting = false;

  const serialize = (value) => {
    if (typeof value === 'string') return value;
    if (value === null || typeof value !== 'object') return String(value);
    if (value instanceof Error) return value.name + ': ' + value.message;
    try {
      const seen = new WeakSet();
      const prune = (v, depth) => {
        if (v === null) return v;
        const t = typeof v;
        if (t === 'bigint' || t === 'symbol' || t === 'function') return String(v);
        if (t !== 'object') return v;
        if (seen.has(v)) return '[Circular]';
        if (depth >= MAX_DEPTH) return Array.isArray(v) ? '[Array]' : '[Object]';
        seen.add(v);
        if (Array.isArray(v)) return v.map((item) => prune(item, depth + 1));
        const out = {};
        for (const key of Object.keys(v)) out[key] = prune(v[key], depth + 1);
        return out;
      };
      const json = JSON.stringify(prune(value, 0));
      return typeof json === 'string' ? json : String(value);
    } catch (err) {
      return '[unserializable]';
    }
  };

  const flush = () => {
    timer = null;
    const items = pendingEntries;
    pendingEntries = [];
    if (dropped > 0) {
      items.push({ level: 'warn', text: '(' + dropped + ' console messages dropped)' });
      dropped = 0;
    }
    if (items.length === 0) return;
    emit({ kind: 'console', value: items });
  };

  const report = (level, args) => {
    // Re-entrancy guard: a page can log from inside a property getter or from inside JSON.stringify.
    // Without this the first such log recurses forever.
    if (reporting) return;
    reporting = true;
    // THE ONE DELIBERATE SWALLOW. An exception escaping a console.log wrapper does not land in our
    // code — it propagates into the PAGE's own call stack and breaks the site under test, the exact
    // opposite of what an observability bridge is for.
    try {
      let text = '';
      for (let i = 0; i < args.length; i++) {
        text += (i > 0 ? ' ' : '') + serialize(args[i]);
        if (text.length > MAX_TEXT) break;
      }
      // Marked, never a bare slice: an unmarked cut reads to the model as the page's COMPLETE output,
      // so it concludes the log ended where the buffer did and stops looking. Same reason the host's
      // own cap marks its cut (see collectors.ts).
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '…(truncated)';
      if (pendingEntries.length >= MAX_QUEUE) {
        dropped++;
      } else {
        pendingEntries.push({ level: level, text: text });
        // At most one channel message per FLUSH_MS window: only the empty→non-empty transition (the
        // sole moment no flush is already pending) arms the timer.
        if (timer === null) timer = setTimeout(flush, FLUSH_MS);
      }
    } catch (err) {
    } finally {
      reporting = false;
    }
  };

  const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  for (const level of levels) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    console[level] = new Proxy(original, {
      apply(target, thisArg, args) {
        report(level, args);
        // Some console methods are implemented in terms of another (console.trace delegates to
        // console.error on several engines), which would report the SAME call twice. Hold the guard
        // across the native call so anything logged internally is attributed to the original call only.
        const outer = reporting;
        reporting = true;
        try {
          return Reflect.apply(target, thisArg, args);
        } finally {
          reporting = outer;
        }
      },
    });
  }

  window.addEventListener('error', (e) => {
    let text = e.message + ' (' + (e.filename || '') + ':' + e.lineno + ':' + e.colno + ')';
    if (e.error instanceof Error && typeof e.error.stack === 'string') {
      const lines = e.error.stack.split('\\n');
      const frame = lines.find((l) => l.trim().indexOf('at ') === 0) || lines[0];
      if (frame) text += '\\n' + frame;
    }
    report('error', [text]);
  });

  window.addEventListener('unhandledrejection', (e) => {
    report('error', ['Unhandled promise rejection: ' + serialize(e.reason)]);
  });
`);
}
