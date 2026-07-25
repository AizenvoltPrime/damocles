/**
 * Credential redaction for everything a PAGE produces that reaches the model.
 *
 * WHY THIS EXISTS. Console output, failed-request URLs and picked-element markup are page-controlled
 * text that lands in the chat transcript, is persisted in the session file, and is re-sent to the model
 * on every subsequent turn. A single-page-app that logs its auth response, a request that fails with
 * `?access_token=…` in the query string, or a picked `<input type=password value=…>` would otherwise
 * put a live credential somewhere the user never chose to put it. The browser profile holds real
 * logged-in sessions, so these are real credentials, not test fixtures.
 *
 * WHY REDACT ON RECORD RATHER THAN ON RENDER. Applying this at the point of capture means the secret
 * never enters the ring buffer, so it cannot be reached by any present or future consumer — the
 * `BrowserConsole`/`BrowserNetwork` tools, the `ElementAttachment` broadcast to chat, or anything
 * added later. Redacting at each render site instead would put the guarantee at the mercy of whoever
 * adds the next reader, which is exactly how the picker attachment became an exfiltration path in the
 * first place.
 *
 * WHY THESE PATTERNS AND NOT A BLANKET RULE. The purpose of console capture is debugging the user's
 * own app, so over-redaction destroys the feature. Everything here is high-precision: named
 * credential keys, and token formats whose shape is unambiguous (JWT, `Bearer`, PEM, and
 * vendor-prefixed keys). Deliberately NOT redacted: bare long hex/base64 runs, which are far more often
 * hashes, content ids, or inline images than secrets.
 *
 * EVERY PATTERN HERE MUST RUN IN LINEAR TIME. This code executes SYNCHRONOUSLY on the extension host
 * against text a hostile page fully controls, so a pattern that backtracks is a remote freeze of the
 * editor, not a slow log line. The rules obey two hard constraints:
 *   - every unbounded `*`/`+` run is over a NEGATED character class that cannot also be matched by the
 *     alternative beside it (the "unrolled loop" form), so there is exactly one way to match a prefix
 *     and nothing to backtrack into;
 *   - every quantifier that sits next to another quantifier over an overlapping class is BOUNDED.
 * The previous `(?:\\.|(?!\2)[^\\])*` value matcher violated both and cost 1.6s on 40KB and 73s on
 * 160KB of ordinary page text — no credential keyword required. See `redaction.test.ts` for the
 * timing guard that keeps this honest.
 *
 * This is a mitigation, not a guarantee: a page can log a credential in a shape no rule anticipates.
 * The bound on the damage is that it is the page's own data, which the operator already has access
 * to — the goal is to stop the routine, predictable leak, not to promise the impossible.
 */

const REDACTED = '[redacted]';

/**
 * Key fragment matched against query-string, JSON and assignment keys. Substring rather than
 * whole-word, so `X-Api-Key`, `user_password` and `refreshToken` are all caught.
 */
const SENSITIVE_KEY_FRAGMENT =
  'pass(?:word|wd|phrase)?|secret|token|api[-_]?key|auth(?:orization)?|session[-_]?id|credential|private[-_]?key|signature|cookie';

/** Bound on the characters of a key surrounding the sensitive fragment. A real key is short; the bound
 *  is what keeps the two runs either side of the fragment from backtracking against each other. */
const KEY_AFFIX = '[\\w.\\[\\]-]{0,40}';

/**
 * A key/value assignment in a query string, fragment, JSON body, attribute list or logfmt output.
 *
 * `#` is in the leading class because OAuth implicit flow returns the token in the FRAGMENT
 * (`…/cb#access_token=…`), which `URL.searchParams` cannot see — so without it the single most
 * common way a real token reaches a URL would pass through untouched. `{`, `[` and `(` are there
 * because a key just as often follows a brace as a separator (`{token: 'x'}`).
 *
 * The value alternatives are UNROLLED: a double-quoted run, a single-quoted run, or an unquoted run,
 * each over a negated class that excludes its own escape and terminator. `\\[^\r\n]` consumes an
 * escaped character as one unit, and because `[^"\\\r\n]` cannot match a backslash the two branches
 * are mutually exclusive — the engine never has a second way to match a prefix.
 *
 * A STRUCTURED value gets its own branches. Without them the bare-token branch matches the opening
 * `[` of `{"tokens": ["a","b"]}` and stops at the first quote, replacing the bracket alone and leaving
 * every array element in the clear — a redaction that reads like it worked and did nothing. The
 * bracket branches are flat (their bodies cannot contain another opener), so a nested structure falls
 * through to the bare-token branch and its inner keys are judged on their own.
 *
 * An UNQUOTED value stops at the ordinary value delimiters instead of running to end of line, so one
 * sensitive key in a serialized object costs that field and not every field beside it. Over-redaction
 * is a real failure mode here: the whole point of console capture is debugging the user's own app.
 * The one place a credential genuinely spans delimiters — a cookie or auth header — is covered
 * whole-line by {@link CREDENTIAL_HEADER_RE} instead.
 */
const ASSIGNMENT_RE = new RegExp(
  `([?&;,#{[(\\s]|^)(["']?${KEY_AFFIX}(?:${SENSITIVE_KEY_FRAGMENT})${KEY_AFFIX}["']?[ \\t]{0,8}[:=][ \\t]{0,8})` +
    `("(?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*"` +
    `|'(?:[^'\\\\\\r\\n]|\\\\[^\\r\\n])*'` +
    `|\\[[^[\\]\\r\\n]{0,4096}\\]` +
    `|\\{[^{}\\r\\n]{0,4096}\\}` +
    `|[^\\s,;&()[\\]{}"'\\r\\n]+)`,
  'gi',
);

/**
 * A header line whose ENTIRE value is credential material, so it is redacted wholesale rather than
 * per-pair. A cookie jar's session id rarely sits under a name containing "session" (`sid`, `PHPSESSID`,
 * `_app_key`), so judging its pairs individually by key would leak the one that matters most.
 */
const CREDENTIAL_HEADER_RE = /^([ \t]{0,8}(?:set-)?cookie|[ \t]{0,8}(?:proxy-)?authorization)([ \t]{0,8}:[ \t]{0,8})[^\r\n]+/gim;

/** Userinfo credentials in any URL (`https://user:hunter2@host`). Lives with the text rules rather than
 *  in {@link redactUrl} because a URL most often reaches us EMBEDDED in a console line, where no
 *  structural parse is available — and because `URL.password` re-encodes on write, which is what
 *  previously emitted a literal `%5Bredacted%5D`. */
const USERINFO_RE = /([a-z][a-z0-9+.-]{0,31}:\/\/[^/@\s:]{1,64}:)[^/@\s]{1,256}@/gi;

/**
 * Token shapes that identify themselves regardless of the key they sit under. Each is anchored on a
 * vendor prefix or a structural signature, so a false positive requires text that is already
 * indistinguishable from a credential.
 */
const TOKEN_SHAPE_RES: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, // JWT
  // `[ \t]+` rather than `\s+`: a scheme and its credential are on ONE line, and matching across a
  // newline would let a log line ending in "Bearer" swallow the first word of the next one.
  /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bsk_(?:live|test)_[A-Za-z0-9]{12,}/g, // Stripe
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic
  /\bnpm_[A-Za-z0-9]{28,}/g, // npm automation token
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bssh-(?:rsa|ed25519|dss)[ \t]+[A-Za-z0-9+/=]{32,}/g,
  // PEM private key. The body run is BOUNDED and lazy over a negated class that cannot match `-`, so
  // an unterminated block fails fast instead of scanning the rest of the buffer for a missing END.
  /-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----[^-]{0,8192}-----END [A-Z ]{0,32}PRIVATE KEY-----/g,
];

/**
 * Redact credentials from page-produced text.
 *
 * ORDER MATTERS, AND IT IS SHAPE-FIRST. A self-identifying token is redacted before the key rules run,
 * because an unquoted value stops at the first space: `authorization: Bearer abc123def456` would
 * otherwise have only the word `Bearer` replaced, leaving the credential itself in the clear.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of TOKEN_SHAPE_RES) out = out.replace(re, REDACTED);
  out = out.replace(USERINFO_RE, `$1${REDACTED}@`);
  out = out.replace(CREDENTIAL_HEADER_RE, `$1$2${REDACTED}`);
  return out.replace(ASSIGNMENT_RE, (_m, prefix: string, keyAndSep: string, value: string) => {
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return `${prefix}${keyAndSep}${quote}${REDACTED}${quote}`;
  });
}

/**
 * Attribute names whose VALUE is a credential by definition rather than by shape, so no pattern can be
 * expected to recognise it — `value="hunter2"` is indistinguishable from any other word.
 *
 * These mirror the predicate `BrowserQuery`'s in-page serializer already applies (`browser-tools.ts`),
 * so the picker cannot become the one path that reports what every other path masks. `BrowserRequestInput`
 * promises a human-entered secret never reaches the model; a picked password field must honour that too.
 */
const SENSITIVE_AUTOCOMPLETE_RE = /one-time-code|current-password|new-password/i;

/** Whether an element's own attributes mark its value as secret — a password input, a one-time-code
 *  field, or anything explicitly tagged `data-sensitive`. */
export function isSensitiveElement(attributes: Record<string, string>): boolean {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) lower[key.toLowerCase()] = value;
  return (
    (lower['type'] ?? '').toLowerCase() === 'password' ||
    SENSITIVE_AUTOCOMPLETE_RE.test(lower['autocomplete'] ?? '') ||
    'data-sensitive' in lower
  );
}

/**
 * Redact a picked element's attribute map: the VALUE of a sensitive field is masked by name (no pattern
 * can recognise a password), and every other attribute still goes through the text rules, because a
 * credential rides just as often in a `data-token` or an `href` query string.
 */
export function redactAttributes(attributes: Record<string, string>): Record<string, string> {
  const sensitive = isSensitiveElement(attributes);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    out[key] = sensitive && key.toLowerCase() === 'value' ? REDACTED : redactSecrets(value);
  }
  return out;
}

/**
 * Redact a picked element's serialized markup.
 *
 * A `value="…"` on a sensitive element is masked STRUCTURALLY (the caller passes the parsed attribute
 * map, which is the same DOM state the markup was serialized from) before the text rules run, so
 * `<input type=password value=hunter2>` cannot ship a live password into the transcript.
 */
export function redactMarkup(html: string, attributes: Record<string, string>): string {
  const structural = isSensitiveElement(attributes)
    ? html.replace(/(\bvalue[ \t]{0,8}=[ \t]{0,8})("[^"\r\n]*"|'[^'\r\n]*'|[^\s>]*)/gi, (_m, prefix: string, value: string) => {
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
        return `${prefix}${quote}${REDACTED}${quote}`;
      })
    : html;
  return redactSecrets(structural);
}

/**
 * Redact credentials from a URL: sensitive query parameters, then the text rules.
 *
 * Query parameters are judged STRUCTURALLY, by name rather than by whether the value happens to look
 * secret, which is the one thing pattern matching cannot do reliably (`?next=%3Ftoken%3D…`). A URL that
 * will not parse (a relative path, or the `url (errorText)` composite the network collector builds)
 * falls back to the text rules, which is why this never throws.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactSecrets(url);
  }
  const sensitive = new RegExp(SENSITIVE_KEY_FRAGMENT, 'i');
  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (!sensitive.test(key)) continue;
    parsed.searchParams.set(key, REDACTED);
    changed = true;
  }
  // `toString()` re-encodes the whole URL, so it is only worth paying when something actually changed;
  // an untouched URL is returned byte-identical for readability. Userinfo is deliberately left to
  // `redactSecrets`: assigning `parsed.password` percent-encodes the marker into `%5Bredacted%5D`.
  const base = changed ? parsed.toString() : url;
  // A token can also ride in the fragment, the path or the userinfo, none of which searchParams covers.
  return redactSecrets(base);
}
