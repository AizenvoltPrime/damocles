// Model-facing summary of what `classifyReadOnlyShellCommand` (readonly-shell.ts) refuses; keep the two in step.
export const READ_ONLY_SHELL_LIMITS =
  "A shell command is not read-only when it holds an unquoted `*`, `?` or `[` (under PowerShell, any of them in a program's argument, quoted or not), names a network path (`\\\\host\\...`, `//host/...`), or reads environment variables or an `environ` file. Let the tool match patterns instead: `rg -t md foo`, `find src -name '*.ts'` or `rg -g '*.md' foo` in bash, `Get-ChildItem src -Filter *.ts` in PowerShell.";
