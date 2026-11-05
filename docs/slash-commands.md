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

The pi engine also expands prompt files from its own folders, `.pi/prompts/` in the project and `~/.damocles/pi/agent/prompts/`. These do not appear in the `/` menu, but typing their name still runs them. If one shares a name with a command in the folders above, the pi file is the one that expands.

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

Quote an `argument-hint` that starts with `[`. Unquoted, `argument-hint: [pr-number] [priority]` is invalid YAML: the command still shows in the menu, but it does not expand when you run it.

Other fields are ignored. `allowed-tools`, `model` and `disable-model-invocation` have no effect, and `name:` does not rename the command; the file name always sets it.

## Subfolders

A file one folder down, such as `.damocles/commands/frontend/component.md`, shows in the menu as `/frontend:component`. The pi engine does not load subfolders, so running it sends `/frontend:component` to the model as typed rather than the file body. Keep command files at the top level of the commands folder.

## Not supported

These features from other tools do not work in Damocles command files:

- `!` shell execution, such as `` !`git status` ``, is sent as literal text.
- `@file` references are not expanded into file contents.
