# MCP servers

This page covers how Damocles finds, configures, connects and exposes MCP servers, their tools and resources, and how MCP servers ask you for input.

The whole subsystem toggles via `damocles.mcp.enabled`. MCP access for subagents and team agents is described in [Agents and teams](agents.md#mcp-for-subagents-and-team-agents), and deferred loading in [Tools](tools.md#deferred-tool-loading).

## Configuration sources

The MCP client is pi's own (`@earendil-works/pi-mcp`); Damocles runs the servers and shares each one across every chat of a folder. Servers are merged from eight sources, each row badged with where it came from. Lowest precedence first:

1. Read-only imports of your Claude Code / Claude Desktop config and of `~/.codex/config.toml` (ties broken by `damocles.assetSourcePrecedence`)
2. pi's own `~/.pi/agent/mcp.json` (badge `pi`)
3. The project's `.pi/mcp.json` (badge `pi-project`)
4. Claude Code's **local** scope for this project (what a plain `claude mcp add` writes, under `projects[<workspace>]` in `~/.claude.json`)
5. Your own `~/.damocles/mcp.json`
6. The project's `.mcp.json`
7. Your personal `<workspace>/.damocles/mcp.local.json`, which wins

**Add, edit and delete servers from the panel**. Only `~/.damocles/mcp.json` is ever written, so every other source is read-only and carries no Edit/Delete button. `~/.claude.json` is deliberately not watched, because Claude Code rewrites it continuously and each write would cycle your live connections, so the panel has a **Reload config** action that re-reads every source on demand.

`.damocles/mcp.local.json` is meant to be personal and gitignored. When git is not ignoring it the panel warns and names the line to add, the warning clears as soon as you add it because `.gitignore` is watched too, and Damocles never edits your `.gitignore` itself. The check is skipped in a workspace you have not trusted, because running git there would run configuration the repository ships, and it gives up after ten seconds so a wedged filesystem cannot hold up session start.

In a workspace you have not trusted, `.mcp.json` and `.damocles/mcp.local.json` servers are listed with an untrusted badge and do not connect, `.pi/mcp.json` is not read until you trust the folder, and the rest still connect.

A config file that exists but cannot be parsed is reported by name and line with a button to open it at the fault, rather than its servers silently disappearing.

## Transports and environment

Servers connect over stdio or streamable HTTP. Legacy SSE servers are not supported and show an error row asking for the server's streamable HTTP URL; an `auth.provider` entry shows an error row too. stdio servers get a minimal default environment plus their own `env`, never your whole environment, so your provider API keys reach a server only when its config names them.

## Tool names

Each tool is exposed under pi's name, `mcp__{server}__{tool}` with every character outside `[A-Za-z0-9_]` replaced by `_` and capped at 64 characters (a colliding or longer name gets an 8-character hash suffix), so `resolve-library-id` becomes `resolve_library_id`. Two servers whose names differ only in such characters are one server: the lower-precedence one is dropped and reported.

Permission rules naming a renamed tool are migrated in `~/.damocles/settings.json`, `~/.damocles/settings.local.json` and a folder's `.damocles/settings.local.json`; rules in a project's committed `.damocles/settings.json`, hook matchers, agent `disallowed_tools` and project-scope `damocles.tools.disabled` entries naming a renamed tool are listed once in a notice for you to edit. Claude Code's settings files are left alone, because Claude Code keeps `-` in MCP tool names.

A rule that named a former `get_` resource tool, such as `mcp__secret__get_passwords`, becomes `mcp__secret__read_mcp_resource(secret://passwords)` in the same three files, so it keeps covering exactly that resource; where Damocles does not edit the file (the committed project settings, Claude Code's settings, hook matchers, `disallowed_tools`, `damocles.tools.disabled`) the notice lists it with its replacement.

## Config fields

Config fields follow pi's `mcp.json`:

- `description`: the server's ToolSearch menu line, else the first line of the server's own instructions
- `timeout`: seconds per request, default 120, reset by progress notifications
- `enabled: false`: listed as disabled until you enable it in the panel
- `oauth.clientName`, `oauth.authServerMetadataUrl`, `oauth.callbackUrl` and `oauth.callbackPort`: a fixed loopback redirect URI for a pre-registered OAuth client, sent exactly as written

### Values in pi-format files

Values in pi-format files (`~/.damocles/mcp.json`, `.damocles/mcp.local.json`, `~/.pi/agent/mcp.json`, `.pi/mcp.json`) follow pi's rules in `env`, `headers`, `bearerToken` and `oauth.clientSecret`:

- `$VAR` and `${VAR}` read an environment variable (`$$` is a literal `$`, `$!` a literal `!`).
- A value starting with `!` runs a shell command and uses its output, like a credential helper (`"!op read op://vault/mcp/token"`; Git Bash or your configured shell on Windows, 10 s timeout, run again on every connect).
- A variable that is not set marks the server failed, naming the variable, instead of sending an empty value.

A folder's file runs commands only in a trusted workspace. In `.mcp.json`, Claude and Codex configs a leading `!` is plain text and `${VAR}` and `$env:VAR` keep their meaning.

A stdio server runs in its folder (a user server in your home directory) unless `cwd` says otherwise, and a relative `cwd` resolves against that same directory. pi does not expand variables in `cwd`, so in a pi-format file a `cwd` holding `${VAR}` or `$env:VAR` marks the server failed.

Existing `$env:NAME` values and `oauth.redirectUri` in your two Damocles files are migrated to `${NAME}` and `oauth.callbackUrl` automatically; any other `$` or leading `!` in an old value now has pi's meaning.

## Tool results

A tool result longer than 20 KB is cut in the middle, and its full text is saved to a temporary file named in the result, so the agent can Read it.

## OAuth

OAuth uses PKCE with dynamic client registration (as `oauth.clientName`, default `Damocles`), rejects a sign-in answered by a different authorization server (RFC 9207 `iss`), and asks you to authenticate again when a server needs more scope than you granted.

## Tool exposure

Each tool row in the MCP panel has an **Off / On / Always loaded** control and names where its state comes from (Config, User, Project or Local).

- **On** is the default: the agent loads the tool with ToolSearch when it needs it.
- **Always loaded** declares the tool from the first turn, which costs context on every turn. The first prompt of a session waits up to 10 seconds for a server with such a tool to connect before it is sent. Stopping the turn, starting a new chat, resuming another conversation or closing the chat during that wait sends nothing to the model and puts your message and its attachments back in the composer, and a message you type meanwhile joins the turn once it starts.

The choice is saved to `damocles.mcp.toolExposure` (`{ "<server>": { "<tool>": "off" | "deferred" | "direct" } }`) at the scope picked in **Save to** at the top of the panel (User, Project, or Local on desktop). Local beats project beats user per tool, and project and local apply only in a trusted folder, so a save that a higher scope still overrides for that tool says so. A change to the setting made anywhere, such as `settings.json`, Settings Sync or another window, applies to every open chat from its next turn. On desktop, Project and Local are saved to the default project, so they are offered only when it is trusted too.

A server's `exposure` and `toolExposure` fields in `mcp.json` (pi's values, `*` patterns allowed) give the starting state. Tools you disabled before this version stay off.

## Resources

A server's **resources** (data it offers by URI) are not tools of their own: the agent reaches every server's resources through three tools, `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`, each naming the server. Text reaches the agent as text, a PNG, JPEG, GIF or WebP image as an image of the type its bytes carry, and other files, other images included, as a saved temporary file the agent can open; MCP App interfaces are left out.

Each server that offers resources has a **Resources** row in its tool list with the same Off / On / Always loaded control, saved to `damocles.mcp.resourceExposure` (`{ "<server>": "off" | "deferred" | "direct" }`) at the **Save to** scope. Its default is Off for a server with `exposeResources: false` or `exposure: "hidden"`, Always loaded for `exposure: "direct"`, and On otherwise. A server is ready as soon as it has listed its tools; its resources are listed only when the agent asks.

### Browsing and attaching resources

**Browse resources** on a server's row in the panel (shown while the server offers resources or has not connected yet, which opening it does) lists its resources page by page and its templates, opens a directory resource in place with a Back row (one that turns out to be a file can then be attached), and fills a template in a form with the server's own completions.

**Attach** puts the pick in the chat's composer as a chip. The resource is read when you send the message, so the model gets its current content: text inside your message, counted with your other attachments against the 128,000-character limit, and a PNG, JPEG, GIF or WebP image as an image of the type its bytes carry, counted toward the 10 images a message carries. Whether a resource is text is decided by that read, so a script or source file labelled `application/javascript` can be attached.

A failed read, binary content, an image the model cannot take, an MCP App interface, text past the limit, a deny rule that now covers the resource or a server replaced or removed since you attached it returns your message and its chips to the composer with the reason, and nothing is sent. Stopping the turn, starting a new chat or closing the chat while the resource is still being read also puts the message and its chips back and sends nothing.

A deny rule that covers a resource also disables its Attach button and names the rule, but it does not stop you browsing: a covered directory still opens and lists its contents for you, never for the model. Ask rules, the Resources control and `exposeResources` shape only the agent's tools, so they never stop you browsing or attaching. A message typed while a turn runs is queued without its chips, which wait for your next message.

## Connection lifecycle

Enabled servers are **supervised**: they stay connected for the session and auto-reconnect when a connection drops, with a crash-loop throttle and config-change re-validation so a reconnect never resurrects an orphaned child process. Opt out per server with `lifecycle: "lazy"` (connect-on-use) or an explicit `idleTimeout`.

## Enabling and disabling servers

Enable and disable servers from the UI, persisted to Damocles workspace state.

- Disabling a server from `~/.damocles/mcp.json` or an imported Claude Code, Claude Desktop or Codex config applies to the whole window (`damocles.mcp.disabledServers`).
- Disabling a project server, one from the folder's `.mcp.json`, `.damocles/mcp.local.json` or Claude Code local scope, applies to that folder only (`damocles.mcp.disabledProjectServers`).

## Status panel

The status panel shows per-server tool counts with expandable details and annotation badges (read-only, destructive, network), error messages for failed servers, and per-server actions: reconnect, authenticate, and, on a connected OAuth server, **Re-authenticate** (clear the token and log in fresh) and **Sign out** (clear the token and disconnect). Sign-out evicts the server's cached tools so the agent can no longer call them and best-effort revokes the token server-side (RFC 7009) where the auth server supports it.

## Elicitation

MCP servers can request user input during tool execution. Form mode renders JSON Schema-driven fields for structured input, and URL mode opens an external browser for OAuth flows. Prompts appear above the chat input with Accept/Decline actions.

A prompt raised during a **subagent's or team agent's** call renders in the spawning panel, labelled with the agent that asked; concurrent agents queue one at a time, and an agent that ends withdraws its own prompt. With two calls in flight on one server the dialog names only the server, because MCP cannot say which call elicited.
