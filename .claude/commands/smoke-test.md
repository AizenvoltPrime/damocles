Manually smoke test the git staged changes in the running desktop app, the way a user would: launch the dev build with a real model, click through every user-visible behaviour the staged changes add or fix, look at screenshots, and report what works and what does not. This command is the user's explicit request to spend real model tokens on that.

Extra scope or focus from the user, if any:

$ARGUMENTS

## What this is and is not

- It is hands-on use of the app through `scripts/smoke-desktop/` (read its `README.md` and `helpers.mjs` first). Every check ends with you looking at the app's own output: a screenshot you read, the chat text, the session file, the hook log or the main log.
- It is not running Vitest, the e2e suite, typecheck or lint. Those are automated checks the user runs separately; do not start a full `npm test` or a full e2e run unless the user asks. Only the static staged-diff checks below and the two builds are part of this command.
- Scope is only what is staged. The changed set is `git diff --cached`, not the whole `## [Unreleased]` section of `CHANGELOG.md`, which also holds already-committed work. If nothing is staged, or there are unstaged edits, say so first and ask whether to include them.

## 1. Check the staged diff

Run in parallel, from Git Bash:

- `git status --porcelain=v1` (count staged vs unstaged and untracked) and `git diff --cached --shortstat`.
- `git diff --cached --name-only --diff-filter=A` to see new files.
- Scans of `git diff --cached -U0` added lines for conflict markers, `.only(`/`.skip(`, `debugger`/`console.log(` in `src` outside tests, `TODO`/`FIXME`, and secret-like strings.
- `git diff --cached --check`. In this repo most files are CRLF, so `--check` reports every CRLF line as trailing whitespace; confirm a hit is a real problem before reporting it.
- For each modified file, compare line endings between `git show HEAD:<f>` and `git show :<f>`; report any file whose endings flipped.
- Run the generators (`generate:settings-schema`, `generate:file-icons`, `generate:profiles`, `sync:vscodeignore`) and check `git status` for drift. A generator that writes LF where git stores CRLF is not drift; restore the staged copy with `git checkout -- <file>` (it only undoes your own regeneration).

## 2. Build the checklist from the staged changes

- List the CHANGELOG entries the staged diff adds: `git diff --cached -U0 -- CHANGELOG.md`, keeping the bold lead of each `+- **...**` line.
- Group the staged source files by folder (`git diff --cached --name-only -- src`) to catch staged behaviour with no CHANGELOG line.
- For each entry, decide how a user would see it in the app and write one concrete check. Mark entries that need outside setup (an API key you don't have, a voice runtime install, an OAuth server) as untested rather than skipping them silently.
- For more than three checks, show the checklist to the user before starting.

## 3. Set up

- Put Node 24.21.0 first on PATH in each PowerShell call (`nvm root`, then `v24.21.0`); never run `nvm use`. Unset `ELECTRON_RUN_AS_NODE`.
- Build: `npm run build` and `npm run build:desktop`.
- Create a scratch project in `%TEMP%` (never the repo, never a real checkout): `git init`, a commit, a few small files of different types (`.ts`, `.json`, `.md`). Add what the checks need, for example:
  - `.damocles/hooks.json` with a node hook script that sleeps on demand. A slow `agent_end` hook (Damocles runs it in pi's `agent_settled`) opens the end-of-turn window. Gate it on a flag file you can create and delete from a step. Also add a slow `input` (UserPromptSubmit) hook gated on a marker word, a slow `tool_call` (PreToolUse) hook gated on a marker word, and an `input` hook that returns `{"decision":"block"}` for another marker word. Have the script append start and end lines to a log file, so you can tell a killed hook from a finished one.
  - `.mcp.json` pointing at a small stdio MCP server script that offers tools, resources and a resource template.
  - `.damocles/commands/<name>.md` for prompt-template checks.
- Start the controller hidden with its output redirected to `%TEMP%`, then `node scripts/smoke-desktop/post.mjs --launch`. Step files go in `%TEMP%\smoke-steps\`, never the repo.
- The app uses the user's real home: their sign-in, user settings, global hooks and `~/.damocles` sessions. Never change their settings files. Restore any setting a step toggles, and never resume or touch their real sessions (for example the ones `/stats` lists).

## 4. Test

- Pick a cheap model for ordinary turns (Sonnet 5.5, Low) with `prepare`, and Ask before edits with YOLO off. Turn YOLO on only where a permission prompt would block the check, such as subagents and teams. Keep team briefs tiny; team roles use the user's configured models.
- Keep each step under 55 seconds. Start long work in one step and poll it from short later steps. Read the result of each step before writing the next, and adjust the prompt rather than the assertion when the model acts differently.
- Collect evidence every time: `h.shot` then read the PNG (if the long path fails, read it through the short `C:\Users\ASTEFA~1\...` form), `h.tail`, the hook log, the session `.jsonl` under `~/.damocles/pi/agent/sessions/`, and `<SMOKE_DIR>/userData/logs/Damocles.log`.
- Exercise the edges as well as the golden path: Stop at each stage (while a hook runs, while pi settles, while a tool runs, on a subagent, on a team), a message sent or queued during each window, and a quit plus relaunch of the app (chats, model, context meter and loaded tools must come back).
- When something looks wrong, find the cause before reporting it. Read the session file and code, and check whether released `v3.7.0` (`git show v3.7.0:<file>`, and the pi version it pinned) already behaved that way. Report a defect as caused by the staged changes only with that evidence.

Known runner quirks:

- Sidebar section title buttons (such as New chat) are hidden until their header is hovered, so a step cannot click them by role. Use `h.newChat()`, or `h.runMenuItem(<id>)` with an id from `src/desktop/main/commands.ts`, for any action the application menu offers.
- The OS does not focus the automated window, so keyboard shortcuts such as Ctrl+P do nothing. Click the control instead (for example the title bar's "Search files in all projects").
- Overlays (Settings, Quick Open, menus) render in the overlay page, not the shell or chat page. Read them from `h.overlay()`.
- The chat is its own page: screenshot `h.active()`, not the shell.
- A slash command that does not exist is sent to the model as a message. Open panels such as MCP servers and `/stats` from the chat header's More menu.

## 5. Clean up and report

- `post.mjs --quit`. Delete the scratch project and step files after checking them for links (`find -type l`). Keep `%TEMP%\damocles-smoke\shots` and tell the user where it is. Name the session folder the scratch project left under `~/.damocles/pi/agent/sessions/` so they can delete it; do not delete it yourself.
- Never stage, unstage or commit. If you edit a tracked file (for example to fix a nit the staged-diff check found), name it and tell the user to re-stage it.
- Report:
  - the staged-diff check results;
  - each checklist item with what you did and what you saw, grouped by area;
  - what you could not test by hand and why, and which automated test covers it;
  - findings, tagged F1, F2 and so on, each saying whether the staged changes caused it or it predates them, with the evidence.
