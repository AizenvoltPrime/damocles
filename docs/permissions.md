# Permissions

This page covers permission modes, YOLO mode, accepting edits from any prompt, and the persistent allow, deny and ask rules Damocles reads from settings files.

## Permission modes

`damocles.permissionMode` sets the default mode (`default`, `acceptEdits`, `plan`). Each panel can have its own permission mode independent of the global default. The mode button, Shift+Tab and YOLO also work while the agent works. A change applies from its next tool call, and switching into or out of Plan mode tells the agent, and any running team agents, at their next step. Plan mode is described in [Plan mode](plan-mode.md).

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
| `Read(.env)`                  | Reads of any `.env` file in the session folder or below, and Grep, Glob and Ls searches of it |
| `Read(*.env)` then `Read(!sample.env)` | In one deny or ask list: every `*.env` file except those named `sample.env` |
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

Tool names in deny and ask rules may use `*` (`*`, `mcp__*`, `Bas*`). An allow rule may use `*` only after a literal `mcp__<server>__`. An allow rule that can approve nothing (another `*`, a `!`, an unusable path, or a `Write(path)` rule, which Claude Code never consults) is skipped and logged by file and position.

### Which tools a rule covers

An `Edit` rule covers every tool that edits files: Edit, Write and GenerateImage. A `Read` deny rule also blocks Edit, Write and GenerateImage on the same paths, including creating a file there. A `Read` deny or ask rule also covers Grep, Glob (`find`) and Ls: a search of a covered file or folder, or one whose `glob` or `pattern` names a covered file, is blocked or asks. A search rooted above a covered folder runs, and Grep and Glob leave the covered files out of their results and say so; Ls lists only names, so it shows the covered folder's name.

### Links and resolved paths

File rules check two paths: the one requested and the file it resolves to through symlinks, junctions, Windows 8.3 short names, `\\?\` prefixes and a share of a local drive such as `\\localhost\C$\`. An allow rule needs both to be inside the folder and match; a deny or ask rule applies when either matches, and a `//`, `~/` or `/` rule written through a linked folder also covers the folder it points to. Accept Edits does not auto-approve a write to a path in the session folder that a link or junction carries outside it; it asks. A `Read` rule also matches the file pi actually opens when it falls back to a macOS screenshot name (curly apostrophe, narrow no-break space before AM/PM, decomposed accents).

### MCP rules

An `mcp__` rule names a server by the name in its config and a tool by the server's own tool name, written as is or as Claude Code writes it (other characters than letters, digits, `_` and `-` as `_`), so `mcp__my-srv` never covers a server named `my.srv` or `my_srv`. A rule spelling a tool's exact Damocles name also matches it. `mcp__<server>__read_mcp_resource(<uri pattern>)` from the table above is the only `mcp__` rule that takes parentheses. Any other `mcp__` rule with parentheses never matches, as in Claude Code: Damocles skips it and logs the settings file and the rule's position.

### Errors

A rule list entry that is not a string is skipped and logged by file and position. If the permission check itself fails, the call is blocked, reads included.

### Quick rule creation

When a permission prompt appears, you can click "Always allow {pattern}" or "Always deny {pattern}" to create a persistent rule. A destination picker lets you choose which `.damocles` settings file to save the rule to (local, project, or global).
