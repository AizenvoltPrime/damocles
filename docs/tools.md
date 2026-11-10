# Tools

This page covers the optional tool groups that are not covered elsewhere (web tools and image generation), how deferred tool loading keeps unused tools out of the prompt, and the Tools panel.

The browser, Compass and MCP tools have their own pages: [Browser](browser.md), [Compass](compass.md) and [MCP servers](mcp.md).

## Order of tool calls in one reply

The agent can ask for several tool calls in one reply, and they usually run at the same time. When a reply holds an `Edit` or a `write`, all its calls run one after another in the order the agent wrote them, so a `read` or a test command after an edit sees the edited file. That includes foreground `Agent` calls: subagents started in the same reply as an `Edit` or `write` run one after another, not side by side.

A `read` never sees a file half written by Damocles' own file tools. For an existing file this holds against `Edit` and `write`: a `read` waits in a per-file queue until an `Edit` or `write` of that file in the same Damocles engine process has finished; `GenerateImage` creates its file atomically, so any reader sees no file or the whole image. It does not hold against MCP tools or shell commands: a shell command such as `cat` can still see a file an `Edit` or `write` is writing, and a `read` can see a file an MCP tool or a shell command is writing.

## Web tools

The web tools are opt-in: enable them via `damocles.pi.webSearch.enabled`. The toggle takes effect on the next turn with no install or reload.

Five native, **key-free** read-only tools:

- **WebSearch**: an answer with cited sources, with optional category / domain / publish-date filters via Exa's advanced search
- **WebFetch**: read a web page or PDF as markdown, with `raw` / `maxChars` / `includeLinks` / `includeImages` controls
- **CodeSearch**: search public source code and docs
- **FeedRead**: read an RSS 2.0 or Atom feed as markdown
- **YouTubeTranscript**: best-effort video transcript when captions are available, though YouTube may block it

WebSearch and CodeSearch are backed by Exa's free endpoint; no API key or config is required. WebFetch extracts HTML via Readability, reads PDFs inline, fetches a GitHub `blob` or `raw` page from `raw.githubusercontent.com`, and falls back to the `r.jina.ai` reader for JavaScript-heavy pages. Every outbound fetch is validated to block internal/loopback/cloud-metadata addresses.

WebFetch never contacts a host that a deny or ask `WebFetch(domain:<host>)` rule matches on a step it takes by itself ([Permissions](permissions.md)): with `raw.githubusercontent.com` matched it fetches the GitHub page as named, with `r.jina.ai` matched it returns the direct result without the reader, and a redirect to a matched host other than the URL's own stops, with the result naming the redirect's URL, which the agent can fetch as a call of its own that the rules judge. Allow rules change none of this, and ImportAsset's URL fetch stops at such a redirect the same way.

All five are read-only, available in plan mode and inherited by `tools: *` subagents. They start **deferred**: their schemas are not in the prompt until the agent loads them with `ToolSearch`, so a turn that never searches the web costs nothing for them. See [Deferred tool loading](#deferred-tool-loading).

## Image generation

An opt-in `GenerateImage` tool (`damocles.imageGeneration.enabled`, off by default and settable only in user settings) creates a new PNG, JPEG or WebP file at the path you approve from a text prompt. It uses an OpenRouter image model you pick in Settings (`damocles.imageGeneration.model`, also user settings only) and your OpenRouter key or sign-in, which you set under OpenRouter in Settings › Models & accounts. Only models whose cost pi can track are offered. The agent loads it with ToolSearch when it needs it.

It goes through the same permission gate as Write: it asks with the path, the prompt and the model in Default mode, runs without asking in Accept Edits, is blocked in Plan mode, never overwrites a file, and a rewind removes the image. The image appears at its path only once it is complete: any program reading the path sees no file or the whole image, never part of one. The cost OpenRouter billed counts in the status bar, the budget and `/stats`, under the image model. The generated image shows in the tool's overlay. Subagents and team agents do not get the tool.

## Deferred tool loading

The browser, Compass, web and MCP tools, and the MCP resource tools (group `mcp_resources`), start registered but **inactive**, so their schemas are not in the prompt on turn one. A conversation that never touches them never pays for them. The resource tools are the one exception to deferral: when a resource server is set to Always loaded, all three are declared from the first turn.

The agent loads a group on demand with the always-active `ToolSearch` tool, and the tools are callable from its next step. The menu it reads is built from live workspace configuration, so a subsystem you disable mid-session drops out of it rather than staying advertised.

What this saves depends on your provider: a tool never loaded always costs nothing, and on Anthropic *loading* a group mid-conversation still reads the cached system prompt and initial tools, so only the new schemas and the messages are written to the cache again. Subagents and team agents resolve through the same deferral, so no agent kind is a hole. `/context` shows the split; see [Context stats](chat.md#context-stats).

## Tools panel

A status panel lists every agent tool grouped by subsystem (core, memory, compass, browser, web, design), each with a per-tool enable switch and a per-subsystem master switch. Core built-ins are locked on; memory, compass, browser, web and design tools toggle. It opens from the Tools button in the chat header (in its More menu when the panel is narrow).
