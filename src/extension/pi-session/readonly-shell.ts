/**
 * readonly-shell.ts — Provably read-only shell command classifier (SECURITY-CRITICAL).
 *
 * Leaf module (imports NOTHING from pi-session, same discipline as `plan-mode-guidance.ts`) so the
 * permission gate and tests can use it without an import cycle.
 *
 * Purpose: in plan mode the model may run provably read-only shell commands with no prompt. This
 * classifier is the sole arbiter of "read-only": it FAILS CLOSED at every stage — any command that is
 * not POSITIVELY recognized as read-only is denied with a category-naming reason. Every disputed
 * classification resolves toward DENY.
 *
 * Trust boundary: the adversary is the MODEL'S COMMAND STRING, not the user's machine configuration.
 * Git commands may invoke user-configured helpers (pager, textconv, fsmonitor) — trusted because the
 * model cannot create or modify that config in plan mode (all writes are blocked). The classifier's
 * SOLE job is to prevent the model from MUTATING STATE or EXECUTING ARBITRARY PROGRAMS without approval.
 */

export type ShellKind = 'bash' | 'powershell';

export type ReadOnlyVerdict =
  | { readOnly: true }
  | { readOnly: false; reason: string }; // reason = category text, e.g. "redirection (`>`) is not allowed"

/** Convenience DENY constructor keeps the reason strings terse and consistent at the call sites. */
function deny(reason: string): ReadOnlyVerdict {
  return { readOnly: false, reason };
}

const ALLOW: ReadOnlyVerdict = { readOnly: true };

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
  | { kind: 'git' };

/**
 * The bash allowlist. Every entry documents WHY it is safe and WHAT is banned. A command absent from
 * this table is denied by stage 3 (unknown token). `always` entries are pure readers that cannot mutate
 * state or execute another program; `flagGated` entries are readers with a narrow exec/write escape hatch
 * closed by banning specific flags; `exactArgs` entries are interpreters allowed ONLY for version probes;
 * `git` routes to the dedicated subcommand walker.
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
  ['file', { kind: 'always' }],
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
  ['diff', { kind: 'always' }],
  ['cmp', { kind: 'always' }],
  ['nl', { kind: 'always' }],
  ['sha256sum', { kind: 'always' }],
  ['md5sum', { kind: 'always' }],
  ['echo', { kind: 'always' }],
  ['printf', { kind: 'always' }],

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

  // sort — a reader except `-o/--output` (writes a file) and `--compress-program` (executes an arbitrary
  // program to compress temp files). Ban the short letter `o` so `-o` AND clusters like `-zo` are caught.
  [
    'sort',
    {
      kind: 'flagGated',
      bannedFlags: ['--output', '--compress-program'],
      bannedShortLetters: ['o'],
    },
  ],

  // rg (ripgrep) — a reader except its preprocessor/exec hooks: `--pre` runs a program per file,
  // `--pre-glob` scopes it, `--hostname-bin` runs a program to resolve the hostname.
  [
    'rg',
    {
      kind: 'flagGated',
      bannedFlags: ['--pre', '--pre-glob', '--hostname-bin'],
    },
  ],

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

  // uniq — a reader; its SECOND positional operand is an OUTPUT file. Handled specially below (positional
  // count), modeled here as flagGated with no banned flags so it reaches the uniq-specific check.
  ['uniq', { kind: 'flagGated', bannedFlags: [] }],

  // tree — a reader except `-o file`, which writes the listing to a file. Ban short letter `o`.
  ['tree', { kind: 'flagGated', bannedFlags: [], bannedShortLetters: ['o'] }],

  // date — a reader except `-s/--set`, which SETS the system clock (state mutation). Ban short letter `s`.
  ['date', { kind: 'flagGated', bannedFlags: ['--set'], bannedShortLetters: ['s'] }],

  // Interpreters — allowed ONLY as a version probe. Any other argument executes a script/expression.
  ['node', { kind: 'exactArgs', allowed: [['--version'], ['-v'], ['-V']] }],
  ['python', { kind: 'exactArgs', allowed: [['--version'], ['-v'], ['-V']] }],
  ['python3', { kind: 'exactArgs', allowed: [['--version'], ['-v'], ['-V']] }],

  // git — routed to the dedicated subcommand walker (read-only subcommands only).
  ['git', { kind: 'git' }],
]);

// ---------------------------------------------------------------------------
// Stage 1 — structural scan (quote-aware single pass, with backslash handling).
// ---------------------------------------------------------------------------

type ScanState = 'none' | 'single' | 'double';

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
 */
function segment(command: string): string[] {
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
      segments.push(current);
      current = '';
      continue;
    }
    if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      segments.push(current);
      current = '';
      i++; // consume the second char
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
// Stage 3 — tokenize a segment on unquoted whitespace (quote/backslash aware).
// ---------------------------------------------------------------------------

/**
 * Tokenize a segment on unquoted whitespace and strip surrounding quotes / backslash escapes so the
 * table lookup and flag matching see the shell's actual argument values. Stage 1 has already guaranteed
 * the segment is structurally clean, so this pass is unquoting, not re-validation.
 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false; // distinguishes an empty-string token ('' ) from no token yet
  let state: ScanState = 'none';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (state === 'single') {
      if (ch === "'") state = 'none';
      else current += ch;
      continue;
    }

    if (ch === '\\') {
      if (i + 1 < segment.length) {
        current += segment[i + 1] ?? '';
        started = true;
        i++;
      }
      continue;
    }

    if (state === 'double') {
      if (ch === '"') state = 'none';
      else current += ch;
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
    if (ch === "'") {
      state = 'single';
      started = true;
      continue;
    }
    if (ch === '"') {
      state = 'double';
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

  // uniq: a second positional operand is the OUTPUT file.
  if (command === 'uniq') {
    const positionals = args.filter((a) => !a.startsWith('-'));
    if (positionals.length >= 2) {
      return deny('`uniq` with a second file operand is not allowed because it writes output');
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
// Bash classification pipeline.
// ---------------------------------------------------------------------------

/**
 * Reading `/proc/<pid|self>/environ` dumps a process's environment block — the same env-secret
 * disclosure the PowerShell classifier blocks for the `env:` PSDrive. A plain reader (`cat`, `head`,
 * `grep`, …) can open it, so screen ANY token that resolves to a `.../environ` procfs path, before the
 * table lookup, so an allowlisted reader pointed at it is still denied. Matches the canonical procfs
 * spellings (`/proc/self/environ`, `/proc/<pid>/environ`, `/proc/<pid>/task/<tid>/environ`); the model
 * cannot forge a symlink to bypass it (all writes are blocked in plan mode).
 */
const PROC_ENVIRON_PATH = /\/proc\/(?:self|thread-self|\d+)\/(?:task\/\d+\/)?environ(?:$|\/)/;

function screenProcEnviron(tokens: readonly string[]): ReadOnlyVerdict | null {
  for (const token of tokens) {
    if (PROC_ENVIRON_PATH.test(token)) {
      return deny('reading `/proc/<pid>/environ` is not allowed (it exposes environment secrets)');
    }
  }
  return null;
}

function classifyBash(command: string): ReadOnlyVerdict {
  // Stage 1 — structural scan.
  const structural = scanStructure(command);
  if (structural) return structural;

  // Stage 2 — segmentation; every segment must independently pass.
  const segments = segment(command);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed === '') {
      return deny('an empty command segment is not allowed');
    }

    // Stage 3 — first-token rule.
    if (firstTokenIsQuoted(seg)) {
      return deny('a quoted command name is not allowed');
    }
    const tokens = tokenize(seg);
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

    // Env-secret screen: deny any reader pointed at a `/proc/<pid>/environ` path, BEFORE the table
    // lookup (an allowlisted `cat`/`head`/`grep` reading it is still denied).
    const procEnviron = screenProcEnviron(args);
    if (procEnviron) return procEnviron;

    const rule = BASH_RULES.get(cmd);
    if (!rule) {
      return deny(`\`${cmd}\` is not a recognized read-only command`);
    }

    // Stage 4 — per-command rule.
    let verdict: ReadOnlyVerdict;
    switch (rule.kind) {
      case 'always':
        verdict = ALLOW;
        break;
      case 'flagGated':
        verdict = evalFlagGated(cmd, args, rule.bannedFlags, rule.bannedShortLetters);
        break;
      case 'exactArgs':
        verdict = evalExactArgs(cmd, args, rule.allowed);
        break;
      case 'git':
        verdict = evalGit(args);
        break;
    }
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
 *   is PS's escape for a literal quote; treating a lone `'` as toggling the state is harmless here
 *   because the run between the two quotes is inert either way.
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
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (state === 'single') {
      // Single quotes are fully literal — only a closing quote matters.
      if (ch === "'") state = 'none';
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
      // Inside double quotes, `; & { } ( ) > <` are literal; only a closing quote matters here.
      if (ch === '"') state = 'none';
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
    if (ch === ';') return deny('a statement separator (`;`) is not allowed');
    if (ch === '&') return deny('the call/background operator (`&`) is not allowed');
    if (ch === '{' || ch === '}') return deny('a script block (`{`/`}`) is not allowed');
    if (ch === '(' || ch === ')') return deny('a parenthesized expression (`(`/`)`) is not allowed');
    if (ch === '>') return deny('redirection (`>`) is not allowed');
    if (ch === '<') return deny('redirection (`<`) is not allowed');
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
 * bash-table-first lookup already covers them with the correct, stricter native-binary rules.
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
  ['write', 'write-output'],
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
 * for symmetry with `env:`/`function:`. Applied to the already-tokenized (unquoted) values.
 */
function screenPsDriveTokens(tokens: readonly string[]): ReadOnlyVerdict | null {
  for (const token of tokens) {
    if (/^env:/i.test(token)) {
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
  }
}

// ---------------------------------------------------------------------------
// PowerShell classification pipeline.
// ---------------------------------------------------------------------------

function classifyPowershell(command: string): ReadOnlyVerdict {
  // PS Stage 1 — structural scan (bans backtick/$/{}/()/;/&/></ newlines outside single quotes).
  const structural = scanStructurePowershell(command);
  if (structural) return structural;

  // PS Stage 2 — split into pipeline stages on unquoted `|`; every stage must independently pass.
  const segments = splitPowershellPipeline(command);
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

    // Tokenize with the SHARED bash tokenizer. It treats `\` as an escape char, which is technically
    // wrong for PS — but every structural metachar (backtick, `$`, quotes' partners) is ALREADY banned
    // by scanStructurePowershell BEFORE we get here, so a surviving `\` is only ever a literal path
    // separator inside an ARGUMENT (e.g. `Get-Content src\a.txt`). tokenize collapses `src\a.txt` →
    // `srca.txt` for the table lookup ONLY (we never re-execute args), and the command NAME token never
    // legitimately contains `\` (a path-qualified `.\x.ps1` is denied below anyway). So this cannot
    // cause an UNDER-block: `Get-Content src\a.txt` still ALLOWS (command token `Get-Content` is clean;
    // the arg mangling is inert). A dedicated PS tokenizer would only change harmless arg values.
    const tokens = tokenize(seg);
    const cmd = tokens[0];
    if (cmd === undefined) {
      return deny('an empty command segment is not allowed');
    }
    const args = tokens.slice(1);

    // PSDrive read screen over ALL tokens, BEFORE the table lookup (an allowlisted cmdlet reading
    // `env:` is still denied).
    const psDrive = screenPsDriveTokens(tokens);
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
    const bashRule = BASH_RULES.get(cmd);
    if (bashRule) {
      const verdict = applyCommandRule(cmd, args, bashRule);
      if (!verdict.readOnly) return verdict;
      continue;
    }

    // Not a native/bash command — resolve as a PowerShell cmdlet (case-insensitive; alias → canonical).
    const lowered = cmd.toLowerCase();
    const canonical = PS_ALIASES.get(lowered) ?? lowered;
    const psRule = PS_RULES.get(canonical);
    if (!psRule) {
      return deny(`\`${cmd}\` is not a recognized read-only PowerShell command`);
    }
    // Screen hang-inducing parameters (e.g. Get-Content -Wait) before applying the base rule.
    const bannedParam = screenPsBannedParams(canonical, args);
    if (bannedParam) return bannedParam;
    const verdict = applyCommandRule(canonical, args, psRule);
    if (!verdict.readOnly) return verdict;
  }

  return ALLOW;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Classify a shell command as provably read-only (safe to auto-run in plan mode) or not. Fails closed:
 * any command not positively recognized as read-only returns a DENY verdict with a category-naming
 * reason. Both bash and PowerShell are supported; PowerShell is classified more strictly.
 */
export function classifyReadOnlyShellCommand(shell: ShellKind, command: string): ReadOnlyVerdict {
  if (shell === 'powershell') {
    return classifyPowershell(command);
  }
  return classifyBash(command);
}
