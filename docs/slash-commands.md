# Custom slash commands

This page covers custom slash command files in Damocles: where they load from, how arguments expand, and which frontmatter fields are read.

For the built-in commands such as `/clear` and `/compact`, see [Built-in commands](usage.md#built-in-commands). For precedence between sources and workspace trust, see [Custom commands](usage.md#custom-commands).

## Create a command

A custom command is a Markdown file. The file name without `.md` becomes the command name, and the body is the prompt sent to the model.

```bash
mkdir -p .damocles/commands
echo "Analyze this code for performance issues and suggest optimizations:" > .damocles/commands/optimize.md
```

Type `/optimize` in the chat to send that prompt.

## Where commands load from

| Scope | Folders |
| :-- | :-- |
| Project | `.damocles/commands/`, `.claude/commands/`, `.codex/prompts/` in the workspace |
| User | `~/.damocles/commands/`, `~/.claude/commands/`, `~/.codex/prompts/` |

Project commands are shared with anyone who opens the repository. User commands are available in every project.

The pi engine also expands prompt files from its own folders, `.pi/prompts/` in the project and `~/.damocles/pi/agent/prompts/`. These do not appear in the `/` menu, but typing their name still runs them. If one has exactly the name of a command in the folders above, the pi file is the one that expands. Names are compared with their capital letters, as pi compares them, so `.pi/prompts/Deploy.md` and `.claude/commands/deploy.md` are two commands: `/Deploy` runs the pi file and `/deploy` the command. A pi file still runs when the command of its name is unavailable.

## Arguments

Text typed after the command name is split into arguments and substituted into the body.

### All arguments

`$ARGUMENTS` and `$@` both become every argument, joined by spaces.

```bash
echo 'Fix issue #$ARGUMENTS following our coding standards' > .damocles/commands/fix-issue.md
```

`/fix-issue 123 high-priority` sends `Fix issue #123 high-priority following our coding standards`.

### Positional arguments

`$1`, `$2` and so on become a single argument. A missing argument becomes empty.

```bash
echo 'Review PR #$1 with priority $2 and assign to $3' > .damocles/commands/review-pr.md
```

`/review-pr 456 high alice` sets `$1` to `456`, `$2` to `high` and `$3` to `alice`.

Quote an argument that contains spaces (`"high priority"` or `'high priority'`). An empty quoted argument (`""` or `''`) keeps its place as an empty value, so `/review-pr 456 "" alice` sets `$2` to empty and `$3` to `alice`.

### Defaults and slices

| Placeholder | Becomes |
| :-- | :-- |
| `${N:-default}` | Argument `N`, or `default` when it is missing or empty |
| `${@:N}` | Every argument from position `N` onward |
| `${@:N:L}` | `L` arguments starting at position `N` |

For example, `Assign to ${3:-the team}` reads `Assign to the team` when no third argument is given.

### Files without placeholders

If the body has no placeholders, any arguments you type are dropped. Only the body is sent.

## Frontmatter

A command file can start with a YAML frontmatter block. Damocles reads two fields:

| Field | Purpose | Default |
| :-- | :-- | :-- |
| `description` | Text shown next to the command in the `/` menu | The first non-heading line of the body, or `No description` |
| `argument-hint` | Hint shown after the command name in the `/` menu | None |

```markdown
---
description: Review pull request
argument-hint: "[pr-number] [priority] [assignee]"
---

Review PR #$1 with priority $2 and assign to $3. Focus on security, performance, and code style.
```

Quote an `argument-hint` that starts with `[`. Unquoted, `argument-hint: [pr-number] [priority]` is invalid YAML: the command shows in the menu as unavailable, with the parser's message, and sending it shows that message instead of running it.

Other fields are ignored. `allowed-tools`, `model` and `disable-model-invocation` have no effect, and `name:` does not rename the command; the file name always sets it.

## Subfolders

A file one folder down, such as `.damocles/commands/frontend/component.md`, is the command `/frontend:component`: the folder name is its namespace. It lists and runs like a top-level command, with the same arguments. Folders deeper than that are not read. A folder named `skill` is reserved, because `/skill:<name>` runs a skill, so its commands show as unavailable and typing `/skill:<name>` still runs the skill. Only the lowercase name is reserved: a folder named `Skill` is an ordinary namespace.

## Links

A command file, a namespace folder, or the commands folder itself (or `~/.claude` as a whole, as dotfile managers set it up) may be a symlink or, on Windows, a junction. Damocles follows it under these rules:

- In your home folder and in a trusted project, every link is followed. Editing or replacing the file it leads to, as `git pull` does, updates the menu and the agent within about 300 ms, and so does making, removing or re-pointing the link itself (`ln -sfn`).
- In an untrusted project, a link that stays inside the project is followed and listed as untrusted, like any project command. A link that leads outside the project is listed as unavailable with "trust this project to use it", and its target is never read. Choosing it asks you to trust the project; once you do, it runs with no reload.
- A link onto a network share or a WSL path (`\\host\share`, `\\wsl.localhost\...`) is listed as unavailable, and its target is never touched. A link from a home or project folder on a network share to another file on that same share is followed. A link onto a drive that did not answer is listed as unavailable and checked again within about two minutes.
- A broken link shows as "broken link to" its target and runs once the target is back. A link loop (a link back to a folder above it), a file over 1 MiB, and a file whose frontmatter does not parse each show as unavailable with the reason. Two links to one folder are two namespaces, each listing its commands. A FIFO or socket is skipped.
- When the commands folder itself, or `~/.claude`, is a link that cannot be followed, the menu shows one unavailable row for the folder, such as ".claude commands, project", with the reason, after the commands when you have typed only `/`. In an untrusted project, choosing a row for a folder linked out of the project asks you to trust the project.

An unavailable command cannot be inserted from the menu: the arrow keys still reach its row, and Enter or Tab there keeps the menu open and has a screen reader read the reason. Sending it by name shows the reason instead of a turn, or, when the project is untrusted and trusting it would let a command or skill of that name run, the trust notice.

## Not supported

These features from other tools do not work in Damocles command files:

- `!` shell execution, such as `` !`git status` ``, is sent as literal text.
- `@file` references are not expanded into file contents.
