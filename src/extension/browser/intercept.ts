import type { BrowserContext, Route } from 'patchright';
import { log } from '../logger';
import type { InterceptRule, RedactedInterceptRule } from './types';

/**
 * Probe URLs, grouped by scheme. Within a group the URLs share no host, no path segment and no
 * extension, so the only way one pattern matches a whole group is by matching every request on that
 * scheme.
 *
 * Grouped rather than flat because a SCHEME-WIDE blanket is just as destructive as a universal one:
 * `https://**` aborts every HTTPS request on the page, and blocking it is the behaviour the previous
 * guard was built around. A flat "matches all probes" test would clear it, since it matches no `http:`
 * URL.
 */
const OVER_BROAD_PROBE_GROUPS = [
  [
    'https://example.com/',
    'https://cdn.other-host.test/assets/app.abc123.js?v=1',
    'https://a.third.example:8443/x/y/z.png',
    'https://fourth.example/index',
  ],
  [
    'http://example.com/',
    'http://cdn.other-host.test/assets/app.abc123.js?v=1',
    'http://a.third.example:8080/x/y/z.png',
    'http://fourth.example/index',
  ],
  ['ws://socket.example/stream', 'ws://other.host.test/a/b/c.sock'],
  ['wss://socket.example/stream', 'wss://other.host.test/a/b/c.sock'],
];

/**
 * A pattern is "over-broad" when it matches every request on any scheme, or when it names nothing at
 * all. Used to forbid blanket block/fulfill rules that would abort or stub the entire page —
 * including, since rules are context-wide, the human's tabs.
 *
 * TWO INDEPENDENT TESTS, BECAUSE THEY CATCH DIFFERENT THINGS.
 *
 * {@link namesNothing} is the structural one: strip the scheme and every wildcard/separator, and if
 * nothing is left the pattern names no host, path or resource. It rejects the degenerate spellings
 * (a lone star, a bare scheme separator, a scheme-host-path star triple) whether or not the compiler
 * makes them match anything — a rule that targets nothing specific has no business blocking or
 * stubbing.
 *
 * {@link matchesEverything} is the behavioural one, and it exists because the structural test alone is
 * a guess about what the compiler will do with what it leaves behind. It guessed wrong for every brace
 * group: `{**}` compiles to `^((.*))$` and `{**,*}` to `^((.*)|([^/]*))$` — both match every request,
 * and both survived the strip because `{`, `}` and `,` were not in the stripped set. Compiling the
 * pattern and testing it against unrelated probe URLs asks the question that actually matters, with the
 * same translation that will route the request.
 *
 * A pattern that fails to compile is NOT over-broad — it is invalid, and `context.route` will reject it
 * on its own terms with a better message than this guard could produce.
 */
function isOverBroadPattern(pattern: string): boolean {
  return namesNothing(pattern) || matchesEverything(pattern);
}

/**
 * True when nothing but wildcards and separators remains after the scheme is stripped.
 *
 * The scheme is stripped FIRST: without that, `https://**` reduces to `"https"` and passed the
 * emptiness check, so a `block` rule on it aborted every HTTPS request.
 */
function namesNothing(pattern: string): boolean {
  return pattern.replace(/^(?:[a-z][a-z0-9+.-]*|\*+):/i, '').replace(/[*/:.\s]/g, '').length === 0;
}

/** True when the compiled pattern matches every probe URL of any one scheme. */
function matchesEverything(pattern: string): boolean {
  let matcher: (url: string) => boolean;
  try {
    // A regex-literal pattern (`/…/flags`) is passed through as a regex by Playwright; anything else is
    // a glob. Both are tested the same way, so neither notation is a way around the guard.
    const asRegex = /^\/(.*)\/([gimsuy]*)$/.exec(pattern);
    if (asRegex) {
      // `g` is dropped: a global regex carries `lastIndex` between `test` calls, so the probe results
      // would depend on the order they were run in.
      const re = new RegExp(asRegex[1]!, asRegex[2]!.replace(/g/g, ''));
      matcher = (url) => re.test(url);
    } else {
      const compiled = new RegExp(globToRegexPattern(pattern));
      matcher = (url) => compiled.test(url);
    }
  } catch {
    return false;
  }
  return OVER_BROAD_PROBE_GROUPS.some((group) => group.every((url) => matcher(url)));
}

/**
 * Playwright's glob-to-regex translation, reimplemented because it is internal to `patchright-core`
 * (`coreBundle.js`, `globToRegexPattern`) with no export path. Kept a faithful transcription rather
 * than an approximation: a guard that compiles a pattern differently from the router is a guard that
 * can be argued around, which is precisely the failure it replaces. `slice6-units.test.ts` pins the
 * translation against the shapes that matter.
 */
const GLOB_ESCAPED_CHARS = new Set(['$', '^', '+', '.', '(', ')', '|', '\\', '?', '*', '+', '[', ']', '{', '}']);

function globToRegexPattern(glob: string): string {
  const tokens = ['^'];
  let inGroup = false;
  for (let i = 0; i < glob.length; ++i) {
    const c = glob[i]!;
    if (c === '\\' && i + 1 < glob.length) {
      const char = glob[++i]!;
      tokens.push(GLOB_ESCAPED_CHARS.has(char) ? '\\' + char : char);
      continue;
    }
    if (c === '*') {
      const charBefore = glob[i - 1];
      let starCount = 1;
      while (glob[i + 1] === '*') {
        starCount++;
        i++;
      }
      if (starCount > 1) {
        const charAfter = glob[i + 1];
        if (charAfter === '/') {
          tokens.push(charBefore === '/' ? '((.+/)|)' : '(.*/)');
          ++i;
        } else {
          tokens.push('(.*)');
        }
      } else {
        tokens.push('([^/]*)');
      }
      continue;
    }
    if (c === '{') {
      if (inGroup) throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: nested '{' is not supported`);
      inGroup = true;
      tokens.push('(');
    } else if (c === '}') {
      if (!inGroup) throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '}'`);
      inGroup = false;
      tokens.push(')');
    } else if (c === ',' && inGroup) {
      tokens.push('|');
    } else {
      tokens.push(GLOB_ESCAPED_CHARS.has(c) ? '\\' + c : c);
    }
  }
  if (inGroup) throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '{'`);
  tokens.push('$');
  return tokens.join('');
}

/**
 * Response headers an agent may never inject via `fulfill`, plus request headers it may never inject
 * via `modify`. Hop-by-hop headers govern the connection itself, not the message, so forging them
 * corrupts the transport rather than mocking a response.
 */
const HOP_BY_HOP_HEADERS = new Set(['connection', 'transfer-encoding', 'upgrade', 'keep-alive']);

/** RFC 7230 `token`: the ONLY characters a header name may contain. Notably excludes CR, LF, space and
 *  the separators, so a name cannot carry a second header inside it. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** RFC 7230 `field-value`: visible ASCII, space and tab, plus obs-text. Excludes CR, LF and NUL — the
 *  three characters that turn one header into two. */
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/;

/**
 * Rejects headers that let a rule reach past "mock this response" into the connection or the profile's
 * cookie jar.
 *
 * SYNTAX IS VALIDATED BEFORE POLICY, AND VALUES ARE VALIDATED AT ALL. Checking only the NAME against a
 * deny-list is not a deny-list at all: `{'X-Foo': 'bar\r\nSet-Cookie: session=…'}` carries the banned
 * header in the VALUE, and `{'X-Foo\r\nSet-Cookie': 'x'}` carries it in the name past the point the
 * lookup reads. Both reach `Fetch.fulfillRequest` verbatim, and `splitSetCookieHeader` downstream
 * exists precisely to split multi-value headers — the machinery honours the injection. Enforcing RFC
 * 7230 token/field-value syntax first means the deny-list below sees exactly one header per entry, so
 * what it checks is what gets sent.
 *
 * `Set-Cookie` is fulfill-only: a stubbed response writing a cookie for a real origin would persist
 * into the shared profile long after the rule is cleared.
 */
function assertHeadersAllowed(headers: Record<string, string>, where: 'fulfill' | 'modify'): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(name)) {
      // The name is echoed JSON-encoded so a control character cannot forge structure in the error the
      // model reads back; the VALUE is never echoed, because it is the field most likely to hold a
      // credential the agent should not see repeated.
      throw new Error(`${JSON.stringify(name)} is not a valid header name — names must be RFC 7230 tokens.`);
    }
    if (!HEADER_VALUE_RE.test(value)) {
      throw new Error(`The value of "${name}" is not a valid header value — control characters (including CR/LF) are not allowed.`);
    }
    const lower = name.toLowerCase();
    if (where === 'fulfill' && lower === 'set-cookie') {
      throw new Error('Set-Cookie is not allowed in fulfill.headers.');
    }
    if (HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith('proxy-')) {
      throw new Error(`The hop-by-hop header "${name}" is not allowed in ${where}.headers.`);
    }
  }
}

/**
 * Owns the active `BrowserIntercept` rules for one browser context: validation, `context.route`
 * registration, the redacted list view and teardown.
 *
 * The context is READ THROUGH A SUPPLIER rather than stored. A second copy would be a second source of
 * truth, and every path that swaps or nulls the service's context would have to remember to sync it —
 * exactly the kind of obligation that gets missed.
 */
export class InterceptManager {
  private readonly getContext: () => BrowserContext | null;
  // Each entry keeps the Playwright route handler reference so it can be removed via context.unroute.
  private rules: { rule: InterceptRule; handler: (route: Route) => Promise<void> }[] = [];

  constructor(getContext: () => BrowserContext | null) {
    this.getContext = getContext;
  }

  /** Drop every rule WITHOUT unrouting — for a context that is already dead, where unroute would only
   *  reject. Keeps `list()` from reporting phantoms while the async teardown settles. */
  forget(): void {
    this.rules = [];
  }

  /**
   * Register a network-interception rule against the context via context.route. Validates the rule,
   * generates an id, installs the handler, records it (with its handler reference for later unroute),
   * and returns the id. Throws if the browser is not connected or the rule is malformed. Synchronous by
   * contract: the route() CDP round-trip is fire-and-forget (interception applies to future requests).
   */
  add(rule: Omit<InterceptRule, 'id'>): string {
    const context = this.getContext();
    if (!context) {
      throw new Error('Browser is not connected — open a page before adding an intercept rule.');
    }
    if (!rule.pattern) {
      throw new Error('An intercept rule requires a pattern.');
    }
    // A blanket pattern (only glob wildcards/separators) with block or fulfill would abort or stub
    // EVERY request — breaking the page and risking bot detection. Only continue/modify rules, which
    // pass requests through, may target everything; block/fulfill must name a specific URL/resource.
    if (rule.action !== 'continue' && isOverBroadPattern(rule.pattern)) {
      throw new Error(
        `An over-broad pattern ("${rule.pattern}") is not allowed for ${rule.action} rules — target a specific URL or resource pattern.`,
      );
    }
    if (rule.action === 'fulfill' && (!rule.fulfill || typeof rule.fulfill.status !== 'number')) {
      throw new Error('A fulfill rule requires fulfill.status.');
    }
    if (rule.action === 'continue' && rule.modify && !rule.modify.headers) {
      throw new Error('A modify rule requires modify.headers.');
    }
    // Trust boundary, stated rather than implied: rules are CONTEXT-WIDE — a subagent's rule applies to
    // the human's tabs too — and stubbing a response for an origin the profile is logged into is within
    // the agent's granted power BY DESIGN. Cookie/Authorization on modify are therefore NOT blocked.
    // What is bounded here is only what reaches past mocking: connection-level headers, and a stubbed
    // Set-Cookie that would outlive the rule in the shared profile. Runs before the id exists, so a
    // rejected rule leaves no trace in this.rules.
    if (rule.fulfill?.headers) assertHeadersAllowed(rule.fulfill.headers, 'fulfill');
    if (rule.modify?.headers) assertHeadersAllowed(rule.modify.headers, 'modify');
    const id = `ir_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const fullRule: InterceptRule = { ...rule, id };
    const handler = this.makeInterceptHandler(fullRule);
    // Fire-and-forget the route() CDP round-trip (the public method is synchronous by contract); log
    // only pattern/action on failure — NEVER any body.
    Promise.resolve(context.route(fullRule.pattern, handler)).catch((err) =>
      log(`[Browser] Intercept route registration failed for ${fullRule.action} ${fullRule.pattern} — ${err instanceof Error ? err.message : String(err)}`),
    );
    this.rules.push({ rule: fullRule, handler });
    return id;
  }

  /** A REDACTED view of the active intercept rules — the raw fulfill body is never returned (bodyBytes only). */
  list(): RedactedInterceptRule[] {
    return this.rules.map(({ rule }) => {
      const redacted: RedactedInterceptRule = { id: rule.id, pattern: rule.pattern, action: rule.action };
      if (rule.fulfill) {
        redacted.status = rule.fulfill.status;
        if (rule.fulfill.body !== undefined) redacted.bodyBytes = Buffer.byteLength(rule.fulfill.body, 'utf8');
        if (rule.fulfill.headers) redacted.fulfillHeaderKeys = Object.keys(rule.fulfill.headers);
      }
      if (rule.modify?.headers) redacted.modifyHeaderKeys = Object.keys(rule.modify.headers);
      return redacted;
    });
  }

  /** Remove every intercept rule (unroute each pattern/handler) and empty the registry. Null-safe. */
  clear(): void {
    for (const entry of this.rules) {
      // Fire-and-forget the unroute CDP round-trip; skipped entirely when the context is already gone.
      Promise.resolve(this.getContext()?.unroute(entry.rule.pattern, entry.handler)).catch((err) =>
        log(`[Browser] Intercept unroute failed for ${entry.rule.action} ${entry.rule.pattern} — ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    this.rules = [];
  }

  /**
   * Build the Playwright route handler for a rule. It ALWAYS terminates in EXACTLY ONE terminal so a
   * request can NEVER hang: block→abort, fulfill→fulfill, continue+headers→continue (merged headers),
   * pure let-through→fallback (so Patchright's earlier-registered stealth route still runs). The
   * try/catch is the ONE deliberate never-hang guard: on any error it falls back so the request
   * proceeds, logging ONLY pattern/action — NEVER request/response bodies (they may carry secrets).
   */
  private makeInterceptHandler(rule: InterceptRule): (route: Route) => Promise<void> {
    return async (route: Route) => {
      try {
        if (rule.action === 'block') {
          await route.abort();
          return;
        }
        if (rule.action === 'fulfill') {
          const opts: Parameters<Route['fulfill']>[0] = { status: rule.fulfill!.status };
          if (rule.fulfill!.headers) opts.headers = rule.fulfill!.headers;
          if (rule.fulfill!.body !== undefined) opts.body = rule.fulfill!.body;
          await route.fulfill(opts);
          return;
        }
        // action === 'continue'
        if (rule.modify?.headers) {
          await route.continue({ headers: { ...route.request().headers(), ...rule.modify.headers } });
          return;
        }
        // Pure let-through: fallback() defers to Patchright's earlier-registered route so its
        // stealth init-script injection still runs. NEVER continue() here — that would terminate the
        // chain and clobber Patchright's route.
        await route.fallback();
      } catch (err) {
        // DELIBERATE never-hang guard (the ONE place we swallow): a handler that throws without a
        // terminal would hang the request forever, so fall back to let it proceed. Log ONLY the
        // pattern/action — NEVER any body.
        log(`[Browser] Intercept handler error for ${rule.action} ${rule.pattern} — ${err instanceof Error ? err.message : String(err)}`);
        await route.fallback().catch(() => {});
      }
    };
  }
}
