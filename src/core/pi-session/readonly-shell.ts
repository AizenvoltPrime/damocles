/**
 * readonly-shell.ts — Provably read-only shell command classifier (SECURITY-CRITICAL).
 *
 * Leaf module (imports NOTHING from pi-session, same discipline as `plan-mode-guidance.ts`) so the
 * permission gate and tests can use it without an import cycle.
 *
 * Purpose: in plan mode and for a read-only agent (a subagent with no write tool, a team reviewer) a
 * provably read-only shell command runs with no prompt while any other asks the user, and the
 * checkpoint baseline wait skips proven reads in every mode. Every caller reaches it through `provenReadOnlyShell`
 * (proven-shell.ts), which adds the PowerShell PATH check. It FAILS CLOSED at every stage — any
 * command that is not POSITIVELY recognized as read-only gets a not-read-only verdict, which the gate routes to the approval flow.
 * Every disputed classification resolves toward not-read-only.
 *
 * Trust boundary: the adversary is the MODEL'S COMMAND STRING, not the user's machine configuration.
 * Git commands may invoke user-configured helpers (pager, textconv, fsmonitor) — trusted because the
 * model cannot change that config in plan mode or as a read-only agent without a shell command passing
 * the approval flow (which YOLO approves). The classifier's job is to keep the model from mutating state, executing
 * arbitrary programs, opening network paths or reading environment secrets without approval.
 */

import { leavesLocalDrives } from '../network-fs';

export type ShellKind = 'bash' | 'powershell';

export type ReadOnlyVerdict =
  /** commandNames: under PowerShell, every command name PowerShell looks up for the command, a PATH script included; under bash, none. */
  | { readOnly: true; commandNames: readonly string[] }
  | { readOnly: false; reason: string }; // reason = category text, e.g. "redirection (`>`) is not allowed"

export interface ShellCheckContext {
  /** Hosts a network path may name (`networkPathHost` of each open project folder and working folder spelling). */
  readonly allowedNetworkHosts: ReadonlySet<string>;
}

/** Convenience DENY constructor keeps the reason strings terse and consistent at the call sites. */
function deny(reason: string): ReadOnlyVerdict {
  return { readOnly: false, reason };
}

const ALLOW: ReadOnlyVerdict = { readOnly: true, commandNames: [] };

// ---------------------------------------------------------------------------
// Command rule table (declarative; shared shape so Slice 3 can reuse it for PowerShell).
// ---------------------------------------------------------------------------

type CommandRule =
  | { kind: 'always' }
  | {
      kind: 'flagGated';
      /** Exact flag tokens AND `flag=`-joined prefixes (so `--output` bans `--output` and `--output=x`). */
      bannedFlags: readonly string[];
      /** Letters matched INSIDE single-dash clusters (`-zo` trips on 'o'). Cluster-style tools only. */
      bannedShortLetters?: readonly string[];
    }
  | { kind: 'exactArgs'; allowed: readonly (readonly string[])[] }
  | { kind: 'git' }
  | { kind: 'sedPrint' }
  | { kind: 'date' };

/**
 * The bash allowlist. Every entry documents WHY it is safe and WHAT is banned. A command absent from
 * this table is denied by stage 3 (unknown token). `always` entries are pure readers that cannot mutate
 * state or execute another program; `flagGated` entries are readers with a narrow exec/write escape hatch
 * closed by banning specific flags; `exactArgs` entries are interpreters allowed ONLY for version probes;
 * `git` routes to the dedicated subcommand walker; `sedPrint` admits only `sed -n` with a print-only script.
 */
const BASH_RULES: ReadonlyMap<string, CommandRule> = new Map<string, CommandRule>([
  // Pure readers — safe ONLY because stage 1 structurally bans all redirection/substitution, so none of
  // these can be turned into a writer (`echo x > f`) or an executor (`cat $(evil)`). None spawns another
  // program or mutates the filesystem given a plain argument list.
  ['cat', { kind: 'always' }],
  ['ls', { kind: 'always' }],
  ['pwd', { kind: 'always' }],
  ['head', { kind: 'always' }],
  ['wc', { kind: 'always' }],
  ['stat', { kind: 'always' }],
  ['which', { kind: 'always' }],
  ['du', { kind: 'always' }],
  ['df', { kind: 'always' }],
  ['whoami', { kind: 'always' }],
  ['uname', { kind: 'always' }],
  ['basename', { kind: 'always' }],
  ['dirname', { kind: 'always' }],
  ['realpath', { kind: 'always' }],
  ['readlink', { kind: 'always' }],
  ['grep', { kind: 'always' }],
  ['cut', { kind: 'always' }],
  ['tr', { kind: 'always' }],
  ['cmp', { kind: 'always' }],
  ['nl', { kind: 'always' }],
  ['sha256sum', { kind: 'always' }],
  ['md5sum', { kind: 'always' }],
  ['echo', { kind: 'always' }],

  // More stdout-only readers. Each takes an input operand and writes nothing: no output-file operand, no
  // exec hook, no in-place mode.
  ['column', { kind: 'always' }],
  ['paste', { kind: 'always' }],
  ['comm', { kind: 'always' }],
  ['tac', { kind: 'always' }],
  ['fold', { kind: 'always' }],
  ['expand', { kind: 'always' }],
  ['od', { kind: 'always' }],
  ['strings', { kind: 'always' }],
  ['rev', { kind: 'always' }],
  // `seq` is DELIBERATELY ABSENT — do not add it. `seq inf` / `seq 1 inf` emit forever, and pi's bash
  // tool has no default timeout, so the turn hangs until the user cancels: the same hang class `tail -f`
  // is banned for. It reads nothing, so it has no research use — its only value is GENERATING input,
  // which a read-only classifier has no reason to grant.

  // cd — changes the working directory for THIS command string only (each tool call spawns a fresh
  // shell). It cannot write and cannot execute another program. `$` is structurally banned so `cd $EVIL`
  // is impossible, and `segment()` classifies each `&&`/`|`/`;` segment independently, so `cd x && <cmd>`
  // gives `<cmd>` no RULE it lacked.
  //
  // It does, however, change what a later RELATIVE path resolves to, and the classifier does not track the
  // working folder, so every path screen must hold without it: `environRefusal` judges the last segment,
  // `cd` into a `proc` folder is refused, and a walk after a `cd` that left the working folder is refused
  // (`nativePathRefusal`).
  //
  // NOTE: `classifyPowershell` looks up the bash table FIRST, so this also allows `cd` in PowerShell,
  // where it aliases the read-only `Set-Location` — intended, and stated here because the entry lives
  // in the bash table.
  ['cd', { kind: 'always' }],

  // jq is DELIBERATELY ABSENT — do not add it. It predefines `$ENV` and an `env` builtin, so
  // `jq -n 'env'` dumps the process environment; single quotes make `$` literal to the stage-1 scan, so
  // the structural `$` ban does not stop `jq -n '$ENV'`. That is the same env-secret disclosure
  // `environRefusal` exists to block, and screening jq's program text means parsing a language —
  // the same reason `awk` is out.

  // sed — only `-n` with a script of print commands (`evalSedPrint`). Its other commands and options write
  // files (`w`, `s///w`, `-i`), run programs (`e`, `s///e`) or read a script from elsewhere (`-f`, `-e`).
  ['sed', { kind: 'sedPrint' }],

  // find — recurses and prints; its escape hatches all EXECUTE a program (`-exec`/`-execdir`/`-ok`/
  // `-okdir`) or WRITE (`-delete`, `-fls`, `-fprint*`). find options are single-dash WORDS, not clusters,
  // so match exact tokens (and the `-fprint*` family by prefix). No short-letter cluster scan.
  [
    'find',
    {
      kind: 'flagGated',
      bannedFlags: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint', '-fprintf', '-fprint0'],
    },
  ],

  // sort — a reader except `-o/--output` (writes a file), `--compress-program` (executes an arbitrary
  // program to compress temp files) and `-T/--temporary-directory` (puts its temp files in a folder the model names,
  // where a killed sort leaves them). Ban the short letters `o` and `T` so clusters like `-zo` are caught.
  [
    'sort',
    {
      kind: 'flagGated',
      bannedFlags: ['--output', '--compress-program', '--temporary-directory'],
      bannedShortLetters: ['o', 'T'],
    },
  ],

  // rg (ripgrep) — a reader except its preprocessor/exec hooks: `--pre` runs a program per file,
  // `--pre-glob` scopes it, `--hostname-bin` runs a program to resolve the hostname.
  // `-z`/`--search-zip` runs gzip, xz, zstd and the other decompressors.
  [
    'rg',
    {
      kind: 'flagGated',
      bannedFlags: ['--pre', '--pre-glob', '--hostname-bin', '--search-zip'],
      bannedShortLetters: ['z'],
    },
  ],

  // file — `-C`/`--compile` writes a `.mgc` file; `-z`/`-Z` (`--uncompress`, `--uncompress-noreport`) run decompressors.
  ['file', { kind: 'flagGated', bannedFlags: ['--compile', '--uncompress', '--uncompress-noreport'], bannedShortLetters: ['C', 'z', 'Z'] }],

  // diff — `-l`/`--paginate` runs `pr` on the output (GNU and BSD).
  ['diff', { kind: 'flagGated', bannedFlags: ['--paginate'], bannedShortLetters: ['l'] }],

  // base64 — macOS and BSD `-o`/`--output` write the output file.
  ['base64', { kind: 'flagGated', bannedFlags: ['--output'], bannedShortLetters: ['o'] }],

  // printf — bash's builtin `-v NAME` assigns a shell variable, and `printf -v PATH <folder>` makes a later segment run that folder's programs.
  ['printf', { kind: 'flagGated', bannedFlags: [], bannedShortLetters: ['v'] }],

  // tail — a reader except FOLLOW mode (`-f`/`-F`/`--follow`), which never returns: pi's native bash tool
  // has NO default timeout, so a follow HANGS the turn until the user cancels. Ban the short letter `f`
  // so `-f` AND clusters like `-nf` are caught.
  [
    'tail',
    {
      kind: 'flagGated',
      bannedFlags: ['--follow'],
      bannedShortLetters: ['f', 'F'],
    },
  ],

  // uniq / xxd — readers whose SECOND positional operand is an OUTPUT file (`uniq in out`,
  // `xxd in out`). Handled by the positional-count check below (`SECOND_POSITIONAL_WRITES`), modeled
  // here as flagGated with no banned flags so they reach it.
  ['uniq', { kind: 'flagGated', bannedFlags: [] }],
  ['xxd', { kind: 'flagGated', bannedFlags: [] }],

  // tree — a reader except `-o file`, which writes the listing to a file, and `-R`, which runs tree again in each folder with
  // `-o 00Tree.html`. Ban short letters `o` and `R`.
  ['tree', { kind: 'flagGated', bannedFlags: [], bannedShortLetters: ['o', 'R'] }],

  // date — a reader except `-s/--set` and an operand not starting with `+`, which SET the system clock (`evalDate`).
  ['date', { kind: 'date' }],

  // Interpreters — allowed ONLY as a version probe. Any other argument executes a script/expression; python's `-v` is
  // verbose mode, which runs the program it reads from stdin (`echo '...' | python -v`).
  ['node', { kind: 'exactArgs', allowed: [['--version'], ['-v'], ['-V']] }],
  ['python', { kind: 'exactArgs', allowed: [['--version'], ['-V']] }],
  ['python3', { kind: 'exactArgs', allowed: [['--version'], ['-V']] }],

  // git — routed to the dedicated subcommand walker (read-only subcommands only).
  ['git', { kind: 'git' }],
]);

// ---------------------------------------------------------------------------
// Stage 0 — no-op redirection pre-pass (bash only).
// ---------------------------------------------------------------------------

type ScanState = 'none' | 'single' | 'double';

/** A boundary character before/after a redirection span: unquoted whitespace or a separator. */
function isRedirectionBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '|' || ch === ';' || ch === '&';
}

/**
 * Remove provably INERT redirection spans so the unchanged pipeline can classify the remainder. This
 * does NOT relax the stage-1 `>` ban: anything this pass does not positively recognize survives into
 * `scanStructure` and is denied there. That is the fail-closed property, and it is why this function is
 * total — "unrecognized" degrades to "denied downstream", never to an error. Stripping also keeps `>`
 * and `/dev/null` out of stage 4, where they would break the `uniq`/`xxd` positional-count rule.
 *
 * SECURITY INVARIANT: the shell executes the ORIGINAL string; only the STRIPPED string is classified.
 * Every removed span must be a no-op with respect to the filesystem and to process execution.
 *
 * Recognized (each requiring a word boundary on BOTH sides):
 *  - `[fd]>` / `[fd]>>` / `&>` / `&>>` followed by optional whitespace then the bare token `/dev/null`
 *  - `[fd]>&[fd]` — fd duplication (dup2 on an already-open descriptor), so `>/dev/null 2>&1` works
 *
 * Deliberately NOT recognized, each fail-closed:
 *  - `>&WORD` where WORD is not all digits. In bash `cmd >&file` ≡ `cmd &>file` — it CREATES AND WRITES
 *    a file named `file`. `2>&1` is a dup ONLY because the right operand is a digit. This is the
 *    sharpest edge here; loosening the operand to `\S+` would silently permit arbitrary file writes.
 *  - `2>&-` (fd close) — inert, but `-` is not a digit, so the `>` is denied. Over-blocking is correct.
 *  - `>|/dev/null` (noclobber override) — not recognized; denied.
 *  - Every `<` form, including `< /dev/null`. Inert, but a form not stripped is a form not to reason about.
 *  - `NUL` — never accepted. Under cmd.exe semantics it is a real, creatable name, and cmd is not the
 *    shell we spawn (pi requires a real bash on Windows).
 *  - Non-exact spellings. The path must be the bare unquoted token `/dev/null` — not `//dev/null`,
 *    `/dev/./null`, `'/dev/null'`, or `/dev/NULL`. Equivalent spellings are over-blocked on purpose.
 *
 * Two boundary rules that are not cosmetic:
 *  - LEFT BOUNDARY. Bash lexes `[0-9]+` as an IO_NUMBER only when the digits form a complete token. In
 *    `cat foo2>/dev/null` the word is `foo2` and the redirect is a bare `>`; stripping `2>/dev/null`
 *    there would silently rewrite the argument from `foo2` to `foo`. So the fd digits (or `&`, or a bare
 *    `>`) must be preceded by a boundary. Consequently `cmd>/dev/null` with no space is not stripped and
 *    is denied — the model can add a space.
 *  - QUOTES AND BACKSLASH, tracked exactly as `scanStructure` does. `cat foo\>/dev/null` is an escaped
 *    literal `>`, not a redirection; a quote-aware but escape-unaware pass would mangle it. Nothing
 *    inside any quoted region is ever stripped.
 */
export function stripNoOpRedirections(command: string): string {
  // Accumulate into an array and join once. Building a string with `out +=` and then INDEXING it for the
  // boundary check (`out[out.length - 1]`) forces the engine to flatten its rope on every character, so
  // the pass is O(n²): a 200k-char argument costs ~18 seconds of synchronous extension-host time — the
  // editor is frozen for all of it. Same freeze as a catastrophic regex, different cause.
  const out: string[] = [];
  let last = ''; // the previously emitted character, tracked so no indexing is needed
  const emit = (s: string): void => {
    if (s === '') return;
    out.push(s);
    last = s[s.length - 1] as string;
  };
  let state: ScanState = 'none';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;

    if (state === 'single') {
      emit(ch);
      if (ch === "'") state = 'none';
      continue;
    }

    if (ch === '\\') {
      emit(ch);
      if (i + 1 < command.length) {
        emit(command[i + 1] ?? '');
        i++;
      }
      continue;
    }

    if (state === 'double') {
      emit(ch);
      if (ch === '"') state = 'none';
      continue;
    }

    // none state.
    if (ch === "'") {
      state = 'single';
      emit(ch);
      continue;
    }
    if (ch === '"') {
      state = 'double';
      emit(ch);
      continue;
    }

    // A redirection span may start here only at a word boundary (the previous EMITTED char).
    if ((ch === '>' || ch === '&' || /[0-9]/.test(ch)) && isRedirectionBoundary(out.length === 0 ? undefined : last)) {
      const span = matchNoOpRedirection(command, i);
      if (span !== null) {
        emit(' '); // preserve the token boundary the span occupied
        i = span - 1;
        continue;
      }
    }

    emit(ch);
  }
  return out.join('');
}

/**
 * Try to match a no-op redirection span starting at `start` (already known to sit at a word boundary).
 * Returns the index just past the span, or `null` when nothing is positively recognized. The span must
 * also END at a word boundary, so `ls > /dev/nullx` matches nothing and is denied downstream.
 */
function matchNoOpRedirection(command: string, start: number): number | null {
  let i = start;

  // Optional fd prefix: `[0-9]+` or `&`.
  const ampPrefix = command[start] === '&';
  while (i < command.length && /[0-9]/.test(command[i] as string)) i++;
  if (i === start && ampPrefix) i++;

  if (command[i] !== '>') return null;
  i++;
  const appended = command[i] === '>';
  if (appended) i++;

  // `[fd]>&[fd]` — a dup2 on an already-open descriptor. The right operand must be ALL DIGITS: with any
  // other word, `>&WORD` creates and writes a file.
  if (command[i] === '&') {
    // Recognize EXACTLY `[fd]>&[fd]`. `>>&N` and `&>&N` are syntax errors in bash — matching them would
    // strip a span the shell would never execute, which is a parser differential waiting to become a
    // bypass. The doc above promises one form; honor it literally.
    if (appended || ampPrefix) return null;
    i++;
    const digitsStart = i;
    while (i < command.length && /[0-9]/.test(command[i] as string)) i++;
    if (i === digitsStart) return null;
    return isRedirectionBoundary(command[i]) ? i : null;
  }

  // `… > /dev/null` — optional whitespace, then the bare unquoted token, exactly spelled.
  while (command[i] === ' ' || command[i] === '\t') i++;
  const TARGET = '/dev/null';
  if (command.slice(i, i + TARGET.length) !== TARGET) return null;
  i += TARGET.length;
  return isRedirectionBoundary(command[i]) ? i : null;
}

// ---------------------------------------------------------------------------
// Stage 1 — structural scan (quote-aware single pass, with backslash handling).
// ---------------------------------------------------------------------------

/**
 * Scan the raw command for structural metacharacters that could redirect, substitute, background, or
 * otherwise escape the static token analysis. Returns a DENY verdict naming the offending category, or
 * `null` if the command is structurally clean.
 *
 * Backslash handling is mandatory, not cosmetic: in `cat \' $(evil) \'` the shell treats `\'` as a
 * literal apostrophe (single quotes never open) and EXECUTES the substitution. A backslash-unaware
 * scanner would think the `$(` sits inside single quotes and wrongly allow it. In the none/double states
 * `\` consumes the next char as literal; inside single quotes `\` is itself literal.
 */
function scanStructure(command: string): ReadOnlyVerdict | null {
  let state: ScanState = 'none';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (state === 'single') {
      // Single quotes are fully literal — nothing escapes, only a closing quote matters.
      if (ch === "'") state = 'none';
      continue;
    }

    // none or double state: backslash consumes the next character as a literal.
    if (ch === '\\') {
      if (i === command.length - 1) return deny('a trailing backslash is not allowed');
      // bash deletes `\<newline>` as a line continuation, joining the words on either side.
      if (command[i + 1] === '\n' || command[i + 1] === '\r') return deny('multi-line commands are not allowed');
      i++; // skip the escaped character
      continue;
    }

    if (ch === '\n' || ch === '\r') return deny('multi-line commands are not allowed');

    if (state === 'double') {
      // Inside double quotes, `$` and backtick STILL expand; `| ; & > <` are literal (fine).
      if (ch === '"') state = 'none';
      else if (ch === '$') return deny('variable or command expansion (`$`) is not allowed');
      else if (ch === '`') return deny('command substitution (backtick) is not allowed');
      continue;
    }

    // none state.
    if (ch === "'") {
      state = 'single';
      continue;
    }
    if (ch === '"') {
      state = 'double';
      continue;
    }
    if (ch === '$') return deny('variable or command expansion (`$`) is not allowed');
    if (ch === '`') return deny('command substitution (backtick) is not allowed');
    if (ch === '>') return deny('redirection (`>`) is not allowed');
    if (ch === '<') {
      // `<(` is process substitution; a bare `<` is input redirection. Both banned.
      if (command[i + 1] === '(') return deny('process substitution (`<(`) is not allowed');
      return deny('redirection (`<`) is not allowed');
    }
    if (ch === '&') {
      // `&&` is a command separator (handled by segmentation); a lone `&` backgrounds the command.
      if (command[i + 1] === '&') {
        i++; // consume the second `&`
        continue;
      }
      return deny('background execution (`&`) is not allowed');
    }
    // Unquoted braces are BRACE EXPANSION, which bash performs BEFORE word splitting and before the
    // classifier's per-token flag gate ever runs: `sort {-o,/tmp/pwn} in` reaches the shell as
    // `sort -o /tmp/pwn in` (a file write), while the classifier sees the single inert token
    // `{-o,/tmp/pwn}`. `find . -delet{e,e}` → `-delete -delete`; `tail -{f,}` → follow-mode hang. The
    // static token analysis cannot model the post-expansion argv, so ban unquoted `{`/`}` structurally
    // (they are literal inside quotes, so quoted braces are unaffected). Mirrors the PowerShell scan.
    if (ch === '{' || ch === '}') return deny('brace expansion (`{`/`}`) is not allowed');
    // `>(` is caught by the `>` case above; nothing else is structural in the none state.
  }

  if (state !== 'none') return deny('an unbalanced quote is not allowed');
  return null;
}

// ---------------------------------------------------------------------------
// Stage 2 — segmentation on unquoted && || | ; (quote/backslash aware).
// ---------------------------------------------------------------------------

/**
 * Split the (already structurally validated) command into segments on unquoted `&&`, `||`, `|`, `;`.
 * The scan in stage 1 guarantees quotes are balanced and no banned metachars remain, so this pass only
 * needs quote/backslash tracking to avoid splitting on a separator that sits inside quotes.
 * Each segment carries the separator that ended it; the last carries none.
 */
function segment(command: string): Array<{ text: string; endedBy?: ';' | '&&' | '||' | '|' }> {
  const segments: Array<{ text: string; endedBy?: ';' | '&&' | '||' | '|' }> = [];
  let current = '';
  let state: ScanState = 'none';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (state === 'single') {
      current += ch;
      if (ch === "'") state = 'none';
      continue;
    }

    if (ch === '\\') {
      current += ch;
      if (i + 1 < command.length) {
        current += command[i + 1] ?? '';
        i++;
      }
      continue;
    }

    if (state === 'double') {
      current += ch;
      if (ch === '"') state = 'none';
      continue;
    }

    // none state.
    if (ch === "'") {
      state = 'single';
      current += ch;
      continue;
    }
    if (ch === '"') {
      state = 'double';
      current += ch;
      continue;
    }
    if (ch === ';') {
      segments.push({ text: current, endedBy: ';' });
      current = '';
      continue;
    }
    if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      segments.push({ text: current, endedBy: ch === '&' ? '&&' : '||' });
      current = '';
      i++; // consume the second char
      continue;
    }
    if (ch === '|') {
      segments.push({ text: current, endedBy: '|' });
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push({ text: current });
  return segments;
}

// ---------------------------------------------------------------------------
// Stage 3 — tokenize a segment on unquoted whitespace (quote/backslash aware).
// ---------------------------------------------------------------------------

/** The characters a backslash escapes inside bash double quotes; before any other the backslash stays. */
const BASH_DOUBLE_QUOTE_ESCAPABLE = '$`"\\\n';

/**
 * Tokenize a segment on unquoted whitespace and remove quoting so the table lookup and flag matching see
 * the argument values the shell hands the program. Stage 1 has already guaranteed the segment is
 * structurally clean, so this pass is unquoting, not re-validation.
 *
 * bash: an unquoted `\x` is `x`; inside double quotes `\` escapes only `$`, backtick, `"`, `\` and a line
 * break and is otherwise kept; single quotes are literal. PowerShell: `\` is an ordinary character, and a
 * doubled quote inside a string of the same quote (`''` in `'…'`, `""` in `"…"`) is one literal quote, and a word
 * that starts with a quote ends at its closing quote, so `'x'y` is two arguments.
 */
export function tokenize(segment: string, dialect: ShellKind): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false; // distinguishes an empty-string token ('' ) from no token yet
  let quotedWord = false;
  let state: ScanState = 'none';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string;

    if (state !== 'none') {
      const quote = state === 'single' ? "'" : '"';
      if (ch === quote) {
        if (dialect === 'powershell' && segment[i + 1] === quote) {
          current += quote;
          i++;
        } else {
          state = 'none';
          if (quotedWord) {
            tokens.push(current);
            current = '';
            started = false;
            quotedWord = false;
          }
        }
        continue;
      }
      if (ch === '\\' && state === 'double' && dialect === 'bash' && i + 1 < segment.length) {
        const next = segment[i + 1] as string;
        if (BASH_DOUBLE_QUOTE_ESCAPABLE.includes(next)) {
          if (next !== '\n') current += next;
          i++;
          continue;
        }
      }
      current += ch;
      continue;
    }

    if (ch === '\\' && dialect === 'bash') {
      if (i + 1 < segment.length) {
        const next = segment[i + 1] as string;
        if (next !== '\n') {
          current += next;
          started = true;
        }
        i++;
      }
      continue;
    }

    // none state.
    if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      state = ch === "'" ? 'single' : 'double';
      quotedWord = dialect === 'powershell' && !started;
      started = true;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Detect whether a segment's FIRST token was written with any quoting or escaping. A bare command name
 * never is, so quoting the command (`'cat' f`, `c\at f`) is a smuggling signal and is denied. We check
 * the raw leading run rather than trusting the unquoted token value.
 */
function firstTokenIsQuoted(segment: string): boolean {
  const trimmed = segment.replace(/^[ \t]+/, '');
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === ' ' || ch === '\t') break;
    if (ch === "'" || ch === '"' || ch === '\\') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Flag helpers.
// ---------------------------------------------------------------------------

/**
 * Match a banned flag token, its `flag=`-joined form, OR an unambiguous long-option PREFIX abbreviation.
 * GNU getopt_long and git's parse-options both accept the shortest unambiguous prefix of a long option:
 * `sort --out=/tmp/pwn` ≡ `--output`, `git log --outp` ≡ `--output`, `sort --compress-prog=evil` ≡
 * `--compress-program`. Exact-token matching alone lets these smuggle a write/exec flag past the gate.
 *
 * We cannot know each tool's full option set here to prove a prefix is truly unambiguous, so — per the
 * fail-closed policy — we treat ANY token that is a `--`-prefix of a banned long flag as banned. This may
 * over-block an abbreviation that also prefixes a SAFE option (e.g. a hypothetical `--out-format` when
 * `--output` is banned), which is acceptable: the model gets a naming reason and can spell the flag in
 * full. Short flags (`-o`) have no abbreviation and are handled exactly / by the cluster scan.
 */
function matchesBannedFlag(token: string, bannedFlags: readonly string[]): boolean {
  // Split off an `=value` suffix so `--out=/tmp/pwn` is matched on its `--out` flag part.
  const eq = token.indexOf('=');
  const flagPart = eq === -1 ? token : token.slice(0, eq);
  for (const flag of bannedFlags) {
    if (token === flag) return true;
    if (token.startsWith(flag + '=')) return true;
    // Long-option prefix abbreviation: `--out` for `--output`. Require a `--` long flag and a flagPart
    // that is a proper, non-empty `--`-prefix of it (length > 2 excludes a bare `--`).
    if (flag.startsWith('--') && flagPart.length > 2 && flag.startsWith(flagPart)) return true;
  }
  return false;
}

/**
 * A single-dash cluster is a token like `-zo` (NOT `--long`). Return true when it bans a short letter.
 * GNU getopt treats an attached value as part of the same token: `-ofile` ≡ `-o file`, so we must inspect
 * the option letters that PRECEDE any attached value, not require the whole token to be letters. We walk
 * from the first letter and stop at the first non-letter (the attached value / count boundary) — that
 * still catches `-zo`, `-nf`, and the smuggled `-oevil.txt` / `-o1` / `-f5` / `-s0`, while `tail -c-5 f`
 * stays allowed (`c` ok, `-` ends the option run). Fail-closed: any banned option letter seen → DENY.
 */
function clusterBansLetter(token: string, bannedShortLetters: readonly string[]): boolean {
  if (!token.startsWith('-') || token.startsWith('--') || token.length < 2) return false;
  for (const ch of token.slice(1)) {
    if (!/[A-Za-z]/.test(ch)) break; // reached the attached value; option letters end here
    if (bannedShortLetters.includes(ch)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stage 4 — per-command rule evaluation.
// ---------------------------------------------------------------------------

/**
 * Readers that treat a SECOND positional operand as an output file to WRITE (`uniq in out`,
 * `xxd in out`). The count is naive — a DETACHED flag value (`xxd -l 64 f`) also counts, so that form
 * over-blocks. Deliberate: distinguishing it needs a per-flag arity table, and a wrong arity there is an
 * UNDER-block. The model can attach the value (`xxd -l64 f`).
 */
const SECOND_POSITIONAL_WRITES: ReadonlySet<string> = new Set(['uniq', 'xxd']);

/**
 * Is this token an OPERAND rather than an option? A bare `-` means STDIN and is a positional, not a
 * flag: `echo x | uniq - /tmp/pwn` is a two-operand invocation that WRITES `/tmp/pwn` with
 * attacker-chosen bytes (`xxd -r -p - out.bin` is the binary variant). A naive `!startsWith('-')` test
 * counts `-` as a flag, drops the operand count to one, and lets the write through.
 */
function isPositionalOperand(token: string): boolean {
  return token === '-' || !token.startsWith('-');
}

function evalFlagGated(
  command: string,
  args: readonly string[],
  bannedFlags: readonly string[],
  bannedShortLetters: readonly string[] | undefined,
): ReadOnlyVerdict {
  for (const arg of args) {
    if (matchesBannedFlag(arg, bannedFlags)) {
      return deny(`\`${command}\` with \`${arg}\` is not allowed because it can write or execute`);
    }
    if (bannedShortLetters && clusterBansLetter(arg, bannedShortLetters)) {
      return deny(`\`${command}\` with \`${arg}\` is not allowed because it can write or execute`);
    }
  }

  // A second positional operand is the OUTPUT file for these readers (`uniq in out`, `xxd in out`).
  if (SECOND_POSITIONAL_WRITES.has(command)) {
    const positionals = args.filter(isPositionalOperand);
    if (positionals.length >= 2) {
      return deny(`\`${command}\` with a second file operand is not allowed because it writes output`);
    }
  }

  return ALLOW;
}

/**
 * `date` as a reader: no `-s`/`--set`, and only `+FORMAT` operands, since GNU and BSD date set the clock to any other operand
 * (`date 0101000025`). The value after `-d`, `-f`, `-r`, `-v` or `-z` (GNU and BSD) is skipped.
 */
function evalDate(args: readonly string[]): ReadOnlyVerdict {
  const flags = evalFlagGated('date', args, ['--set'], ['s']);
  if (!flags.readOnly) return flags;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg === '--') options = false;
    else if (options && arg.startsWith('-') && arg !== '-') {
      if (/^-[uRjn]*[dfrvz]$/.test(arg) || /^--(?:date|file|reference)$/.test(arg)) i++;
    } else if (!arg.startsWith('+')) {
      return deny(`\`date\` with the operand \`${arg}\` is not allowed because it sets the clock; format with \`date +FORMAT\``);
    }
  }
  return ALLOW;
}

function evalExactArgs(command: string, args: readonly string[], allowed: readonly (readonly string[])[]): ReadOnlyVerdict {
  for (const combo of allowed) {
    if (combo.length === args.length && combo.every((a, idx) => a === args[idx])) {
      return ALLOW;
    }
  }
  return deny(`\`${command}\` is only allowed as a version probe (e.g. \`${command} --version\`)`);
}

// ---------------------------------------------------------------------------
// git subcommand walker.
// ---------------------------------------------------------------------------

/** git subcommands whose flags/args are otherwise unrestricted (pure history/state readers). */
const GIT_OPEN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'shortlog',
  'describe',
  'rev-parse',
  'ls-files',
  'ls-tree',
]);

/** Flags every git subcommand bans (they write a file). */
const GIT_OUTPUT_FLAGS: readonly string[] = ['--output', '--output-directory'];

function gitOutputBanned(args: readonly string[]): ReadOnlyVerdict | null {
  for (const arg of args) {
    if (matchesBannedFlag(arg, GIT_OUTPUT_FLAGS)) {
      return deny('`git` with `--output` is not allowed because it writes a file');
    }
  }
  return null;
}

/**
 * Walk a `git` invocation. Pre-subcommand options are banned except `--no-pager`/`-P` (and a lone
 * `--version`); each read-only subcommand has its own narrow rules. Every disputed case denies.
 */
function evalGit(args: readonly string[]): ReadOnlyVerdict {
  let idx = 0;

  // Pre-subcommand options: only `--no-pager` / `-P` are allowed; a lone `--version` is the whole command.
  while (idx < args.length && (args[idx] as string).startsWith('-')) {
    const opt = args[idx] as string;
    if (opt === '--version') {
      return args.length === idx + 1
        ? ALLOW
        : deny('`git --version` does not take additional arguments');
    }
    if (opt === '--no-pager' || opt === '-P') {
      idx++;
      continue;
    }
    return deny(`\`git ${opt}\` is not an allowed pre-subcommand option`);
  }

  if (idx >= args.length) {
    return deny('`git` requires a read-only subcommand (e.g. `git status`, `git log`)');
  }

  const sub = args[idx] as string;
  const rest = args.slice(idx + 1);

  const outputBan = gitOutputBanned(rest);
  if (outputBan) return outputBan;

  if (GIT_OPEN_SUBCOMMANDS.has(sub)) {
    return ALLOW;
  }

  switch (sub) {
    case 'grep': {
      // git grep can open a pager to run a program via -O/--open-files-in-pager. `-O` takes an OPTIONAL
      // attached argument (`-Onotepad` runs notepad), so ban the whole `-O…` prefix, not just the bare
      // `-O` token. The long form is prefix-abbreviatable, handled by matchesBannedFlag.
      for (const arg of rest) {
        if (arg.startsWith('-O') || matchesBannedFlag(arg, ['--open-files-in-pager'])) {
          return deny('`git grep -O` / `--open-files-in-pager` is not allowed because it launches a pager program');
        }
      }
      return ALLOW;
    }

    case 'branch': {
      // Read-only branch listing ONLY. Any flag outside the list-mode set creates/deletes/renames.
      const allowedFlags = new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--contains', '--merged', '--no-merged']);
      const listModeFlags = new Set(['--list', '--contains', '--merged', '--no-merged']);
      let hasListMode = false;
      const positionals: string[] = [];
      for (const arg of rest) {
        if (arg.startsWith('-')) {
          if (!allowedFlags.has(arg)) {
            return deny(`\`git branch ${arg}\` is not a read-only branch operation`);
          }
          if (listModeFlags.has(arg)) hasListMode = true;
        } else {
          positionals.push(arg);
        }
      }
      // A bare positional (`git branch new-feature`) CREATES a branch. Only allow positionals as the
      // argument to a list-mode flag (`git branch --contains <commit>`).
      if (positionals.length > 0 && !hasListMode) {
        return deny('`git branch <name>` creates a branch and is not read-only');
      }
      return ALLOW;
    }

    case 'tag': {
      // Read-only tag listing ONLY. `git tag <name>` creates a tag.
      const listModeFlags = new Set(['-l', '--list']);
      let hasListMode = false;
      const positionals: string[] = [];
      for (const arg of rest) {
        if (arg.startsWith('-')) {
          if (arg === '-l' || arg === '--list' || arg.startsWith('-n')) {
            if (listModeFlags.has(arg)) hasListMode = true;
            continue;
          }
          return deny(`\`git tag ${arg}\` is not a read-only tag operation`);
        }
        positionals.push(arg);
      }
      if (positionals.length > 0 && !hasListMode) {
        return deny('`git tag <name>` creates a tag and is not read-only');
      }
      return ALLOW;
    }

    case 'remote': {
      // bare `git remote`, `git remote -v`, or `git remote get-url <name>` ONLY. `remote show` = network.
      if (rest.length === 0) return ALLOW;
      if (rest.length === 1 && rest[0] === '-v') return ALLOW;
      if (rest.length === 2 && rest[0] === 'get-url') return ALLOW;
      return deny('`git remote` is only allowed as bare, `-v`, or `get-url <name>`');
    }

    case 'stash': {
      // Only `git stash list` / `git stash show ...` read; every other stash form writes.
      if (rest.length >= 1 && (rest[0] === 'list' || rest[0] === 'show')) return ALLOW;
      return deny('`git stash` is only allowed as `list` or `show`');
    }

    case 'reflog': {
      // bare `git reflog` or `git reflog show ...` read; `delete`/`expire` write.
      if (rest.length === 0) return ALLOW;
      if (rest[0] === 'show') return ALLOW;
      return deny('`git reflog` is only allowed as bare or `show`');
    }

    case 'config': {
      // Read-only config ONLY: `--list`/`-l`, or a `--get*` query. `git config a b` writes a value.
      if (rest.length === 0) {
        return deny('`git config` without a read-only flag can write configuration');
      }
      if (rest[0] === '--list' || rest[0] === '-l') return ALLOW;
      if (rest[0] === '--get' || rest[0] === '--get-all' || rest[0] === '--get-regexp') return ALLOW;
      return deny('`git config` is only allowed as `--list`/`-l` or `--get`/`--get-all`/`--get-regexp`');
    }

    case 'worktree': {
      if (rest.length === 1 && rest[0] === 'list') return ALLOW;
      return deny('`git worktree` is only allowed as `list`');
    }

    default:
      return deny(`\`git ${sub}\` is not a recognized read-only git subcommand`);
  }
}

// ---------------------------------------------------------------------------
// sed print-only walker.
// ---------------------------------------------------------------------------

/** Long options that change only how sed reads and matches; exact spellings only, so an abbreviation fails closed. */
const SED_ALLOWED_LONG: ReadonlySet<string> = new Set(['--regexp-extended', '--separate', '--null-data', '--unbuffered', '--posix', '--sandbox']);
const SED_QUIET_LONG: ReadonlySet<string> = new Set(['--quiet', '--silent']);
/** `-n` plus the short forms of `SED_ALLOWED_LONG`; none takes a value, so a cluster's every letter is an option. */
const SED_ALLOWED_SHORT = 'nErsuz';

/**
 * `sed` as a reader: `-n` (or `--quiet`/`--silent`), only the options above, and exactly one script argument whose commands
 * are all `p`. Options may follow operands, as getopt permutes them, until `--`.
 */
function evalSedPrint(args: readonly string[]): ReadOnlyVerdict {
  const inPlace = (arg: string): ReadOnlyVerdict => deny(`\`sed\` with \`${arg}\` is not allowed because it edits files in place`);
  const scriptOption = (arg: string): ReadOnlyVerdict => deny(`\`sed\` with \`${arg}\` is not allowed; give exactly one script argument, with no \`-e\` or \`-f\``);
  let quiet = false;
  let script: string | undefined;
  let optionsEnded = false;
  for (const arg of args) {
    if (optionsEnded || arg === '-' || !arg.startsWith('-')) {
      script ??= arg;
      continue;
    }
    if (arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const name = arg.split('=', 1)[0]!;
      if (SED_QUIET_LONG.has(arg)) quiet = true;
      else if (SED_ALLOWED_LONG.has(arg)) continue;
      else if (name.length > 2 && '--in-place'.startsWith(name)) return inPlace(arg);
      else if (name.length > 2 && ('--expression'.startsWith(name) || '--file'.startsWith(name))) return scriptOption(arg);
      else return deny(`\`sed\` option \`${name}\` is not allowed`);
      continue;
    }
    for (const letter of arg.slice(1)) {
      if (letter === 'i') return inPlace(arg);
      if (letter === 'e' || letter === 'f') return scriptOption(arg);
      if (!SED_ALLOWED_SHORT.includes(letter)) return deny(`\`sed\` option \`-${letter}\` is not allowed`);
      if (letter === 'n') quiet = true;
    }
  }
  if (!quiet) return deny("`sed` without `-n` is not allowed; read lines with `sed -n '<address>p' <file>`");
  if (script === undefined) return deny('`sed` needs a script');
  return sedScriptVerdict(script);
}

/**
 * The print-only script grammar: `cmd (';' cmd)*`, `cmd := addr? 'p'`, `addr := line (',' (line | '+' N))?`,
 * `line := N | '$' | N '~' N | '/' re '/' 'I'?`, where `re` holds no unescaped `/` and no line break, which is where GNU sed's
 * own scan ends a regex. Blanks may stand around a command.
 */
function sedScriptVerdict(script: string): ReadOnlyVerdict {
  let i = 0;
  const shown = (ch: string): string => (ch === '\n' ? '\\n' : ch);
  const blanks = (): void => {
    while (script[i] === ' ' || script[i] === '\t') i++;
  };
  const number = (): boolean => {
    const start = i;
    while (/[0-9]/.test(script[i] ?? '')) i++;
    return i > start;
  };
  const badAddress = (): ReadOnlyVerdict => {
    const at = script[i] === undefined ? 'the end of the script' : `\`${shown(script[i]!)}\``;
    return deny(`a \`sed\` address must be a line number, \`$\`, \`N~N\`, /regex/ or \`+N\`, not ${at}`);
  };
  const line = (): ReadOnlyVerdict | null => {
    if (script[i] === '$') {
      i++;
      return null;
    }
    if (script[i] === '/') {
      for (i++; i < script.length && script[i] !== '/'; i++) {
        if (script[i] === '\\') i++;
        if (script[i] === '\n') return deny('a `sed` address /regex/ with a line break is not allowed');
      }
      if (i >= script.length) return deny('a `sed` address /regex/ is not closed');
      i++;
      if (script[i] === 'I') i++;
      return null;
    }
    if (!number()) return badAddress();
    if (script[i] === '~') {
      i++;
      if (!number()) return badAddress();
    }
    return null;
  };
  for (;;) {
    blanks();
    if (script[i] !== undefined && /[0-9$/]/.test(script[i]!)) {
      const first = line();
      if (first) return first;
      if (script[i] === ',') {
        i++;
        if (script[i] === '+') {
          i++;
          if (!number()) return badAddress();
        } else {
          const second = line();
          if (second) return second;
        }
      }
      blanks();
    }
    const command = script[i];
    if (command === undefined) return deny('a `sed` script command is missing; only `p` is allowed');
    if (command !== 'p') {
      return deny(`\`sed\` script command \`${shown(command)}\` is not allowed; only \`p\` after a line number, \`$\`, \`N~N\` or /regex/ address is`);
    }
    i++;
    blanks();
    if (i >= script.length) return ALLOW;
    if (script[i] !== ';') return deny(`\`sed\` script text \`${shown(script[i]!)}\` after \`p\` is not allowed; separate commands with \`;\``);
    i++;
  }
}

// ---------------------------------------------------------------------------
// Path screens: wildcards, network paths, environment files and procfs walks.
// ---------------------------------------------------------------------------

/**
 * The first word of a bash segment holding an unquoted `*`, `?` or `[`, as written, and that character. bash replaces such a
 * word with the file names it matches before the program starts, so the classifier cannot know the argv (a file named
 * `-n` becomes an option of `ls *`).
 */
function unquotedWildcard(segment: string): { word: string; char: string } | undefined {
  let state: ScanState = 'none';
  let wordStart = 0;
  let found: string | undefined;
  let i = 0;
  for (; i < segment.length; i++) {
    const ch = segment[i]!;
    if (state === 'single') {
      if (ch === "'") state = 'none';
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (state === 'double') {
      if (ch === '"') state = 'none';
      continue;
    }
    if (ch === "'") state = 'single';
    else if (ch === '"') state = 'double';
    else if (ch === ' ' || ch === '\t') {
      if (found !== undefined) break;
      wordStart = i + 1;
    } else if (found === undefined && (ch === '*' || ch === '?' || ch === '[')) found = ch;
  }
  return found === undefined ? undefined : { word: segment.slice(wordStart, i), char: found };
}

/**
 * The parts of an argument a program may open as a path: the word, the text after each `=`, a single-dash word's attached
 * value, and the file after a leading `@` (a response file, as binutils reads it).
 */
function pathParts(word: string): string[] {
  const parts = [word];
  if (word.startsWith('@')) parts.push(word.slice(1));
  for (let i = word.indexOf('='); i >= 0; i = word.indexOf('=', i + 1)) parts.push(word.slice(i + 1));
  const letters = /^-[A-Za-z0-9]+/.exec(word);
  if (letters && !word.startsWith('--')) parts.push(word.slice(letters[0].length));
  return parts.filter((part) => part !== '');
}

/** A path's segments; Windows, MSYS2 and PowerShell all read `\` as a separator too. */
function segmentsOf(part: string): string[] {
  return part.split(/[\\/]/);
}

/** Whether a PowerShell wildcard pattern (`*`, `?`, `[az]`, `[a-z]`) matches name, ignoring case, as the providers match paths. */
function psWildcardMatches(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  // matched[j]: the pattern read so far matches the first j characters of name.
  let matched = Array.from({ length: n.length + 1 }, (_, j) => j === 0);
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    const close = ch === '[' ? p.indexOf(']', i + 2) : -1;
    const accepts = (c: string): boolean => {
      if (ch === '?') return true;
      if (close < 0) return c === ch;
      const set = p.slice(i + 1, close);
      for (let k = 0; k < set.length; k++) {
        if (set[k + 1] === '-' && k + 2 < set.length) {
          if (c >= set[k]! && c <= set[k + 2]!) return true;
          k += 2;
        } else if (c === set[k]) return true;
      }
      return false;
    };
    const next = matched.map(() => false);
    for (let j = 0; j <= n.length; j++) {
      if (ch === '*') next[j] = matched[j]! || (j > 0 && next[j - 1]!);
      else next[j] = j > 0 && matched[j - 1]! && accepts(n[j - 1]!);
    }
    matched = next;
    if (close > 0) i = close;
  }
  return matched[n.length]!;
}

/** Whether a path segment names `name` (ignoring case), or, as a PowerShell wildcard pattern, may match it. */
function segmentNames(segment: string, name: string, wildcards: boolean): boolean {
  return wildcards ? psWildcardMatches(segment, name) : segment.toLowerCase() === name;
}

/**
 * Screen each argument for a network or device path (`leavesLocalDrives`): opening `\\host\share` sends the user's NTLM hash
 * to `host`. PowerShell also binds each element of a comma list as a path and reads a `FileSystem::` provider-qualified one.
 */
function networkPathRefusal(args: readonly string[], context: ShellCheckContext, dialect: ShellKind): ReadOnlyVerdict | null {
  for (const arg of args) {
    for (const part of argumentPaths(arg, dialect)) {
      if (leavesLocalDrives(part, context.allowedNetworkHosts)) {
        return deny(`a network or device path (\`${arg}\`) is not allowed: opening it can send your Windows credentials to another computer`);
      }
    }
  }
  return null;
}

const PS_FILESYSTEM_PROVIDER = /^(?:microsoft\.powershell\.core\\)?filesystem::/i;

/** The paths an argument may name (`pathParts`); under PowerShell, of each comma element, which a cmdlet binds as its own path, with a `FileSystem::` prefix dropped. */
function argumentPaths(arg: string, dialect: ShellKind): string[] {
  const elements = dialect === 'powershell' ? arg.split(',').map((element) => element.replace(PS_FILESYSTEM_PROVIDER, '')) : [arg];
  return elements.flatMap(pathParts);
}

/**
 * Environments are private (`/proc/<pid>/environ` is mode 0400) and Damocles refuses environment dumps, so no argument part
 * may end in a segment named `environ`. That holds whatever the working folder and whatever links the path crosses
 * (`proc/self/environ` after `cd /`, `/dev/fd/../environ`). A cmdlet's wildcard (`/proc/self/envir*`) counts where it can
 * reach procfs: in an absolute path, one with `..`, or after a `cd` that left the working folder (`walkRootRisk`).
 * Process listings stay proven: command lines are public (`/proc/<pid>/cmdline` is 0444; CWE-214 makes a secret there its program's bug).
 */
function environRefusal(args: readonly string[], dialect: ShellKind, wildcards: boolean, cwdMoved: boolean): ReadOnlyVerdict | null {
  for (const arg of args) {
    for (const part of argumentPaths(arg, dialect)) {
      const segments = segmentsOf(part);
      const reachesProcfs = cwdMoved || segments[0] === '' || segments.includes('..');
      if (segmentNames(segments.at(-1)!, 'environ', wildcards && reachesProcfs)) {
        return deny(`reading a file named \`environ\` (\`${arg}\`) is not allowed: \`/proc/<pid>/environ\` holds a process's environment secrets`);
      }
    }
  }
  return null;
}

const PS_REGISTRY_PROVIDER = /^(?:microsoft\.powershell\.core\\)?registry::/i;
// Cygwin's registry folders, as MSYS2 programs in Git Bash read them.
const PROCFS_REGISTRY = /^registry(?:32|64)?$/i;

/**
 * The subkeys below a user's hive that a path names, from the top: `HKCU:\Environment`, `Registry::HKEY_CURRENT_USER\Environment`,
 * `Registry::HKEY_USERS\<sid>\Environment` and `/proc/registry/HKEY_CURRENT_USER/Environment` all give `['Environment']`; a
 * hive, `Registry::`, `HKEY_USERS` or one of its users gives `[]`, and so does such a path holding `..`, which the registry
 * provider and Cygwin both resolve (`HKCU:\Software\..\Environment`). Undefined for any other path.
 * A `registry` segment is Cygwin's registry folder when `proc` comes before it, or when the path may climb or start
 * elsewhere than the working folder: it holds `..` (`/proc/self/../registry`), or is relative after `cd` left the working folder.
 */
function userHiveSubkeys(part: string, wildcards: boolean, cwdMoved: boolean): string[] | undefined {
  const provider = PS_REGISTRY_PROVIDER.exec(part);
  const written = segmentsOf(provider ? part.slice(provider[0].length) : part);
  const segments = written.filter((segment) => segment !== '' && segment !== '.');
  const climbs = segments.includes('..');
  let hive: string;
  let below: string[];
  const drive = provider ? null : /^(hkcu|hku):(.*)$/i.exec(segments[0] ?? '');
  if (provider || drive === null) {
    const registryFolder = (segment: string, i: number): boolean =>
      PROCFS_REGISTRY.test(segment) && (segments[i - 1]?.toLowerCase() === 'proc' || climbs || (cwdMoved && written[0] !== ''));
    const start = provider ? 0 : segments.findIndex(registryFolder) + 1;
    if (!provider && start === 0) return undefined;
    if (start === segments.length) return [];
    hive = segments[start]!;
    below = segments.slice(start + 1);
  } else {
    hive = drive[1]!;
    // `HKCU:Environment` is relative to the drive's location, its root in a fresh session.
    below = [...(drive[2] && drive[2] !== '.' ? [drive[2]] : []), ...segments.slice(1)];
  }
  const cu = segmentNames(hive, 'hkey_current_user', wildcards) || segmentNames(hive, 'hkcu', wildcards);
  const users = segmentNames(hive, 'hkey_users', wildcards) || segmentNames(hive, 'hku', wildcards);
  if (!cu && !users && !(provider && climbs)) return undefined;
  if (climbs || below.includes('..')) return [];
  return cu ? below : below.slice(1);
}

/**
 * A user's saved environment variables are as private as a process's (`HKCU\Environment`, `HKCU\Volatile Environment` and
 * their `HKEY_USERS\<sid>` forms are readable only by the user, SYSTEM and administrators), so no argument may name those
 * keys, a value under them, or a key above them that a listing or walk would show them from. The system-wide
 * `HKLM\...\Session Manager\Environment`, which every user can read, and every other key stay readable.
 */
function registryEnvironmentRefusal(args: readonly string[], dialect: ShellKind, wildcards: boolean, cwdMoved: boolean): ReadOnlyVerdict | null {
  for (const arg of args) {
    for (const part of argumentPaths(arg, dialect)) {
      const subkeys = userHiveSubkeys(part, wildcards, cwdMoved);
      if (subkeys === undefined) continue;
      const key = subkeys[0];
      if (key === undefined || segmentNames(key, 'environment', wildcards) || segmentNames(key, 'volatile environment', wildcards)) {
        return deny(`reading \`${arg}\` is not allowed: a user's \`Environment\` and \`Volatile Environment\` registry keys hold their saved environment secrets`);
      }
    }
  }
  return null;
}

/**
 * Why a folder a command walks may reach `/proc/<pid>/environ`, else undefined. The session's working folder is never `/`
 * nor inside procfs, so a walk reaches it only by climbing with `..` (`/dev/fd/..` is `/proc/self`), from wherever an
 * earlier `cd` moved, or from an absolute path that is the root or holds a `proc` segment.
 */
function walkRootRisk(root: string, cwdMoved: boolean, wildcards: boolean): string | undefined {
  const segments = segmentsOf(root);
  if (segments.includes('..')) return 'a path with `..`';
  if (segments[0] !== '') return cwdMoved ? 'a relative path after `cd` left the working folder' : undefined;
  if (segments.some((segment) => segmentNames(segment, 'proc', wildcards))) return 'a `proc` folder';
  if (segments.every((segment) => segment === '' || segment === '.')) return 'the root folder';
  return undefined;
}

/** Judges every path any argument names (`argumentPaths`), since an option's value can name a folder too (`--from-file=DIR`). */
function walkRefusal(subject: string, args: readonly string[], dialect: ShellKind, cwdMoved: boolean, wildcards: boolean): ReadOnlyVerdict | null {
  // No operand walks the working folder.
  const roots = [...args.flatMap((arg) => argumentPaths(arg, dialect)), ...(operands(args).length === 0 ? ['.'] : [])];
  for (const root of roots) {
    const risk = walkRootRisk(root, cwdMoved, wildcards);
    if (risk) {
      return deny(`${subject} over ${risk} (\`${root}\`) is not allowed: it can reach \`/proc/<pid>/environ\`, which holds environment secrets; name a folder below the working folder`);
    }
  }
  return null;
}

/**
 * Whether a bash-table program may read the files of a folder and print them: rg, grep recursing, diff (two folders compare
 * their same-named files), and git's `diff`, which runs as `--no-index` on a path outside the working tree.
 */
function walksFolders(cmd: string, args: readonly string[]): boolean {
  switch (cmd) {
    case 'rg':
      return true;
    case 'grep':
      return args.some((arg) => clusterBansLetter(arg, ['r', 'R', 'd']) || matchesBannedFlag(arg, ['--recursive', '--dereference-recursive', '--directories']));
    case 'diff':
      return true;
    case 'git':
      return args.find((arg) => !arg.startsWith('-')) === 'diff' || args.some((arg) => matchesBannedFlag(arg, ['--no-index']));
    default:
      return false;
  }
}

/** The operands of a bash-table command (words not starting with `-`, and a lone `-`), which a walker may take as folders. */
function operands(args: readonly string[]): string[] {
  return args.filter(isPositionalOperand);
}

/** Whether `cd` with these arguments leaves the working folder for a place a later relative path cannot be judged from. */
function cdLeavesWorkingFolder(args: readonly string[]): boolean {
  const target = operands(args)[0];
  if (target === undefined || target === '-' || target.startsWith('~') || /^[A-Za-z]:/.test(target)) return true;
  const segments = segmentsOf(target);
  return segments[0] === '' || segments.includes('..');
}

/**
 * The screens every bash-table program gets under either shell, before its rule: network paths, `environ`, and the folders
 * `cd` enters or a walker reads. `wildcards`: arguments are PowerShell wildcard patterns (a cmdlet's), not literal paths.
 */
function nativePathRefusal(cmd: string, args: readonly string[], cwdMoved: boolean, context: ShellCheckContext, dialect: ShellKind): ReadOnlyVerdict | null {
  const screened = networkPathRefusal(args, context, dialect) ?? environRefusal(args, dialect, false, cwdMoved) ?? registryEnvironmentRefusal(args, dialect, false, cwdMoved);
  if (screened) return screened;
  if (cmd === 'cd') {
    const target = operands(args)[0];
    if (target !== undefined && segmentsOf(target).some((segment) => segmentNames(segment, 'proc', false))) {
      return deny(`\`cd\` into a \`proc\` folder (\`${target}\`) is not allowed: a later command could read \`environ\` there by a relative name`);
    }
    // PowerShell's `cd` enters a provider (`HKCU:`, `Registry::`), where a later relative name reads that store.
    if (target !== undefined && /^[^\\/:]{2,}:|::/.test(target)) {
      return deny(`\`cd\` into a PowerShell drive or provider other than a file system drive (\`${target}\`) is not allowed`);
    }
  }
  return walksFolders(cmd, args) ? walkRefusal(`\`${cmd}\` reading folders`, args, dialect, cwdMoved, false) : null;
}

// ---------------------------------------------------------------------------
// Bash classification pipeline.
// ---------------------------------------------------------------------------

function classifyBash(command: string, context: ShellCheckContext): ReadOnlyVerdict {
  // Stage 0 — strip provably inert redirections. The stripped string feeds BOTH stage 1 and stage 2,
  // else `>` and `/dev/null` land in the arg list and break the positional-count rule.
  const scannable = stripNoOpRedirections(command);

  // Stage 1 — structural scan.
  const structural = scanStructure(scannable);
  if (structural) return structural;

  // Stage 2 — segmentation; every segment must independently pass. A `cd` changes where the later segments' relative paths point.
  const segments = segment(scannable);
  let cwdMoved = false;
  for (const [index, { text: seg }] of segments.entries()) {
    const trimmed = seg.trim();
    if (trimmed === '') {
      // `ls;` runs `ls` and nothing after it; an empty segment anywhere else, or after `|`, `&&` or `||`, is a syntax error.
      if (index > 0 && index === segments.length - 1 && segments[index - 1]!.endedBy === ';') continue;
      return deny('an empty command segment is not allowed');
    }

    // Stage 3 — first-token rule.
    if (firstTokenIsQuoted(seg)) {
      return deny('a quoted command name is not allowed');
    }
    const tokens = tokenize(seg, 'bash');
    const cmd = tokens[0];
    if (cmd === undefined) {
      return deny('an empty command segment is not allowed');
    }
    const args = tokens.slice(1);

    if (cmd.includes('=')) {
      return deny(`an environment-assignment prefix (\`${cmd}\`) is not allowed`);
    }
    if (cmd.includes('/') || cmd.includes('\\') || cmd.startsWith('.')) {
      return deny(`a path-qualified command (\`${cmd}\`) is not allowed; use a bare read-only command name`);
    }

    const wildcard = unquotedWildcard(seg);
    if (wildcard) {
      return deny(
        `an unquoted wildcard (\`${wildcard.char}\` in \`${wildcard.word}\`) is not allowed: the shell replaces it with file names before the command runs, and a file name can become an option. Quote the pattern and let the tool match it (\`rg -g '*.md' foo\`, \`find src -name '*.ts'\`)`,
      );
    }

    // Path screens run before the table lookup, so an allowlisted reader pointed at such a path is still denied.
    const pathRefusal = nativePathRefusal(cmd, args, cwdMoved, context, 'bash');
    if (pathRefusal) return pathRefusal;
    if (cmd === 'cd' && cdLeavesWorkingFolder(args)) cwdMoved = true;

    const rule = BASH_RULES.get(cmd);
    if (!rule) {
      return deny(`\`${cmd}\` is not a recognized read-only command`);
    }

    // Stage 4 — per-command rule.
    const verdict = applyCommandRule(cmd, args, rule);
    if (!verdict.readOnly) {
      return verdict;
    }
  }

  return ALLOW;
}

// ===========================================================================
// PowerShell classification pipeline (Slice 3) — STRICTER than bash.
//
// PowerShell's grammar is far harder to reason about than POSIX sh, so this classifier is
// deliberately more restrictive. Everything the bash pipeline shares is REUSED (`deny`, `ALLOW`,
// `CommandRule`, `BASH_RULES`, `evalGit`, `evalFlagGated`, `evalExactArgs`, `matchesBannedFlag`,
// `clusterBansLetter`, `tokenize`, `firstTokenIsQuoted`). The bash structural scan / segmenter are
// NOT reused: PS does not use backslash as an escape character (backtick is the PS escape char, and
// it is banned wholesale), and PS must additionally ban scriptblocks `{}`, parentheses `()`, and the
// call operator `&`. So PS gets its OWN structural scan and pipeline splitter below.
//
// The bash `/dev/null` redirection carve-out is DELIBERATELY NOT extended here. PS spells the bit
// bucket `$null`, and `scanStructurePowershell`'s `$` ban is load-bearing — it also stops `$(…)`
// subexpressions and `$env:` reads. Trading a provable structural ban for a semantic one is not worth
// it, so `2>$null` stays blocked on PowerShell (asserted by test).
// ===========================================================================

// ---------------------------------------------------------------------------
// PS Stage 1 — structural scan (PS-specific; backtick is the escape char, `\` is a literal path sep).
// ---------------------------------------------------------------------------

/**
 * The whitespace codepoints PowerShell treats as ARGUMENT SEPARATORS beyond the plain space/tab that the
 * shared `tokenize()` splits on. Verified against pwsh 7 and Windows PowerShell 5.1: each of these breaks
 * a command line into separate arguments, but `tokenize()` keeps them INSIDE a token — so `Get-ChildItem
 * <VT>env:` is one token here (missing the `env:` PSDrive screen) yet two arguments to PowerShell (which
 * dumps every env var). Left unhandled this is an UNDER-BLOCK. We reject the whole class structurally,
 * BEFORE tokenizing, so no exotic-whitespace token ever reaches the arg screen or the flag-ban logic.
 * `\r`/`\n` are covered separately by the multi-line check; the zero-width space `\u200b` is intentionally
 * excluded because PowerShell does NOT treat it as a separator (it stays part of the token, matching
 * `tokenize()` — no split divergence, no under-block).
 */
// eslint-disable-next-line no-control-regex -- VT/FF/NEL are intentional PS argument separators to reject
const PS_ARG_SEPARATOR_WHITESPACE = /[\u000b\u000c\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/**
 * Scan a raw PowerShell command for structural metacharacters that could execute code, redirect, or
 * escape the static token analysis. Returns a DENY verdict naming the offending category, or `null` if
 * structurally clean. Each category returns a DISTINCT reason substring so callers/tests can assert it.
 *
 * States: none / single / double.
 * - Single quotes `'...'` are FULLY LITERAL in PS — nothing inside them expands or executes, only the
 *   closing `'` matters (so `Select-String 'literal $x'` is safe). A `''` inside a single-quoted string
 *   (and `""` inside a double-quoted one) is one literal quote and does not close the string.
 * - `$` and backtick are banned in BOTH none AND double states: PS expands `$var`/`$(...)` and processes
 *   backtick escapes inside double quotes, so `"$(Get-Date)"` MUST be blocked.
 * - Exotic argument-separator whitespace (see `PS_ARG_SEPARATOR_WHITESPACE`) is banned in BOTH none AND
 *   double states: the shared tokenizer does not split on it, so it could smuggle a second argument past
 *   the arg screen / flag-ban logic. Banning it in the double state too is a harmless over-block.
 * - `; & { } ( ) > <` are execution/redirection vectors only OUTSIDE quotes; inside double quotes they
 *   are literal text, so they are banned in the none state only.
 * - PowerShell does NOT use `\` as an escape char (backtick is), so this scan treats `\` as an ordinary
 *   literal path separator — it is never consumed as an escape (unlike the bash scan).
 */
function scanStructurePowershell(command: string): ReadOnlyVerdict | null {
  let state: ScanState = 'none';
  let wordStart = true;
  let parameterWord = false;
  let quotedWord = false;
  // A word that starts with a quote ends at its closing quote; what follows starts another word.
  const closeQuote = (i: number): ReadOnlyVerdict | null => {
    state = 'none';
    if (!quotedWord) return null;
    quotedWord = false;
    wordStart = true;
    parameterWord = false;
    const next = command[i + 1];
    if (next === '.' || next === '[' || command.startsWith('::', i + 1)) {
      return deny(`member access or indexing (\`${next === ':' ? '::' : next}\`) after a quoted word is not allowed`);
    }
    return null;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // PowerShell reads U+2018-U+201B as `'` and U+201C-U+201E as `"`, so each opens or closes a string.
    if (ch !== undefined && ch >= '\u2018' && ch <= '\u201e') return deny('a typographic quote character is not allowed');

    if (state === 'single') {
      // Single quotes are fully literal; a doubled `''` is one literal quote.
      if (ch === "'") {
        if (command[i + 1] === "'") i++;
        else {
          const verdict = closeQuote(i);
          if (verdict) return verdict;
        }
      }
      continue;
    }

    // Banned in BOTH none and double states (newlines, exotic arg-separator whitespace, PS escape
    // char, PS expansion). The whitespace class is rejected here — BEFORE tokenizing — because the
    // shared tokenizer only splits on space/tab, so an unhandled separator would smuggle a second
    // argument past the PSDrive/flag screens (a real under-block, e.g. `Get-ChildItem \u000benv:`).
    if (ch === '\n' || ch === '\r') return deny('multi-line commands are not allowed');
    if (ch !== undefined && PS_ARG_SEPARATOR_WHITESPACE.test(ch)) {
      return deny('an unsupported whitespace character is not allowed');
    }
    if (ch === '`') return deny('the PowerShell escape character (backtick) is not allowed');
    if (ch === '$') return deny('variable or subexpression expansion (`$`) is not allowed');

    if (state === 'double') {
      // Inside double quotes, `; & { } ( ) > <` are literal; a doubled `""` is one literal quote.
      if (ch === '"') {
        if (command[i + 1] === '"') i++;
        else {
          const verdict = closeQuote(i);
          if (verdict) return verdict;
        }
      }
      continue;
    }

    // none state.
    if (ch === ' ' || ch === '\t' || ch === '|') {
      wordStart = true;
      parameterWord = false;
      continue;
    }
    if (wordStart && ch === '-' && command[i + 1] !== '-') parameterWord = true;
    if (ch === "'" || ch === '"') {
      quotedWord = wordStart;
      wordStart = false;
      state = ch === "'" ? 'single' : 'double';
      continue;
    }
    wordStart = false;
    // PowerShell ends a `-name` parameter word at `:` or before `.` or `[` and passes what follows as another argument.
    if (parameterWord && (ch === ':' || ch === '.' || ch === '[')) {
      return deny(`a \`-parameter\` word holding \`${ch}\` is not allowed under PowerShell`);
    }
    // PowerShell reads an en dash, em dash or horizontal bar as `-` when it starts a parameter.
    if (ch !== undefined && ch >= '\u2013' && ch <= '\u2015') return deny('a typographic dash outside quotes is not allowed');
    // `@name` splats a variable, `@env:NAME` included, into arguments.
    if (ch === '@') return deny('splatting (`@`) is not allowed');
    // A `;` with only blanks after it ends the one statement and starts no other.
    if (ch === ';' && !/^[ \t]*$/.test(command.slice(i + 1))) return deny('a statement separator (`;`) is not allowed');
    if (ch === '&') return deny('the call/background operator (`&`) is not allowed');
    if (ch === '{' || ch === '}') return deny('a script block (`{`/`}`) is not allowed');
    if (ch === '(' || ch === ')') return deny('a parenthesized expression (`(`/`)`) is not allowed');
    if (ch === '>') return deny('redirection (`>`) is not allowed');
    if (ch === '<') return deny('redirection (`<`) is not allowed');
    // After `--%` PowerShell passes the rest of the line verbatim and expands `%NAME%` environment variables.
    if (ch === '-' && command.startsWith('--%', i)) return deny('the stop-parsing token (`--%`) is not allowed');
  }

  if (state !== 'none') return deny('an unbalanced quote is not allowed');
  return null;
}

// ---------------------------------------------------------------------------
// PS Stage 2 — pipeline splitter (split on unquoted `|` ONLY; no `\` escape).
// ---------------------------------------------------------------------------

/**
 * Split a (structurally validated) PowerShell command into pipeline stages on unquoted `|`. Statement
 * separators (`;`) and the call operator (`&`) are already structurally banned, so `|` is the only
 * splitter. Quote-aware so `Select-String 'a|b'` stays a single segment. PS does NOT treat `\` as an
 * escape char, so backslashes are copied verbatim (never consume the next character).
 */
function splitPowershellPipeline(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let state: ScanState = 'none';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (state === 'single') {
      current += ch;
      if (ch === "'") state = 'none';
      continue;
    }
    if (state === 'double') {
      current += ch;
      if (ch === '"') state = 'none';
      continue;
    }

    // none state — no backslash escape in PowerShell.
    if (ch === "'") {
      state = 'single';
      current += ch;
      continue;
    }
    if (ch === '"') {
      state = 'double';
      current += ch;
      continue;
    }
    if (ch === '|') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

// ---------------------------------------------------------------------------
// PS alias map + rule table.
// ---------------------------------------------------------------------------

/**
 * Common PowerShell aliases the model emits constantly → their canonical cmdlet (all lowercased). The
 * incoming command token is lowercased and resolved through this map BEFORE the PS-table lookup, so the
 * rules live once on the canonical name. `ls`/`cat`/`pwd`/`echo`/`sort` are deliberately ABSENT — the
 * bash-table-first lookup already covers them with the correct, stricter native-binary rules. `write` is absent too:
 * pwsh on Linux and macOS has no such alias and runs write(1), which messages another user's terminal.
 */
const PS_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  ['dir', 'get-childitem'],
  ['gci', 'get-childitem'],
  ['gc', 'get-content'],
  ['type', 'get-content'],
  ['gl', 'get-location'],
  ['gi', 'get-item'],
  ['sls', 'select-string'],
  ['select', 'select-object'],
  ['measure', 'measure-object'],
  ['ft', 'format-table'],
  ['fl', 'format-list'],
  ['fw', 'format-wide'],
]);

/**
 * The PowerShell allowlist, keyed by LOWERCASED canonical cmdlet name (PS is case-insensitive, so the
 * incoming token is lowercased before lookup). Every entry is `always`: these are pure readers/
 * formatters whose only dangerous parameters take scriptblocks — and scriptblocks (`{`) are already
 * structurally impossible per `scanStructurePowershell`. A cmdlet absent from this table is denied.
 *
 * DELIBERATELY ABSENT (→ default deny): `Get-Help` (its `-Online` switch launches a browser and PS
 * parameter abbreviation makes a flag ban fragile), `Where-Object`/`ForEach-Object` (scriptblocks),
 * `Invoke-*`, `Set-*`, `Out-File`, `Start-Process`, `New-*`, `Remove-*`, `cmd`, `powershell`, `pwsh`.
 * `git` is NOT here — it resolves via BASH-TABLE-FIRST (`BASH_RULES.get('git')` → `evalGit`).
 */
const PS_RULES: ReadonlyMap<string, CommandRule> = new Map<string, CommandRule>([
  ['get-childitem', { kind: 'always' }],
  ['get-content', { kind: 'always' }],
  ['get-item', { kind: 'always' }],
  ['get-itemproperty', { kind: 'always' }],
  ['get-location', { kind: 'always' }],
  ['get-date', { kind: 'always' }],
  // Command lines are public (/proc/<pid>/cmdline is 0444; CWE-214 makes a secret there its program's bug), environments are not.
  ['get-process', { kind: 'always' }],
  ['get-service', { kind: 'always' }],
  ['get-command', { kind: 'always' }],
  ['get-member', { kind: 'always' }],
  ['select-string', { kind: 'always' }],
  ['select-object', { kind: 'always' }],
  ['measure-object', { kind: 'always' }],
  ['test-path', { kind: 'always' }],
  ['resolve-path', { kind: 'always' }],
  ['split-path', { kind: 'always' }],
  ['join-path', { kind: 'always' }],
  ['sort-object', { kind: 'always' }],
  ['format-table', { kind: 'always' }],
  ['format-list', { kind: 'always' }],
  ['format-wide', { kind: 'always' }],
  ['out-string', { kind: 'always' }],
  ['write-output', { kind: 'always' }],
]);

/**
 * PSDrive read screen. `env:`/`function:`/`variable:` PSDrive reads (`gci env:`, `Get-Content env:PATH`)
 * dump process secrets, so ANY token (command OR argument) matching one of these prefixes denies,
 * case-insensitively, BEFORE the table lookup. `variable:` is harmless in a fresh process but is blocked
 * for symmetry with `env:`/`function:`. Applied to the already-tokenized (unquoted) values. A provider-qualified path
 * (`Environment::NAME`, `Microsoft.PowerShell.Core\Function::x`) reaches the same stores without a drive. A cmdlet
 * binds each element of a comma list (`x,env:NAME`) as its own path, so each element is screened.
 */
function screenPsDriveTokens(tokens: readonly string[]): ReadOnlyVerdict | null {
  for (const raw of tokens.flatMap((token) => token.split(','))) {
    const token = raw.replace(/^[^\\]*\\(?=(?:environment|function|variable)::)/i, '');
    if (/^env:/i.test(token) || /^environment::/i.test(token)) {
      return deny('reading the `env:` PSDrive is not allowed (it exposes environment secrets)');
    }
    if (/^function:/i.test(token)) {
      return deny('reading the `function:` PSDrive is not allowed');
    }
    if (/^variable:/i.test(token)) {
      return deny('reading the `variable:` PSDrive is not allowed');
    }
  }
  return null;
}

/**
 * PowerShell parameters that turn an otherwise read-only cmdlet into a HANG (or mutation), keyed by
 * canonical (lowercased) cmdlet name. Each value is a list of LOWERCASED minimal parameter prefixes that
 * still bind the dangerous parameter. PowerShell accepts any UNAMBIGUOUS leading substring of a parameter
 * name, so `-Wait` and `-Wai` both bind Get-Content's `-Wait` (follow mode), while `-Wa`/`-W` are
 * ambiguous with `-WarningAction`/`-WarningVariable` and ERROR out — `-wai` is the shortest spelling that
 * runs. pi's PowerShell tool has a 120s default timeout, so a `-Wait` follow stalls the turn for two
 * minutes: the same hang class as the banned bash `tail -f`. An exact `-Wait` token ban would be leaky
 * (the `-Wai` abbreviation slips through), so we ban the whole prefix family.
 */
const PS_BANNED_PARAM_PREFIXES: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['get-content', ['-wai']], // -Wait / -Wai — follow mode, hangs the turn
  ['cat', ['-wai']], // Windows PowerShell aliases `cat` to Get-Content, ahead of the bash-table rule
]);

/**
 * Deny any argument that binds a hang-inducing PowerShell parameter of the resolved cmdlet (see
 * `PS_BANNED_PARAM_PREFIXES`). Case-insensitive prefix match; a `-Wait:$true`-style value is already
 * impossible because `$` is banned structurally.
 */
function screenPsBannedParams(canonical: string, args: readonly string[]): ReadOnlyVerdict | null {
  const prefixes = PS_BANNED_PARAM_PREFIXES.get(canonical);
  if (!prefixes) return null;
  for (const arg of args) {
    const lowered = arg.toLowerCase();
    for (const prefix of prefixes) {
      if (lowered.startsWith(prefix)) {
        return deny(`\`${canonical}\` with \`${arg}\` (follow/wait mode) is not allowed because it hangs the turn`);
      }
    }
  }
  return null;
}

/**
 * Deny a native command argument whose argv the program may not receive as one value. Windows PowerShell 5.1's legacy
 * argument passing rebuilds a command line without escaping, so the program's parser re-splits an argument holding `"`,
 * drops an empty one, and reads a trailing `\` of an argument it wrapped in quotes as escaping the closing quote.
 * pwsh 7 passes an unquoted `,` list holding a quoted element as several arguments. An MSYS2 program (Git's usr/bin)
 * parses its own command line, removing `'`, brace-expanding `{a,b}` and replacing `@file` with the file's words.
 */
function screenPsNativeArgs(segment: string, args: readonly string[]): ReadOnlyVerdict | null {
  let quote: string | undefined;
  for (const ch of segment) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ',') {
      return deny('an unquoted `,` in a native command is not allowed under PowerShell');
    }
  }
  for (const arg of args) {
    if (arg === '') return deny('an empty argument to a native command is not allowed under PowerShell');
    if (arg.startsWith('@')) return deny(`a native command argument starting with \`@\` (\`${arg}\`) is not allowed under PowerShell`);
    const reparsed = /["'{}]/.exec(arg);
    if (reparsed) return deny(`a native command argument holding \`${reparsed[0]}\` (\`${arg}\`) is not allowed under PowerShell`);
    if (/\s/.test(arg) && arg.endsWith('\\')) {
      return deny(`a native command argument with whitespace ending in \`\\\` (\`${arg}\`) is not allowed under PowerShell`);
    }
  }
  return null;
}

/** Apply a `CommandRule` (shared shape) to a resolved command + args — the SAME switch bash uses. */
function applyCommandRule(cmd: string, args: readonly string[], rule: CommandRule): ReadOnlyVerdict {
  switch (rule.kind) {
    case 'always':
      return ALLOW;
    case 'flagGated':
      return evalFlagGated(cmd, args, rule.bannedFlags, rule.bannedShortLetters);
    case 'exactArgs':
      return evalExactArgs(cmd, args, rule.allowed);
    case 'git':
      return evalGit(args);
    case 'sedPrint':
      return evalSedPrint(args);
    case 'date':
      return evalDate(args);
  }
}

// ---------------------------------------------------------------------------
// PowerShell classification pipeline.
// ---------------------------------------------------------------------------

function classifyPowershell(command: string, context: ShellCheckContext): ReadOnlyVerdict {
  // PS Stage 1 — structural scan (bans backtick/$/{}/()/;/&/></ newlines outside single quotes).
  const structural = scanStructurePowershell(command);
  if (structural) return structural;

  // PS Stage 2 — split into pipeline stages on unquoted `|`; every stage must independently pass. Stage 1 admits a `;` only
  // as the last character before trailing blanks, outside quotes, so it is dropped here.
  const segments = splitPowershellPipeline(command.replace(/;[ \t]*$/, ''));
  const stages: Array<{ seg: string; cmd: string; args: string[] }> = [];
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed === '') {
      return deny('an empty command segment is not allowed');
    }

    // Dot-sourcing: a stage whose first non-space chars are `.` then whitespace (`. ./x.ps1`) executes
    // the sourced script in the current scope. Distinct category, checked before tokenizing.
    if (/^\.\s/.test(trimmed)) {
      return deny('dot-sourcing (leading `. `) is not allowed');
    }

    // A quoted command name (`'Get-Content' x`) is a smuggling signal, denied exactly as in bash.
    if (firstTokenIsQuoted(seg)) {
      return deny('a quoted command name is not allowed');
    }

    // PowerShell quoting: `\` is a literal character and only a doubled quote escapes, so `"x\"` is the whole string `x\`.
    const tokens = tokenize(seg, 'powershell');
    const cmd = tokens[0];
    if (cmd === undefined) {
      return deny('an empty command segment is not allowed');
    }
    stages.push({ seg, cmd, args: tokens.slice(1) });
  }

  // A pipeline that hands a listing to Get-Content, Select-String or `cat` reads every file the listing names
  // (`Get-ChildItem /proc/self | Get-Content`), so the other stages' arguments are folders it walks.
  const readsListing = stages.length > 1 && stages.some(isPsContentReader);
  const cwdMoved = stages.some((stage) => stage.cmd === 'cd' && cdLeavesWorkingFolder(stage.args));
  // PowerShell searches PATH for a command name before it loads the module of the cmdlet that name means.
  const commandNames: string[] = [];
  for (const stage of stages) {
    const { seg, cmd, args } = stage;

    // PSDrive read screen over ALL tokens, BEFORE the table lookup (an allowlisted cmdlet reading
    // `env:` is still denied).
    const psDrive = screenPsDriveTokens([cmd, ...args]);
    if (psDrive) return psDrive;

    // Command-token path/assignment checks — identical to bash (over-blocking is acceptable).
    if (cmd.includes('=')) {
      return deny(`an environment-assignment prefix (\`${cmd}\`) is not allowed`);
    }
    if (cmd.includes('/') || cmd.includes('\\') || cmd.startsWith('.')) {
      return deny(`a path-qualified command (\`${cmd}\`) is not allowed; use a bare read-only command name`);
    }

    // Lookup order — BASH-TABLE-FIRST (platform-safety rule). On Linux/macOS pwsh, `sort`/`cat`/`ls`
    // are native binaries (not shadowed by aliases), so they MUST inherit the stricter bash rule (e.g.
    // `sort` bans `-o`). `git` is in the bash table (kind:'git'), so `git status`/`git commit` route
    // through the shared `evalGit` automatically — no separate PS git entry exists or is needed.
    // PowerShell on Windows resolves `expand` to expand.exe, the cabinet expander, which writes its destination operand.
    const bashRule = cmd === 'expand' ? undefined : BASH_RULES.get(cmd);
    if (bashRule) {
      const nativeArgs = screenPsNativeArgs(seg, args);
      if (nativeArgs) return nativeArgs;
      const wildcard = args.find((arg) => /[*?[]/.test(arg));
      if (wildcard !== undefined) {
        return deny(
          `a wildcard in a native command's argument (\`${wildcard}\`) is not allowed under PowerShell, quoted or not: Git's MSYS2 programs on Windows and pwsh on Linux and macOS replace it with file names before the program runs, and a file name can become an option. Match with a cmdlet instead (\`Get-ChildItem src -Filter *.ts\`, \`Select-String foo -Path *.md\`) or a type filter (\`rg -t md foo\`)`,
        );
      }
      const pathRefusal = nativePathRefusal(cmd, args, cwdMoved, context, 'powershell');
      if (pathRefusal) return pathRefusal;
      if (readsListing && !isPsContentReader(stage)) {
        const walk = walkRefusal(`\`${cmd}\` piped to a file reader`, args, 'powershell', cwdMoved, false);
        if (walk) return walk;
      }
      const aliasedParam = screenPsBannedParams(cmd, args);
      if (aliasedParam) return aliasedParam;
      const verdict = applyCommandRule(cmd, args, bashRule);
      if (!verdict.readOnly) return verdict;
      // PowerShell tries `Get-<name>` for a name it finds no command for.
      commandNames.push(cmd, ...(PS_WINDOWS_ALIAS_TARGETS.get(cmd) ?? []), `get-${cmd}`);
      continue;
    }

    // Not a native/bash command — resolve as a PowerShell cmdlet (case-insensitive; alias → canonical).
    const canonical = psCanonical(cmd);
    const psRule = PS_RULES.get(canonical);
    if (!psRule) {
      return deny(`\`${cmd}\` is not a recognized read-only PowerShell command`);
    }
    // A cmdlet matches its path arguments as wildcard patterns itself, so each screen tests the names it guards against them.
    const pathRefusal =
      networkPathRefusal(args, context, 'powershell') ?? environRefusal(args, 'powershell', true, cwdMoved) ?? registryEnvironmentRefusal(args, 'powershell', true, cwdMoved);
    if (pathRefusal) return pathRefusal;
    if (readsListing && !isPsContentReader(stage)) {
      const walk = walkRefusal(`\`${cmd}\` piped to a file reader`, args, 'powershell', cwdMoved, true);
      if (walk) return walk;
    }
    // Screen hang-inducing parameters (e.g. Get-Content -Wait) before applying the base rule.
    const bannedParam = screenPsBannedParams(canonical, args);
    if (bannedParam) return bannedParam;
    const verdict = applyCommandRule(canonical, args, psRule);
    if (!verdict.readOnly) return verdict;
    commandNames.push(canonical);
  }

  return { readOnly: true, commandNames };
}

/** The cmdlets bash-table names are aliases of on Windows. */
const PS_WINDOWS_ALIAS_TARGETS: ReadonlyMap<string, readonly string[]> = new Map([
  ['cat', ['get-content']],
  ['cd', ['set-location']],
  ['diff', ['compare-object']],
  ['echo', ['write-output']],
  ['ls', ['get-childitem']],
  ['pwd', ['get-location']],
  ['sort', ['sort-object']],
]);

/** A cmdlet name, lowercased, with an alias resolved. */
function psCanonical(cmd: string): string {
  const lowered = cmd.toLowerCase();
  return PS_ALIASES.get(lowered) ?? lowered;
}

/** Whether a pipeline stage reads the files its input names: Get-Content, Select-String, or `cat`, Windows' alias of Get-Content. */
function isPsContentReader(stage: { readonly cmd: string }): boolean {
  const canonical = psCanonical(stage.cmd);
  return stage.cmd === 'cat' || canonical === 'get-content' || canonical === 'select-string';
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Upper bound on the command string this classifier will even look at. Every stage is a linear
 * character walk, but they run SYNCHRONOUSLY on the extension host, so a pathological input still buys
 * editor-freeze time proportional to its length. No legitimate read-only command approaches this, and
 * refusing early is both cheaper and more honest than classifying it.
 */
export const MAX_COMMAND_LENGTH = 8192;

/**
 * Classify a shell command as provably read-only (safe to auto-run in plan mode) or not. Fails closed:
 * any command not positively recognized as read-only returns a DENY verdict with a category-naming
 * reason. Both bash and PowerShell are supported; PowerShell is classified more strictly.
 */
export function classifyReadOnlyShellCommand(shell: ShellKind, command: string, context: ShellCheckContext): ReadOnlyVerdict {
  if (command.length > MAX_COMMAND_LENGTH) {
    return deny(`the command is too long to classify (over ${MAX_COMMAND_LENGTH} characters)`);
  }
  if (shell === 'powershell') {
    return classifyPowershell(command, context);
  }
  return classifyBash(command, context);
}

/** A character standing for computed text: a word holding it is computed. */
export const COMPUTED_TEXT = '\u0000';

/** The builtins whose `NAME=value` operands are assignments. */
export const DECLARATION_BUILTINS: ReadonlySet<string> = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);

/**
 * A word's literal text, a variable it expands as `$NAME` or `${NAME}` (`quoted` inside double quotes), a `~` it
 * expands to the shell's HOME, or a `$(...)` command substitution: its parsed body (also in the segment's
 * `substitutions`) and the body as written.
 */
export type ShellPart =
  | string
  | { readonly variable: string; readonly quoted: boolean }
  | { readonly tilde: true }
  | { readonly substitution: ShellStructure; readonly body: string; readonly quoted: boolean };

export interface ShellAssignment {
  readonly name: string;
  readonly value: string | undefined;
  /** The value as written, quotes and expansions included; absent when the text does not give it (a `for` variable). */
  readonly raw?: string;
  /** The offset of the name in the parsed text. */
  readonly offset: number;
  /** Written `+=`. */
  readonly append: boolean;
  /** The value's parts, when only variables, `~` and `$(...)` make it computed. */
  readonly template?: readonly ShellPart[];
}

/** One simple command: its leading assignments and its words, each undefined when any part of it is computed. */
export interface ShellSegment {
  readonly assignments: readonly ShellAssignment[];
  readonly words: ReadonlyArray<string | undefined>;
  /** Each word as written, quotes and expansions included. */
  readonly rawWords: readonly string[];
  /** Each computed word's parts, when only variables, `~` and `$(...)` make it computed; undefined for the other words. */
  readonly templates: ReadonlyArray<readonly ShellPart[] | undefined>;
  /** Each word's offset in the parsed text. */
  readonly offsets: readonly number[];
  /** The parsed bodies of `$()`, backticks and process substitutions in this command; they run before it. */
  readonly substitutions: readonly ShellStructure[];
  /**
   * Whether the command runs exactly once where it stands: outside every compound command and `( )`, not after `&&`, `||`
   * or `|`, and neither piped nor put in the background.
   */
  readonly unconditional: boolean;
  /**
   * `&&` or `||` when the command runs only where the segment before it succeeded or failed: it follows that operator
   * directly, after a simple command that is not negated, with no compound command or reserved word between.
   */
  readonly guard?: '&&' | '||';
  /**
   * Whether the command runs exactly once each time a walk passes it, given its guard and each `if` branch it is in: not in
   * a pipeline or a background job, and not in a compound command that follows `&&`, `||` or `|`, is piped or is put in
   * the background.
   */
  readonly sequential: boolean;
  /**
   * The complete command it belongs to, counted from 0: bash reads one whole, up to a line break outside every compound
   * command and after no `&&`, `||` or `|`, before it runs any of it.
   */
  readonly line: number;
}

/** A run of segments, which stay flat in `ShellStructure.segments`. */
export interface ShellRange {
  readonly start: number;
  /** The index after the range's last segment. */
  readonly end: number;
}

/** A `for`, `while` or `until` loop over a run of segments, which stay flat in `ShellStructure.segments`. */
export interface ShellLoop {
  /** The first segment that repeats: a `while` or `until` condition, or the body after a `for` header. */
  readonly start: number;
  /** The index after the loop's last segment. */
  readonly end: number;
  /** A `for` header's segment, which runs once: its variable's assignment and the substitutions in its list. */
  readonly header?: number;
  readonly variable?: string;
  /**
   * Each list item's parts, a literal item as one string; absent without an `in` list, for `for ((`, and when an item is
   * a glob or a brace expansion or has any part that is not literal text, a plain variable, `~` or `$(...)`.
   */
  readonly items?: ReadonlyArray<readonly ShellPart[]>;
}

export interface ShellStructure {
  /** In the order they run; a compound command's redirections are a segment before its first one, run once. */
  readonly segments: readonly ShellSegment[];
  /** In the order they open, so an outer loop comes before the loops inside it. */
  readonly loops: readonly ShellLoop[];
  /** The `( )` subshells, in the order they open. */
  readonly subshells: readonly ShellRange[];
  /**
   * The branches of each `if`, in the order they open, each running whole or not at all: from `then` or `else` to the next
   * `elif`, `else` or `fi`, and from `elif` to the same, its condition included, with the body after its `then` a branch
   * inside it, since the condition may fail.
   */
  readonly branches: readonly ShellRange[];
  /**
   * Syntax the parse cannot follow: an unbalanced quote, substitution or compound command, a word after a compound
   * command's closing word, a heredoc without its end, a function or `case`.
   */
  readonly unparsable: boolean;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const RESERVED_SKIP: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time']);
// The reserved words that open a compound command, each with the word that closes it.
const COMPOUND_CLOSER: ReadonlyMap<string, string> = new Map([
  ['if', 'fi'],
  ['while', 'done'],
  ['until', 'done'],
  ['for', 'done'],
  ['{', '}'],
]);
const COMPOUND_CLOSE: ReadonlySet<string> = new Set(COMPOUND_CLOSER.values());
const RESERVED_UNPARSABLE: ReadonlySet<string> = new Set(['case', 'esac', 'function', 'select', 'coproc']);
// Unquoted, these make a word a glob, whose value the text does not give.
const GLOB_CHARS = '*?[';
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
// A declaration builtin's operand that assigns, an array element included.
const DECLARED = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const ARITHMETIC_TEST = /^-(eq|ne|lt|le|gt|ge)$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_AT = /[A-Za-z_][A-Za-z0-9_]*/y;

/** Index of the `'` closing the `$'` quote whose `'` is at `open`, where a backslash escapes the next character; -1 when unbalanced. */
function closingAnsiQuote(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === "'") return i;
  }
  return -1;
}

/** End index of the `$()`, `${}` or backtick expansion starting at `at`, `at` itself when none starts there, -1 when unbalanced. */
function expansionEnd(text: string, at: number): number {
  if (text[at] === '`') return closingBacktick(text, at);
  if (text[at] !== '$') return at;
  if (text[at + 1] === '(') return substitutionEnd(text, at);
  if (text[at + 1] === '{') return closingBrace(text, at + 1);
  if (text[at + 1] === "'") return closingAnsiQuote(text, at + 1);
  return at;
}

/** Index of the `"` closing the one at `open`, skipping escapes and the expansions inside; -1 when unbalanced. */
function closingDoubleQuote(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '"') return i;
    if (text[i] === '`' || (text[i] === '$' && (text[i + 1] === '(' || text[i + 1] === '{'))) {
      i = expansionEnd(text, i);
      if (i < 0) return -1;
    }
  }
  return -1;
}

/** End index of the `$(` at `dollar`: arithmetic when bash reads it so, else a command substitution read as a script; -1 when unbalanced. */
function substitutionEnd(text: string, dollar: number): number {
  if (text[dollar + 2] === '(') {
    const end = closingParen(text, dollar + 1, false);
    if (end >= 0 && isArithmetic(text, dollar, end)) return end;
  }
  return closingParen(text, dollar + 1, true);
}

/**
 * Index of the `)` closing the `(` at `open`, skipping quotes, expansions and nested parentheses; -1 when unbalanced.
 * In a `script` it also skips comments and heredoc bodies, as bash does; arithmetic has neither (`<<` is a shift there).
 */
function closingParen(text: string, open: number, script: boolean): number {
  let depth = 0;
  let wordStart = true;
  const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    const atWordStart = wordStart;
    wordStart = /[\s;&|()<>]/.test(ch);
    if (ch === '\\') {
      i++;
      continue;
    }
    if (script && ch === '#' && atWordStart) {
      const end = text.indexOf('\n', i);
      if (end < 0) return -1;
      i = end - 1;
      continue;
    }
    if (script && ch === '\n') {
      for (const doc of heredocs.splice(0)) {
        let found = false;
        while (!found && i < text.length - 1) {
          const lineEnd = text.indexOf('\n', i + 1);
          const line = text.slice(i + 1, lineEnd < 0 ? text.length : lineEnd).replace(/\r$/, '');
          i = lineEnd < 0 ? text.length : lineEnd;
          found = (doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter;
        }
        if (!found) return -1;
      }
      continue;
    }
    if (script && ch === '<' && text[i + 1] === '<') {
      if (text[i + 2] === '<') {
        i += 2;
        continue;
      }
      const stripTabs = text[i + 2] === '-';
      const at = i + (stripTabs ? 3 : 2);
      const word = heredocDelimiter(text.slice(at));
      if (!word) return -1;
      heredocs.push({ delimiter: word.delimiter, stripTabs });
      i = at + word.length - 1;
      wordStart = false;
      continue;
    }
    if (script && ch === '$' && text[i + 1] === '(') {
      i = substitutionEnd(text, i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === "'") {
      i = text.indexOf("'", i + 1);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '"') {
      i = closingDoubleQuote(text, i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '`' || (ch === '$' && (text[i + 1] === '{' || text[i + 1] === "'"))) {
      i = expansionEnd(text, i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Index of the `}` closing the `${` whose brace is at `open`; bash counts no bare `{` inside, and skips quotes even within double quotes. */
function closingBrace(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '}') return i;
    if (ch === "'") {
      i = text.indexOf("'", i + 1);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '"') {
      i = closingDoubleQuote(text, i);
      if (i < 0) return -1;
      continue;
    }
    i = expansionEnd(text, i);
    if (i < 0) return -1;
  }
  return -1;
}

/** Index of the backtick closing the one at `open`; -1 when unbalanced. */
function closingBacktick(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '`') return i;
  }
  return -1;
}

/** Whether the `$(` at `dollar`, closed at `end`, is arithmetic: bash reads `$((` as one only when its inner `(` closes right before the outer `)`. */
function isArithmetic(text: string, dollar: number, end: number): boolean {
  return text[dollar + 2] === '(' && closingParen(text, dollar + 2, false) === end - 1;
}

/** Calls `sub` with the body of each `$()` and backtick substitution in `text`, arithmetic bodies searched too; `fail` on an unbalanced one. */
function substitutionsIn(text: string, sub: (body: string) => void, fail: () => void): void {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '$' && text[i + 1] === '(') {
      const end = substitutionEnd(text, i);
      if (end < 0) return fail();
      if (isArithmetic(text, i, end)) substitutionsIn(text.slice(i + 3, end - 1), sub, fail);
      else sub(text.slice(i + 2, end));
      i = end;
    } else if (text[i] === '`') {
      const end = closingBacktick(text, i);
      if (end < 0) return fail();
      sub(text.slice(i + 1, end).replace(/\\`/g, '`'));
      i = end;
    }
  }
}

/** A heredoc delimiter word after quote removal, and whether any part of it was quoted; undefined for one the parse cannot read. */
function heredocDelimiter(text: string): { delimiter: string; quoted: boolean; length: number } | undefined {
  const blanks = /^[ \t]*/.exec(text)![0].length;
  let delimiter = '';
  let quoted = false;
  let i = blanks;
  for (; i < text.length && !/[\s;&|<>()]/.test(text[i]!); i++) {
    const ch = text[i]!;
    if (ch === '`' || (ch === '$' && /["'(]/.test(text[i + 1] ?? ''))) return undefined;
    if (ch === '\\') {
      quoted = true;
      delimiter += text[++i] ?? '';
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      quoted = true;
      delimiter += text.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && '$`"\\'.includes(text[j + 1] ?? '')) j++;
        delimiter += text[j];
      }
      if (j >= text.length) return undefined;
      quoted = true;
      i = j;
    } else {
      delimiter += ch;
    }
  }
  return i === blanks ? undefined : { delimiter, quoted, length: i };
}

/** The bash structure of `command`, for checks that need the targets of particular commands; see ShellStructure. Bounded by MAX_COMMAND_LENGTH like the classifier. */
export function parseShellStructure(command: string, depth = 0): ShellStructure {
  if (command.length > MAX_COMMAND_LENGTH || depth > 8) return { segments: [], loops: [], subshells: [], branches: [], unparsable: true };
  const segments: ShellSegment[] = [];
  let unparsable = false;
  let assignments: ShellAssignment[] = [];
  let words: Array<string | undefined> = [];
  let rawWords: string[] = [];
  let templates: Array<readonly ShellPart[] | undefined> = [];
  let offsets: number[] = [];
  // Each word's literal text, computed parts left out.
  let literals: string[] = [];
  let substitutions: ShellStructure[] = [];
  // Whether `&&`, `||` or `|` runs the next command conditionally.
  let chained = false;
  // The operator the next command is guarded by (ShellSegment.guard), kept across blank lines and comments.
  let guard: '&&' | '||' | undefined;
  // Whether the last command ended was a simple command whose exit status is its own, so an `&&` or `||` after it guards.
  let guardable = false;
  // A `!` before the current command, which inverts its exit status.
  let negated = false;
  // The current word's parts; undefined once a part is neither literal nor a plain variable.
  let parts: ShellPart[] | undefined = [];
  let ignoredSegment = false;
  // A `for` header assigns its variable each item of the list. Its first word is the variable, then `in` and the list up
  // to `;` or a newline, or `do`, which ends a header without a list.
  let forHeader: 'none' | 'variable' | 'afterVariable' | 'list' = 'none';
  type OpenLoop = Mutable<ShellLoop> & { items?: Array<readonly ShellPart[]> };
  const loops: OpenLoop[] = [];
  const subshells: Array<Mutable<ShellRange>> = [];
  const branches: Array<Mutable<ShellRange>> = [];
  // The compound commands and subshells open here, innermost last: the word that closes each, the index of its first
  // segment, how many loops, subshells and branches opened before it, whether it runs exactly once where it stands,
  // whether its segments run once per walk (ShellSegment.sequential), an `if`'s open branch, the body inside an `elif`'s
  // branch, whether that `elif`'s condition is being read, and the loop or subshell it is.
  type Compound = {
    close: string;
    at: number;
    loops: number;
    subshells: number;
    branches: number;
    unconditional: boolean;
    sequential: boolean;
    branch?: Mutable<ShellRange>;
    body?: Mutable<ShellRange> | undefined;
    condition?: boolean;
    loop?: OpenLoop;
    subshell?: Mutable<ShellRange>;
  };
  const compounds: Compound[] = [];
  const sequentialHere = (): boolean => compounds.every((compound) => compound.sequential);
  // The compound command whose closing word the current command follows: its redirections are the rest of that command.
  let closed: Compound | undefined;
  // Whether the current command has a redirection, after which bash reads no reserved word.
  let redirected = false;
  // bash's `time -p`: the -p belongs to the keyword.
  let timed = false;
  // ShellSegment.line of the command being read.
  let line = 0;
  let value = '';
  let computed = false;
  let pattern = false;
  // How far the word has come toward a brace expansion, which bash makes only of an unquoted `{`, then an unquoted `,`
  // or `..`, then `}`; any other braces are literal text.
  let brace: 'none' | 'open' | 'separated' = 'none';
  let inWord = false;
  let wordStart = 0;
  // The index of the last character read as unquoted literal text.
  let plainAt = -1;
  let redirectTarget = false;
  // `owner` is the substitutions of the command that read the heredoc, which its body's `$()` run with.
  const heredocs: Array<{ delimiter: string; stripTabs: boolean; quoted: boolean; owner: ShellStructure[] }> = [];

  const sub = (body: string, into: ShellStructure[] = substitutions): ShellStructure => {
    const parsed = parseShellStructure(body, depth + 1);
    if (parsed.unparsable) unparsable = true;
    into.push(parsed);
    return parsed;
  };
  const openCompound = (close: string, loop?: OpenLoop): void => {
    const subshell = close === ')' ? { start: segments.length, end: segments.length } : undefined;
    compounds.push({
      close,
      at: segments.length,
      loops: loops.length,
      subshells: subshells.length,
      branches: branches.length,
      unconditional: compounds.length === 0 && !chained,
      sequential: sequentialHere() && !chained,
      ...(loop === undefined ? {} : { loop }),
      ...(subshell === undefined ? {} : { subshell }),
    });
    if (loop !== undefined) loops.push(loop);
    if (subshell !== undefined) subshells.push(subshell);
    guard = undefined;
  };
  /** Ends the open branch of an `if`, and the body inside it. */
  const endBranch = (compound: Compound): void => {
    if (compound.branch !== undefined) compound.branch.end = segments.length;
    if (compound.body !== undefined) compound.body.end = segments.length;
    compound.body = undefined;
  };
  const closeCompound = (close: string): void => {
    const compound = compounds.pop();
    if (compound?.close !== close) unparsable = true;
    if (compound?.loop !== undefined) compound.loop.end = segments.length;
    if (compound?.subshell !== undefined) compound.subshell.end = segments.length;
    if (compound !== undefined) endBranch(compound);
    closed = compound;
  };
  /** Puts `segment`, the redirections of `compound`, before the compound command's first segment, where bash performs them. */
  const insertBefore = (compound: Compound, segment: ShellSegment): void => {
    segments.splice(compound.at, 0, segment);
    // `compound`'s own loops shift past the segment; a loop enclosing it keeps a start at `at`, so the segment repeats with that body.
    const shift = (index: number, inside: boolean): number => (index > compound.at || (index === compound.at && inside) ? index + 1 : index);
    loops.forEach((loop, k) => {
      const inside = k >= compound.loops;
      loop.start = shift(loop.start, inside);
      loop.end = shift(loop.end, inside);
      if (loop.header !== undefined) loop.header = shift(loop.header, inside);
    });
    subshells.forEach((subshell, k) => {
      const inside = k >= compound.subshells;
      subshell.start = shift(subshell.start, inside);
      subshell.end = shift(subshell.end, inside);
    });
    branches.forEach((branch, k) => {
      const inside = k >= compound.branches;
      branch.start = shift(branch.start, inside);
      branch.end = shift(branch.end, inside);
    });
  };
  /** The loop whose `for` header is being read. */
  const headerLoop = (): OpenLoop => compounds.at(-1)!.loop!;
  const fail = (): void => {
    unparsable = true;
  };
  /** Literal text of the current word. */
  const append = (text: string): void => {
    value += text;
    if (parts === undefined || text === '') return;
    const last = parts.at(-1);
    if (typeof last === 'string') parts[parts.length - 1] = last + text;
    else parts.push(text);
  };
  const reference = (variable: string, quoted: boolean): void => {
    computed = true;
    parts?.push({ variable, quoted });
  };
  /** A computed part that is not a plain variable. */
  const opaque = (): void => {
    computed = true;
    parts = undefined;
  };
  /** The variable a `${...}` from `open` to `close` names, when it holds nothing else. */
  const bracedName = (open: number, close: number): string | undefined => {
    const name = command.slice(open + 2, close);
    return VARIABLE_NAME.test(name) ? name : undefined;
  };
  // Arithmetic runs the `$()` in an array subscript of text it evaluates: a variable's value, as `$((x))` evaluates it, or
  // an operand of `let` or of a `[[` comparison. An unbalanced one never runs.
  const runsInArithmetic = (text: string): void => {
    if (/\$\(|`/.test(text)) substitutionsIn(text, sub, () => undefined);
  };
  /**
   * Handles the `$(` at `at`: a command substitution is parsed and becomes a part of the word, an arithmetic one is
   * searched and makes the word opaque; the closing index, or -1.
   */
  const dollarParen = (at: number, quoted: boolean): number => {
    const end = substitutionEnd(command, at);
    if (end < 0) return -1;
    if (isArithmetic(command, at, end)) {
      substitutionsIn(command.slice(at + 3, end - 1), sub, fail);
      opaque();
    } else {
      const body = command.slice(at + 2, end);
      const substitution = sub(body);
      computed = true;
      parts?.push({ substitution, body, quoted });
    }
    return end;
  };
  /** Handles the `${` at `at`: its word may hold substitutions; the closing index, or -1. */
  const dollarBrace = (at: number): number => {
    const end = closingBrace(command, at + 1);
    if (end >= 0) substitutionsIn(command.slice(at + 2, end), sub, fail);
    return end;
  };
  const endWord = (end: number): void => {
    if (!inWord) return;
    inWord = false;
    const raw = command.slice(wordStart, end);
    // `~user` names another user's home, which the text does not give.
    const expands = (pattern && !['[', ']', '[[', ']]'].includes(raw)) || /^~[^/]/.test(raw);
    const literal = value;
    const word = computed || expands || literal.includes(COMPUTED_TEXT) ? undefined : literal;
    const template = computed && !expands && !literal.includes(COMPUTED_TEXT) ? parts : undefined;
    value = '';
    computed = false;
    pattern = false;
    brace = 'none';
    parts = [];
    if (redirectTarget) {
      redirectTarget = false;
      return;
    }
    if (forHeader === 'variable') {
      forHeader = 'afterVariable';
      if (VARIABLE_NAME.test(raw)) {
        assignments.push({ name: raw, value: undefined, offset: wordStart, append: false });
        headerLoop().variable = raw;
      }
      return;
    }
    if (forHeader === 'afterVariable') {
      if (raw === 'in') {
        forHeader = 'list';
        headerLoop().items = [];
      } else if (raw === 'do') {
        endSegment(end);
      } else {
        unparsable = true;
      }
      return;
    }
    if (forHeader === 'list') {
      const loop = headerLoop();
      const item = word === undefined ? template : [word];
      if (item === undefined) delete loop.items;
      else loop.items?.push(item);
      return;
    }
    if (ignoredSegment) return;
    if (words.length === 0 && ASSIGNMENT.test(raw)) {
      const eq = raw.indexOf('=');
      const append = raw[eq - 1] === '+';
      const name = raw.slice(0, append ? eq - 1 : eq);
      // The name and `=` are unquoted literal text, so they begin the first part.
      const [head, ...rest] = template ?? [];
      const valueTemplate = template === undefined ? undefined : [(head as string).slice(eq + 1), ...rest].filter((part) => part !== '');
      assignments.push({
        name,
        value: word === undefined ? undefined : word.slice(word.indexOf('=') + 1),
        raw: raw.slice(eq + 1),
        offset: wordStart,
        append,
        ...(valueTemplate === undefined ? {} : { template: valueTemplate }),
      });
      runsInArithmetic(literal);
      return;
    }
    const head = words[0];
    // A computed part may give the operand's name.
    if (head === 'let' || (head !== undefined && DECLARATION_BUILTINS.has(head) && (word === undefined || DECLARED.test(literal)))) runsInArithmetic(literal);
    if (head === '[[' && word !== undefined && ARITHMETIC_TEST.test(word)) runsInArithmetic(literals.at(-1) ?? '');
    else if (head === '[[' && ARITHMETIC_TEST.test(words.at(-1) ?? '')) runsInArithmetic(literal);
    if (words.length === 0 && assignments.length === 0 && !redirected && word !== undefined && raw === word) {
      if (timed && word === '-p') {
        timed = false;
        return;
      }
      timed = word === 'time';
      if (COMPOUND_CLOSE.has(word)) {
        closeCompound(word);
        return;
      }
      // A reserved word right after a closing word starts the next command, as `else` does after `done`.
      if (RESERVED_SKIP.has(word) || word === 'for') {
        closed = undefined;
        guard = undefined;
      }
      if (word === '!') negated = true;
      // An `if`'s condition runs once; a branch starts at its `then` and at each `elif` and `else`, and the body after an
      // `elif`'s condition is a branch inside that one, since the condition may fail.
      const opened = compounds.at(-1);
      if (opened?.close === 'fi' && (word === 'elif' || word === 'else')) {
        endBranch(opened);
        opened.branch = { start: segments.length, end: segments.length };
        opened.condition = word === 'elif';
        branches.push(opened.branch);
      } else if (opened?.close === 'fi' && word === 'then' && (opened.branch === undefined || opened.condition === true)) {
        const branch = { start: segments.length, end: segments.length };
        if (opened.branch === undefined) opened.branch = branch;
        else opened.body = branch;
        opened.condition = false;
        branches.push(branch);
      }
      const close = COMPOUND_CLOSER.get(word);
      // A `for` loop's repeated part starts after its header, where endSegment moves `start`.
      if (close !== undefined) openCompound(close, close === 'done' ? { start: segments.length, end: segments.length } : undefined);
      if (RESERVED_SKIP.has(word)) return;
      if (RESERVED_UNPARSABLE.has(word)) {
        unparsable = true;
        ignoredSegment = true;
        return;
      }
      if (word === 'for') {
        ignoredSegment = true;
        forHeader = 'variable';
        return;
      }
    }
    words.push(word);
    rawWords.push(raw);
    templates.push(template);
    offsets.push(wordStart);
    literals.push(literal);
  };
  /** Ends the current command, `detached` when it is piped or put in the background. */
  const endSegment = (end: number, detached = false): void => {
    endWord(end);
    if (redirectTarget) unparsable = true;
    if (closed !== undefined && (words.length > 0 || assignments.length > 0)) unparsable = true;
    // An ignored `for` header still runs the substitutions in its list and assigns its variable; a heredoc whose body is
    // still to come may add substitutions.
    const kept =
      (!ignoredSegment && words.length > 0) || assignments.length > 0 || substitutions.length > 0 || heredocs.some((doc) => !doc.quoted && doc.owner === substitutions);
    // A piped or backgrounded compound command may run in a subshell, so none of its segments runs once in this shell.
    if (closed !== undefined && detached) {
      for (let k = closed.at; k < segments.length; k++) segments[k] = { ...segments[k]!, sequential: false };
    }
    // A blank line or a comment ends nothing, so an `&&` before it still guards the command after it.
    const ended = kept || closed !== undefined || redirected || ignoredSegment;
    if (kept) {
      const ignored = ignoredSegment;
      const guarded = closed === undefined ? guard : undefined;
      const segment: ShellSegment = {
        assignments,
        words: ignored ? [] : words,
        rawWords: ignored ? [] : rawWords,
        templates: ignored ? [] : templates,
        offsets: ignored ? [] : offsets,
        substitutions,
        unconditional: (closed === undefined ? compounds.length === 0 && !chained : closed.unconditional) && !detached,
        ...(guarded === undefined ? {} : { guard: guarded }),
        sequential: closed === undefined && sequentialHere() && !detached && (!chained || guarded !== undefined),
        line,
      };
      if (closed === undefined) segments.push(segment);
      else insertBefore(closed, segment);
      chained = false;
    }
    if (ended) {
      guardable = kept && closed === undefined && !ignoredSegment && !negated;
      guard = undefined;
      negated = false;
    }
    if (forHeader !== 'none') {
      const loop = headerLoop();
      if (kept) loop.header = segments.length - 1;
      loop.start = segments.length;
    }
    closed = undefined;
    redirected = false;
    assignments = [];
    words = [];
    rawWords = [];
    templates = [];
    offsets = [];
    literals = [];
    substitutions = [];
    ignoredSegment = false;
    forHeader = 'none';
    timed = false;
  };
  const startWord = (at: number): void => {
    if (!inWord) {
      inWord = true;
      wordStart = at;
    }
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === '\n') {
      endWord(i);
      // A heredoc body starts on the next line and ends at its delimiter line; it is data for the command that read it.
      for (const doc of heredocs.splice(0)) {
        let found = false;
        while (i < command.length - 1) {
          const lineEnd = command.indexOf('\n', i + 1);
          const line = command.slice(i + 1, lineEnd < 0 ? command.length : lineEnd).replace(/\r$/, '');
          i = lineEnd < 0 ? command.length : lineEnd;
          if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) {
            found = true;
            break;
          }
          // An unquoted delimiter leaves `$()` and backticks in the body running.
          if (!doc.quoted) substitutionsIn(line, (body) => sub(body, doc.owner), fail);
        }
        if (!found) unparsable = true;
      }
      endSegment(i);
      if (compounds.length === 0 && !chained) line++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord(i);
      continue;
    }
    if (ch === '#' && !inWord) {
      const end = command.indexOf('\n', i);
      i = (end < 0 ? command.length : end) - 1;
      continue;
    }
    if (ch === '\\') {
      if (command[i + 1] === '\n') {
        i++;
        continue;
      }
      startWord(i);
      if (i + 1 < command.length) append(command[++i]!);
      continue;
    }
    if (ch === "'") {
      startWord(i);
      const end = command.indexOf("'", i + 1);
      if (end < 0) return { segments, loops, subshells, branches, unparsable: true };
      append(command.slice(i + 1, end));
      i = end;
      continue;
    }
    if (ch === '"') {
      startWord(i);
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const c = command[j]!;
        if (c === '\\' && j + 1 < command.length) {
          const next = command[j + 1]!;
          append('$`"\\\n'.includes(next) ? next : `\\${next}`);
          j++;
        } else if (c === '`') {
          const end = closingBacktick(command, j);
          if (end < 0) return { segments, loops, subshells, branches, unparsable: true };
          sub(command.slice(j + 1, end).replace(/\\`/g, '`'));
          opaque();
          j = end;
        } else if (c === '$' && /[A-Za-z_{(0-9?@*#!$-]/.test(command[j + 1] ?? '')) {
          if (command[j + 1] === '(') {
            const end = dollarParen(j, true);
            if (end < 0) return { segments, loops, subshells, branches, unparsable: true };
            j = end;
          } else if (command[j + 1] === '{') {
            const end = dollarBrace(j);
            if (end < 0) return { segments, loops, subshells, branches, unparsable: true };
            const name = bracedName(j, end);
            if (name === undefined) opaque();
            else reference(name, true);
            j = end;
          } else {
            NAME_AT.lastIndex = j + 1;
            const name = NAME_AT.exec(command)?.[0];
            if (name === undefined) {
              opaque();
            } else {
              reference(name, true);
              j += name.length;
            }
          }
        } else {
          append(c);
        }
      }
      if (j >= command.length) return { segments, loops, subshells, branches, unparsable: true };
      i = j;
      continue;
    }
    if (ch === '`') {
      startWord(i);
      const end = closingBacktick(command, i);
      if (end < 0) return { segments, loops, subshells, branches, unparsable: true };
      sub(command.slice(i + 1, end).replace(/\\`/g, '`'));
      opaque();
      i = end;
      continue;
    }
    if (ch === '$') {
      const next = command[i + 1] ?? '';
      if (next === '(') {
        startWord(i);
        const end = dollarParen(i, false);
        if (end < 0) return { segments, loops, subshells, branches, unparsable: true };
        i = end;
        continue;
      }
      if (next === '{') {
        startWord(i);
        const end = dollarBrace(i);
        if (end < 0) return { segments, loops, subshells, branches, unparsable: true };
        const name = bracedName(i, end);
        if (name === undefined) opaque();
        else reference(name, false);
        i = end;
        continue;
      }
      if (next === "'") {
        startWord(i);
        const end = closingAnsiQuote(command, i + 1);
        if (end < 0) return { segments, loops, subshells, branches, unparsable: true };
        opaque();
        i = end;
        continue;
      }
      // `$"..."` is a translatable string; with no translation it is the double-quoted text.
      if (next === '"') {
        startWord(i);
        continue;
      }
      if (/[A-Za-z_0-9?@*#!$-]/.test(next)) {
        startWord(i);
        const start = ++i;
        while (/[A-Za-z_0-9]/.test(command[i + 1] ?? '') && /[A-Za-z_]/.test(next)) i++;
        if (/[A-Za-z_]/.test(next)) reference(command.slice(start, i + 1), false);
        else opaque();
        continue;
      }
      startWord(i);
      append(ch);
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      // `&>` and `&>>` redirect both streams; every other `&` ends a command.
      if (ch === '&' && command[i + 1] === '>') {
        endWord(i);
        i += command[i + 2] === '>' ? 2 : 1;
        redirectTarget = true;
        redirected = true;
        continue;
      }
      const list = command[i + 1] === ch && ch !== ';';
      const pipe = ch === '|' && !list;
      // A piped or backgrounded command may run in a subshell, and the command after `&&`, `||` or `|` may not run.
      endSegment(i, pipe || (ch === '&' && !list));
      if (pipe || list) chained = true;
      guard = list && guardable ? (ch === '&' ? '&&' : '||') : undefined;
      if (list || (ch === '|' && command[i + 1] === '&')) i++;
      continue;
    }
    if (ch === '(' && inWord && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(command.slice(wordStart, i))) {
      // An array assignment: its elements are data, but the substitutions among them run.
      const end = closingParen(command, i, true);
      if (end < 0) return { segments, loops, subshells, branches, unparsable: true };
      const elements = parseShellStructure(command.slice(i + 1, end), depth + 1);
      if (elements.unparsable) unparsable = true;
      for (const element of elements.segments) substitutions.push(...element.substitutions);
      opaque();
      i = end;
      continue;
    }
    if (ch === '(' || ch === ')') {
      if (ch === '(' && (inWord || words.length > 0)) {
        // `name()` defines a function, `a(b` is not shell: neither is followed.
        unparsable = true;
      }
      endSegment(i);
      if (ch === '(') openCompound(')');
      else closeCompound(')');
      continue;
    }
    if (ch === '<' || ch === '>') {
      // A process substitution runs its body: parsed like `$()`. After a redirect it is the redirect's target, else a computed word.
      if (command[i + 1] === '(') {
        endWord(i);
        const end = closingParen(command, i + 1, true);
        if (end < 0) return { segments, loops, subshells, branches, unparsable: true };
        sub(command.slice(i + 2, end));
        if (redirectTarget) {
          redirectTarget = false;
        } else {
          startWord(i);
          opaque();
        }
        i = end;
        continue;
      }
      // A file descriptor number written right before the operator belongs to it, not to the words.
      if (inWord && !computed && /^\d+$/.test(value) && command.slice(wordStart, i) === value) {
        inWord = false;
        value = '';
        parts = [];
      } else {
        endWord(i);
      }
      redirected = true;
      if (ch === '<' && command[i + 1] === '<' && command[i + 2] === '<') {
        i += 2;
        redirectTarget = true;
        continue;
      }
      if (ch === '<' && command[i + 1] === '<') {
        const stripTabs = command[i + 2] === '-';
        i += stripTabs ? 2 : 1;
        const word = heredocDelimiter(command.slice(i + 1));
        if (!word) return { segments, loops, subshells, branches, unparsable: true };
        heredocs.push({ delimiter: word.delimiter, stripTabs, quoted: word.quoted, owner: substitutions });
        i += word.length;
        continue;
      }
      while (command[i + 1] === '>' || command[i + 1] === '|' || command[i + 1] === '&' || command[i + 1] === '<') i++;
      redirectTarget = true;
      continue;
    }
    if (ch === '~') {
      // bash expands a `~` that starts a word, or follows an assignment word's first `=` or an unquoted `:` in it; its
      // prefix runs to `/`, the word's end, or there `:`, and a longer one names another user's home.
      const before = inWord ? command.slice(wordStart, i) : '';
      const assigned = ASSIGNMENT.exec(before)?.[0];
      const assigning = assigned !== undefined && (assigned === before || (command[i - 1] === ':' && plainAt === i - 1));
      if (!inWord || assigning) {
        startWord(i);
        if (/^(?:[\s/;&|()<>]|$)/.test(command[i + 1] ?? '') || (assigning && command[i + 1] === ':')) {
          computed = true;
          parts?.push({ tilde: true });
        } else {
          opaque();
          append(ch);
        }
        continue;
      }
    }
    startWord(i);
    if (GLOB_CHARS.includes(ch)) pattern = true;
    if (ch === '{' && brace === 'none') brace = 'open';
    else if (brace === 'open' && (ch === ',' || (ch === '.' && plainAt === i - 1 && command[i - 1] === '.'))) brace = 'separated';
    else if (ch === '}' && brace === 'separated') pattern = true;
    plainAt = i;
    append(ch);
  }
  endSegment(command.length);
  if (heredocs.length > 0 || compounds.length > 0) unparsable = true;
  return { segments, loops, subshells, branches, unparsable };
}
