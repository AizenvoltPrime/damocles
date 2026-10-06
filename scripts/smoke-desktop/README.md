# Desktop smoke runner

Drives the dev desktop app with a real model, one step at a time, for manual smoke tests (`SMOKE_TESTS.md` when present). It is not part of the e2e suite and does not run in CI.

The controller launches `dist/desktop/main.js` once with your real home folder, so the app uses your sign-in and your user settings, but with its own profile folder (`--user-data-dir`), so it does not touch the windows of an app you have open. Each step is a JavaScript file that the controller runs against the live app.

## Run

1. Build: `npm run build && npm run build:desktop`.
2. Start the controller in the background:
   - PowerShell: `Start-Process node -ArgumentList scripts/smoke-desktop/controller.mjs -WindowStyle Hidden`
   - bash: `node scripts/smoke-desktop/controller.mjs &`
3. `node scripts/smoke-desktop/post.mjs --launch`
4. Write a step file and post it: `node scripts/smoke-desktop/post.mjs step.js`
5. Finish with `node scripts/smoke-desktop/post.mjs --quit`, which closes the app and the controller.

`--log` prints the app's recent console output. The scratch folder is `$SMOKE_DIR`, by default `<tmp>/damocles-smoke`: it holds the profile, `shots/` and the controller's token. `SMOKE_PORT` changes the port (default 9555).

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

`helpers.mjs` lists every helper: `active`, `newChat`, `goTo`, `addProject`, `prepare` (YOLO off, a mode, a model and effort), `setMode`, `setYolo`, `setModel`, `send`, `slash`, `prompt`, `answerQuestion`, `waitCard` (desktop pop-up cards), `running`, `tail`, `shot`, `state`, `shell`, `overlay`, `popup`, and `app()` for the Electron main process.

Use a scratch copy of a project, never your own checkout: the agent really edits files.

## Lessons

- Keep each step under a minute (`post.mjs` gives up after 55 seconds). Start long work in one step and check it with short status steps; a step that waits on a model can hang the caller.
- Models act differently each run, so check each result (screenshots, `tail`, the session files under `~/.damocles/pi/agent/sessions/`) before the next step, and adjust the prompt rather than the assertion.
- The model control is a dropdown menu (`menuitemradio`), and the composer's Stop is the button labelled `Stop (Esc)`; a running shell card has `Stop, then add an optional note`.
- A chat opens in the home folder only while no project is listed.
- `damocles.maxBudgetUsd` applies only to a dollar-billed model (an API key), never to a subscription.
- A desktop pop-up card lives 7 to 12 seconds (`KIND_LIFE_MS`), so read it right after it appears.
- The app's window is not focused by the OS under automation, so F6 into the pop-ups, the chime, the taskbar count and flash, and click-through cannot be checked here.
- Turning a settings switch back on writes the value explicitly; restore your user settings file if a step changed it.
