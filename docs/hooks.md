# Hooks

Hooks let you run your own command at key moments in a Damocles session — before a tool runs, after a
prompt is submitted, when the agent finishes, when it's waiting for your approval, and more.

A hook can observe (log, notify), add context, rewrite a tool's arguments, **block** a tool or prompt,
or **force-allow** a tool past the approval gate.

The contract is Damocles' own: the child receives one JSON object on stdin (snake_case keys, a uniform
tool schema) and replies with one JSON object on stdout. It is engine-agnostic and stable — it does not
leak Damocles' internal tool wiring.

---

## Safety model

There is **no enable/disable setting** — a hook is live purely by being present in a `hooks.json` file.
The safety boundary is **workspace trust**:

- **Global** `~/.damocles/hooks.json` — always honored (it's yours).
- **Project** `<workspace>/.damocles/hooks.json` — honored **only when the VS Code workspace is
  trusted**. This is what stops a malicious repo from shipping its own `hooks.json` full of shell
  commands. Granting trust activates it live; no reload needed.

Both files are watched and hot-reload on change. When both define hooks for the same event, **global runs
first, then project**.

Hooks are powerful — a `tool_call` hook can force-allow a tool past the diff/approval gate. That power is
bounded and visible: a hook only affects tools you wrote a hook for, the project file requires trust, and
**every block and force-allow is logged to the "Damocles" output channel and raises a subtle in-chat
notice**.

> ⚠️ **A `tool_call` hook that returns `decision: "allow"` turns off human approval for matching tools.**
> A force-allowed `Write` / `Edit` / `Bash` / `PowerShell` runs **without** the diff/approval prompt — and
> the allow **also overrides plan mode** (the tool runs even while you're in a read-only plan). This is the
> point of force-allow, and it is no more privileged than the hook command itself (which already runs
> arbitrary local code), but treat any `allow` hook as "I trust this tool to run unattended in this
> workspace." Use `match` to scope it as tightly as possible, and prefer global (`~/.damocles`) over
> project hooks for allow rules. A hook that only wants to *deny* or *add context* never needs `allow`.

---

## File locations & format

| File | Scope | Honored when |
| --- | --- | --- |
| `~/.damocles/hooks.json` | Global (all workspaces) | Always |
| `<workspace>/.damocles/hooks.json` | Project | Workspace is trusted |

Files are **JSONC** — `//` line and `/* */` block comments are allowed. Scripts live by convention next to
the config (e.g. `~/.damocles/hooks/` or `<workspace>/.damocles/hooks/`), but any path works.

---

## Config schema

```jsonc
{
  "hooks": {
    "<eventKey>": [
      {
        // A shell string (run via the platform shell — pipes, &&, jq, any binary)
        // OR an argv array (no shell).
        "command": "uv run \"${workspaceFolder}/.damocles/hooks/my_hook.py\"",
        "match": "Bash",        // optional regex on the tool name (tool_call / tool_result only)
        "timeoutMs": 60000,     // optional, default 60000
        "description": "human label, ignored by the runner"
      }
    ]
  }
}
```

- **`command`** — a shell string **or** an argv array (`["uv", "run", "…"]`, no shell).
- **`match`** — optional regex tested against the tool name (`Bash`, `Edit`, `Read`, …). Only applies to
  `tool_call` / `tool_result`. Omit to match every tool.
- **`timeoutMs`** — optional per-hook timeout; a hook that overruns is killed and treated as fail-soft.
- **`description`** — optional human label.

### Variable substitution

Expanded in every command token (string or argv element):

| Variable | Expands to |
| --- | --- |
| `${workspaceFolder}` | Absolute path of the workspace root |
| `${workspaceFolderBasename}` | The workspace folder's name |
| `${userHome}` | Your home directory |
| `${env:NAME}` / `$NAME` | The environment variable `NAME` (empty string if unset) |

### Child environment

The child process inherits the **full** parent environment plus:

| Variable | Value |
| --- | --- |
| `DAMOCLES_PROJECT_DIR` | Workspace root |
| `DAMOCLES_HOOK_EVENT` | The event key that fired (e.g. `tool_call`) |

> The child sees every variable in Damocles' own environment. Provider/OAuth credentials live in the
> Damocles agent dir, not env, so they are **not** exposed — but any secret you keep in an ambient env var
> (e.g. `OPENAI_API_KEY`) reaches the hook process. Don't pipe the environment to an untrusted command.

---

## The hook contract

### stdin (snake_case)

The runner writes one JSON object to the child's stdin. Common keys on **every** event: `session_id`,
`transcript_path`, `cwd`, `event` (the event key that fired). Per event:

| Event | Extra stdin keys |
| --- | --- |
| `tool_call` | `tool_name`, `input` |
| `tool_result` | `tool_name`, `input`, `result` (`{ output, is_error, details? }`) |
| `input` | `prompt` |
| `agent_end` / `subagent_end` | `messages` (`{role, content}[]`); `subagent_end` adds `parent_tool_use_id` |
| `permission_required` | `message`, `tool_name`, `input`, `file_path` \| `command`; `parent_tool_use_id` *(only when the wait is a subagent's tool)* |
| `session_start` | `reason` |
| `session_shutdown` | `reason` |
| `session_before_compact` | *(base keys only)* |
| `before_agent_start` | `prompt` |

`tool_name` / `input` use a **uniform tool schema**: consistent names (`Read`, `Write`, `Edit`, `Bash`,
`Grep`, `Glob`) and a consistent input shape (file tools expose `input.file_path`, `Bash` exposes
`input.command`). This is a stable contract — it does not change when a tool's internal wiring does.

### stdout (output contract)

A hook influences the run **only** through one JSON object on stdout. The exit code is health, not a
signal: any non-zero exit is fail-soft (logged, no effect) and can never silently block.

| Response field | Effect |
| --- | --- |
| `decision: "allow"` | `tool_call`: force-allow the tool past the approval gate |
| `decision: "deny"` | `tool_call`: block the tool (`reason` is shown) |
| `decision: "block"` | `tool_result`: mark the result an error + append `reason`; `input`: reject the prompt |
| `decision: "ask"` *(or omitted)* | no decision — normal flow |
| `reason` | text shown with a deny/block |
| `updated_input` | `tool_call`: rewrite the tool's arguments (uniform shape; mapped to the engine before it runs) |
| `updated_output` | `tool_result`: replace the tool's output |
| `context` | add context for the model (`tool_call`: appended to the tool's result; `tool_result`: appended; `input`: added to the turn) |
| `session_title` | `input`: rename the session |
| `system_message` | any blocking event: shown to you as a notification |

| Child outcome | Effect |
| --- | --- |
| exit 0, JSON object | applied per the table above |
| exit 0, plain (non-JSON) stdout | added as context |
| exit 0, empty stdout | no-op |
| any non-zero exit | fail-soft: logged, no effect |

> To block, **emit JSON** — `{"decision":"deny"}` for `tool_call`, `{"decision":"block"}` for
> `tool_result` / `input`. A non-zero exit alone never blocks. Spawn failures and timeouts are fail-soft
> too, **except** a `tool_call` hook on a write/shell tool, which stays **fail-closed** (the tool is
> blocked) if the hook itself can't run.

---

## Event keys

### Tier 1 — block / mutate

| Config key | Fires | Can do |
| --- | --- | --- |
| `tool_call` | before a tool runs | deny / force-allow / rewrite `updated_input` / add `context` |
| `tool_result` | after a tool runs | modify output, add context, block (marks the result an error) |
| `input` | on prompt submit | add context, block, rename the session (`session_title`) |
| `agent_end` | the agent finished a turn | observe-only |
| `subagent_end` | a subagent finished | observe-only; carries `parent_tool_use_id` |
| `session_start` | a session started | observe-only |
| `session_shutdown` | a session ended | observe-only |
| `session_before_compact` | before compaction | observe-only |
| `before_agent_start` | before each turn | stdout is injected as context for the run |

### Synthetic (Damocles-defined)

| Config key | Notes |
| --- | --- |
| `permission_required` | the agent is **blocked waiting for your file/shell approval**. Observe-only; lazy (zero cost unless configured); debounced once per turn |

### Tier 2 — observe-only (cheap notify/logging; return value ignored)

`model_select`, `thinking_level_select`, `session_before_switch`, `session_before_fork`,
`session_before_tree`, `turn_start`, `turn_end`, `agent_start`, `message_start`, `message_end`,
`resources_discover`.

> `session_before_fork` is emitted by Damocles at its fork point (its payload adds `parent_session_id`,
> `entry_id`, `new_session_id`) because Damocles forks by branching the session file into a new panel.
> `session_before_tree` only fires from pi's session-tree navigation, which Damocles' webview does not
> expose, so it never fires here.

### Excluded (never spawned)

`message_update`, `tool_execution_start/update/end`, `context`, `before_provider_request`,
`after_provider_response`, `user_bash`, `project_trust` — too high-frequency or mutation-heavy for a
spawned command.

---

## Worked examples

A complete `~/.damocles/hooks.json` (delete what you don't need):

```jsonc
{
  "hooks": {
    "tool_call": [
      {
        // Block destructive shell commands: emit a deny JSON when the command matches.
        "match": "Bash",
        "command": "in=$(cat); echo \"$in\" | jq -e -r '.input.command | test(\"rm -rf\")' >/dev/null && echo '{\"decision\":\"deny\",\"reason\":\"Refusing rm -rf\"}'"
      },
      {
        // Force-allow every Write past the diff/approval gate.
        "match": "Write",
        "command": ["uv", "run", "${workspaceFolder}/.damocles/hooks/auto_approve_write.py"]
      }
    ],
    // Ping Telegram when the agent is waiting on you.
    "permission_required": [
      { "command": ["uv", "run", "${workspaceFolder}/.damocles/hooks/notify.py"] }
    ],
    // Dump the transcript when a turn finishes.
    "agent_end": [
      { "command": ["uv", "run", "${workspaceFolder}/.damocles/hooks/on_stop.py"] }
    ]
  }
}
```

**Force-allow a Write** (`auto_approve_write.py`):

```python
#!/usr/bin/env -S uv run --script
import json, sys
json.load(sys.stdin)  # consume the payload
print(json.dumps({"decision": "allow", "reason": "trusted path"}))
```

**Deny a tool** — emit a `decision: "deny"` with a reason the model sees:

```python
print(json.dumps({"decision": "deny", "reason": "writes to /etc are not allowed"}))
```

**Rewrite a tool's input** — return the uniform tool shape; Damocles maps it to the engine's native shape
before the tool runs:

```python
print(json.dumps({"updated_input": {"file_path": "/safe/redirect.txt"}}))
```

**Rename the session from a prompt** (`input` hook):

```python
print(json.dumps({"session_title": "Investigating the flaky test"}))
```

---

## Cross-platform notes

- A **shell string** runs through `cmd.exe` on Windows and `/bin/sh` on macOS/Linux. Bash-isms
  (`jq < /dev/stdin`, `<<<`) need a POSIX shell on `PATH`. `uv run script.py` is fully portable — prefer
  it (or the argv form) for cross-platform hooks.
- `transcript_path` points at the session JSONL (the canonical, complete record). The inline `messages`
  array on `agent_end` / `subagent_end` is a convenience snapshot; for very long sessions, read
  `transcript_path`.

---

## Troubleshooting

- **Hook didn't fire?** Check, in order: (1) the workspace is **trusted** if the hook is in the project
  file; (2) the file is named exactly `hooks.json` and lives in `~/.damocles/` or
  `<workspace>/.damocles/`; (3) the JSON is valid (comments are allowed, but trailing commas are not);
  (4) the **Damocles** output channel — every hook run is logged there with its event key, command, exit
  code, and decision.
- **Hook errors are never fatal.** A spawn failure, timeout, or non-zero exit is logged and the turn
  continues — except a `tool_call` hook on a write/shell tool, which stays fail-closed (the tool is
  blocked) if the hook itself fails to run.
- **A force-allow or block** always raises a subtle in-chat notice so a gate override is never silent.
```
