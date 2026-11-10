# Permissions

This page covers permission modes, YOLO mode, accepting edits from any prompt, and the persistent allow, deny and ask rules Damocles reads from settings files.

## Permission modes

`damocles.permissionMode` sets the default mode (`default`, `acceptEdits`, `plan`). Each panel can have its own permission mode independent of the global default. The mode button, Shift+Tab and YOLO also work while the agent works. A change applies from its next tool call, and switching into or out of Plan mode tells the agent, and any running team agents, at their next step. Plan mode is described in [Plan mode](plan-mode.md). A design chat stays in Default mode with fixed limits that hold under YOLO too, described in [Design mode](design-mode.md#what-a-design-chat-may-do).

## YOLO mode

Toggle YOLO to auto-approve all tool calls (except plan approval and questions). It is an ephemeral per-panel setting that resets on session clear; a workspace default (`damocles.dangerouslySkipPermissions`) seeds it for new panels.

## Accept all edits from any prompt

"Yes, and accept all edits this session" on an edit prompt, whether the chat's own, a subagent's or a team agent's, switches the chat to Accept edits, so every agent's later file edits run unasked while shell commands still ask. Edit prompts already open that the new mode would not ask about close as approved, and turning YOLO on or changing the mode does the same.

## Permission rules

Define persistent allow/deny rules for tools in Claude Code CLI-compatible settings files. Rules are evaluated before each tool call and can automatically allow, deny, or prompt for specific patterns. Damocles keeps its own rules in `.damocles/`, and also reads the equivalent Claude Code files so rules you already wrote there keep working.

### How rules combine

A deny rule in any of the files below wins, then an ask rule in any file prompts, then an allow rule allows. So a repository's committed allow can never override a deny or ask in your own user files, and an ask rule prompts even when a more specific allow also matches. An ask rule prompts in every mode, read-only tools and acceptEdits edits included; only `dangerouslySkipPermissions` skips it.

### Settings files read

| Priority | File                              | Scope             |
| -------- | --------------------------------- | ----------------- |
| 1        | `.damocles/settings.local.json`   | Project (private) |
| 2        | `.claude/settings.local.json`     | Project (private) |
| 3        | `.damocles/settings.json`         | Project (shared)  |
| 4        | `.claude/settings.json`           | Project (shared)  |
| 5        | `~/.damocles/settings.local.json` | User (private)    |
| 6        | `~/.claude/settings.local.json`   | User (private)    |
| 7        | `~/.damocles/settings.json`       | User (shared)     |
| 8        | `~/.claude/settings.json`         | User (shared)     |

Skills and slash commands still follow file priority: `.damocles` is read first and outranks both compat sources. Damocles only ever *writes* to `.damocles/`. Your `.claude` files are read and never modified. Add `.damocles/settings.local.json` to your `.gitignore` if you do not want your personal rules committed.

In a restricted window the four project files are ignored, deny and ask rules included, and only your user files apply. Granting trust loads the project rules with no window reload.

### Example settings file

```json
{
  "permissions": {
    "allow": ["Bash(git:*)", "Bash(npm run *)", "PowerShell(Get-ChildItem:*)"],
    "deny": ["Bash(rm:*)", "Bash(sudo:*)", "PowerShell(Remove-Item:*)"],
    "ask": ["Bash(npm publish:*)"]
  }
}
```

`Bash` and `PowerShell` rules are evaluated independently, so a `Bash(git:*)` rule does not auto-allow a `PowerShell git status` call. Cross-shell isolation is intentional: PowerShell flag semantics and sandboxing differ from Bash on Windows, so users who want both must write both rules explicitly.

### Pattern syntax

| Pattern                       | Matches                                |
| ----------------------------- | -------------------------------------- |
| `Bash`                        | All Bash commands                      |
| `Bash(git:*)`                 | Bash commands starting with `git`      |
| `Bash(npm run *)`             | Bash commands starting with `npm run ` |
| `PowerShell`                  | All PowerShell commands                |
| `PowerShell(Get-ChildItem:*)` | PowerShell commands starting with `Get-ChildItem` |
| `Edit(*.ts)`                  | Edit, Write and GenerateImage calls on `.ts` files in the session folder or below |
| `Edit(src/**)`                | As an allow rule, edits and writes under `src/` of the session folder; as a deny or ask rule, under any `src/` folder below it |
| `Write(src/**)`               | As a deny or ask rule, like `Edit(src/**)` but for Write only. As an allow rule it approves nothing, as in Claude Code: use `Edit(src/**)` |
| `Read(.env)`                  | Reads of any `.env` file in the session folder or below, Grep, Glob and Ls searches of it, and a design chat's ImportAsset of it |
| `Read(*.env)` then `Read(!sample.env)` | In one deny or ask list: every `*.env` file except those named `sample.env` |
| `WebFetch(domain:example.com)` | WebFetch calls, and ImportAsset from a URL, on the host `example.com` exactly (not `www.example.com`), in any case, any port. A deny or ask rule covers a call when any of its URLs (`url`, `urls`) is on the host, an allow rule only when every one is. As a deny or ask rule it also covers a URL that does not parse, and WebFetch never contacts the host on a step of its own: it skips its GitHub rewrite to `raw.githubusercontent.com` and its `r.jina.ai` reader when the rule names those hosts, and stops at a redirect from another host to it, naming the redirect's URL. There is no wildcard: `domain:*.example.com` allows nothing, and as a deny or ask rule covers every URL, as does a `WebFetch` rule written without `domain:` (`WebFetch(example.com)`) |
| `*` or `mcp__*` (deny or ask only) | Every tool, or every MCP tool. Also covers MCP resource reads and lists that name a server. |
| `mcp__github__get_*`          | The `get_` tools of the server named `github` |
| `Read(//c/Users/me/secrets/**)` | An absolute path (`//` is the file system root; on Windows `//c/` is `C:\`) |
| `Read(~/.ssh/**)`             | A path under your home folder          |
| `Edit(/src/**)`               | `src/` in the project folder (see below) |
| `mcp__puppeteer` or `mcp__puppeteer__*` | Every tool of the server named `puppeteer` in its config, including reading and listing its resources (`read_mcp_resource`, `list_mcp_resources`, `list_mcp_resource_templates` naming `puppeteer`). A deny or ask also leaves `puppeteer` out of a list across servers. |
| `mcp__puppeteer__puppeteer_navigate` | That one MCP tool, by its server and tool names (an over-long name's hash suffix included) |
| `mcp__github__read_mcp_resource(repo://docs/*)` | Reads of `github` resources whose URI matches. `*` is the only wildcard. The URI is matched as written, and the text runs to the final `)`. A deny also leaves matching resources out of lists, and a deny, or an ask other than one the read itself asked under, leaves them out of a read that returns them as children. A Damocles extension; Claude Code skips `mcp__` rules with parentheses. |

### File paths

File paths in rules follow Claude Code's four forms: `//path` from the file system root, `~/path` from your home folder, `/path` from the settings file's folder, and `path` or `./path` from the session folder. A `/path` rule in a project file (`.damocles/` or `.claude/` in the project) is relative to the project folder. In a user file it is relative to that file's own folder, as Claude Code resolves it to `~/.claude/path`: `Read(/secrets/**)` in `~/.damocles/settings.json` covers `~/.damocles/secrets/`, not a project's `secrets/`. Write `//path` or `~/path` for a user rule that names an absolute location. A rule that starts with a Windows drive letter (`C:/x/**` or `C:\x\**`) is absolute too; this form is a Damocles addition, not part of Claude Code's syntax.

Paths match as in Claude Code, with gitignore patterns (the `ignore` library pi also uses), in POSIX form (`C:\Users\me` is `/c/Users/me`, so `//c/**/.env` covers a drive and `//**/.env` every drive). A rule matches only at or below the folder it is anchored to: `Read(.env)` never covers a `.env` in a parent folder or another project, and `Read(//**/.env)` covers every one. A bare name such as `.env` or `*.env` matches at any depth below its anchor. A relative pattern with one folder before its last part, such as `src/**`, allows only `<session folder>/src/` but denies or asks for a `src/` folder at any depth below the session folder; write `**/src/**` to allow any depth. Every other shape matches the same way in every list. `\` escapes the next character, so `Read(\[2024-06\] Reports/**)` names that folder literally; parentheses need no escape. A pattern gitignore cannot use (such as `#notes` or `a[`) still denies or asks for that exact path, and allows nothing. On Windows matching ignores case; on macOS and Linux it does not.

### Exceptions with `!`

A deny or ask rule starting with `!` carves its paths out of the relative (`path`, `./path`) rules for the same tool listed before it in the same list of the same file. A `!` rule listed first carves nothing, a `!` is always read from the session folder (so `Read(!~/notes/public/**)` carves nothing out of `Read(~/notes/**)`), and a folder a rule blocks as a whole stays blocked (`Read(secrets/**)` then `Read(!secrets/public/**)` still blocks `secrets/public/`). Allow rules cannot use `!`.

### Tool names and wildcards

Tool names in deny and ask rules may use `*` (`*`, `mcp__*`, `Bas*`). An allow rule may use `*` only after a literal `mcp__<server>__`. An allow rule that can approve nothing (another `*`, a `!`, an unusable path, a `Write(path)` rule, which Claude Code never consults, or a `WebFetch` rule that names no plain `domain:<host>`) is skipped and logged by file and position.

### Which tools a rule covers

An `Edit` rule covers every tool that edits files: Edit, Write and GenerateImage. A `Read` deny rule also blocks Edit, Write and GenerateImage on the same paths, including creating a file there. A `Read` deny or ask rule also covers Grep, Glob (`find`) and Ls: a search of a covered file or folder, or one whose `glob` or `pattern` names a covered file, is blocked or asks. A search rooted above a covered folder runs, and Grep and Glob leave the covered files out of their results and say so; Ls lists only names, so it shows the covered folder's name. A `Read` rule also covers a design chat's ImportAsset of any file, named by `path` or `file`, inside the project or outside it, and a `WebFetch` rule its ImportAsset of a URL; ImportAsset's own rules apply beside them, and the stricter rule wins.

### Links and resolved paths

File rules check two paths: the one requested and the file it resolves to through symlinks, junctions, Windows 8.3 short names, `\\?\` prefixes and a share of a local drive such as `\\localhost\C$\`. An allow rule needs both to be inside the folder and match; a deny or ask rule applies when either matches, and a `//`, `~/` or `/` rule written through a linked folder also covers the folder it points to. Accept Edits does not auto-approve a write to a path in the session folder that a link or junction carries outside it; it asks. A `Read` rule also matches the file pi actually opens when it falls back to a macOS screenshot name (curly apostrophe, narrow no-break space before AM/PM, decomposed accents).

### Network paths on Windows

Opening `\\host\share\file` sends your Windows sign-in to `host`. So on Windows, Read, Grep, Glob, Ls, ImportAsset (`path` or `file`), Edit, Write, GenerateImage, a browser upload and a browser load of a `file:` address ask before they open a network or device path: two leading slashes in any mix (`\\host`, `//host`), `\\?\UNC\`, `\\.\UNC\`, a WebDAV `\\host@SSL\` path, and every other `\\?\` or `\\.\` path, including a path in the project that a link or junction leads to one. Damocles decides this from the path and its links alone, without opening it, and no rule check, diff or plan-file check opens it before you answer. An allow rule naming the call still runs it unasked, a deny rule still blocks it, and YOLO approves it. Such a call runs unasked only under an allow rule naming the whole tool, such as `Read`, `Edit` or `BrowserUpload`: an allow rule with a path needs the file a path resolves to (see [Links and resolved paths](#links-and-resolved-paths)), which Damocles does not look up here, so `Read(src/**)` does not run a read through a link in `src` to a share, and `Read(//host/share/**)` allows nothing. Deny and ask rules match the path as written. The hosts of the chat's project folder and working folder, as written and as a mapped drive's network path, of every open project folder opened by its network path, and WSL's `\\wsl$\` and `\\wsl.localhost\` stay allowed, but not with an `@` suffix (`\\wsl.localhost@SSL\`), which Windows sends to WebDAV instead. A mapped drive letter is a path on that drive and is not affected.

### Read-only shell commands

In plan mode, for read-only agents and in design chats, a Bash or PowerShell command runs unasked only when Damocles proves it read-only; any other asks (YOLO approves it), and a design chat refuses it. One check decides this for all three and for whether a command waits for the turn's checkpoint. A command is not proven when:

- bash: a word holds an unquoted `*`, `?` or `[`, because bash replaces it with file names before the program starts and a file name can become an option (`ls *` beside a file named `-n` runs `ls -n ...`). A quoted or escaped pattern (`rg -g '*.md' foo`, `find src -name '*.ts'`, `\*`) reaches the program as written and stays proven.
- PowerShell: an argument of a native program such as `rg` holds `*`, `?` or `[`, quoted or not, since Git's programs expand their own command line on Windows and pwsh expands unquoted native arguments on Linux and macOS. A cmdlet's wildcard (`gci *.ts`, `Get-Content src/*.md`) stays proven: PowerShell matches it, and a match never becomes a parameter.
- An argument names a network or device path, on every operating system, outside the hosts allowed above.
- On Windows, a folder on the PowerShell tool's `PATH`, or pwsh's own folder, holds one of the command's names as a script or document (`rg.cmd`, `Get-Content.ps1`, any type `PATHEXT` lists other than `.exe` and `.com`, or a file with no extension). PowerShell finds such a file before it loads the cmdlet the name means, and a `.cmd` or `.bat` runs through `cmd.exe`, which reads the arguments again. `PATH` holding a relative folder, which PowerShell searches from a folder a command can change, does the same for every command. Damocles reads the folders for each command, so a script added a moment ago counts. Bash never runs a `.cmd` by its bare name.
- It writes, runs another program or sets the clock through an option of an otherwise read-only program: `file -C`, `file -z`, `rg -z`, `diff -l`, `base64 -o` (macOS and BSD), `tree -R`, `sort -T`, `printf -v`, `date` with an operand not starting with `+`, and `python -v`. Only `python --version` and `python -V` run.
- An argument ends in a folder entry named `environ` (an `=value`, an attached value and a `@file` name included), a `cd` path holds a `proc` folder, or a program that reads the files of a folder (`rg`, `grep -r`, every `diff`, `git diff`) may reach `/proc` through any of its paths, under bash and PowerShell alike (`Get-Content /proc/self/envir*` included). A process's environment holds its secrets and is readable only by its owner, so Damocles never reads one unasked. Process listings (`Get-Process`, reading `/proc/<pid>/cmdline`) stay proven: a command line is readable by everyone, and a secret put on one is the bug of the program that put it there.
- On Windows, it reads your own saved environment variables, which only you, SYSTEM and administrators can read, as a process's environment file: `HKCU:\Environment` (or `HKCU:Environment`), `HKCU:\Volatile Environment`, their `HKEY_USERS\<sid>` forms, every `Registry::` spelling, Git Bash's `/proc/registry`, `/proc/registry32` and `/proc/registry64` folders, a PowerShell wildcard that can match them (`HKCU:\Env*`), a key above them that a listing or walk shows them from (`Get-ChildItem HKCU:\`), a path that reaches them through `..` (`HKCU:\Software\..\Environment`), and a PowerShell `cd` into any drive other than a file system drive. The system-wide variables under `HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`, which every user can read, and every other registry key stay proven.

Every argument counts as a path these rules might reach, a search pattern included, so `rg environ src`, `git log -S environ`, `rg '..' src`, `grep -r '/' src` and a pattern starting with `\\` or `//` ask too. Each costs one prompt (a refusal in a design chat), never an unasked run.

### MCP rules

An `mcp__` rule names a server by the name in its config and a tool by the server's own tool name, written as is or as Claude Code writes it (other characters than letters, digits, `_` and `-` as `_`), so `mcp__my-srv` never covers a server named `my.srv` or `my_srv`. A rule spelling a tool's exact Damocles name also matches it. `mcp__<server>__read_mcp_resource(<uri pattern>)` from the table above is the only `mcp__` rule that takes parentheses. Any other `mcp__` rule with parentheses never matches, as in Claude Code: Damocles skips it and logs the settings file and the rule's position.

### Errors

A rule list entry that is not a string is skipped and logged by file and position. If the permission check itself fails, the call is blocked, reads included.

### Quick rule creation

When a permission prompt appears, you can click "Always allow {pattern}" or "Always deny {pattern}" to create a persistent rule. A destination picker lets you choose which `.damocles` settings file to save the rule to (local, project, or global).
