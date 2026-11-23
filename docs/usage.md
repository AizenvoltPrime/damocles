# Using Damocles

This page covers day-to-day use of the chat: sending prompts, keyboard shortcuts, attaching context, mentions, slash commands, skills, instructions files, voice input and per-panel workspace folders.

## Basic use

- Open the Damocles sidebar view in the secondary sidebar (right side), or click the Damocles icon in the editor title bar (top right) to open a panel.
- Type your question or request in the chat input.
- Press Enter to send (Shift+Enter for a new line).
- Review any file changes in the diff view before approving.

## Keyboard shortcuts

- `Ctrl+Shift+U` / `Cmd+Shift+U`: Focus the chat panel
- `Ctrl+K` / `Cmd+K`: Toggle the Prompt Navigator overlay
- `↑` / `↓`: Navigate through prompt history (like a terminal shell)
- `Shift+Tab`: Cycle through permission modes
- `Escape`: Cancel the current request (when processing)
- `Escape Escape`: Open the rewind popup to restore a previous state
- `1` to `n`: Pick an answer on a permission, question or skill card, unless the cursor is in a text field. With two cards showing, the keys answer only the card that has focus

Desktop app only:

- `Ctrl+N` / `Cmd+N`: New chat in the selected project
- `Shift+Alt+N` (`Ctrl+Alt+N` on Linux, `Cmd+Alt+N` on macOS): New chat in the selected chat's worktree
- `Ctrl+B` / `Cmd+B`: Show or hide the sidebar
- `Ctrl+Tab` / `Ctrl+Shift+Tab` (`Cmd+Shift+]` / `Cmd+Shift+[` on macOS): Next or previous chat, or the next or previous editor tab while the editor has focus
- `Ctrl+P` / `Cmd+P`: Quick Open, to find a file by name or to browse a typed folder path; type `>` to switch to commands
- `Ctrl+Shift+P` / `Cmd+Shift+P`: Show all commands
- `F4` / `Shift+F4`: Next or previous search result
- `Ctrl+Shift+R` / `Cmd+Shift+R`: Search again in a Search Editor; `Alt+L`, `Alt+=` and `Alt+-` toggle, add and remove context lines
- `` Ctrl+` `` and `` Ctrl+Shift+` ``: Toggle the terminal, and start a new one
- `Ctrl+Shift+5` (`Cmd+\` on macOS): Split the terminal; `Alt+Left` / `Alt+Right` (`Alt+Cmd+Left` / `Alt+Cmd+Right` on macOS) move between its panes, and on Linux `Ctrl+Shift+Left` / `Ctrl+Shift+Right` (`Cmd+Ctrl+Left` / `Cmd+Ctrl+Right` on macOS) resize them
- `Ctrl+Up` / `Ctrl+Down` (`Cmd` on macOS): Previous or next command in the terminal
- `Ctrl+click` / `Cmd+click`: Open a file or folder link in the terminal; `F2` in the terminal list or tab renames a terminal; `Shift+F10` or the menu key opens the terminal menu
- `Ctrl+Shift+C` / `Ctrl+Shift+V` (`Cmd+C` / `Cmd+V` on macOS): Copy and paste in the terminal; on Windows `Ctrl+C` also copies a selection (without one it interrupts) and `Ctrl+V` also pastes; `Ctrl+F` finds in its output
- `Shift+Alt+F` / `Shift+Option+F`: Format Document
- `Alt+F5` / `Shift+Alt+F5`: Next or previous change in the editor; `Ctrl+K Ctrl+Alt+S`, `Ctrl+K Ctrl+N` and `Ctrl+K Ctrl+R` (`Cmd` on macOS) stage, unstage and revert the selected lines
- `Ctrl+Shift+F` / `Cmd+Shift+F` and `Ctrl+Shift+H` / `Cmd+Shift+H`: Find in Files and Replace in Files, seeded with the editor's selection
- `Ctrl+S` / `Cmd+S` and `Ctrl+Shift+S` / `Cmd+Shift+S`: Save and Save As in the editor
- `F6` / `Shift+F6`: Move focus to the next or previous part of the window: the keep-changes banner while it counts, the sidebar, the editor (browser tabs included), the chat, the terminal and, while one shows, the desktop pop-ups. `Escape` leaves the pop-ups
- `Ctrl+Alt+Shift+0`, `Ctrl+Alt+Shift+W` and `Ctrl+Alt+Shift+.` (`Cmd+Alt+Shift` on macOS): Reset Theme to Default, Toggle Wallpapers and Next Wallpaper
- `Ctrl+,` / `Cmd+,`: Open Settings
- `Ctrl+W` / `Cmd+W`: Close the editor tab that has focus

## IDE context

The input bar shows a context indicator that tracks your active editor:

- **Eye icon + line count**: When you have code selected, shows "N lines"
- **Code icon + filename**: When a file is open without selection, shows the filename

Click the indicator to toggle whether the context is included in your next message. When enabled, the selected code (or entire file) is automatically injected into your prompt, with no need to manually @mention or paste code. A workspace default (`damocles.ideContext.enabled`) controls whether the chip starts on in new panels.

## Image attachments

Paste images from the clipboard directly into the chat input with `Ctrl+V` / `Cmd+V`:

- **Supported formats**: PNG, JPEG, GIF, WebP
- **Size limit**: 5MB per image
- **Max attachments**: 10 images per message

Attached images appear as compact chips (icon + filename + WIDTH×HEIGHT) below the input. Hover over a chip to reveal the remove button. Click any image in the conversation to open it in a lightbox.

## @ mentions

Type `@` to reference workspace files or agents (`@agent-Explore`, etc.) with fuzzy search autocomplete.

- `@`: Trigger the autocomplete popup for files and agents
- `↑` / `↓`: Navigate suggestions
- `Tab` / `Enter`: Insert the selected item
- `Escape`: Close the popup

| Syntax             | Description                              |
| ------------------ | ---------------------------------------- |
| `@path/to/file.ts` | Reference a workspace file               |
| `@agent-Explore`   | Use the fast codebase exploration agent  |
| `@agent-Plan`      | Use the architecture planning agent      |
| `@agent-<name>`    | Use a custom agent from an `agents/` dir |

In a trusted project the `@` file list also lists the files below symlinks and junctions, including ones that lead outside the project (`search.followSymlinks` in VS Code or `damocles.desktop.search.followSymlinks` in the desktop app turns this off), and a file reached through such a link can be mentioned; the mention shows the path through the link. In an untrusted project the list shows no links, and a file whose link leads outside the project cannot be mentioned. A file in another project of the window follows that project's trust too: a link out of it is followed only while this chat's folder and that project are both trusted. A link onto a network share or a WSL path is never listed or followed. A link to a mapped drive letter is followed, since the drive is your own mapping, so its share is contacted as when you open the drive. Granting or taking back trust, or changing the follow or ignore-file settings, lists the project again, so the list never keeps links that no longer apply. In a chat that works in its worktree, the list leaves out a file a link leads to in the project folder, which such a chat cannot mention.

Custom agents are loaded from `.damocles/agents/*.md`, `.pi/agents/*.md` and `.claude/agents/*.md` in the workspace (project) and from `~/.damocles/agents/*.md`, `~/.pi/agent/agents/*.md` and `~/.claude/agents/*.md` (user). Project agents override user agents with the same name. Within one scope `.damocles` wins a name collision, then `.pi`, then `.claude`. See [Agents and teams](agents.md#custom-agents) for how they run.

## Slash commands

Type `/` for built-in commands and custom commands from `.damocles/commands/`, `.claude/commands/` and `.codex/prompts/`.

- `/`: Trigger the command autocomplete popup
- `↑` / `↓`: Navigate suggestions
- `Tab` / `Enter`: Insert the selected command
- `Escape`: Close the popup

### Built-in commands

| Command                    | Description                                                            |
| -------------------------- | ---------------------------------------------------------------------- |
| `/clear`                   | Clear conversation history                                             |
| `/compact`                 | Compact conversation                                                   |
| `/rewind`                  | Rewind conversation/code to a checkpoint                               |
| `/init`                    | Initialize CLAUDE.md                                                   |
| `/remember <text>`         | Save session memory (`project:` or `global:` prefix for broader scope) |
| `/note <text>`             | Save a persistent note to the knowledge base                           |
| `/memories`                | Open the memory management panel                                       |
| `/context`                 | Display context usage breakdown                                        |
| `/usage`                   | Show Claude and ChatGPT subscription rate-limit usage and Claude account |
| `/stats`                   | Show token and cost statistics across all projects                     |
| `/btw <question>`          | Ask a side question using conversation context                         |
| `/steer <agent> <message>` | Send a steering message to a running subagent                          |

In a desktop chat on a remote host, `/usage` shows this computer's subscription usage, read by Damocles on this computer, so it works while the host is offline.

### Custom commands

Custom commands are loaded from `.damocles/commands/*.md`, `.claude/commands/*.md` and `.codex/prompts/*.md` (project) plus their `~/` user equivalents.

The precedence chain is **builtin > `.damocles` > `.claude`/`.codex`**. A built-in from the table above always wins, so a custom command or skill named after one is dropped from the menu instead of showing a row that runs the built-in anyway. Within a source, project overrides user. Between the two compat sources, `damocles.assetSourcePrecedence` (default `claude`) breaks the tie. Names match without regard to case, so `.damocles/skills/Foo` and `.claude/skills/foo` are one entry rather than two.

Every one of those directories is watched, the `~/` ones included, so creating `~/.damocles/commands/foo.md` puts `/foo` in the menu within about 300 ms with no window reload. With no folder open there is no project scope at all, and your `~/` assets are listed as user entries.

Project-scope commands are gated on workspace trust. In a restricted window they still appear in the menu, badged untrusted, and selecting one shows a message instead of starting a turn. Granting trust loads them with no window reload. User-scope commands are unaffected, including when a project command or skill of the same name is withheld: the working user one still runs.

## Skills

Skills are specialized tools that extend the agent's capabilities. Skills are discovered from your Damocles dirs (project and user `.damocles/skills/`, `.claude/skills/` and `.codex/skills/`) and merged into the slash-command list alongside the built-in commands. `.damocles` wins any name collision; between `.claude` and `.codex`, `damocles.assetSourcePrecedence` decides. In an untrusted workspace the project-scope entries are listed with an untrusted badge and refuse to run until you trust the workspace.

You can invoke skills in two ways.

**Via slash command (recommended):**

- Type `/skill-name` to invoke a skill directly. It appears in the autocomplete popup alongside regular commands.
- Skills invoked this way are **auto-approved** (no approval prompt).
- Pass arguments after the skill name: `/skill-name additional context here`.

**Via the agent's autonomous invocation.** When the agent decides to use a skill on its own, you approve or deny the invocation:

- **Yes**: Approve this invocation (manual mode)
- **Yes, don't ask again**: Auto-approve this skill for the session
- **No**: Deny the skill and end the turn. An unexplained "no" leaves the agent nothing to work with, so it stops rather than looking for another route to the same thing
- **Tell Damocles what to do instead**: Deny this invocation but keep the turn running, handing your text to the agent as the instruction to follow instead

These two are **not** the same action with extra text: the feedback box is what decides whether the agent stops or carries on. Anything Damocles decides on its own, whether a permission rule, plan mode, a read-only agent, a closed session, or the permission system failing, never ends the turn, because you were never asked.

Skills are loaded from `.damocles/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md` and `.codex/skills/<name>/SKILL.md` (project) plus their `~/` user equivalents, with the same precedence and trust rules as commands. The description is parsed from the YAML frontmatter, and a `name:` there overrides the directory name so the menu invokes the skill under the name the agent loaded it as. A skill without a description is listed as unavailable, since the agent cannot load it.

Commands and skills may be symlinks or junctions, and so may their folders and `~/.claude` itself. Links in your home folder and in a trusted project are followed, and a skill folder linked from both lists once. In an untrusted project a link that stays inside is followed; one that leads outside is listed as unavailable ("trust this project to use it") and its target is never read, and choosing it asks you to trust the project. A link onto a network share or a WSL path is listed as unavailable, except a link from a home or project folder on a share to another file on that same share. Broken links, link loops, files over 1 MiB, bad frontmatter and commands in a folder named `skill` show as unavailable rows with the reason, cannot be inserted, and sending one by name shows the reason. A commands or skills folder, or `~/.claude`, that is a link Damocles cannot follow shows as one unavailable row naming the folder. A skill folder linked twice lists once, and nothing inside a skill folder is read, as the agent loads skills; a skill folder that a `.gitignore`, `.ignore` or `.fdignore` in the skills folder names is not listed, since the agent skips it. Give a skill folder you also link under another name a `name:` in its `SKILL.md`: without one, the menu names the skill after its real folder and the agent after whichever path it walks first. Editing a linked file, or making, removing or re-pointing a link, updates the menu and the agent within about 300 ms. See [Slash commands](slash-commands.md#links).

## Instructions files

An `AGENTS.md` or `CLAUDE.md` in the workspace, and in each of its parent directories, is loaded into every turn as project instructions. `~/.damocles/AGENTS.md` (or `CLAUDE.md`) is the user-global instructions file: it loads in every workspace, ahead of the project ones, and `/context` lists it.

Project instructions are gated on workspace trust, for the same reason project skills are: the file goes into the system prompt, so a repository you have not trusted could steer the agent with it. In a restricted window no workspace or parent-directory file is loaded, and the user-global file still is. Granting trust loads the project ones with no window reload. A restricted window also withholds pi's project layer: the packages and shell settings in `.pi/settings.json`, and `.pi/extensions`, `.pi/skills`, `.pi/prompts` and `.pi/APPEND_SYSTEM.md`. Granting trust loads it with no reload. Editing `~/.damocles/AGENTS.md` is picked up within about 300 ms, the same as an asset directory.

On Windows, Damocles does not read or write a settings, permission, hooks or MCP config file, the user-global instructions file, or the agent's settings, sign-in and models files in `~/.damocles/pi/agent`, that is a link onto a network share or a WSL path, or that sits in a folder (such as `.damocles` or `.claude`) that is such a link; a notice names the file, and a refused sign-in file shows you as signed out. Links to a mapped drive letter, a local folder, or another folder on the share your home or project is on still work, also when the home or project folder is itself reached through a link onto that share (`C:\work` linked to `\\nas\projects`), and `~/.damocles` or one of its folders may itself be a link onto a share. One server under two names (`nas` and `nas.corp.example`) counts as two shares. To keep such a file on a share, map the share to a drive letter. Damocles does not watch a folder through such a link either, and the log names the link once; the desktop app starts the watch once the link is replaced by a folder, and the VS Code extension after a window reload.

## Voice input

`damocles.voice.mode` selects one of three modes:

- **`off`.** Voice disabled, mic button hidden.
- **`push-to-talk`** (cloud STT). Click the microphone in the chat input to dictate messages. Supports OpenAI Whisper, Deepgram, and Google Cloud STT. Audio is recorded extension-side using native platform APIs (Windows/macOS/Linux) and transcribed via your configured provider. Configure provider, API key, and language in Settings › Voice.
- **`wake-word`** (local Jarvis), hands-free. Say *"Hey Jarvis, …"* (or any 1 to 4 word English phrase you set in Settings) and Damocles transcribes once you stop speaking; it can optionally speak the assistant's reply aloud. A Python sidecar runs sherpa-onnx keyword spotting + Silero VAD + Parakeet TDT 0.6B v2 ASR + optional VibeVoice-Realtime TTS. **Fully on-device: no audio bytes or transcript text ever leave your machine.** The wake phrase is stripped before transcription via a two-layer defense (ASR offset + regex). VRAM is about 3.7 GB with TTS and about 2.2 GB without; CPU fallback is automatic. The sidecar runs on Windows x64, Linux x64 and macOS arm64 only; on any other platform (Intel macOS, Windows arm64, Linux arm64) Damocles says so up front and installs nothing, and push-to-talk still works. On Linux and macOS the installer surfaces actionable per-distro commands if a C++ toolchain or PortAudio is missing (`apt install build-essential libportaudio2` on Debian/Ubuntu/WSL, `brew install portaudio` on macOS, etc.); on WSL2 with a CUDA GPU it falls back to `/usr/lib/wsl/lib/nvidia-smi` for driver detection. Full guide: [Jarvis mode](voice-jarvis-mode.md).

Voice requires local audio hardware. It is not available when connected to a remote host via SSH, because the extension host runs server-side where no microphone is present. Voice settings are listed in [Configuration](configuration.md#settings).

## Per-panel workspace folders

In a window with two or more workspace folders, each panel works in one of them. Pick a panel's folder under **This chat** in Settings or from the folder picker in the chat header, and pick the folder new panels open in under **Defaults for new chats**. In a window with one folder or none, the header offers no picker, the rows are hidden and nothing changes. The chat header shows the folder's git branch beside it, read from the repository's `HEAD` file without running git, so it shows in untrusted folders too and follows a checkout made in any tool.

The panel's folder decides:

- the working directory for the agent's tools and shell, and the `CLAUDE.md` / `AGENTS.md` instructions files it loads
- project skills, commands, markdown agents, hooks and permission rules from that folder's `.damocles/`, `.claude/` and `.codex/` directories, and its `.pi/` layer
- @-mention files and the paths tool cards open
- project memories, checkpoints and the Compass index
- the project MCP servers from that folder's `.mcp.json`, `.pi/mcp.json`, `.damocles/mcp.local.json` and Claude local-scope config. User MCP servers are shared: a server used by panels in several folders runs once. Disabling a project MCP server affects only that folder.

Subagents, teams and `/btw` run in their panel's folder. Changing a panel's folder before the first message switches at once. After that, Damocles asks first, then starts a new conversation in the new folder, and the old one stays in history. While a switch is in progress the folder picker shows a spinner and the prompt box does not send. History lists every open folder's sessions with a folder label, and resuming a session moves the panel to that session's folder. Each chat tab shows its folder name, for example `Damocles · api`. When you remove a folder from the workspace, its panels move to the default folder with a warning.

When one open folder sits inside another, pi also loads the outer folder's `CLAUDE.md` for panels in the inner one, because it reads instructions files from every parent directory. Most `damocles.*` VS Code settings apply to the whole window. The ones a chat reads for itself (`maxBudgetUsd`, `taskBudget`, `autoCompact`, `permissionMode`, `dangerouslySkipPermissions`, the thinking and effort settings, the `team.*` models and efforts, `subagents.maxConcurrent` and the two notice switches) also take a value from a folder's settings, which applies to that folder's panels; Settings' Workspace section saves there while the folder is trusted. Put other per-project configuration in `<folder>/.damocles/`.

## Moved folders in VS Code

When you open a folder that is a clone or a move of a folder whose chats Damocles kept and which is gone now, a notification asks "Move the chats of <old folder> here?", followed by anything to know first, such as chat worktrees the opened folder's repository cannot link. If the chats cannot move (the old folder exists again, or one of its chats is open in another window), Damocles says why instead of asking. Damocles reads the opened folder's first commit only in a trusted workspace, so a copy or a local clone that shares no remote with the old folder is offered once you trust the workspace. Move Chats moves them, with their history, checkpoints, spend and memories, into the opened folder's chats; Not Now does not ask again for that pair of folders, and an offer you have not answered yet stays the only one for its folders. **Damocles: Move Chats Here** in the Command Palette asks again. A move that pauses says why, with Retry and Stop Moving; Stop Moving, once confirmed, leaves the chats already moved in the opened folder and the rest with the old folder, which Move Chats Here can move later. The desktop app has its own flow, Locate… on a missing project's row: see [Desktop app](desktop-app.md).
