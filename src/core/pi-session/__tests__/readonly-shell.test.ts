import { describe, it, expect } from 'vitest';
import { classifyReadOnlyShellCommand, parseShellStructure, stripNoOpRedirections, tokenize } from '../readonly-shell';

const CONTEXT = { allowedNetworkHosts: new Set<string>() };

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
    // a trailing `;` ends the command and starts no other
    ['ls;'],
    ['ls -la ; '],
    ['git status;'],
    // print-only sed
    ['sed -n 5p f'],
    ["sed -n '$p' f"],
    ["sed -n '/re/,+3p' f"],
    ["sed -n '1p;5p' a b"],
    ['cat f | sed -n 2p'],
    ["sed --quiet -E '/a|b/Ip' f"],
    ["sed -nsz '0~4p' f"],
    ["sed -n '/a\\/b/,$p' f"],
    ["sed -n '1,5 p; 9p' f"],
    ["sed -n -- '1p' -n"],
    // inside double quotes bash keeps a `\` that precedes anything but `$`, backtick, `"`, `\` or a line break
    ['grep "a\\.b" f'],
    ['rg "foo\\"bar" f'],
    ['sed -n "/a\\/b/p" f'],
];

describe('classifyReadOnlyShellCommand — bash allowlist (provably read-only)', () => {
  it.each(BASH_ALLOWED)('allows: %s', (command) => {
    const verdict = classifyReadOnlyShellCommand('bash', command, CONTEXT);
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
    ['ls |', 'empty command'],
    ['ls &&', 'empty command'],
    ['ls ||', 'empty command'],
    ['ls &', 'background'],
    ['; ls', 'empty command'],
    ['ls;;', 'empty command'],
    [';', 'empty command'],
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
    ['cat /proc/self/./environ', 'environment secrets'],
    ['cat /proc/1/task/../environ', 'environment secrets'],
    ['cd /proc/self && cat environ', 'into a `proc` folder'],
    ['cd /proc && cat self/environ', 'into a `proc` folder'],
    ['cd //proc/self && cat environ', 'network or device path'], // two leading slashes name a host on Windows
    // `seq` emits forever on `inf` with no tool timeout — the same hang class as `tail -f`.
    ['seq inf', 'not a recognized read-only command'],
    ['seq 1 10', 'not a recognized read-only command'],
    // `>>&N` / `&>&N` are bash SYNTAX ERRORS; the pre-pass must not strip a span the shell never runs.
    ['ls 2>>&1', 'redirection'],
    ['ls &>&1', 'background execution'], // survives the pre-pass, then the `&` ban catches it
    // jq/awk stay unrecognized: both are languages whose program text the stage-1 `$` ban cannot see
    // through (`jq -n 'env'` / `jq -n '$ENV'` dump the process environment).
    ['jq -n env', 'not a recognized read-only command'],
    ["jq -n '$ENV'", 'not a recognized read-only command'],
    ["awk '{print}' f", 'not a recognized read-only command'],
    // sed runs only as `-n` with a print-only script; every option and command that writes, runs or edits is refused.
    ['sed 5p f', 'without `-n`'],
    ['sed -ni 1p f', 'in place'],
    ['sed -n -i.bak 1p f', 'in place'],
    ['sed -n --in-place 1p f', 'in place'],
    ['sed -n --in-place=.bak 1p f', 'in place'],
    ['sed -n -e 1p f', 'one script'],
    ['sed -n --expression=1p f', 'one script'],
    ['sed -n -f s.sed f', 'one script'],
    ['sed -n -l 5 1p f', 'option `-l`'],
    ['sed -n --follow-symlinks 1p f', 'option `--follow-symlinks`'],
    ['sed -n --debug 1p f', 'option `--debug`'],
    ['sed -n', 'needs a script'],
    ["sed -n 's/a/b/w x' f", 'script command `s`'],
    ["sed -n '1w x' f", 'script command `w`'],
    ["sed -n '1e id' f", 'script command `e`'],
    ["sed -n '{p}' f", 'script command `{`'],
    ["sed -n '1!p' f", 'script command `!`'],
    ["sed -n '1p;R x' f", 'script command `R`'],
    ["sed -n '$=' f", 'script command `=`'],
    ["sed -n '1,' f", 'address'],
    ["sed -n '/a' f", 'address'],
    ["sed -n '1~p' f", 'address'],
    ["sed -n '1pw' f", 'after `p`'],
    ["sed -n '1p;' f", 'script command'],
    // Long-option abbreviations are matched by prefix only for the options that write or read a script.
    ['sed -n --in-pl 1p f', 'in place'],
    ['sed -n --exp=1p f', 'one script'],
    ['sed --qui 1p f', 'option `--qui`'],
    ['sed -n -I 1p f', 'option `-I`'],
    // sed reads `\/` inside double quotes as an escaped delimiter, so the regex runs on to the next `/`.
    ['sed -En "/^|\\/p;/e touch pwned;/p" README.md', 'script command `e`'],
    ['sed -n "/x\\/p;/w out;/p" f', 'script command `w`'],
    ['sed -n "/x\\/p" f', 'not closed'],
    ['sed -n "/x\\/p/" f', 'command is missing'],
    // `\<newline>` is a line continuation: bash joins the two halves into one word.
    ['find . -del\\\nete', 'multi-line'],
    ['rg --p\\\nre=sh x', 'multi-line'],
    ['sort --out\\\nput=x f', 'multi-line'],
    ['sort --out\\\r\nput=x f', 'multi-line'],
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
    const verdict = classifyReadOnlyShellCommand('bash', command, CONTEXT);
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
    ['Get-ChildItem;'], // a trailing `;` starts no other statement
    ['Get-ChildItem ; '],
    ["Select-String 'a;' f;"],
    ['rg "C:\\Users\\x" f'], // `\` is literal in PowerShell, so rg gets `C:\Users\x`
    ["sed -n '1,5p' f"],
    ['sed -n "/a\\/b/p" f'],
    ['git log --oneline -- src\\a.ts'],
    ['Select-String \'"version"\' package.json'], // a cmdlet binds the string itself, so a `"` in it stays one value
    // PowerShell splits only a single-dash parameter word, and only a native command re-parses `,`
    ['git log --since=1.week'],
    ['git log --since=2024-01-01T10:00'],
    ["rg '-e:x' f"],
    ['Get-Content -Path a.txt'],
    ['Get-ChildItem | Select-Object Name,Length'],
    ["Get-Content 'my file.txt'"],
    ["rg 'foo bar' src\\a.txt"],
    ["Select-String 'it''s' f"],
  ];

  it.each(allowed)('allows: %s', (command) => {
    const verdict = classifyReadOnlyShellCommand('powershell', command, CONTEXT);
    expect(verdict.readOnly).toBe(true);
  });
});

describe('classifyReadOnlyShellCommand — PowerShell denials (fail-closed, category-naming reasons)', () => {
  // [command, reasonSubstring] — the substring asserts the DENY CATEGORY, not merely readOnly === false.
  const blocked: readonly [string, string][] = [
    // structural denials
    ['Get-Content x; Get-Content y', 'statement separator'],
    ['Get-ChildItem; rm x', 'statement separator'],
    ['Get-ChildItem;;', 'statement separator'],
    ['Get-ChildItem |;', 'empty command'],
    [';', 'empty command'],
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
    // sed under PowerShell gets the same print-only grammar, judged on PowerShell's argument values.
    ['sed 5p f', 'without `-n`'],
    ['sed -n -i 1p f', 'in place'],
    ['sed -En "/^|\\/p;/e calc;/p" f', 'script command `e`'],
    ['sed -n "/x\\/p;/w out;/p" f', 'script command `w`'],
    // `"x\"` is the whole string `x\`, so the flag after it is a separate argument.
    ['rg "x\\" --pre=calc.exe "y"', 'write or execute'],
    ['sort "x\\" -o out.txt "y"', 'write or execute'],
    // `--%` passes the rest verbatim and expands `%NAME%`.
    ['sed -n p -- --% %GITHUB_TOKEN%', 'stop-parsing'],
    ['git log --% %X%', 'stop-parsing'],
    // PowerShell reads typographic quotes as `'` and `"`, so these strings close early.
    ["Get-Content '\u2018 ; Remove-Item x ; \u2018'", 'typographic quote'],
    ['Get-Content "\u201c ; Remove-Item x ; \u201c"', 'typographic quote'],
    // Windows PowerShell 5.1 rebuilds a native command line without escaping, so the program re-splits these.
    ["rg 'a \"b c\" --pre=calc.exe' f", 'holding `"`'],
    ["rg '' f", 'empty argument'],
    ['rg "a b\\" f', 'whitespace ending in'],
    ['Get-ChildItem\nRemove-Item x', 'multi-line'],
    // PowerShell ends a `-name` word at `:` or before `.`/`[` and passes the rest as another argument.
    ['rg -e:--pre=calc.exe .', 'holding `:`'],
    ['git log -S:--output=out.txt', 'holding `:`'],
    ['uniq -c.out in', 'holding `.`'],
    ['rg -g[a] x', 'holding `[`'],
    ['Get-Content -Path:env:USERNAME', 'holding `:`'],
    // An en dash, em dash or horizontal bar starts a parameter like `-`.
    ['rg \u2013e:--pre=calc.exe .', 'typographic dash'],
    ['Get-Content f \u2013Wait', 'typographic dash'],
    ['Get-Content f \u2014Wait', 'typographic dash'],
    // pwsh 7 passes a comma list holding a quoted element as several arguments.
    ["rg x,' --pre=calc.exe ' f", 'unquoted `,`'],
    ["rg 'a b',x f", 'unquoted `,`'],
    // `@name` splats a variable into arguments.
    ['echo @env:GITHUB_TOKEN', 'splatting'],
    ['Write-Output @env:GITHUB_TOKEN', 'splatting'],
    // Provider-qualified paths reach the environment without the `env:` drive.
    ['Get-Content Environment::GITHUB_TOKEN', 'environment secrets'],
    ['Get-Content Microsoft.PowerShell.Core\\Environment::USERNAME', 'environment secrets'],
    ['Get-ChildItem environment::', 'environment secrets'],
    ['Get-ChildItem Microsoft.PowerShell.Core\\Function::', 'function:'],
    // Windows PowerShell resolves `cat` to Get-Content, whose -Wait follows forever.
    ['cat log.txt -Wait', 'hangs the turn'],
    ['cat log.txt -wai', 'hangs the turn'],
    // An MSYS2 program removes `'` and brace-expands its own command line.
    ['find . "-\'delete\'"', "holding `'`"],
    ['tail "-\'f\'" log', "holding `'`"],
    ['sort "{-o,out}" in', 'holding `{`'],
    // `expand` is expand.exe under PowerShell on Windows, which writes its destination.
    ['expand package.json src\\index.ts', 'not a recognized read-only PowerShell command'],
    // A word that starts with a quote ends at its closing quote; glued text is another argument.
    ['rg "x"--pre=calc.exe f', 'write or execute'],
    ["git log 'HEAD'--output=out.txt", 'output'],
    ["Get-Content -TotalCount '1'env:USERNAME", 'environment secrets'],
    ["rg 'x'-e:--pre=calc.exe f", 'holding `:`'],
    ["Get-Content 'x'.Length", 'member access'],
    ['Get-Content "x"[0]', 'member access'],
    ["Get-Content 'p'::Empty", 'member access'],
    ['rg -e -- -e:--pre=calc.exe .', 'holding `:`'],
    // A cmdlet binds each element of a comma list as its own path.
    ['Get-Content nonexist.txt,env:USERNAME', 'environment secrets'],
    ['Get-Content x,Environment::USERNAME', 'environment secrets'],
    ['gci x,env:', 'environment secrets'],
    // An MSYS2 program replaces `@file` with the file's words.
    ['find . "@opts.txt"', 'starting with `@`'],
  ];

  it.each(blocked)('blocks: %s', (command, reasonSubstring) => {
    const verdict = classifyReadOnlyShellCommand('powershell', command, CONTEXT);
    expect(verdict.readOnly).toBe(false);
    if (!verdict.readOnly) {
      expect(verdict.reason).toContain(reasonSubstring);
    }
  });
});

describe('classifyReadOnlyShellCommand — wildcards, network paths, environment files and walks', () => {
  const verdictOf = (shell: 'bash' | 'powershell', command: string, allowedNetworkHosts: readonly string[] = []) =>
    classifyReadOnlyShellCommand(shell, command, { allowedNetworkHosts: new Set(allowedNetworkHosts) });

  // [shell, command, allowed network hosts]
  const proven: ReadonlyArray<readonly ['bash' | 'powershell', string, (readonly string[])?]> = [
    // A quoted or escaped wildcard reaches the program as written, which matches it itself.
    ['bash', "rg TODO '*.md'"],
    ['bash', "rg -g '*.md' foo"],
    ['bash', "find src -name '*.ts'"],
    ['bash', 'ls "*.md"'],
    ['bash', String.raw`ls \*.md`],
    ['bash', "git log -- '*.ts'"],
    ['bash', 'grep -r foo src'],
    ['bash', 'cd src && rg foo'],
    ['bash', 'cd / && ls'],
    ['bash', 'cat /proc/self/cmdline'],
    ['bash', 'cat /proc/cpuinfo'],
    ['bash', 'ls /proc'],
    ['bash', 'rg foo /home/u/project'],
    // A cmdlet matches its own wildcard paths, and a match never becomes a parameter.
    ['powershell', 'gci *.ts'],
    ['powershell', 'Get-Content src/*.md'],
    ['powershell', 'Get-ChildItem src -Filter *.ts'],
    ['powershell', 'Select-String foo -Path *.md'],
    ['powershell', 'gci * | Select-String foo'],
    ['powershell', 'Get-ChildItem src -Recurse | Select-String foo'],
    ['powershell', 'Get-ChildItem /proc/self'],
    ['powershell', 'Get-Content /proc/cpuinfo'],
    ['powershell', 'Get-Process'],
    // The hosts of the chat's folders and WSL's file server are allowed.
    ['bash', 'cat //files/proj/a.txt', ['files']],
    ['bash', String.raw`cat '\\FILES\proj\a.txt'`, ['files']],
    ['bash', String.raw`cat '\\?\UNC\files\proj\a.txt'`, ['files']],
    ['powershell', String.raw`Get-Content \\files\proj\a.txt`, ['files']],
    ['powershell', String.raw`gc FileSystem::\\files\proj\a.txt`, ['files']],
    ['bash', String.raw`cat '\\wsl.localhost\Ubuntu\etc\os-release'`],
    ['powershell', String.raw`Get-Content '\\wsl$\Ubuntu\etc\os-release'`],
    ['powershell', String.raw`Get-Content \\wsl.localhost\Ubuntu\etc\os-release`],
    // Options audited for writes, runs and endless follows: these stay readers.
    ['bash', 'file -b f'],
    ['bash', 'diff -u a b'],
    ['bash', 'base64 -d f'],
    ['bash', "printf '%s\\n' x"],
    ['bash', 'date'],
    ['bash', 'date -u +%F'],
    ['bash', 'date -d tomorrow +%F'],
    ['bash', 'tree -L 2'],
    ['bash', 'python3 --version'],
    ['bash', 'sort -n f'],
    // A diff of two folders in the working folder, and git's diff inside the repository.
    ['bash', 'diff src lib'],
    ['bash', 'git diff HEAD~1 -- src'],
    ['bash', 'strings @opts.txt'],
    // Registry reads other than a user's environment keys, the system-wide environment included.
    ['powershell', String.raw`Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'`],
    ['powershell', String.raw`Get-Item HKCU:\Software`],
    ['powershell', String.raw`Get-ChildItem HKCU:\Software`],
    ['powershell', String.raw`Get-ChildItem Registry::HKEY_LOCAL_MACHINE\SOFTWARE`],
    ['bash', 'ls src/registry'],
    ['bash', 'cat src/registry/x'],
    ['bash', 'cat ../registry/x'],
    ['powershell', String.raw`Get-Item HKCU:\Software\.\Microsoft`],
    ['bash', "cat '/proc/registry/HKEY_LOCAL_MACHINE/SYSTEM/CurrentControlSet/Control/Session Manager/Environment/Path'"],
  ];

  it.each(proven.map(([shell, command, hosts]) => ({ shell, command, hosts: hosts ?? [] })))('proves $shell: $command', ({ shell, command, hosts }) => {
    expect(verdictOf(shell, command, hosts)).toMatchObject({ readOnly: true });
  });

  // [shell, command, reason substring]
  const refused: ReadonlyArray<readonly ['bash' | 'powershell', string, string]> = [
    // A1: bash replaces an unquoted wildcard with file names before the program runs.
    ['bash', 'ls src/*.ts', 'unquoted wildcard (`*` in `src/*.ts`)'],
    ['bash', 'rg TODO *', 'unquoted wildcard'],
    ['bash', 'cat ?.md', 'unquoted wildcard (`?`'],
    ['bash', 'ls [ab].md', 'unquoted wildcard (`[`'],
    ['bash', 'cat a[', 'unquoted wildcard'],
    ['bash', 'rg --glob=*.ts x', 'unquoted wildcard'],
    ['bash', 'cat /proc/*/environ', 'unquoted wildcard'],
    ['bash', 'cd /c/GameDev/damocles && grep -rn "x" src/**/*.ts | head -40', 'unquoted wildcard'],
    // A1: MSYS2 programs glob their own command line, quoted or not, and pwsh globs native arguments on Linux and macOS.
    ['powershell', "rg TODO '*.md'", 'quoted or not'],
    ['powershell', 'ls *.ts', 'quoted or not'],
    ['powershell', 'rg --glob=*.ts x', 'quoted or not'],
    ['powershell', "grep foo '[ab].md'", 'quoted or not'],
    // A2: every network and device spelling, in a word, an `=value`, an attached value, a comma list or a provider path.
    ['bash', 'cat //evil/s/f', 'network or device path'],
    ['bash', String.raw`cat '\\evil\s\f'`, 'network or device path'],
    ['bash', String.raw`cat '\/evil\s\f'`, 'network or device path'],
    ['bash', String.raw`cat '/\evil\s\f'`, 'network or device path'],
    ['bash', String.raw`cat '\\?\UNC\evil\s\f'`, 'network or device path'],
    ['bash', String.raw`cat '\\.\UNC\evil\s\f'`, 'network or device path'],
    ['bash', String.raw`cat '\??\UNC\evil\s\f'`, 'network or device path'],
    ['bash', "cat '//?/UNC/evil/s/f'", 'network or device path'],
    ['bash', String.raw`cat '\\.\pipe\evil'`, 'network or device path'],
    ['bash', String.raw`cat '\\?\GLOBALROOT\Device\Mup\evil\s\f'`, 'network or device path'],
    ['bash', String.raw`cat '\\?\C:\Windows\win.ini'`, 'network or device path'],
    ['bash', String.raw`cat '\\evil@SSL\DavWWWRoot\f'`, 'network or device path'],
    ['bash', 'rg --file=//evil/s/p x', 'network or device path'],
    ['bash', 'grep -f//evil/s/p x', 'network or device path'],
    ['bash', 'cd //evil/s && ls', 'network or device path'],
    ['bash', 'cat //files/proj/a.txt', 'network or device path'],
    ['powershell', String.raw`Get-Content \\evil\s\f`, 'network or device path'],
    ['powershell', String.raw`gc FileSystem::\\evil\s\f`, 'network or device path'],
    ['powershell', String.raw`gc Microsoft.PowerShell.Core\FileSystem::\\evil\s\f`, 'network or device path'],
    ['powershell', String.raw`gc x,\\evil\s\f`, 'network or device path'],
    ['powershell', 'rg x //evil/s', 'network or device path'],
    // E1: options that write, run another program, or set the clock.
    ['bash', 'file -C -m magic', 'write or execute'],
    ['bash', 'file --compile -m magic', 'write or execute'],
    ['bash', 'file -z f.gz', 'write or execute'],
    ['bash', 'file -bZ f.gz', 'write or execute'],
    ['bash', 'file --uncompress f.gz', 'write or execute'],
    ['bash', 'diff -l a b', 'write or execute'],
    ['bash', 'diff --paginate a b', 'write or execute'],
    ['bash', 'base64 -o out f', 'write or execute'],
    ['bash', 'base64 --output=out f', 'write or execute'],
    ['bash', 'printf -v PATH /tmp/x && git status', 'write or execute'],
    ['bash', 'rg -z foo', 'write or execute'],
    ['bash', 'rg --search-zip foo', 'write or execute'],
    ['bash', 'tree -R -H x', 'write or execute'],
    ['bash', 'date 0101000025', 'sets the clock'],
    ['bash', 'date -u 0101000025', 'sets the clock'],
    ['bash', "echo 'print(1)' | python3 -v", 'version probe'],
    ['bash', 'python -v', 'version probe'],
    // E2: environ by any spelling, and walks that can reach procfs.
    ['bash', 'cd / && cat proc/self/environ', 'environment secrets'],
    ['bash', 'cat /dev/fd/../environ', 'environment secrets'],
    ['bash', 'grep -f /proc/self/environ x', 'environment secrets'],
    ['bash', 'grep --file=/proc/self/environ x', 'environment secrets'],
    ['bash', 'cd proc', 'into a `proc` folder'],
    ['bash', 'grep -rz SECRET /proc/self', 'a `proc` folder'],
    ['bash', 'rg -a SECRET /proc/1', 'a `proc` folder'],
    ['bash', 'diff -r /proc/1 /proc/2', 'a `proc` folder'],
    ['bash', 'git diff --no-index /proc/self /tmp/x', 'a `proc` folder'],
    ['bash', 'grep -r SECRET /', 'the root folder'],
    ['bash', 'grep -rz SECRET /dev/fd/..', 'a path with `..`'],
    ['bash', 'rg SECRET ../../..', 'a path with `..`'],
    ['bash', 'cd / && grep -r SECRET .', 'after `cd` left the working folder'],
    ['bash', 'cd / && rg SECRET', 'after `cd` left the working folder'],
    // E3: the same rule for PowerShell, wildcard-aware for cmdlets.
    ['powershell', 'Get-Content /proc/self/environ', 'environment secrets'],
    ['powershell', 'Get-Content /proc/self/envir*', 'environment secrets'],
    ['powershell', 'gc /proc/self/env[i]ron', 'environment secrets'],
    ['powershell', 'Get-Content -Path /proc/self/* -Include env*', 'environment secrets'],
    ['powershell', 'Get-ChildItem /proc/self | Get-Content', 'a `proc` folder'],
    ['powershell', 'gci /pr?c/self | gc', 'a `proc` folder'],
    ['powershell', 'gci / -Recurse | Select-String SECRET', 'the root folder'],
    ['powershell', 'gci .. -Recurse | Select-String SECRET', 'a path with `..`'],
    ['powershell', 'cat /proc/self/environ', 'environment secrets'],
    // diff compares the same-named files of two folders without -r, and git's diff runs as --no-index outside the repository.
    ['bash', 'diff -a /proc/self /proc/1', 'a `proc` folder'],
    ['bash', 'diff -a --from-file=/proc/self --to-file=/proc/1', 'a `proc` folder'],
    ['bash', 'git diff --text /proc/self /proc/1', 'a `proc` folder'],
    ['bash', 'cd / && diff -a proc/self proc/1', 'after `cd` left the working folder'],
    ['bash', 'diff -a /dev/fd/.. x', 'a path with `..`'],
    // An `@` server goes to WebDAV, not WSL; a response file's path is a path too.
    ['bash', String.raw`cat '\\wsl.localhost@SSL\Ubuntu\x'`, 'network or device path'],
    ['bash', String.raw`cat '\\wsl$@80\Ubuntu\x'`, 'network or device path'],
    ['bash', 'strings @//evil/s/x', 'network or device path'],
    ['bash', 'sort -T /tmp f', 'write or execute'],
    ['bash', 'sort --temporary-directory=/tmp f', 'write or execute'],
    // C7: a user's saved environment in the registry, in every spelling.
    ['powershell', String.raw`Get-ItemProperty HKCU:\Environment`, 'saved environment secrets'],
    ['powershell', String.raw`Get-Item 'HKCU:\Volatile Environment'`, 'saved environment secrets'],
    ['powershell', 'Get-Item HKCU:Environment', 'saved environment secrets'],
    ['powershell', String.raw`Get-Item Registry::HKEY_CURRENT_USER\Environment`, 'saved environment secrets'],
    ['powershell', String.raw`Get-Item Microsoft.PowerShell.Core\Registry::HKEY_CURRENT_USER\Environment`, 'saved environment secrets'],
    ['powershell', String.raw`Get-Item Registry::HKCU\Environment`, 'saved environment secrets'],
    ['powershell', String.raw`Get-Item HKCU:\Env*`, 'saved environment secrets'],
    ['powershell', String.raw`Get-Item Registry::HKEY_C*\Environment`, 'saved environment secrets'],
    ['powershell', String.raw`Get-Item Registry::HKEY_USERS\S-1-5-21-1-2-3-1001\Environment`, 'saved environment secrets'],
    ['powershell', String.raw`Get-Item Registry::HKEY_USERS\*\Environment`, 'saved environment secrets'],
    ['powershell', 'Get-ChildItem HKCU:\\', 'saved environment secrets'],
    ['powershell', String.raw`gci HKCU:\ -Recurse`, 'saved environment secrets'],
    ['powershell', String.raw`gci HKCU:\ | Get-ItemProperty`, 'saved environment secrets'],
    ['powershell', 'Get-ChildItem Registry::HKEY_USERS', 'saved environment secrets'],
    ['powershell', 'Get-ChildItem Registry::', 'saved environment secrets'],
    ['powershell', 'ls HKCU:\\', 'saved environment secrets'],
    ['powershell', String.raw`cd HKCU:\Software`, 'drive or provider'],
    ['powershell', 'cd Registry::', 'saved environment secrets'],
    ['bash', 'cat /proc/registry/HKEY_CURRENT_USER/Environment/X', 'saved environment secrets'],
    ['bash', "cat '/proc/registry32/HKEY_CURRENT_USER/Volatile Environment/X'", 'saved environment secrets'],
    ['bash', 'cat /proc/registry64/HKEY_USERS/S-1-5-21-1/Environment/X', 'saved environment secrets'],
    ['bash', 'cd / && cat proc/registry/HKEY_CURRENT_USER/Environment/X', 'saved environment secrets'],
    ['bash', 'grep -ra x /proc/registry/HKEY_CURRENT_USER', 'saved environment secrets'],
    // Cygwin and the registry provider resolve `.` and `..`, so the screen holds without the path's shape.
    ['bash', 'cat /proc/self/../registry/HKEY_CURRENT_USER/Environment/X', 'saved environment secrets'],
    ['bash', 'cat /dev/fd/../../registry/HKEY_CURRENT_USER/Environment/X', 'saved environment secrets'],
    ['bash', 'cat /proc/./registry/HKEY_CURRENT_USER/Environment/X', 'saved environment secrets'],
    ['bash', 'cat /proc/registry/HKEY_CURRENT_USER/Software/../Environment/X', 'saved environment secrets'],
    ['bash', 'cd /dev/fd/.. && cd .. && cat registry/HKEY_CURRENT_USER/Environment/X', 'saved environment secrets'],
    ['powershell', String.raw`Get-ItemProperty HKCU:\Software\..\Environment`, 'saved environment secrets'],
    ['powershell', String.raw`Get-Item HKCU:\.\Environment`, 'saved environment secrets'],
    ['powershell', String.raw`Get-Item Registry::HKEY_CURRENT_USER\Software\..\Environment`, 'saved environment secrets'],
    ['powershell', String.raw`Get-Item Registry::HKEY_LOCAL_MACHINE\..\HKEY_CURRENT_USER\Environment`, 'saved environment secrets'],
    ['powershell', String.raw`Get-ChildItem HKCU:\Software\..`, 'saved environment secrets'],
  ];

  it.each(refused)('refuses %s: %s', (shell, command, reason) => {
    const verdict = verdictOf(shell, command);
    expect(verdict.readOnly).toBe(false);
    if (!verdict.readOnly) expect(verdict.reason).toContain(reason);
  });

  it.each([
    ['git status', ['git', 'get-git']],
    ['git log --oneline | head -5', ['git', 'get-git', 'head', 'get-head']],
    ['Get-ChildItem | rg foo', ['get-childitem', 'rg', 'get-rg']],
    ['ls -la', ['ls', 'get-childitem', 'get-ls']],
    ['cat foo.txt | sort', ['cat', 'get-content', 'get-cat', 'sort', 'sort-object', 'get-sort']],
    ['gc f | sls x | Measure-Object', ['get-content', 'select-string', 'measure-object']],
    ['date +%F', ['date', 'get-date']],
    ['node --version', ['node', 'get-node']],
  ] as const)('reports every command name PowerShell looks up: %s', (command, names) => {
    expect(verdictOf('powershell', command)).toEqual({ readOnly: true, commandNames: names });
  });

  it('reports no command names for bash, which never runs a .cmd by bare name', () => {
    expect(verdictOf('bash', 'git status | head -5')).toEqual({ readOnly: true, commandNames: [] });
  });

  it('never proves a form that runs a program it does not name as typed', () => {
    for (const command of ['& rg foo', 'rg.exe foo', 'write hello']) {
      expect(verdictOf('powershell', command).readOnly).toBe(false);
    }
  });
});

describe('tokenize — the argv each shell hands the program', () => {
  it.each([
    ['grep "a\\.b" f', ['grep', 'a\\.b', 'f']],
    ['rg "foo\\"bar" f', ['rg', 'foo"bar', 'f']],
    ['echo "\\$x \\` \\\\ \\n"', ['echo', '$x ` \\ \\n']],
    ["echo \\$HOME a\\ b 'c\\d' x\\\\y", ['echo', '$HOME', 'a b', 'c\\d', 'x\\y']],
    ['sed -En "/^|\\/p;/e touch pwned;/p" README.md', ['sed', '-En', '/^|\\/p;/e touch pwned;/p', 'README.md']],
    ['find . -del\\\nete', ['find', '.', '-delete']],
    ['ls \\\n -a', ['ls', '-a']],
    ["cat '' \"\"", ['cat', '', '']],
  ] as const)('bash: %s', (segment, argv) => {
    expect(tokenize(segment, 'bash')).toEqual(argv);
  });

  it.each([
    ['rg "x\\" --pre=calc.exe "y"', ['rg', 'x\\', '--pre=calc.exe', 'y']],
    ['sed -En "/^|\\/p;/e calc;/p" f', ['sed', '-En', '/^|\\/p;/e calc;/p', 'f']],
    ['Get-Content src\\a.txt', ['Get-Content', 'src\\a.txt']],
    ['rg "C:\\Users\\x" f', ['rg', 'C:\\Users\\x', 'f']],
    ["Select-String \"a\"\"b\" 'c''d' '''' \"\"", ['Select-String', 'a"b', "c'd", "'", '']],
    [
      "rg 'x'y \"x\"--pre=calc.exe x\"y\"-z 1'x' -a'x' 'a''b'c ''x",
      ['rg', 'x', 'y', 'x', '--pre=calc.exe', 'xy-z', '1x', '-ax', "a'b", 'c', '', 'x'],
    ],
  ] as const)('powershell: %s', (segment, argv) => {
    expect(tokenize(segment, 'powershell')).toEqual(argv);
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
    .filter((command) => classifyReadOnlyShellCommand('bash', command, CONTEXT).readOnly && !hasUnquotedGt(command));

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
    const verdict = classifyReadOnlyShellCommand('bash', 'ls ' + 'a'.repeat(9000), CONTEXT);
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
