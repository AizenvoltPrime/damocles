# Worktree isolation

A chat that works in its own chat worktree must not edit, change into, or run git against the project folder it was
made from. Worktree isolation (D62) is the check that enforces this. It reads the paths a write tool names and the text
of every Bash and PowerShell command, without running anything, and blocks the call when a target lies in a protected
area.

This document states the rules the check follows, in observable terms: what blocks, what is read as a value, and what
is computed. The guarantee and the invariants other subsystems rely on are in `docs/invariants.md`, "Worktree chats".

| File | Role |
| --- | --- |
| `src/core/pi-session/worktree-isolation.ts` | The interpreter: write paths, shell targets, value reading, directories, loops, wrappers, the cmd and PowerShell walkers |
| `src/core/pi-session/readonly-shell.ts` | `parseShellStructure`: Bash text as segments, loops, subshells and word templates |
| `src/core/pi-session/ps-structure.ts` | The PowerShell scanner, parameter binder and cmdlet, parameter and variable tables |
| `src/core/pi-session/cmd-structure.ts` | cmd.exe's reading of a command line: switches, quotes, `%NAME%`, separators, `!` |
| `src/core/pi-session/path-functions.ts` | `Join-Path`, `Split-Path`, `[IO.Path]::Combine`, `dirname`, `basename` |
| `src/core/pi-session/pi-session.ts` | `PiSession.worktreeIsolation()`: the check's input, built per call |
| `src/core/pi-session/permission-gate.ts` | Calls the check for every tool call |

The rows of `src/core/pi-session/__tests__/worktree-isolation.test.ts` are the most complete statement of behavior.

---

## Scope and threat model

The check guards against working in the wrong copy: an agent that types the project folder's path out of habit, `cd`s
up out of the worktree, or follows a variable that still names the project. It is not a sandbox. A command that writes
into the project folder without git, such as `cp` or a redirect, is not caught; it stays under the normal permission
rules, which ask for shell commands outside YOLO. Adversarial text built to hide a name (`.('Set'+'Location')`) is out
of scope.

The protected areas are:

- **the project folder**, the folder the chat's project was added as;
- **another worktree of the project**, every other live chat worktree of the same project;
- **the project's repository**, the repository's top level, which can lie above the project folder. Only git targets,
  working directories and link targets check it; a write tool does not.

A target inside the chat's working folder never blocks, even where the working folder lies inside a protected area.

The check applies to the chat, its subagents and its team, in every permission mode, YOLO included, and before a
PreToolUse hook's force-allow, on the input as the hook rewrote it. Git writes to the shared `.git` directory stay
allowed, so commits from the worktree work.

The check fails closed. A target it cannot read from the text is **computed**, and a computed target blocks. "Computed"
below always means "the text does not prove its value". Text the check cannot parse blocks.

One check, of any tool, reads each path's `realpath` and `lstat` at most once, and a dangling link's `readlink` at most
once (`rememberedPathQueries`), however many targets share the path as a prefix. The next check reads them again.

## Write tools

Edit, Write and GenerateImage block when their `file_path` (or `path`) lies in the project folder or another worktree of
the project, outside the working folder. The path is resolved as the tools resolve it: `@`, `~`, `file://` and Git Bash
drive forms (`/c/...`) included, relative paths against the working folder. Each target is compared in three forms: with
links and junctions resolved, as spelled (8.3 short names and a `\\?\` prefix expanded), and as resolved lexically. A
path that reaches the project folder through a link in the worktree blocks.

## Shell targets

A Bash or PowerShell command blocks when it does any of these:

- **Changes directory** into a protected area: `cd`, `pushd`, `chdir`, `Set-Location`, `Push-Location` and their
  aliases, `env -C`, `sudo -D`, `parallel --wd`, `wsl --cd`, `pwsh -WorkingDirectory`, `Start-Process
  -WorkingDirectory`, `Start-Job -WorkingDirectory`, cmd's `cd`, `pushd` and `start /d`. A `cd` operand takes `..` both lexically and physically, so
  `cd -P link/..` cannot reach the project folder through a link.
- **Runs git** whose working directory, `-C` folder, `--git-dir`, `--work-tree`, `-c core.worktree=` value or
  `git worktree remove|move|repair` operand lies in a protected area. A path git opens takes `..` physically.
- **Makes git write a protected area through an operand** ("git's operands"): the path of `git worktree add`, the
  folder and `--separate-git-dir` of `git clone` and `git init`, and core.worktree as `git config` writes it.
- **Makes a link** whose target lies in a protected area or above one, which a relative path through the link then
  reaches, or whose target the text does not prove ("Links"). `ln -s <project> l && cd l` blocks at the `ln`.
- **Points git there through a variable**: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`,
  `GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES`, checked where the command sets them and at each git
  call.
- **Gives git text it runs** that reaches a protected area. See "Command variables" below.
- **Sets `CDPATH`** so that a relative `cd` lands in a protected area. A computed `CDPATH` blocks every `cd`, and a `~`
  that starts an entry goes to the home ("Home and the current directory").

A target variable keeps every value it may hold, since an assignment may run in a subshell or a branch not taken, and
each value is checked. A computed value of a git path variable or `CDPATH` blocks.

On Windows a shell target is also compared as Win32 opens it for a native program (`GetFullPathName`, measured with
git): the last segment without its trailing dots and spaces, and an earlier segment that ends in a single `.` without
it. So `git -C <project>.` and `cd /d <project>.\src` in cmd reach the project folder.

git is any command whose leaf name is `git` once `.exe`, `.cmd`, `.bat` or `.com` is removed, on every platform and
from any folder (`/usr/bin/git`, `.\tools\git.exe`, `git.cmd`). Bash and PowerShell share one reading of git's
arguments.

### git's options

git's global options before the subcommand are read one by one. `-C`, `--git-dir`, `--work-tree`, `-c` and
`--namespace` are followed, and the options that take no value (`--no-pager`, `--bare`, `-p` and the rest of
`GIT_FLAG_OPTIONS`) pass. These block:

- a computed option, or a computed `-C`, `--git-dir` or `--work-tree` value;
- any other global option, since it may take the next word (`--attr-source HEAD -C <project>`);
- `--config-env`, `-c alias.*` (an alias runs commands), and `-c include.path=` or `-c includeIf.*.path=` (a
  configuration file is not read);
- a variable that gives git configuration from the environment, set in the command: `GIT_CONFIG`,
  `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, `GIT_CONFIG_GLOBAL` and
  `GIT_CONFIG_SYSTEM`.

On Windows git reads its environment without case, so `git_dir=...` is `GIT_DIR`. Bash's own `CDPATH` and `HOME` keep
their case.

### git's operands

`git worktree add`, `clone`, `init` and `config` have their options read from git 2.56's tables as parse-options reads
them: a long option by any unique prefix, `--no-<name>`, `=value` or the next word, short letters in clusters, and
`--` or `--end-of-options` ending them. `worktree add`, `clone` and `init` take options after operands too; `config`
stops at its first operand, so `git config user.name --x` sets a value. An unknown or ambiguous option blocks, and so
does a computed word where an operand that names a folder may be (`git worktree add "$(cat f)"`); a computed value of
an option that names no folder (`-b "$branch"`) passes. Relative paths resolve from git's working directory, after
`-C`, as measured.

- `git worktree add`: its first operand, the new worktree's path. `--reason <text>`, `-b` and `-B` take a value.
- `git clone <repository> [<folder>]`: the folder and `--separate-git-dir`. The repository is read, so
  `git clone <project> sub` passes. Without a folder git makes one in the working directory, named after the
  repository, and refuses a folder that exists and is not empty. A `-c` value is read as a `-c` before the subcommand
  is, and an `--upload-pack` command as command text ("Command variables").
- `git init [<folder>]`: the folder and `--separate-git-dir`. On a folder that already holds a repository,
  `--separate-git-dir` moves that repository's git directory; from a linked worktree it moved the project's `.git` and
  left a `gitdir:` file in the project folder. So `--separate-git-dir` blocks when the folder it initializes (the
  working directory without an operand) lies in or above the working folder.
- `git config`: a write of core.worktree (key without case: `Core.WorkTree`) or of the `core` section. A write is
  `--add`, `--replace-all`, `--unset`, `--unset-all`, `--rename-section`, `--remove-section`, two or more operands with
  no action, or the `set`, `unset`, `rename-section` and `remove-section` subcommands. A read (`--get`, one operand,
  `get`, `list`) passes, and so does any other key. Where the write goes, measured from a linked worktree:
  - with no file option, or `--local`, the repository's shared `.git/config`. The project folder's own git then works
    wherever the value says, whatever it is (a relative value is read from the project's `.git`), while this worktree's
    does not move. So every such write blocks.
  - `--worktree`, this worktree's `config.worktree` (git refuses without `extensions.worktreeConfig`). This worktree's
    git then works in the value, read from its own git directory when relative. A value in a protected area blocks; a
    relative or computed value blocks too, since the git directory is not in the text.
  - `--file`, that file: one in a protected area blocks whatever the value, since it may be a configuration of the
    project; otherwise a value in a protected area, relative to the file's folder, blocks.
  - `--global` and `--system`: git reads core.worktree from neither, so the write moves no repository and passes.

### Links

The check resolves links on disk when it runs, so it cannot see a link the command makes and then uses. A command
that makes a link blocks when the link's target lies in a protected area or above one (`ln -s .. up` from the worktree
reaches the other worktrees beside it; `ln -s ~ h` and `ln -s / r` reach them too), and when the target, or a folder
a relative target is read from, is computed. A target is read lexically and with `..` taken physically.

- `ln` (GNU coreutils 8.32, Git Bash's), from any shell: `-s`, `-f`, `-n`, `-T`, `-t <folder>`, `-r`, `-L`, `-P`,
  `-b`, `-v`, `-i`, `-d`, `-S <suffix>`, clusters, and long options by unique prefix. A symbolic link reads a relative
  target from the link's folder, with `-r` from the working directory; a hard link from the working directory. With
  two operands the second names the link or an existing folder the link goes in, and both readings are checked.
  Git Bash's `ln -s` copies the target when `MSYS` is unset and makes a link under `MSYS=winsymlinks:native`,
  `nativestrict`, `lnk` or `sys`; it reads a relative target from the link's folder either way, so a copy is checked
  as a link. `--help` and `--version` make
  nothing.
- cmd's `mklink` ("cmd"): the link, then the target, switches anywhere among them. `/J` (which wins over `/D`) and
  `/H` read a relative target from the working directory; `/D` and no switch make a symbolic link, which Windows reads
  from the link's folder. Another switch, an attached switch or another number of operands makes nothing.
- PowerShell's `New-Item` and `ni` with `-ItemType` or `-Type` and `-Value` or `-Target`, from the pipeline included.
  The FileSystem provider reads the type as a case-blind wildcard with `*` appended, trying directory, container, file,
  symbolic link, junction and hard link in that order, so `s`, `j`, `h`, `*link` and `?unction` make links; a computed
  type may be any link. A junction and a hard link read a relative target from the current location (pwsh 7 refuses a
  relative junction target); a symbolic link from the link's folder in pwsh 7 and from the location in Windows
  PowerShell 5.1, so both are checked. The link is `-Path` (positional), joined with `-Name`.
- .NET and Win32 link calls in PowerShell (`CreateSymbolicLink`, `CreateAsSymbolicLink`, `CreateHardLink`, in a
  method call or an `Add-Type` declaration) block whatever their arguments.

### Setting variables

A variable is checked where the command sets it:

- Bash: an assignment, a prefix assignment, an `export`, `declare`, `local`, `readonly` or `typeset` operand, a
  `NAME=value` operand of `env`, `sudo`, `cross-env` or `cross-env-shell`, and each item of a `for` header. `read`,
  `mapfile`, `readarray`, `printf -v` and `getopts` naming a git path, command or configuration variable or `CDPATH`
  block. A nameref (`declare`,
  `local` or `typeset` with `-n`) and keyword mode (`set -k`, `set -o keyword`, a shell started with `-k`) block.
- PowerShell: `$env:NAME`, `${env:NAME}`, `Set-Item`, `New-Item`, `Set-Content` and `Add-Content` on `env:` (an
  `Add-Content` value is computed), and `[Environment]::SetEnvironmentVariable` with any target. The name is read without
  case. `$null` unsets the variable, and a multiple assignment gives a computed value. `SetEnvironmentVariable` called any
  other way, and copying, moving or renaming an `env:` item, block.
- cmd: `set`, `set "N=v"` and `set /p` ("cmd").

### Command variables

git runs some values as shell text: `GIT_SSH_COMMAND`, `GIT_PAGER`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`,
`GIT_EXTERNAL_DIFF`, `GIT_ASKPASS`, `GIT_PROXY_COMMAND`, and its `PAGER`, `EDITOR` and `VISUAL` fallbacks; and the
values of `-c core.sshCommand`, `core.pager`, `core.editor`, `core.askPass`, `core.fsmonitor`, `core.gitProxy`,
`sequence.editor`, `diff.external`, `interactive.diffFilter`, `pager.*`, the `filter.*` drivers, `diff.*.command` and
`textconv`, `merge.*.driver`, `credential.helper` (after its `!`), `gpg.program` and `remote.*.uploadpack` and
`receivepack`. That text is parsed as a script `sh -c` runs, in POSIX mode, starting where git may run and in the
working folder, with a home the text does not give.

A command variable from the starting environment is checked at each git call, as the same variable set in the command
is. A prefix assignment on that git (`GIT_PAGER=less git log`) replaces it for that call; a separate assignment adds a
value, and the starting one is still checked. A starting `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`,
`GIT_CONFIG_KEY_<n>` or `GIT_CONFIG_VALUE_<n>` blocks at a git call. A starting `GIT_CONFIG`, `GIT_CONFIG_GLOBAL` or
`GIT_CONFIG_SYSTEM` names the user's own configuration file, which is not read, as `~/.gitconfig` is not.

A command variable's value may hold `$name` or `${name}`, because the shell git starts expands it again:

- a variable that reads as its value ("Value reading") is spliced in, and the text is parsed with it, so
  `GIT_SSH_COMMAND="ssh -i $K"` passes when `K` names a key file and blocks when it holds `x; git -C <project> add .`;
- a variable nothing in the command can set, whose value is still unknown (after a sourced file), is one computed word,
  never syntax;
- a variable the command sets but whose value does not read, a variable bash sets itself (`REPLY`, `PWD`), any other
  expansion form (`$1`, `${K:-x}`, `$(...)`, a backtick), and any variable in a command that can set one by a name the
  text does not show, block.

Another variable may be computed: `GIT_AUTHOR_NAME="$n"` passes.

## The tool's shell

pi's bash tool runs `${commandPrefix}\n${command}` when the shell command prefix is set. The check parses the same text,
so the prefix is part of the command: its assignments define values, its `cd` moves, and a file it sources is a
barrier.

The Bash tool's shell decides how the text is read:

- the default shell (Git Bash on Windows) and a `shellPath` whose leaf is `bash`, `sh`, `dash` or `ash` are read as
  bash, starting from the starting environment; `sh`, `dash` and `ash` run in POSIX mode, which expands aliases;
- WSL's `bash.exe` in `System32` or `Sysnative` reads its command from input in the distribution's environment, so it
  starts with no environment the text gives: inherited values and the home are computed, and values the command sets
  still read;
- any other `shellPath` (zsh, fish, tcsh, csh, ksh, mksh, nu, pwsh, cmd) blocks every Bash command with "The Bash tool
  runs `<name>`, whose commands this check cannot read. Use the PowerShell tool, or set shellPath to bash."

The tool's bash runs as `bash -c`, which is neither a login nor an interactive shell, so it reads no startup file unless
its environment holds `BASH_ENV`; then it starts behind a barrier. Only an interactive shell reads `ENV`.

A Bash command longer than 8,192 characters, the prefix and its newline included, and a PowerShell command longer than
8,192 characters block with a reason that names the limit and points to the Write tool for long file contents.

The PowerShell tool runs `pwsh` or `powershell` with `-NoProfile -NonInteractive -Command`, so it runs no profile and
starts from the starting environment.

PowerShell text is split into tokens as pwsh 7 and Windows PowerShell 5.1 split it, measured on both. Whitespace is
space, tab, VT, FF, U+00A0, U+0085 and every Unicode separator (U+2028 included); U+200B, U+FEFF and U+180E are part of
a token. A CR, an LF or a CRLF ends a statement and a comment, and a backtick before one continues the line. The single
quotes are `'`, U+2018, U+2019, U+201A and U+201B, the double quotes `"`, U+201C, U+201D and U+201E. Any quote of a
kind closes a string or a here-string opened by another of that kind, and two of a kind inside a string stand for the
second.

## Value reading

A variable reference reads as its value only where the text proves that value. Everywhere else it is computed. Reading
is all-or-nothing per reference: a word with one computed part is computed.

### Definitions: the one-site rule

A reference to `N` reads as `V` when a defining assignment sets `N` to `V`, the walk reaches the reference after it, and
that assignment is `N`'s only site anywhere in the run (the command, every text it runs, and every child it starts).

A defining assignment, in Bash:

- `N=value` alone on its command, or an option-free `export N=value` with the name and `=` written plainly;
- with a literal value, or one built from variables that read (`wt="$base/src"`);
- outside compound commands, `( )`, `$()`, pipelines, the background, and the command after `&&` or `||` (the first
  command of a chain counts);
- in the walked text itself, not in `eval`, `trap` or alias text. A child shell's text (`bash -c`, wsl) defines its own
  values the same way.

In PowerShell:

- `$name`, `${name}` or `$env:NAME` set by a plain `=` (no cast, member or index access, one target);
- to one string, one variable that reads, `$null` (which unsets an `$env:` variable), or the output of a path function
  (`$p = Join-Path $wt 'src'`, `$p = (Join-Path $wt 'src')`);
- outside script blocks, parentheses, pipelines and `&&` or `||` chains, and not in `Invoke-Expression` text. A pipeline
  or chain that feeds an assignment makes its value computed (`$wt = '<W>' | Out-Null`).

A `for` or `foreach` variable reads as each item inside the body while the header is its one site ("Loops and
functions").

### Sites

A site is any place that can set a variable. A text scan finds sites in every walked text, inside quotes and comments
too, which can only add sites:

- Bash: `N=`, `N+=`, `N[...]=`, `${N:=`, `${N=` and a `{N}>` redirection;
- PowerShell: `$N` with optional member or index access followed by `=` or an operator-assignment, `++` or `--` next to
  the name, and a `foreach ($N in` header;
- cmd: `set N=`, also quoted or after `/p`.

The interpreter adds the sites the scan cannot see, on words after quote removal, since quotes can build a name
(`declare "w""t=x"`):

- Bash: a prefix assignment, a `for` header, a declaration builtin's operand, the names `read`, `mapfile`, `readarray`,
  `printf -v`, `getopts`, `unset`, `wait -p` and `compgen -V` set;
- PowerShell: the targets of a multiple or chained assignment, the variable `-OutVariable`, `-ErrorVariable`,
  `-WarningVariable`, `-InformationVariable` or `-PipelineVariable` names (by alias or any binding prefix, after `:` or
  as the next word, a leading `+` removed), an `env:` item path, `[Environment]::SetEnvironmentVariable`, and each
  `set` cmd runs.

Sites count by text and offset, so a loop walked again or a second pass never counts one site twice. A second site
anywhere, before or after the read, leaves every reference to that name computed.

### Poison

A poison is a construct that can set a variable by a name the text does not show. After one, no value reads for the
whole run, inherited values, the home and `$PWD` included:

- Bash arithmetic, which assigns names held in values: `$((`, `$[`, `((`, `let`, a `[[` arithmetic comparison
  (`-eq` and the rest), a `${...[` subscript, a `${x:N}` substring, a subscripted assignment, `printf -v x[...]`, and
  `${!x=}`;
- a Bash declaration builtin (`declare`, `typeset`, `local`, `readonly`, `export`) with any option, and a setter or
  declaration given a computed name;
- PowerShell's variable cmdlets (`Set-Variable`, `New-Variable`, `Clear-Variable`, `Remove-Variable`, `Get-Variable`
  and their aliases), `Tee-Object -Variable`, any mention of `variable:`, `[ref]`, `PSReference`, `PSVariable`,
  `SessionState`, `Runspace` or `Import-LocalizedData`, `param(`, `function`, `filter`, `workflow`, `configuration`,
  `class`, `trap` and `data`, splatting, a computed output-variable name, and a computed or wildcard `env:` item path;
- cmd's `set /a` and a `set` with a computed name.

### Barriers

A barrier is code the text does not show running in the shell's own process. Every value known before it is computed
after it, inherited values included; a value set after it reads normally:

- Bash `source` and `.`. The file is not read, so `source .venv/bin/activate` passes;
- PowerShell dot-sourcing of anything but a literal script block, `Import-Module`, `ipmo` and `using module`;
- the start of a child that runs startup files: a Bash child with `BASH_ENV` in its environment, `bash -l`, `--login`,
  `-i` or `--interactive`, `pwsh` or `powershell` without `-NoProfile`, and cmd without `/d` (AutoRun).

A PowerShell script file the command runs (a command or `&` operand ending in `.ps1` or `.psm1`, without case) is an
environment barrier: after it, `$env:` values and what children inherit are computed, and plain variables keep their
values. A script changes plain variables only through `$global:` writes, which are not read, like its location changes.
A bare command name stays a program (`npm` may resolve to `npm.ps1`, which the text does not show).

A PowerShell script block that may run later (a value such as `$f = { ... }`, or an argument of a command that may keep
it, such as `Register-EngineEvent -Action { ... }`) makes a later script file, dot-source or module import a poison
instead, because the block's reads may come after the barrier. A block that runs where it stands (`if`, `foreach`,
`ForEach-Object`, `Where-Object`, `Invoke-Command`, `try`) does not.

A barrier also makes the aliases unread and OLDPWD computed, so a later `cd -` or `pushd -` blocks, and adds an unknown
value to Bash's `HOME`.

### References

In Bash, a reference reads only as `$NAME` or `${NAME}`. Special parameters, operator forms (`${x:-y}`), `$'...'` and
the variables bash sets or uses itself (`IFS`, `RANDOM`, `REPLY`, `OLDPWD` and the like) are computed; `HOME` and `PWD`
read as the shell's own ("Home and the current directory"). An unquoted reference
reads only when its value is one word that splitting, globbing and tilde expansion leave unchanged (not empty, no
whitespace, `*`, `?`, `[`, `(` or `\`), and never in a command that assigns `IFS`. A value that starts with `~` never
reads, because bash does not tilde-expand a value.

A Bash word with an unquoted `*`, `?` or `[`, or with braces around an unquoted `,` or `..` (`{a,b}`, `{1..3}`), is a
pattern and computed. Other braces are text, so `xargs -I{} cp {} /tmp` reads as written.

In PowerShell, a reference reads only as a token that is exactly `$name`, or a string or bare token that expands it
(`"$wt\src"`, `$wt\src`). A member or index access (`$wt.Parent`), a name qualified by anything but `env:`, an
automatic or preference variable other than `$HOME` and `$PWD`, and a number are computed. Names match without case.
`$env:NAME` reads only when the variable is set, since a cmdlet binds `$null` and `''` differently.

A value that reads reaches its consumer as literal text in the same place would. cmd's `%NAME%` is the exception: cmd
expands it before it parses the line, so the value is parsed with the line ("cmd").

### Passes

The check walks the command up to three times. The first pass reads values optimistically. It becomes invalid when a
name it read gains a site in text walked later (eval, a trap, a child, `Invoke-Expression`, text built from a value), or
a poison appears after a read. The second pass starts from every site and poison the first found. If it is invalid
too, a third pass with value reading off decides. A block from any pass stands.

## Starting environment

The check starts from the environment the chat's shells start with: `process.env` of Damocles Core merged with the
worktree's variables (`DAMOCLES_PROJECT_FOLDER`, `DAMOCLES_WORKTREE_INDEX`), read per call, never cached, and never
logged. `PATH` and pi's `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL` are
computed, because pi sets them per call. On Windows names match without case, and a name `process.env` holds in two
spellings is computed.

A variable the command never sets reads as its starting value: in Bash an unset one as empty, in PowerShell `$env:NAME`
only when set. A starting value reads only while its name has no site in the run. A starting `CDPATH`, git path variable
or command variable is followed as if the command had set it.

Git Bash on Windows converts `PATH`, `HOME`, `TMP`, `TEMP` and `TMPDIR` to POSIX form when it imports them. A Bash
reference to one whose value holds `\` or `;` reads only when the value is a single drive path, in its `/c/...` form;
any other such value is computed.

### What children inherit

A child process inherits its parent's exported environment at the point it starts, as far as the text proves it:

- Bash exports `export NAME=value` and an assignment to a variable the shell started with;
- PowerShell exports every `$env:` value; a plain PowerShell variable is never inherited;
- a Bash child reads names with case; a pwsh or cmd child reads them without case on Windows. On Windows a name the
  parent's environment spells another way is computed in a Bash child;
- `wsl`, `sudo`, `su`, `runuser`, `doas`, `env -i`, `env -u`, `env -`, `exec -c` and `Start-Process` with
  `-UseNewEnvironment`, `-Credential` or `-Verb` (by any prefix) give the child an environment the text does not show.

A variable that is not exported does not reach a child. The parent replaces its own references in the text it passes,
so `bash -c "cd $d"` reads the parent's `$d`.

## Home and the current directory

`~` (starting a word, or after an assignment's first `=` or an unquoted `:`) and an operand-less Bash `cd` go to the
home the shell has:

- Bash's home is `HOME` with every value it may hold: the starting value (or, without `HOME`, the profile folder Git
  Bash uses), each value an assignment, a declaration or a `for` item gives it, and an unknown value for `read`,
  `mapfile`, `printf -v`, `getopts`, `unset`, `${HOME:=}`, a barrier or a startup file. A prefix assignment
  (`HOME=/tmp/h cd`) replaces it for that command. Children inherit it through the environment, and a PowerShell
  `$env:HOME` assignment reaches its Bash children.
- PowerShell's `~` and `$HOME` are its read-only `$HOME`, fixed when the process starts from the `USERPROFILE` it
  inherits on Windows (`HOME` elsewhere); `HOMEDRIVE` and `HOMEPATH` change nothing, and neither does assigning `$HOME` or
  changing `USERPROFILE` in the running process. The tool's PowerShell, and a child whose variable the run never sets,
  have the profile folder; a child started after the text sets it has the value it reads as ("Value reading"), so
  `$env:USERPROFILE = '<project>'; pwsh -c 'cd ~'` enters the project folder; a computed or unknown value makes `~` and
  `$HOME` computed in that child.

The home reads only when it has exactly one possible value, no poison came, and the value does not start with `~`.
Otherwise `~` and an operand-less `cd` are computed. So `HOME=/tmp/h; cd ~` blocks, because the home may be either
value, and arithmetic anywhere in the command makes the home computed. git runs a command variable's text with an
unknown home. `~user` is computed. A quoted `~` is a folder name.

`$HOME` reads as that home. `$PWD` reads as the current directory when exactly one directory is possible and nothing in
the run sets `PWD`; in Bash on Windows it reads in the `/c/...` form.

## Directories

### Places

The check follows every place the shell may stand in. A place is a directory together with its own directory stack and
OLDPWD values. A command that may fail keeps the places before it possible, so a failed `cd` cannot hide where the shell
is.

- A `cd` or `Set-Location` that succeeds moves; one that fails stays put. Each place records whether the last command
  there succeeded, failed or either.
- `&&` and `||` are followed exactly: the command after `&&` runs only in the places where the one before it succeeded,
  the command after `||` only where it failed, and the others stay as they were. `cd src && git -C .. status` passes.
  A guard after a compound command, a negated command (`!`) or a pipeline is not followed, so both outcomes stay
  possible.
- A `( )` subshell returns to the places it started with. A `$()` gets its own copy of the variables, functions and
  directory stack.
- Only the builtin, called by its name, moves the shell. `chdir`, `CD` and a `cd` run by a wrapper start a program in a
  process of their own; their target is still checked.

### Push and pop

- Bash `pushd` pushes only when it moves; a failed `pushd` leaves the stack as it was. `pushd` without an operand swaps
  with the stack's top. `pushd -` goes to OLDPWD ("Previous directory"). `pushd -n`, `pushd +N` and `pushd -N` block.
- PowerShell `Push-Location` pushes even when it fails to move.
- `popd` and `Pop-Location` return to the stack's top. On an empty stack Bash's `popd` fails and stays; cmd's `popd` and
  `Pop-Location` stay.
- `dirs -c` clears the stacks. `popd` with any argument, `-StackName`, and anything that may set `DIRSTACK` make the
  directory unknown.

### Previous directory

`cd -` goes to OLDPWD in each place and fails where it is unset; `pushd -` does the same and pushes the directory it
leaves. OLDPWD is computed when the text may set it, the starting environment holds it, a barrier ran, a poison came,
or the shell is a child shell; then `cd -` and `pushd -` block, because the directory they change to is computed.
Only Bash's `cd` and `pushd` builtins read `-` this way; to `env -C`, `sudo -D` and cmd's `cd` it names a folder.
PowerShell's `Set-Location -` and `+` go to any location the process has stood in.

### Unknown directories

The directory becomes unknown when the places pass 32, a loop or the walk of a trap that runs before every command does
not settle, a drive change in cmd (`D:`) runs, `su
-l` or `sudo -i` goes to a user's home, `find -execdir` runs, or one of the push and pop cases above applies. In Bash an
unknown directory blocks the next command that needs it: a git call, a `cd`, a git path or `CDPATH` value, or a child
shell or cmd that starts there; `$PWD` is then computed. In PowerShell it blocks the next statement that runs git, a
shell, cmd or wsl, or moves or starts a process in a location (`Set-Location`, `Push-Location`, `Start-Process`). When the places
grew past 32, the reason suggests the form that keeps them few: a `( cd "$d" && ... )` subshell in Bash, or `Push-Location` and
`Pop-Location` in PowerShell, at a loop body's top level or in an `if` branch inside it ("Loops and functions").

### PowerShell locations

`Set-Location`, `Push-Location`, `sl`, `cd`, `chdir`, `pushd`, and the functions `cd..`, `cd\` and `cd~` move the
location. Their parameters bind by any unambiguous prefix. `-Path`, positional included, takes wildcards, so a value
with an unescaped `*`, `?` or `[` is a pattern and computed; `-LiteralPath` is read as written. A directory from the
pipeline or a splatted variable is computed. `Set-Location` without a path goes home; `Push-Location` without one pushes
and stays. A `FileSystem::` prefix is removed, and a path on any other drive of two or more letters (`HKLM:`) blocks. On
Linux and macOS each `\` in a location reads as `/`, as pwsh's FileSystem provider reads it; a native program such as
git gets `\` as written.

These block: `New-PSDrive` and its aliases, the session-state location and drive methods (`SetLocation`,
`PushCurrentLocation`, `PopLocation`, `Drive.New`), and `$PSDefaultParameterValues` named anywhere.
`[Environment]::CurrentDirectory` and `SetCurrentDirectory` pass, because PowerShell starts native programs and
`Start-Process` in its own location.

### Traps and jumps

A Bash trap's action is walked once where it is set. An `EXIT` trap runs again where its shell exits, from every place
that shell has stood in. The shell is the script, a child shell, a `( )` subshell or a `$()` substitution: a subshell or
substitution starts with none of the `EXIT` traps around it, runs the ones it sets when it exits, from its own places,
and leaves the traps around it as they were.

A trap on anything but `EXIT` (`ERR`, `DEBUG`, `RETURN`, a signal, or a condition the text does not give) may run any
number of times before each later command of its shell, and after the last one, before the `EXIT` trap. Each later
command starts from every place the trap actions reach when run again and again from where the shell stands, walked as
a loop body until the places stop growing ("Loops and functions"). An action does not run again inside itself, and
another trap's action may run between its commands, as in bash. A `( )` subshell and a substitution keep these traps,
as bash does under `set -E` and `set -T`. A trap does not change the exit status `&&` and `||` read.

After `break` or `continue` every command may start from any place seen, and in PowerShell after `break`, `continue`,
`return`, `throw` and inside `catch`, `finally` and `trap`. In a PowerShell text that holds a `trap` anywhere, every
statement may start from any place seen: PowerShell sets a trap for its whole scope, and its `continue` resumes after the
top-level statement around the error, which may leave an `if` branch or a loop body partway.

## Loops and functions

- A Bash `for` or PowerShell `foreach` over at most 32 items the text gives runs its body once per item, with its
  variable reading as that item inside the body while the header is its only site. A Bash item reads when it is
  literal, a variable that reads, `~` or a path function; a PowerShell item must be one string or variable token. After
  the loop the variable is computed. An empty list runs the body no times.
- Any other loop (`while`, `until`, `for ((`, a longer or unreadable list, `do`, `switch`, `ForEach-Object` and other
  script blocks given as arguments), and every call of a PowerShell function or filter, is walked again until the
  directories, values, aliases and traps it reaches stop growing. A loop may stop between any two of its commands, so
  where a walk dropped a place it stood in, every place seen stays possible after the loop.
- A PowerShell function or filter is walked once where it is defined (its places join those before it) and recorded by
  name without case; each call by that name walks its body where the call stands.
- A branch of an `if` runs whole or not at all: in Bash from `then` or `else` to the next `elif`, `else` or `fi`, and
  from `elif` to the same; in PowerShell an `if` or `else` block, and an `elseif` from its condition to the end of its
  block (`if(` and `elseif(` without a space included). An `elif` or `elseif` condition belongs to its branch, and the
  body after it is a branch of its own inside it, since the condition may run and fail. A branch's commands follow one
  another, `&&` and `||` included, and the places after it are those it reaches joined with those before it. So a
  `pushd` and `popd`, a `Push-Location` and `Pop-Location`, or a `( cd ... )` subshell that returns inside a branch of a
  loop body leaves the places as they were, as at the body's top level; a branch that leaves a place changed adds it. A
  `break` or `continue` in a branch is followed as anywhere else ("Traps and jumps"). Real shells measured: Git Bash
  5.3 and bash 5.2 on Ubuntu 24.04, pwsh 7.6 and Windows PowerShell 5.1, where an error that ends one statement of a
  branch does not end the branch unless a `trap` is in the scope ("Traps and jumps").
- `try`, `catch` and `finally` bodies, Bash groups and subshells, and a script block after `&` or `.` run at most once.
- A loop that has not settled after 32 walks makes the directory unknown. Past 256 loop and function body walks in one
  pass, the command blocks. The walks of the traps that run before every command ("Traps and jumps") count too; they
  are walked again only where the shell's state changed since they last settled, so commands that change nothing cost
  none.
- A Bash function definition and `case`, `select` and `coproc` cannot be parsed, so they block.

Bash reads reserved words (`for`, `do`, `done`, `if`, `fi`, `{`, `}` and the rest) only as the first word of a simple
command, unquoted, with no assignment or redirection before them. An unbalanced or mismatched compound command, and a
word after a closing word (`done x`), cannot be parsed. Redirections on `done`, `fi`, `}` or `)` run once before the
compound command, so their substitutions run before it.

## Path functions

A path function reads as the path it prints, where Windows PowerShell 5.1, pwsh 7 and Git Bash agree and every operand
reads. Every other form, option or edge case is computed.

In PowerShell, a `( )` or `$( )` that is a whole token, or a `$( )` inside a string, reads when it holds one statement
that is a string or a variable that reads, or one of:

- `Join-Path` with one path and one child path: separators normalized, one leading separator of the child dropped, none
  doubled. `-Resolve`, `-AdditionalChildPath`, several paths, a child starting with two separators, a wildcard, a UNC
  path, a drive other than a file system drive of the working folder, the project, its repository or the home folder,
  and a `:` outside a leading drive are computed.
- `Split-Path` with `-Parent` (the default), `-Leaf` or `-Qualifier`. A root, a doubled or trailing separator, a last
  `.` or `..`, a drive-relative path, a lone `~` (which Split-Path resolves to the home folder) and a switch given a value
  are computed.
- `[IO.Path]::Combine` and `[System.IO.Path]::Combine` with string, variable or subexpression arguments: a rooted argument restarts
  the path, an empty one is skipped. A drive-relative argument, a `:` outside a leading drive, and `"`, `<`, `>`, `|` or
  a control character are computed.

The same statements give an assignment's value (`$p = Join-Path $wt 'src'`).

In Bash, a `$(...)` holding one command with no pipe, list or redirection reads when the command is:

- `dirname` or `basename` (no suffix operand) with one operand, as POSIX defines them, `\` a separator too in Git Bash;
  a drive with nothing below it and a leading `//` are computed;
- `realpath -m`, with links resolved where the path exists, or `realpath -m -s` (lexical), only when exactly one current
  directory is possible.

The printed path reaches its consumer as literal text in the same place would, so an unquoted `$(...)` follows the
unquoted-reference rule. Any other command's output is computed (`cd "$(git rev-parse --show-toplevel)"` blocks).

## cmd

cmd reads the command line it is started with as cmd does (`cmd-structure.ts`), whichever shell starts it.

**The line it gets** is the one its caller builds: Git Bash's MSYS2 quoting, with `//c` read as `/c`; PowerShell's
legacy quoting, both as pwsh 7 and as Windows PowerShell 5.1 build it; `Start-Process` arguments joined by spaces; and
`npx -c` and `cross-env-shell` text on Windows as `/d /s /c "<text>"`. `--%` before cmd's arguments and any mention of
`$PSNativeCommandArgumentPassing` block.

**Switches**, up to `/c` or `/r`, attached (`/cgit`) or quoted: `/d`, `/s`, `/q`, `/a`, `/u`, `/t:<color>`, `/e:on|off`,
`/f:on|off` and `/v:on|off`. `/?` runs nothing. No `/c`, `/k`, and any other switch block. Without `/d`, AutoRun runs
first, so cmd starts behind a barrier; the check never reads the registry.

**The quote rule**: the text after `/c` loses its first and last quote, and where every condition for keeping them
holds except "names an executable file", which the text does not show, both readings are checked.

**`%NAME%`** is replaced before anything else is parsed:

- a value the text or the starting environment proves is spliced into the line and parsed with it, so a value's `&`
  really runs and a value's `(` where a command starts blocks;
- a name nothing can have set stays as written (`%G%`);
- a value from outside the command that is not known (after AutoRun or another barrier) is a computed word, and cmd's
  dynamic names (`CD`, `DATE`, `RANDOM`, `ERRORLEVEL` and the rest) are computed;
- a name the command may set blocks, and so do a replacement (`%X:a=b%`) and a substring of a value that holds syntax.

**Parsing** after `%NAME%`: carriage returns are removed, and everything from the first line feed is ignored. `^`,
quotes, `&`, `&&`, `||`, `|`, redirections and a leading `@` are read as cmd reads them. A redirection's target ends at
whitespace, `,`, `;`, `=` or an operator. The delimiters are cmd's measured whitespace (including U+0085, U+00A0 and
U+180E, not U+00FF) and `,`, `;` and `=`. Only a `(` where a command starts blocks; every other parenthesis is text.
A label blocks. A pipeline's sides run in child cmd processes, which read their text again.

**Delayed expansion**: with `/v:off` a `!` is text. Otherwise it is computed, and where expansion may be on (`/v:on`, or
no `/v` switch, since the registry may turn it on), each part of a command that holds a `!` also loses its carets.
Without a `/v` switch both readings are checked.

**Commands**: an internal command's name ends at a delimiter or at `.`, `\`, `/`, `:`, `+`, `[`, `]` or `(`, so
`cd..`, `cd\`, `cd/d` and `cd(` are `cd`. A program token is also read as the program named before its first unquoted
`/` or `(` (`"cmd"/c`). cmd follows:

- `cd` and `chdir`, with `/d`: the rest of the line without quotes, and its first word in case extensions are off;
- `pushd`, `popd`, and a drive change (`D:`), after which the directory is unknown;
- `set`, as an assignment; `set /p` gives a computed value, and `set /a` poisons and blocks when it names a variable git
  reads;
- `start`: the first quoted token among its options is the title, wherever it stands, and options go on after it; a `/`
  right after the title's closing quote starts the next option; `/d` names the folder; the first other token, a second
  quoted one included, is the program, and the words after it are its own. An internal command there runs in a new cmd,
  which runs AutoRun;
- `call`, which reads its text again; `call :label` and any `%` after `call` block;
- `mklink`, as a link: its words split at cmd's delimiters, quotes removed ("Links");
- git, its arguments split both as the C runtime and as MSYS2 split them; nested shells.

`for`, `if`, `goto`, `setlocal enabledelayedexpansion` and `setlocal disableextensions` block. More than 16 readings of
one line block.

## Nested shells and wrappers

### Shells

`sh`, `bash`, `dash` and `ash` started by the command are read as bash. Their `-c` text is parsed as a child script; `-c` anywhere in a cluster (`-lc`, `-ec`) takes the next operand. These block: a
computed argument, no script operand, `-s`, `-` or `--` with nothing after it (the shell reads its commands from
input), a script operand of `/dev/stdin`, `/dev/fd/<n>` or `/proc/<pid>/fd/<n>`, `-k` or `-o keyword`, and an unknown
long option. `-c` text for `zsh`, `ksh`, `mksh`, `fish`, `tcsh` or `csh` blocks, since their syntax (fish's `set -x`, a
two-operand `cd`) is not bash's. A script file operand is not read, even one the command wrote. `--version` and `--help` run nothing.
`--posix`, `-o posix` and `-O expand_aliases` change how the child reads aliases.

`pwsh` and `powershell` read their switches as each program does, measured on pwsh 7.6 and Windows PowerShell 5.1: each
switch by the prefixes that program accepts, after `-`, `--`, `/` or a Unicode dash, tried in the program's own order,
with the switches that take a value (`-ExecutionPolicy`, `-WindowStyle`, `-OutputFormat`, `-InputFormat`,
`-ConfigurationName`, `-EncodedArguments`, `-Token`, `-UTCTimestamp`, and pwsh's `-SettingsFile`, `-CustomPipeName` and
`-ConfigurationFile`) taking the next word. 5.1's `-i` is `-InputFormat`; pwsh's is `-Interactive`. The first word that
is neither a switch the program takes nor a switch's value ends the switches: `powershell` runs it and the words after
it as its command (`powershell git -C <project> status` runs git there, and an unknown switch starts the command as a
command of that name), and `pwsh` takes it as a script file, which is not read (`pwsh git -C <project> status` runs no
command text). Then:

- `-Command` takes the rest of the line joined, pwsh's `-CommandWithArgs` the next word; `-EncodedCommand` takes UTF-16LE
  base64, and the switches after it are still read;
- `-File` names a script file, not read;
- pwsh's `-WorkingDirectory` is a working directory. Windows PowerShell 5.1 takes its value and stays where it starts;
- Windows PowerShell's launcher takes a leading `-Version` and `-PSConsoleFile`, each once and after `-` only; later they
  start the command;
- without `-NoProfile` the profiles run first, and a console file, a session configuration (`-ConfigurationName`,
  `-ConfigurationFile`) and pwsh's `-Login` off Windows run code first too, so the child starts behind a barrier.

`-`, `-Command -` and `-File -` (which read the commands from input), a server mode (`-ServerMode`, `-SocketServerMode`,
`-NamedPipeServerMode`, `-SSHServerMode`), no command, computed text and undecodable base64 block. `-?`, `-Help`, and
pwsh's `-Version` run nothing. pwsh's `exec` function (Linux and macOS) runs its words as a program, read as after `&`;
`Switch-Process` blocks.

`wsl` reads the command line its caller builds ("cmd", "The line it gets"; from PowerShell also pwsh 7.3's Standard
quoting, which pwsh gives every program but cmd), as wsl.exe reads it (`WslClient.cpp`, measured): its own options are
split at spaces and tabs only, so a quoted option is not one, and `--cd` alone takes a quoted value. A management command
(`--list`, `--status`, `--shutdown` and the rest) runs nothing; `--cd` is a working directory (a Linux path when it starts
with `/` or `~`); `-e`, `--exec` and `--shell-type none` run the rest of the line split into words as `CommandLineToArgvW`
splits it; otherwise the rest of the line, quotes and spacing as the caller wrote them, is the text bash reads
(`wsl bash -c "git -C /mnt/c/... status"` runs the git). No command line, `--debug-shell` and an unknown option block.

### Text the shell runs itself

`eval` text and trap actions run in the same shell, so their `cd` and assignments reach the commands after them; their
assignments never define values. Computed `eval` or `trap` text blocks. PowerShell's `Invoke-Expression` runs its literal
text in the same scope; computed or piped text blocks. `[scriptblock]::Create`, `InvokeScript`, `NewScriptBlock` and
`PSVariable.Set` block.

PowerShell can start a process or run text through its own language, which the check does not follow, so these block:
`[powershell]::Create` and `AddScript` or `AddCommand`; a `System.Diagnostics.Process` started, made or set up
(`[Diagnostics.Process]::Start` or `::new`, `New-Object` of the type, any `ProcessStartInfo` or `StartInfo`); WMI and CIM
methods (`Invoke-CimMethod`, `Invoke-WmiMethod`, `[wmiclass]`, `[wmi]`, `InvokeMethod`, and a command that names
`Win32_Process` and calls a `Create` method); COM objects (`New-Object -ComObject`, `GetTypeFromProgID`,
`GetTypeFromCLSID`), such as `WScript.Shell` with `Run` or `Exec` and `Shell.Application` with `ShellExecute`; and a
link made through .NET or Win32 ("Links"). Reading processes passes: `Get-Process`,
`[Diagnostics.Process]::GetCurrentProcess()`, `Get-CimInstance Win32_Process`.

Bash arithmetic runs a `$()` in an array subscript of the text it evaluates, so a `$()` in quoted text is followed where
that text becomes a variable's value, a `let` operand or a `[[` arithmetic operand; in any other argument it is data.

### Wrappers

`env`, `command`, `builtin`, `exec`, `nohup`, `nice`, `time`, `timeout`, `sudo`, `stdbuf`, `xargs`, `setsid`, `doas`,
`flock`, `watch`, `parallel`, `ionice`, `taskset`, `chrt`, `script`, `su`, `runuser`, `winpty`, `cross-env`,
`cross-env-shell` and `npx` are read with their own option tables, short clusters and long-option abbreviations; any
other option blocks. Each runs its command in a process of its own, except `builtin` and `command` without `-v` or
`-V`. `busybox` runs its applet in a process of its own.

- `env`, `sudo`, `cross-env` and `cross-env-shell` take `NAME=value` operands, checked as assignments.
- `env -C`, `sudo -D` and `parallel --wd` change directory; `sudo -R` blocks.
- `env -S` splits its own text, and each later word reaches the command as one computed word.
- The text `flock -c`, `script -c`, `su -c`, `runuser -c`, `npx -c`, `watch` (without `-x`) and `cross-env-shell` hand
  to a shell is parsed as a script. A computed word in `watch`, `cross-env-shell` or a `parallel` command template
  blocks.
- `parallel` runs each job through a shell, with each input in place of its replacement string, or appended, as one
  computed word; without a template each `:::` input is a command line, and `::::` or `--arg-file` input blocks.
- `xargs` puts what it reads in place of its replace string, or after the command, as a computed word.
- `find -exec` and `-ok` run their command with `{}` computed; `-execdir` and `-okdir` run it in a directory the text
  does not give.
- `mapfile -C` runs callback text and blocks.

### Start-Process

`Start-Process`, `saps` and `start` start their program in `-WorkingDirectory`, checked as a location and wildcard-aware,
or else in the current location. Its `-ArgumentList` elements, joined by spaces and split again as the program's runtime
splits them, go to git, cmd or a nested shell; cmd and wsl read the joined line itself. A computed program, a computed git
argument and `-Environment` block.

### Jobs

A `Start-Job` script block, and its `-InitializationScript`, run once in a new process with the caller's environment and
none of its variables (`$using:` references are computed). pwsh 7 starts the job in `-WorkingDirectory`, which it sets as
written: a `~` there is the job's home, a pattern fails, and a relative path resolves from a folder the text does not
give, so a pattern and a relative path are computed. Without `-WorkingDirectory` pwsh 7 starts the job in the current
location and Windows PowerShell 5.1, which has no `-WorkingDirectory`, in the Documents folder, so the job's directory is
computed: `Start-Job { npm test }` passes and `Start-Job { git status }` blocks. `Start-ThreadJob` and
`ForEach-Object -Parallel` (pwsh 7; 5.1 has neither) run their blocks in the current location, as measured.

## Aliases

Bash aliases are read where bash expands them. Each literal `alias NAME='text'` in the command or the command prefix is
recorded, and a command word that names it is read as its text, the next word too while the text ends in a blank.
Expansion follows bash:

- non-interactive `bash -c` expands aliases only after `shopt -s expand_aliases`, or in POSIX mode (`sh`, `set -o
  posix`, `--posix`, `POSIXLY_CORRECT`, `SHELLOPTS` with `posix`), or with `BASHOPTS` holding `expand_aliases`;
- bash reads a whole line before it runs it, so an alias defined on a line does not expand later on the same line;
  substitutions, `eval` and trap text are read when they run;
- only an unquoted literal command word expands, and an alias is not expanded again inside its own text;
- a child shell starts with no aliases; an alias a sourced or startup file defines is not read.

These block: an alias defined by computed text, an alias named after a reserved word, `alias -p` with definitions,
`unalias` of a computed name, an alias change while a trap is set, and an alias with text over more than one line where
it is used. A command word that may name an alias whose definition, or whether expansion is on, the text does not prove
(after `false && alias ...`, a subshell, `eval`, a barrier, or a computed `shopt`) blocks where it is used.

PowerShell's `Set-Alias`, `New-Alias` and their aliases, and an alias or function defined on the `alias:` or
`function:` drive, block.

## Block reasons

A block is a policy block (`formatPolicyBlockReason`): "This chat works in its worktree. Edits and commands aimed at
the project folder are blocked in every mode." followed by the detail and "Work in `<working folder>` instead."

The detail names the word as the command wrote it and the area it reaches ("`"$p"` is in the project folder."), never a
value read from it. A word that comes from text the command built has no spelling, and the detail names only the area
("A path the command builds is in the project folder."). Text read again (`eval`, `bash -c`, cmd, `Invoke-Expression`,
`pwsh -Command`) is parsed from its expanded form, so its words may hold a value the command itself wrote.

A reason never repeats a value from the starting environment. Every value a reference read from it, and every starting
command variable checked, is split into runs of letters and digits; a run of 3 or more characters that the command text
does not contain is kept back. When the word a detail would name contains one, the detail drops the word and keeps the
area. The home counts as such a value only when it came from `HOME`, or from `USERPROFILE` on Windows without `HOME`.

## Limits

| Constant | Value | Effect |
| --- | --- | --- |
| `MAX_COMMAND_LENGTH` (`readonly-shell.ts`) | 8,192 characters | A longer Bash command, prefix included, or PowerShell command blocks naming the limit; a longer nested Bash text cannot be parsed and blocks. |
| `MAX_NESTING` | 200 | Blocks, loops, subshells, function calls and nested texts deeper than this block, naming the limit. |
| `parseShellStructure` depth | 8 | Bash substitutions nested deeper cannot be parsed. |
| `MAX_PS_NESTING` (`ps-structure.ts`) | 200 | PowerShell subexpressions nested deeper cannot be parsed. |
| `MAX_DEPTH` | 6 | Nested texts (eval, trap and alias text, child shells, substitutions, `Invoke-Expression`, cmd) deeper than this block. |
| `MAX_PLACES` | 32 | Past this many places, or places stood in, or OLDPWD values, the directory or OLDPWD is unknown. |
| `MAX_LOOP_ITEMS` | 32 | A longer `for` or `foreach` list is walked as any loop, its variable computed. |
| `MAX_UNSETTLED_WALKS` | 32 | A loop, or the walk of a trap that runs before every command, not settled after this many walks makes the directory unknown. |
| `MAX_LOOP_WALKS` | 256 | Past this many loop, function body and repeating trap walks in one pass, the command blocks. |
| `MAX_TRAP_RUNS` | 6 | Where a shell or subshell exits its `EXIT` trap actions are walked again; a seventh such walk in one exit blocks. |
| `MAX_READINGS` (`cmd-structure.ts`) | 16 | More readings of one cmd line (quote rule, unproven `%NAME%`, delayed expansion) block. |
| Passes | 3 | See "Value reading". |
| Secret runs | 3 characters | Shorter runs of a starting value may appear in a reason. |

## Assumptions

- The tool's Git Bash runs as `bash -c`, neither a login nor an interactive shell, so it reads no startup file without
  `BASH_ENV`. A Windows test runs Git Bash as pi starts it and fails if that changes.
- The starting environment is exact apart from `PATH` and pi's per-call variables. If a shell tool changes the
  environment it gives its shell, `PiSession.worktreeIsolation()` must read the same source (`shellOptions()`).
- A folder the shell stood in still exists when `popd` or `Pop-Location` returns to it.
- A script file's text is not read. Its location changes and its `$global:` writes do not reach the command.
- Script blocks given to `Start-ThreadJob`, `ForEach-Object -Parallel` and other cmdlets that keep a block are read with
  the caller's location, as pwsh 7 runs them, and with its variables, which they see only through `$using:`; a
  `Start-Job` block runs in its own process ("Jobs").
- git hooks run at the worktree's top level, so `core.hooksPath` is not a target.
- Where Windows PowerShell 5.1 and pwsh 7 differ, or a case was not verified, the reading is computed.

## Accepted gaps

- Writes into the project folder without git (`cp`, `mv`, redirects, editors) are not caught, and neither are files
  git writes where an option names them (`git format-patch -o`, `git archive -o`, `git bundle create`).
- Links made by other programs (`cp -s`, `cp -l`, `fsutil hardlink create`, Sysinternals `junction`) are not read.
- `git config --edit` runs an editor whose changes the text does not show.
- Other spellings of the same disk are not recognized: admin shares (`\\localhost\C$\...`), `subst` and mapped drives.
- File contents are not read: sourced files, profiles, `BASH_ENV`, cmd AutoRun, git configuration files (a global
  alias with `!`) and hook scripts. Barriers account for their effect on variables, not on directories.
- An item cmdlet with a computed path writing `env:GIT_DIR` (`$p = 'env:' + 'GIT_DIR'; Set-Item $p ...`), `enable -f`
  replacing a builtin, and adversarial name building (`.('Set'+'Location')`).
- A `$()` in text a variable takes from outside the command is not followed into arithmetic
  (`x=$(cat f); echo $((x))`), since blocking that would block `n=$(wc -l < f); echo $((n+1))`.
- Command output is computed, except the path functions above.
- Programs that run text in their own language are not read: `node -e`, `python -c`, `make`, npm scripts, `schtasks`
  and `wmic`. No shell-text check can read them; they stay under the normal permission rules.
