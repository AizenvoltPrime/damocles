import { describe, it, expect } from 'vitest';
import { classifyReadOnlyShellCommand, parseShellStructure, stripNoOpRedirections } from '../readonly-shell';

const BASH_ALLOWED: readonly [string][] = [
    ['git status'],
    ['git --no-pager log --oneline | head -20'],
    ['git --version'],
    ['git diff HEAD~1'],
    ['git branch -a'],
    ['git branch --contains abc123'],
    ["git tag -l 'v*'"],
    ['git config --get user.name'],
    ['git show HEAD'],
    ['git blame file.ts'],
    ['git stash list'],
    ['git reflog'],
    ['git remote -v'],
    ['git remote get-url origin'],
    ['git worktree list'],
    ['ls -la && pwd'],
    ["cat 'file with $(dollar).txt'"],
    ["grep 'foo$' f"],
    ['echo \\$HOME'],
    ['grep -rn "TODO" src'],
    ["find . -name '*.ts'"],
    ['diff a.ts b.ts'],
    ['node --version'],
    ['python3 -V'],
    ['rg --json pattern'],
    ['wc -l file'],
    ['tail -n 50 file'],
    ['tail -c-5 f'], // attached negative count on a non-banned letter stays allowed (boundary check)
    ['date +%s'], // a `+format` operand (no leading `-`) is not a flag, so the `s` is not gated
    ['sort -n5o out'], // getopt halts at the invalid `5`, so `o` is never an active option (stays allowed)
    ['cat a.txt b.txt'],
    ['head -5 f | wc -l'],
    // safe long flags that are NOT prefixes of a banned flag stay allowed (H2 must not over-block these)
    ['sort --reverse -n file'],
    ['git log --stat --oneline'],
    ['git config --get-regexp alias'],
    ['rg --json --stats pattern'],
    ["cat 'a{b,c}.txt'"], // braces inside single quotes are literal, not expansion → allowed
    ['grep "{a,b}" file'], // braces inside double quotes are literal → allowed
    // cd — each segment is classified independently, so this grants the grep nothing
    ['cd /c/GameDev/damocles && grep -rn "x" src/**/*.ts | head -40'],
    ['cd src && ls'],
    ['cd'],
    ['cd -'],
    // stdout-only readers
    ['tac f'],
    ['rev f'],
    ['base64 -d f'],
    ['od -c f'],
    ['strings bin'],
    ['fold -w 80 f'],
    ['expand f'],
    ['column -t f'],
    ['paste a b'],
    ['comm a b'],
    ['xxd f'],
    ['xxd -l64 f'], // attached flag value; the DETACHED `-l 64 f` counts as a 2nd positional → denied
    // no-op redirections to /dev/null (and fd dups) are stripped before the structural `>` ban
    ['grep -rln "x" some/path 2>/dev/null | head -5'],
    ['ls -la >/dev/null 2>&1'],
    ['ls > /dev/null'],
    ['cat f 2>>/dev/null'],
    ['ls &>/dev/null'],
    ['ls &>> /dev/null'],
    ['git status 2>&1 | head -20'],
    ['cd src 2>/dev/null && ls'],
    ["grep '2>/dev/null' f"], // literal inside quotes — never stripped, never a redirect
    ['grep "a > b" f'],
];

describe('classifyReadOnlyShellCommand — bash allowlist (provably read-only)', () => {
  it.each(BASH_ALLOWED)('allows: %s', (command) => {
    const verdict = classifyReadOnlyShellCommand('bash', command);
    expect(verdict.readOnly).toBe(true);
  });
});

describe('classifyReadOnlyShellCommand — bash denials (fail-closed, category-naming reasons)', () => {
  // [command, reasonSubstring] — the substring asserts the DENY CATEGORY, not merely readOnly === false.
  const blocked: readonly [string, string][] = [
    // git subcommand / walker denials
    ['git commit -m x', 'not a recognized read-only git subcommand'],
    ['git branch new-feature', 'creates a branch'],
    ['git tag v1', 'creates a tag'],
    ['git config user.name x', 'git config'],
    ['git -c core.pager=evil log', 'pre-subcommand option'],
    ['git -C /tmp log', 'pre-subcommand option'],
    ['git grep -O evil pattern', 'pager'],
    ['git ls-remote origin', 'not a recognized read-only git subcommand'],
    ['git branch -d old', 'not a read-only branch operation'],
    ['git remote show origin', 'get-url'],
    ['git stash pop', 'list'],
    // structural denials
    ['echo hi > out.txt', 'redirection'],
    ['git log $(evil)', 'expansion'],
    ['git log `evil`', 'backtick'],
    ['git log "`evil`"', 'backtick'],
    ['echo "$(evil)"', 'expansion'],
    ["cat \\' $(evil) \\'", 'expansion'],
    ['sort $FLAG f', 'expansion'],
    ['cat $FOO', 'expansion'],
    ['echo "$HOME"', 'expansion'],
    ['cat <(evil)', 'process substitution'],
    ['sleep 5 &', 'background'],
    ['cat foo\\', 'trailing backslash'],
    ['cat \'unterminated', 'unbalanced quote'],
    ['ls\nrm -rf /', 'multi-line'],
    // segmentation / first-token denials
    ['ls; rm -rf /', 'not a recognized read-only command'],
    ['ls;', 'empty command'],
    ['env', 'not a recognized read-only command'],
    ['printenv', 'not a recognized read-only command'],
    ['FOO=1 cat f', 'environment-assignment'],
    ['LD_PRELOAD=x cat f', 'environment-assignment'],
    ['/bin/cat f', 'path-qualified'],
    ['./script.sh', 'path-qualified'],
    ['npm test', 'not a recognized read-only command'],
    ['npx anything', 'not a recognized read-only command'],
    ['', 'empty command'],
    // brace expansion — bash expands `{…}` BEFORE the flag gate sees the tokens (H1)
    ['sort {-o,/tmp/pwn} in', 'brace expansion'],
    ['find . -delet{e,e}', 'brace expansion'],
    ['tail -{f,} log', 'brace expansion'],
    ['cat {a,b}.txt', 'brace expansion'],
    // flag-gated denials (write/execute/hang escape hatches)
    ['find . -exec rm x \\;', 'write or execute'],
    ['find . -delete', 'write or execute'],
    ['sort -o out in', 'write or execute'],
    ['sort -zo out in', 'write or execute'],
    // long-option prefix abbreviation — getopt accepts the shortest unambiguous prefix (H2)
    ['sort --out=/tmp/pwn in', 'write or execute'],
    ['sort --outp /tmp/pwn in', 'write or execute'],
    ['sort --compress-prog=evil f', 'write or execute'],
    ['git log --outp=/tmp/pwn', 'output'],
    ['tail --fol log', 'write or execute'],
    ['date --se=x', 'write or execute'],
    // git grep -O attached form runs an arbitrary program (H3)
    ['git grep -Onotepad pattern', 'pager'],
    // env-secret disclosure via a procfs environ path (M1)
    ['cat /proc/self/environ', 'environment secrets'],
    ['head /proc/1/environ', 'environment secrets'],
    ['grep KEY /proc/self/task/2/environ', 'environment secrets'],
    // Attached-value short-option smuggling (GNU getopt: `-ofile` ≡ `-o file`) — must DENY.
    ['sort -oevil.txt in', 'write or execute'],
    ['sort -o1 in', 'write or execute'],
    ['sort -o/tmp/x in', 'write or execute'],
    ['tree -oout.txt .', 'write or execute'],
    ['tail -f5 log', 'write or execute'],
    ['tail -F1 log', 'write or execute'],
    ['date -s0', 'write or execute'],
    ['sort --compress-program=evil f', 'write or execute'],
    ['tail -f log', 'write or execute'],
    ['tail -nf 5 log', 'write or execute'],
    ['date -us', 'write or execute'],
    ['tree -ao', 'write or execute'],
    ['rg --pre=evil x', 'write or execute'],
    ['uniq a b', 'second file operand'],
    // `cd` grants the following segment nothing — every segment is classified independently
    ['cd /tmp && rm -rf x', 'not a recognized read-only command'],
    // xxd's second positional operand is an output file (same shape as uniq)
    ['xxd in out', 'second file operand'],
    // A DETACHED flag value is indistinguishable from a positional without a per-flag arity table, and
    // a wrong arity there is an UNDER-block. Fail-closed: over-block and let the model attach the value.
    ['xxd -l 64 f', 'second file operand'],
    // A bare `-` is STDIN — a positional operand, NOT a flag. Counting it as a flag drops the operand
    // count to one and lets an arbitrary file write through with attacker-chosen bytes.
    ['echo hi | uniq - /tmp/pwn', 'second file operand'],
    ['uniq - /tmp/pwn', 'second file operand'],
    ['xxd -r -p - out.bin', 'second file operand'],
    // procfs env-secret screen: doubled slashes, dot segments, and `cd` laundering all stay blocked.
    ['cat /proc//self/environ', 'environment secrets'],
    ['cat /proc/self//environ', 'environment secrets'],
    ['cat /proc/self/./environ', '`.` or `..` segments'],
    ['cat /proc/1/task/../environ', '`.` or `..` segments'],
    ['cd /proc/self && cat environ', 'cd` into `/proc`'],
    ['cd /proc && cat self/environ', 'cd` into `/proc`'],
    ['cd //proc/self && cat environ', 'cd` into `/proc`'],
    // `seq` emits forever on `inf` with no tool timeout — the same hang class as `tail -f`.
    ['seq inf', 'not a recognized read-only command'],
    ['seq 1 10', 'not a recognized read-only command'],
    // `>>&N` / `&>&N` are bash SYNTAX ERRORS; the pre-pass must not strip a span the shell never runs.
    ['ls 2>>&1', 'redirection'],
    ['ls &>&1', 'background execution'], // survives the pre-pass, then the `&` ban catches it
    // jq/awk/sed stay unrecognized: all three are languages whose program text the stage-1 `$` ban
    // cannot see through (`jq -n 'env'` / `jq -n '$ENV'` dump the process environment).
    ['jq -n env', 'not a recognized read-only command'],
    ["jq -n '$ENV'", 'not a recognized read-only command'],
    ["awk '{print}' f", 'not a recognized read-only command'],
    ['sed -n 1p f', 'not a recognized read-only command'],
    // --- /dev/null pre-pass: these are the SECURITY assertions, not smoke tests ---------------------
    // `>&WORD` with a non-digit operand is a FILE WRITE (`cmd >&file` ≡ `cmd &>file`), never a dup.
    ['ls >&/tmp/pwn', 'redirection'],
    ['ls >& /tmp/pwn', 'redirection'],
    ['ls 2>&/tmp/pwn', 'redirection'],
    // Attached digits belong to the preceding WORD (`foo2`), so this is a bare `>` — stripping it would
    // silently rewrite the argument from `foo2` to `foo`.
    ['cat foo2>/dev/null x', 'redirection'],
    // Non-exact spellings and unrecognized forms are all over-blocked on purpose.
    ['ls > /dev/null/x', 'redirection'],
    ['ls > /dev/nullx', 'redirection'],
    ['ls > //dev/null', 'redirection'],
    ['ls > /dev/./null', 'redirection'],
    ["ls > '/dev/null'", 'redirection'],
    ['ls > /dev/NULL', 'redirection'],
    ['ls > NUL', 'redirection'],
    ['ls >| /dev/null', 'redirection'],
    ['ls 2>&-', 'redirection'],
    // Ordinary writes stay banned.
    ['ls > out.txt', 'redirection'],
    // Input redirection is untouched by the pre-pass.
    ['cat < in.txt', 'redirection'],
    ['cat < /dev/null', 'redirection'],
    // Stripping must not hide a segment, and stripping to empty must fail closed.
    ['ls > /dev/null; rm -rf /', 'not a recognized read-only command'],
    ['> /dev/null', 'empty command'],
    // interpreter denials
    ['node script.js', 'version probe'],
    ['node', 'version probe'],
    ['python3 script.py', 'version probe'],
  ];

  it.each(blocked)('blocks: %s', (command, reasonSubstring) => {
    const verdict = classifyReadOnlyShellCommand('bash', command);
    expect(verdict.readOnly).toBe(false);
    if (!verdict.readOnly) {
      expect(verdict.reason).toContain(reasonSubstring);
    }
  });
});

describe('classifyReadOnlyShellCommand — PowerShell allowlist (provably read-only)', () => {
  const allowed: readonly [string][] = [
    ['Get-ChildItem -Recurse'],
    ['Get-Content foo.txt | Select-String bar | Measure-Object'],
    ['Get-Content package.json | Select-String version'],
    ['git status'], // via shared bash git walker (bash-table-first)
    ['gci -Recurse'],
    ['dir'],
    ['gc foo.txt'],
    ['type foo.txt'],
    ['sls pattern file'],
    ['Get-Content f | select -First 5'],
    ['measure'],
    ['ft'],
    ['fl'],
    ['Get-Content f | Sort-Object'],
    ['ls -la'], // via bash rule
    ['cat foo.txt'], // via bash rule
    ['pwd'],
    ['echo hello'],
    ['get-content foo.txt'], // case-insensitivity
    ["Select-String 'literal $x' file"], // `$` inside single quotes is fully literal
    ['Get-Content src\\a.txt'], // literal `\` path separator; command token clean → ALLOW
    ['Get-Content foo.txt -TotalCount 5'], // a non-Wait param on a screened cmdlet stays allowed
    ['cd src'], // bash-table-first → in PS `cd` aliases the read-only Set-Location
  ];

  it.each(allowed)('allows: %s', (command) => {
    const verdict = classifyReadOnlyShellCommand('powershell', command);
    expect(verdict.readOnly).toBe(true);
  });
});

describe('classifyReadOnlyShellCommand — PowerShell denials (fail-closed, category-naming reasons)', () => {
  // [command, reasonSubstring] — the substring asserts the DENY CATEGORY, not merely readOnly === false.
  const blocked: readonly [string, string][] = [
    // structural denials
    ['Get-Content x; Get-Content y', 'statement separator'],
    ['& notepad', 'call/background operator'],
    ['G`et-Content x', 'backtick'],
    ['Write-Output (Remove-Item x)', 'parenthesized expression'],
    ['Get-ChildItem { evil }', 'script block'],
    ['Get-Content $env:PATH', 'expansion'],
    ['"$(Get-Date)"', 'expansion'], // `$` banned even inside double quotes
    ['Get-Content x > out.txt', 'redirection'],
    ['Get-Content x 2> err', 'redirection'],
    ['. ./script.ps1', 'dot-sourcing'],
    // not-allowlisted cmdlet denials
    ['Set-Content a.txt x', 'not a recognized read-only PowerShell command'],
    ['Out-File x', 'not a recognized read-only PowerShell command'],
    ["Invoke-Expression 'x'", 'not a recognized read-only PowerShell command'],
    ['iex x', 'not a recognized read-only PowerShell command'],
    ['Where-Object Name', 'not a recognized read-only PowerShell command'],
    ['where x', 'not a recognized read-only PowerShell command'],
    ['ForEach-Object x', 'not a recognized read-only PowerShell command'],
    ['% x', 'not a recognized read-only PowerShell command'],
    ["[IO.File]::ReadAllText('x')", 'parenthesized expression'], // parens caught structurally first
    ['Get-Help Get-Content', 'not a recognized read-only PowerShell command'],
    ['Start-Process calc', 'not a recognized read-only PowerShell command'],
    ['pwsh -c evil', 'not a recognized read-only PowerShell command'],
    ['cmd /c dir', 'not a recognized read-only PowerShell command'],
    // PSDrive read denials
    ['gci env:', 'env:'],
    ['Get-Content env:PATH', 'env:'],
    // Exotic argument-separator whitespace: PS splits on these 18 codepoints but the shared tokenizer
    // does not, so they could smuggle a second arg past the PSDrive/flag screens. Rejected structurally
    // (fail-closed) before tokenizing.
    ['Get-ChildItem \u000benv:', 'whitespace'], // vertical tab → would leak all env vars
    ['Get-Content \u000benv:PATH', 'whitespace'], // vertical tab → would leak env value
    ['sort \u000b-o\u000bout\u000bin', 'whitespace'], // would bypass the native-binary `-o` write-ban
    ['Get-ChildItem \u00a0env:', 'whitespace'], // NBSP separator
    ['Get-ChildItem \u3000env:', 'whitespace'], // ideographic space separator
    // bash-table-first denials (native binaries inherit the stricter bash rule)
    ['git commit -m x', 'not a recognized read-only git subcommand'],
    ['sort -o out in', 'write or execute'],
    // Get-Content -Wait is PS follow mode — hangs the turn (bounded by the 120s tool timeout) (M2)
    ['Get-Content log.txt -Wait', 'hangs the turn'],
    ['Get-Content log.txt -wait', 'hangs the turn'], // case-insensitive
    ['Get-Content log.txt -Wai', 'hangs the turn'], // shortest unambiguous abbreviation
    ['gc log.txt -Wait', 'hangs the turn'], // via alias → canonical
    // The bash /dev/null carve-out must NOT leak into PowerShell: PS spells the bit bucket `$null`, and
    // there is no pre-pass here, so the `>` is caught structurally (the `$` ban would catch it too).
    ['Get-Content x 2>$null', 'redirection'],
    ['Get-Content x > /dev/null', 'redirection'],
  ];

  it.each(blocked)('blocks: %s', (command, reasonSubstring) => {
    const verdict = classifyReadOnlyShellCommand('powershell', command);
    expect(verdict.readOnly).toBe(false);
    if (!verdict.readOnly) {
      expect(verdict.reason).toContain(reasonSubstring);
    }
  });
});

describe('parseShellStructure — loops, and the commands that run once where they stand', () => {
  const words = (command: string) => parseShellStructure(command).segments.map((s) => s.words);
  const unconditional = (command: string) => parseShellStructure(command).segments.map((s) => s.unconditional);
  const substituted = (command: string) => parseShellStructure(command).segments.map((s) => s.substitutions.map((sub) => sub.segments[0]!.words));

  it('records each loop over its segments, a for header apart from the body it repeats', () => {
    const parsed = parseShellStructure('for f in a "b c" ~ $x "$(pwd)"; do cd "$f"; done; git status');
    expect(parsed.unparsable).toBe(false);
    expect(parsed.segments.map((s) => s.words)).toEqual([[], ['cd', undefined], ['git', 'status']]);
    expect(parsed.loops).toEqual([
      {
        start: 1,
        end: 2,
        header: 0,
        variable: 'f',
        items: [['a'], ['b c'], [{ tilde: true }], [{ variable: 'x', quoted: false }], [expect.objectContaining({ body: 'pwd', quoted: true })]],
      },
    ]);
    expect(parseShellStructure('while read l; do cd ..; done').loops).toEqual([{ start: 0, end: 2 }]);
    expect(parseShellStructure('for a in x; do until false; do :; done; done').loops).toEqual([
      { start: 1, end: 3, header: 0, variable: 'a', items: [['x']] },
      { start: 1, end: 3 },
    ]);
  });

  it.each([['*.ts'], ['{a,b}'], ["$'a'"], ['${x:-y}'], ['$1'], ['"$@"'], ['~user'], ['`pwd`'], ['$((1))'], ['<(pwd)']])('gives a for loop no items when one is %s', (item) => {
    const parsed = parseShellStructure(`for f in a ${item}; do :; done`);
    expect(parsed.loops).toHaveLength(1);
    expect(parsed.loops[0]).toMatchObject({ variable: 'f' });
    expect(parsed.loops[0]!.items).toBeUndefined();
  });

  it('marks the commands that run exactly once where they stand', () => {
    expect(unconditional('a; b && c || d | e & f\ng')).toEqual([true, true, false, false, false, true, true]);
    expect(unconditional('a &> out; b')).toEqual([true, true]);
    expect(unconditional('(cd x); y')).toEqual([false, true]);
    expect(unconditional('if a; then b; else c; fi; d')).toEqual([false, false, false, true]);
    expect(unconditional('{ a; }; b')).toEqual([false, true]);
    expect(unconditional('while a; do b; done; c')).toEqual([false, false, true]);
  });

  it('marks the operator that guards a command after a lone simple command, and the commands that run once per walk', () => {
    const guards = (command: string) => parseShellStructure(command).segments.map((s) => s.guard);
    const sequential = (command: string) => parseShellStructure(command).segments.map((s) => s.sequential);
    expect(guards('a && b || c; d')).toEqual([undefined, '&&', '||', undefined]);
    expect(guards('a &&\n\n# x\nb')).toEqual([undefined, '&&']);
    expect(guards('! a && b; { a; } && b; (a) || b')).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(guards('a && if b; then c; fi; a && time b; a && { b; }')).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(guards('a | b && c')).toEqual([undefined, undefined, '&&']);
    // An `if` branch's commands run once per walk of their branch, which runs whole or not at all.
    expect(sequential('a; b && c; if d; then e; else f; fi; g | h; i & j')).toEqual([true, true, true, true, true, true, false, false, false, true]);
    expect(sequential('x && { y; }; (z); { w; } | v; for d in a; do u; done')).toEqual([true, false, true, false, false, true, true]);
    expect(sequential('x | if y; then z; fi')).toEqual([false, false, false]);
    expect(parseShellStructure('(a; (b)); c').subshells).toEqual([{ start: 0, end: 2 }, { start: 1, end: 2 }]);
    // A compound command's redirection runs before it, inside the subshell around it.
    expect(parseShellStructure('( { a; } > $(b) )').subshells).toEqual([{ start: 0, end: 2 }]);
    // An `elif`'s condition belongs to its branch, and the body after it, which a failed condition skips, is a branch
    // inside it; the redirection of the `if` runs before its condition.
    expect(parseShellStructure('if a; then b; elif c; then d; else e; fi > $(f)').branches).toEqual([{ start: 2, end: 3 }, { start: 3, end: 5 }, { start: 4, end: 5 }, { start: 5, end: 6 }]);
    expect(parseShellStructure('if a; then b; elif c; then d; elif e; then f; fi').branches).toEqual([{ start: 1, end: 2 }, { start: 2, end: 4 }, { start: 3, end: 4 }, { start: 4, end: 6 }, { start: 5, end: 6 }]);
    // The redirection of a compound command that starts a branch runs inside that branch.
    expect(parseShellStructure('if a; then { b; } > $(c); if d; then e; fi; fi').branches).toEqual([{ start: 1, end: 5 }, { start: 4, end: 5 }]);
  });

  // Git Bash reads an alias defined on an earlier line at each of these breaks, and none defined on the same line.
  it('numbers the complete commands bash reads whole before it runs any of them', () => {
    const lines = (command: string) => parseShellStructure(command).segments.map((s) => s.line);
    expect(lines('a; b\nc && d\ne')).toEqual([0, 0, 1, 1, 2]);
    expect(lines('a &&\nb\nc |\nd\ne \\\nf\ng')).toEqual([0, 0, 1, 1, 2, 3]);
    expect(lines('if a; then\nb\nfi\nc\n{\nd\n}\ne')).toEqual([0, 0, 1, 2, 3]);
    expect(lines('a <<E\n$(b)\nE\nc # x\n\nd')).toEqual([0, 1, 3]);
    expect(lines('for i in x; do\na\ndone > >(b)\nc')).toEqual([0, 0, 0, 1]);
  });

  it('reads a reserved word only where a command starts, before any assignment or redirection', () => {
    const loop = parseShellStructure('for f in a b; do X=1 done; >/dev/null done; X=1 for y; X=1 while :; done; cd ..');
    expect(loop.unparsable).toBe(false);
    expect(loop.segments.map((s) => s.words)).toEqual([[], ['done'], ['done'], ['for', 'y'], ['while', ':'], ['cd', '..']]);
    expect(loop.loops).toEqual([{ start: 1, end: 5, header: 0, variable: 'f', items: [['a'], ['b']] }]);
    expect(unconditional('if a; then X=1 fi; cd x; fi; y')).toEqual([false, false, false, true]);
    expect(unconditional('{ X=1 }; cd x; }; y')).toEqual([false, false, true]);
    expect(words('X=1 if a; X=1 then b; >x fi; 2>&1 {')).toEqual([['if', 'a'], ['then', 'b'], ['fi'], ['{']]);
    expect(parseShellStructure('{ X=1 }').unparsable).toBe(true);
    expect(parseShellStructure('for f in a; do X=1 done').unparsable).toBe(true);
  });

  it("puts a compound command's redirections before its first segment, where bash performs them", () => {
    const procsub = 'for d in $(ls); do cd "$d"; done < <(git status); pwd';
    expect(parseShellStructure(procsub).unparsable).toBe(false);
    expect(substituted(procsub)).toEqual([[['git', 'status']], [['ls']], [], []]);
    expect(unconditional(procsub)).toEqual([true, false, false, true]);
    expect(parseShellStructure(procsub).loops).toMatchObject([{ header: 1, start: 2, end: 3 }]);
    const heredoc = 'while read l; do echo "$l"; done <<EOF\n$(git status)\nEOF\npwd';
    expect(substituted(heredoc)).toEqual([[['git', 'status']], [], [], []]);
    expect(parseShellStructure(heredoc).loops).toEqual([{ start: 1, end: 3 }]);
    // The body belongs to cat, inside the loop.
    const inside = 'while read l; do cat <<EOF; done\n$(git status)\nEOF\npwd';
    expect(substituted(inside)).toEqual([[], [['git', 'status']], []]);
    expect(parseShellStructure(inside).loops).toEqual([{ start: 0, end: 2 }]);
    expect(words('a && if b; then c; fi > >(d)')).toEqual([['a'], [], ['b'], ['c']]);
    expect(unconditional('a && if b; then c; fi > >(d)')).toEqual([true, false, false, false]);
    expect(unconditional('{ cd x; } < <(pwd) &')).toEqual([false, false]);
    expect(unconditional('(cd x) < <(pwd); y')).toEqual([true, false, true]);
    const nested = parseShellStructure('for a in x; do while b; do c; done < <(d); done');
    expect(nested.segments.map((s) => s.words)).toEqual([[], [], ['b'], ['c']]);
    expect(nested.loops).toEqual([
      { start: 1, end: 4, header: 0, variable: 'a', items: [['x']] },
      { start: 2, end: 4 },
    ]);
  });

  it.each([['fi'], ['a)'], ['(a'], ['if a; then b'], ['if a; then b; done'], ['{ a; )'], ['if a; then b; fi c'], ['while a; do b; done < x c']])(
    'marks an unbalanced or misplaced compound command unparsable: %s',
    (command) => {
      expect(parseShellStructure(command).unparsable).toBe(true);
    },
  );

  it.each([['for a in 1; do for b in 2; do :; done done'], ['if false; then :; else for x in 1; do :; done fi'], ['{ for x in 1; do :; done }'], ['( if a; then b; fi )']])(
    'reads a closing word right after another compound command: %s',
    (command) => {
      expect(parseShellStructure(command).unparsable).toBe(false);
    },
  );

  it('runs the substitutions a declaration builtin evaluates in a subscript, whatever gives the name', () => {
    for (const name of ['a', '$n', '"$n"', '${n}', '$-', '${n:-a}']) {
      expect(substituted(`declare ${name}'[$(git status)]=1'`), name).toEqual([[['git', 'status']]]);
    }
  });
});

/**
 * The pre-pass is a FOURTH quote/backslash walk in this file, and two scanners that disagree is the
 * classic parser-differential bug. This is the guard: on any command with no unquoted `>`, stripping
 * must be a byte-level no-op, so no currently-allowed command can silently change meaning.
 */
describe('stripNoOpRedirections — differential against the allowed corpus', () => {
  const noUnquotedRedirect = BASH_ALLOWED
    .map(([command]) => command)
    .filter((command) => classifyReadOnlyShellCommand('bash', command).readOnly && !hasUnquotedGt(command));

  it.each(noUnquotedRedirect.map((c) => [c]))('is a byte-level no-op for: %s', (command) => {
    expect(stripNoOpRedirections(command)).toBe(command);
  });

  it('covers a meaningful slice of the corpus (guards a vacuous filter)', () => {
    expect(noUnquotedRedirect.length).toBeGreaterThan(30);
  });

  // The escape- and quote-awareness assertions. `cat foo\>/dev/null` reads a file literally NAMED
  // `foo>/dev/null` — an escape-unaware pass would strip the span and silently rewrite the argument to
  // `foo`, turning a read of one file into a read of another.
  it.each([
    ['cat foo\\>/dev/null'],
    ["grep '2>/dev/null' f"],
    ['grep "a > b" f'],
    ['cat foo2>/dev/null x'], // attached digits belong to `foo2`; the `>` is bare, so nothing is stripped
  ])('never strips a quoted or escaped span: %s', (command) => {
    expect(stripNoOpRedirections(command)).toBe(command);
  });

  // The pre-pass runs synchronously on the extension host, so super-linear cost is an editor freeze,
  // not just a slow function. A rope-flattening accumulator made this ~18s for a 200k-char argument.
  it('stays linear on a pathological input (no O(n^2) host freeze)', () => {
    const started = Date.now();
    stripNoOpRedirections('&'.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses a command too long to classify rather than walking it', () => {
    const verdict = classifyReadOnlyShellCommand('bash', 'ls ' + 'a'.repeat(9000));
    expect(verdict.readOnly).toBe(false);
    if (!verdict.readOnly) expect(verdict.reason).toContain('too long to classify');
  });

  it('strips only the span, leaving the command and its arguments intact', () => {
    expect(stripNoOpRedirections('ls -la >/dev/null 2>&1').trim()).toBe('ls -la');
    expect(stripNoOpRedirections('grep -rln "x" p 2>/dev/null | head -5').replace(/\s+/g, ' ').trim())
      .toBe('grep -rln "x" p | head -5');
    // A non-dup `>&WORD` is a file write: it must survive so the structural `>` ban denies it.
    expect(stripNoOpRedirections('ls >&/tmp/pwn')).toContain('>');
  });
});

/** Quote/backslash-aware `>` detector — mirrors the scanner states, for the differential filter only. */
function hasUnquotedGt(command: string): boolean {
  let state: 'none' | 'single' | 'double' = 'none';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (state === 'single') {
      if (ch === "'") state = 'none';
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (state === 'double') {
      if (ch === '"') state = 'none';
      continue;
    }
    if (ch === "'") { state = 'single'; continue; }
    if (ch === '"') { state = 'double'; continue; }
    if (ch === '>') return true;
  }
  return false;
}
