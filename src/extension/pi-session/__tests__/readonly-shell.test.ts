import { describe, it, expect } from 'vitest';
import { classifyReadOnlyShellCommand } from '../readonly-shell';

describe('classifyReadOnlyShellCommand — bash allowlist (provably read-only)', () => {
  const allowed: readonly [string][] = [
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
  ];

  it.each(allowed)('allows: %s', (command) => {
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
  ];

  it.each(blocked)('blocks: %s', (command, reasonSubstring) => {
    const verdict = classifyReadOnlyShellCommand('powershell', command);
    expect(verdict.readOnly).toBe(false);
    if (!verdict.readOnly) {
      expect(verdict.reason).toContain(reasonSubstring);
    }
  });
});
