// Known-secret masking (docs/invariants.md "GitHub and GitLab accounts", masking): every live forge token, and every token
// answered to git in the last ANSWERED_WINDOW_MS, is replaced with MASK in tool results, exactly and in its base64 forms, as
// GitHub Actions masks secrets in logs. Process-global: it holds secrets, never session state. Matching is linear in the
// text (Aho-Corasick over code units), however many tokens are held.

export const MASK = '***';
export const ANSWERED_WINDOW_MS: number = 8 * 60 * 60_000;
// shorter values would mask ordinary text; no forge token is this short
const MIN_SECRET_CHARS = 8;
// a cut-off piece of a secret at a partial's start or end is masked from this many characters on
export const MIN_PARTIAL_CHARS = 6;

/**
 * The strings a secret shows as: itself, and per alignment (0, 1 or 2 bytes before it in the encoded data) the run of
 * base64 characters that depend on its bytes alone, in standard and URL-safe alphabets. An HTTP basic header's
 * base64("user:token") holds one of these runs whatever the user.
 */
export function secretForms(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  const forms = new Set([secret]);
  for (let align = 0; align < 3; align++) {
    const encoded = Buffer.concat([Buffer.alloc(align), bytes]).toString('base64').replace(/=+$/, '');
    // a character holding any bit of the alignment bytes, or of the zero padding at the end, depends on its neighbours
    const start = Math.ceil((align * 8) / 6);
    const total = align + bytes.length;
    const run = encoded.slice(start, total % 3 === 0 ? encoded.length : encoded.length - 1);
    if (run.length >= MIN_SECRET_CHARS) {
      forms.add(run);
      forms.add(run.replaceAll('+', '-').replaceAll('/', '_'));
    }
  }
  return [...forms];
}

interface Automaton {
  readonly next: Array<Map<string, number>>;
  readonly fail: number[];
  readonly depth: number[];
  // the longest pattern ending at each state, 0 for none
  readonly out: number[];
}

function build(patterns: readonly string[]): Automaton {
  const next: Array<Map<string, number>> = [new Map()];
  const depth = [0];
  const out = [0];
  for (const pattern of patterns) {
    let state = 0;
    for (const c of pattern.split('')) {
      let to = next[state]!.get(c);
      if (to === undefined) {
        to = next.length;
        next.push(new Map());
        depth.push(depth[state]! + 1);
        out.push(0);
        next[state]!.set(c, to);
      }
      state = to;
    }
    out[state] = Math.max(out[state]!, depth[state]!);
  }
  const fail = new Array<number>(next.length).fill(0);
  const queue: number[] = [];
  for (const to of next[0]!.values()) queue.push(to);
  for (let head = 0; head < queue.length; head++) {
    const state = queue[head]!;
    for (const [c, to] of next[state]!) {
      let f = fail[state]!;
      while (f !== 0 && !next[f]!.has(c)) f = fail[f]!;
      const target = next[f]!.get(c);
      fail[to] = target !== undefined && target !== to ? target : 0;
      out[to] = Math.max(out[to]!, out[fail[to]!]!);
      queue.push(to);
    }
  }
  return { next, fail, depth, out };
}

function step(automaton: Automaton, state: number, c: string): number {
  let current = state;
  for (;;) {
    const to = automaton.next[current]!.get(c);
    if (to !== undefined) return to;
    if (current === 0) return 0;
    current = automaton.fail[current]!;
  }
}

/** Code unit spans [start, end) of every match, merged where they touch or overlap; and the state after the text. */
function scan(automaton: Automaton, text: string): { readonly spans: Array<[number, number]>; readonly state: number } {
  const spans: Array<[number, number]> = [];
  let state = 0;
  for (let index = 0; index < text.length; index++) {
    state = step(automaton, state, text[index]!);
    const length = automaton.out[state]!;
    if (length === 0) continue;
    // a longer match may start before spans already taken, which it then swallows
    let start = index + 1 - length;
    let end = index + 1;
    while (spans.length > 0 && start <= spans.at(-1)![1]) {
      const [lastStart, lastEnd] = spans.pop()!;
      start = Math.min(start, lastStart);
      end = Math.max(end, lastEnd);
    }
    spans.push([start, end]);
  }
  return { spans, state };
}

/** spans sorted by start, those that touch or overlap joined into one. */
function mergedSpans(spans: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function replaceSpans(text: string, spans: ReadonlyArray<readonly [number, number]>): string {
  if (spans.length === 0) return text;
  let result = '';
  let at = 0;
  for (const [start, end] of spans) {
    result += text.slice(at, start) + MASK;
    at = end;
  }
  return result + text.slice(at);
}

// by code unit, as patterns and texts are matched
const reversed = (text: string): string => text.split('').reverse().join('');

export interface KnownSecrets {
  /** The account's live tokens, replacing what it held before; an empty list forgets the account. */
  setLive(accountId: string, secrets: readonly string[]): void;
  /** A token answered to git: masked until ANSWERED_WINDOW_MS after now. */
  answered(secret: string, now?: number): void;
  /** text with every known secret masked; never throws. */
  mask(text: string, now?: number): string;
  /**
   * A streamed snapshot (pi's tail of a shell's output): masked as mask does, plus a piece of a secret cut off at its start
   * or end, from MIN_PARTIAL_CHARS characters on.
   */
  maskPartial(text: string, now?: number): string;
  /**
   * Text that continues over later calls (a job log's reads): masked as mask does, except its last characters, as many as
   * the longest form of a held secret, which come back as held, for the caller to put before the next text. final keeps
   * nothing back.
   */
  maskStreamed(text: string, final: boolean, now?: number): { readonly text: string; readonly held: string };
  /** Whether any secret is held now. */
  holds(now?: number): boolean;
}

export function createKnownSecrets(clock: () => number = Date.now): KnownSecrets {
  const live = new Map<string, readonly string[]>();
  const answered = new Map<string, number>();
  let automata: { readonly forward: Automaton; readonly backward: Automaton; readonly longest: number; readonly key: string } | undefined;

  const current = (now: number): { readonly forward: Automaton; readonly backward: Automaton; readonly longest: number } | undefined => {
    for (const [secret, until] of answered) if (until <= now) answered.delete(secret);
    const secrets = [...new Set([...[...live.values()].flat(), ...answered.keys()])].filter((secret) => secret.length >= MIN_SECRET_CHARS).sort();
    if (secrets.length === 0) return undefined;
    const key = secrets.join('\n');
    if (automata?.key !== key) {
      const patterns = [...new Set(secrets.flatMap(secretForms))];
      automata = { forward: build(patterns), backward: build(patterns.map(reversed)), longest: Math.max(...patterns.map((pattern) => pattern.length)), key };
    }
    return automata;
  };

  const mask = (text: string, now: number): string => {
    const held = current(now);
    return held ? replaceSpans(text, scan(held.forward, text).spans) : text;
  };

  return {
    setLive(accountId, secrets) {
      if (secrets.length === 0) live.delete(accountId);
      else live.set(accountId, [...secrets]);
    },
    answered(secret, now = clock()) {
      answered.set(secret, Math.max(answered.get(secret) ?? 0, now + ANSWERED_WINDOW_MS));
    },
    mask: (text, now = clock()) => mask(text, now),
    maskPartial(text, now = clock()) {
      const held = current(now);
      if (!held) return text;
      const { spans, state } = scan(held.forward, text);
      const all: Array<[number, number]> = [...spans];
      const tail = held.forward.depth[state]!;
      if (tail >= MIN_PARTIAL_CHARS) all.push([text.length - tail, text.length]);
      // the longest start of the text that ends a secret: the end state of the reversed scan, over the reversed text
      const head = held.backward.depth[scan(held.backward, reversed(text)).state]!;
      if (head >= MIN_PARTIAL_CHARS) all.push([0, head]);
      return replaceSpans(text, mergedSpans(all));
    },
    maskStreamed(text, final, now = clock()) {
      const held = current(now);
      if (!held) return { text, held: '' };
      const { spans } = scan(held.forward, text);
      // a secret not yet complete started within the last `longest` characters
      let cut = final ? text.length : Math.max(0, text.length - held.longest);
      for (const [start, end] of spans) if (start < cut && end > cut) cut = start;
      // a surrogate pair stays whole on one side
      if (cut > 0 && cut < text.length && text.charCodeAt(cut - 1) >= 0xd800 && text.charCodeAt(cut - 1) <= 0xdbff) cut--;
      return { text: replaceSpans(text.slice(0, cut), spans.filter(([, end]) => end <= cut)), held: text.slice(cut) };
    },
    holds: (now = clock()) => current(now) !== undefined,
  };
}

let registry: KnownSecrets = createKnownSecrets();

/** The process's registry: this computer's core registers its accounts' tokens, a daemon's core the tokens it relayed. */
export function knownSecrets(): KnownSecrets {
  return registry;
}

/** Tests only: a fresh registry. */
export function resetKnownSecretsForTests(clock?: () => number): void {
  registry = createKnownSecrets(clock);
}
