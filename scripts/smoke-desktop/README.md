# Desktop smoke runner

Drives the dev desktop app with a real model, one step at a time, for manual smoke tests (`SMOKE_TESTS.md` when present). It is not part of the e2e suite and does not run in CI.

The controller launches `dist/desktop/main.js` on a hermetic home of its own, seeded from yours, so the app behaves like yours but never writes your home folder or the windows of an app you have open. Each step is a JavaScript file that the controller runs against the live app.

## Hermetic home

Each `--launch` replaces `$SMOKE_DIR/run/` with a new copy and starts the app with `h/` there as its home (`HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_*`), `ud/` as its profile (`--user-data-dir`) and `tmp/` as its temp folder, as the e2e suite does (`e2e/desktop/support/hermetic.ts`). `--relaunch` quits the app and starts it again on the same `run/`, so chats, panels, settings and sessions carry over as they do for a user. The app gets an allowlist of OS variables plus proxy and CA variables; provider keys and other variables from your shell do not reach it. Everything the app writes under `~` (`~/.damocles` settings, sessions, worktree registry, memory, plans, usage, pi's agent folder, git and shell caches) lands in `h/`. `hermetic.mjs` holds the seeding, `session.mjs` the launches and the cleanup.

Before `run/` is deleted, by `--quit` or by the next `--launch`, the runner deletes `h/` (which holds the copied sign-in) and then copies the main and core logs (`ud/logs`) to `$SMOKE_DIR/logs/`, so the logs of a run that crashed survive the next launch. `--quit` deletes `run/` even when the app does not close: after 20 seconds, or when closing it fails, the runner kills the app's process tree and cleans up anyway. If the controller itself is killed, the home stays until the next `--launch` or `--quit`. Screenshots stay in `$SMOKE_DIR/shots/`.

The runner writes a `.damocles-smoke` file into `run/` and `logs/` when it creates them, and never deletes either folder without it: if `SMOKE_DIR` names a folder that already has a `run` or `logs` folder of its own, `--launch` refuses with a message (and a refused `logs/` only costs the run's logs, never the cleanup of the home).

The launch copies, read only, from your home:

- `~/.damocles/settings.json` (your preferences) and the one-time key migration markers next to it;
- from `~/.damocles/pi/agent`: `settings.json`, `models.json`, `models-store.json`, and the installed packages in `git/`, `npm/` and `extensions/`, which hold the Claude subscription plugin's clone;
- `~/.gitconfig` and `~/.config/git/config`, and Windows PowerShell's module analysis cache;
- `auth.json`, rewritten: each `api_key` entry as it is, and each `oauth` entry without its refresh token. The app uses your current access token but can never refresh it, because a refresh rotates the token and would sign your own app out. The copy is never a link: pi locks `auth.json` by its literal path, so a link would let two apps refresh one credential unlocked.

It never copies your sessions, worktree registry, memory, plans, global hooks or MCP servers, and it never follows a linked folder (it could lead back into your home). A linked file it copies by name, such as a stow- or chezmoi-managed `~/.gitconfig`, arrives as a plain file holding its content; links inside a copied folder are skipped, and each folder's skipped links are named in one notice. A smoke test that needs hooks or MCP servers puts them in its scratch project, or writes them under `h.home()` before it relies on them.

When a copied access token would expire within 30 minutes after pi's 5-minute refresh window, `--launch` returns a notice naming the provider: send one message with that provider in your own Damocles app once the notice's time has passed (that app refreshes a token in its last five minutes), or sign in again there, then `--quit` and `--launch` again. A test that does not use that provider can ignore it; the launch never fails on it.

Keys you saved in Damocles itself live in your profile's `secrets.json` (safeStorage), and the smoke app has its own profile, so it never has them; give a test a key through its own settings if it needs one.

## Run

1. Build: `npm run build && npm run build:desktop`.
2. Start the controller in the background:
   - PowerShell: `Start-Process node -ArgumentList scripts/smoke-desktop/controller.mjs -WindowStyle Hidden`
   - bash: `node scripts/smoke-desktop/controller.mjs &`
3. `node scripts/smoke-desktop/post.mjs --launch`
4. Write a step file and post it: `node scripts/smoke-desktop/post.mjs step.js`
5. To check what survives a quit and relaunch, post `node scripts/smoke-desktop/post.mjs --relaunch`, which quits the app and starts it again on the same home. Its answer says `"closed": "quit"` for a clean quit; `"killed"` means the app did not quit within 20 seconds (a quit dialog about running terminals or unsaved editors may have been open) and was killed, so what follows is crash recovery, not a clean relaunch. Give it a longer timeout (`--relaunch 90`) when a hang is possible. After the app exits on its own, `--relaunch` starts it again on the home it left.
6. Finish with `node scripts/smoke-desktop/post.mjs --quit`, which closes the app, deletes the home and stops the controller.

`--log` prints the app's recent console output. The scratch folder is `$SMOKE_DIR`, by default `<tmp>/damocles-smoke`: it holds `run/` while a session lasts, `shots/`, the last finished run's `logs/` and the controller's token. `SMOKE_PORT` changes the port (default 9555).

## Steps

A step is the body of an async function with the helpers as `h`; its return value is printed as JSON.

```js
const { active, prepare, send, prompt, poll, running, shot } = h;
const t = await active();
await prepare(t, 'Ask before edits');
await send(t, 'Run "dotnet --version" in the shell.');
await poll(async () => (await prompt(t).count()) > 0, 30000, 1000);
await shot(t, 'shell-prompt');
return { options: await prompt(t).getByRole('option').allInnerTexts(), running: await running(t) };
```

`helpers.mjs` lists every helper: `home` (the app's hermetic home), `active`, `newChat` (File > New Chat), `goTo`, `addProject`, `runMenuItem` (an application menu item by its id in `src/desktop/main/commands.ts`), `prepare` (YOLO off, a mode, a model and effort), `setMode`, `setYolo`, `setModel`, `send`, `slash`, `prompt`, `answerQuestion`, `waitCard` (desktop pop-up cards), `running`, `tail`, `shot`, `state`, `shell`, `overlay`, `popup`, and `app()` for the Electron main process.

Use a scratch copy of a project, never your own checkout: the agent really edits files.

## Lessons

- Keep each step under a minute (`post.mjs` gives up after 55 seconds). Start long work in one step and check it with short status steps; a step that waits on a model can hang the caller.
- Models act differently each run, so check each result (screenshots, `tail`, the session files under `h.home()`'s `.damocles/pi/agent/sessions/`) before the next step, and adjust the prompt rather than the assertion.
- The model control is a dropdown menu (`menuitemradio`), and the composer's Stop is the button labelled `Stop (Esc)`; a running shell card has `Stop, then add an optional note`.
- A chat opens in the home folder only while no project is listed.
- `damocles.maxBudgetUsd` applies only to a dollar-billed model (an API key), never to a subscription.
- A desktop pop-up card lives 7 to 12 seconds (`KIND_LIFE_MS`), so read it right after it appears.
- The app's window is not focused by the OS under automation, so F6 into the pop-ups, the chime, the taskbar count and flash, and click-through cannot be checked here.
- Turning a settings switch back on writes the value explicitly, into the hermetic copy of the settings file; each `--launch` starts again from your own, and a `--relaunch` keeps the copy.
